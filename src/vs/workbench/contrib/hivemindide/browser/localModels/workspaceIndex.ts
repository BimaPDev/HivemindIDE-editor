/*---------------------------------------------------------------------------------------------
 *  HivemindIDE local models: workspace retrieval for chat (the RAG half).
 *
 *  Files are split into overlapping line windows. Every chunk is searchable by
 *  keyword (BM25) as soon as the index is built; when an embedding model is
 *  configured, chunks are also embedded in the background and searched by
 *  meaning, and the two rankings are fused. A query never waits for
 *  embeddings — chunks without a vector yet simply compete on keywords.
 *
 *  The index lives in memory for the window's lifetime and is kept current
 *  from file-change events rather than rebuilt.
 *--------------------------------------------------------------------------------------------*/

import { Limiter } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ResourceMap, ResourceSet } from '../../../../../base/common/map.js';
import { extname } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { QueryBuilder } from '../../../../services/search/common/queryBuilder.js';
import { ISearchService } from '../../../../services/search/common/search.js';
import { ILocalModelsService } from './localModelsService.js';

const MAX_FILES = 4000;
const MAX_FILE_BYTES = 256 * 1024;
const CHUNK_LINES = 50;
const CHUNK_OVERLAP = 10;
/** Embedding input is capped so it fits the smallest common embedding context (512 tokens). */
const EMBED_CHARS = 1500;
const EMBED_BATCH = 32;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const RRF_K = 60;

const TEXT_EXTENSIONS = new Set([
	'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.kts', '.swift', '.m', '.mm',
	'.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.fs', '.rb', '.php', '.lua', '.dart', '.scala', '.clj', '.ex', '.exs',
	'.erl', '.hs', '.ml', '.zig', '.sql', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.r', '.jl', '.vue', '.svelte',
	'.html', '.css', '.scss', '.less', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.xml', '.graphql', '.proto',
	'.md', '.mdx', '.txt', '.rst', '.tf', '.hcl', '.gradle', '.cmake', '.nix',
]);
const TEXT_BASENAMES = new Set(['makefile', 'dockerfile', 'gemfile', 'rakefile', 'procfile', 'justfile']);

const STOP_WORDS = new Set(['in', 'is', 'it', 'on', 'of', 'to', 'an', 'or', 'as', 'at', 'be', 'by', 'do', 'if', 'me', 'my', 'we', 'so', 'the', 'and', 'for', 'with', 'this', 'that', 'from', 'are', 'was', 'what', 'how', 'why', 'does', 'where', 'which', 'can', 'you', 'your', 'into', 'about', 'use', 'using', 'not', 'but', 'have', 'has', 'var', 'let', 'const', 'return', 'function', 'import', 'export', 'new']);

export interface IRetrievedChunk {
	readonly uri: URI;
	/** 1-based, inclusive. */
	readonly startLine: number;
	readonly endLine: number;
	readonly text: string;
}

interface IChunk extends IRetrievedChunk {
	readonly termFreqs: Map<string, number>;
	readonly length: number;
	vector?: Float32Array;
}

export class WorkspaceIndex extends Disposable {

	private readonly chunksByFile = new ResourceMap<IChunk[]>();
	private readonly docFreq = new Map<string, number>();
	private chunkCount = 0;
	private totalLength = 0;

	private built: Promise<void> | undefined;
	private readonly dirty = new ResourceSet();
	/** Files were added since the last listing; list again so ignore rules apply to them. */
	private rescanNeeded = false;
	private embedding: Promise<void> | undefined;
	private embeddingModelPath: string | undefined;
	private readonly queryBuilder: QueryBuilder;

	constructor(
		@ISearchService private readonly searchService: ISearchService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILocalModelsService private readonly localModelsService: ILocalModelsService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.queryBuilder = instantiationService.createInstance(QueryBuilder);

		this._register(this.fileService.onDidFilesChange(e => {
			if (!this.built) {
				return;
			}
			// Changes to indexed files are re-read directly. New files are not
			// trusted on sight — build output and logs appear the same way — so they
			// wait for a fresh listing, which applies .gitignore and search.exclude.
			for (const uri of e.rawUpdated) {
				if (this.chunksByFile.has(uri)) {
					this.dirty.add(uri);
				}
			}
			if (e.rawAdded.some(uri => isIndexable(uri) && this.workspaceContextService.isInsideWorkspace(uri))) {
				this.rescanNeeded = true;
			}
			for (const uri of e.rawDeleted) {
				this.removeFile(uri);
				this.dirty.delete(uri);
			}
		}));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this.reset()));
		this._register(this.localModelsService.onDidChange(() => {
			if (this.localModelsService.embeddingModel?.path !== this.embeddingModelPath) {
				this.dropVectors();
			}
		}));
	}

	get size(): number {
		return this.chunkCount;
	}

	/** Finds the chunks most relevant to `query`. Builds the index on first use. */
	async search(query: string, limit: number, token: CancellationToken): Promise<IRetrievedChunk[]> {
		if (limit <= 0 || this.workspaceContextService.getWorkspace().folders.length === 0) {
			return [];
		}
		await this.ensureBuilt(token);
		await this.rescanIfNeeded(token);
		await this.refreshDirty();
		if (token.isCancellationRequested || this.chunkCount === 0) {
			return [];
		}

		const keywordRanking = this.rankByKeywords(query);
		const vectorRanking = await this.rankByVector(query);
		this.startEmbedding();

		const fused = new Map<IChunk, number>();
		const addRanking = (ranking: IChunk[]) => ranking.forEach((chunk, rank) => fused.set(chunk, (fused.get(chunk) ?? 0) + 1 / (RRF_K + rank)));
		addRanking(keywordRanking.slice(0, 100));
		addRanking(vectorRanking.slice(0, 100));

		return [...fused.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, limit)
			.map(([chunk]) => ({ uri: chunk.uri, startLine: chunk.startLine, endLine: chunk.endLine, text: chunk.text }));
	}

	private ensureBuilt(token: CancellationToken): Promise<void> {
		if (!this.built) {
			this.built = this.build(token).catch(err => {
				this.logService.warn('[LocalModels] indexing the workspace failed', err);
				this.built = undefined;
			});
		}
		return this.built;
	}

	/** Workspace files eligible for the index, honouring ignore files and exclude settings. */
	private async listFiles(token: CancellationToken): Promise<URI[]> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		const query = this.queryBuilder.file(folders, { maxResults: MAX_FILES * 2, _reason: 'hivemindideLocalModelsIndex' });
		const result = await this.searchService.fileSearch(query, token);
		return result.results.map(r => r.resource).filter(isIndexable).slice(0, MAX_FILES);
	}

	private async rescanIfNeeded(token: CancellationToken): Promise<void> {
		if (!this.rescanNeeded) {
			return;
		}
		this.rescanNeeded = false;
		const added = (await this.listFiles(token)).filter(uri => !this.chunksByFile.has(uri));
		await Promise.all(added.map(uri => this.indexFile(uri)));
	}

	private async build(token: CancellationToken): Promise<void> {
		const files = await this.listFiles(token);

		const limiter = new Limiter<void>(16);
		await Promise.all(files.map(uri => limiter.queue(() => this.indexFile(uri))));
		limiter.dispose();
		this.logService.info(`[LocalModels] indexed ${files.length} files into ${this.chunkCount} chunks`);
	}

	private async refreshDirty(): Promise<void> {
		if (this.dirty.size === 0) {
			return;
		}
		const uris = [...this.dirty];
		this.dirty.clear();
		await Promise.all(uris.map(uri => this.indexFile(uri)));
	}

	private async indexFile(uri: URI): Promise<void> {
		this.removeFile(uri);
		let text: string;
		try {
			const stat = await this.fileService.stat(uri);
			if (stat.size > MAX_FILE_BYTES) {
				return;
			}
			text = (await this.fileService.readFile(uri)).value.toString();
		} catch {
			return;
		}
		if (text.includes('\u0000')) {
			return; // binary despite the extension
		}

		const lines = text.split(/\r?\n/);
		const chunks: IChunk[] = [];
		for (let start = 0; start < lines.length; start += CHUNK_LINES - CHUNK_OVERLAP) {
			const end = Math.min(lines.length, start + CHUNK_LINES);
			const chunkText = lines.slice(start, end).join('\n');
			if (chunkText.trim()) {
				const terms = tokenize(`${uri.path} ${chunkText}`);
				const termFreqs = new Map<string, number>();
				for (const term of terms) {
					termFreqs.set(term, (termFreqs.get(term) ?? 0) + 1);
				}
				chunks.push({ uri, startLine: start + 1, endLine: end, text: chunkText, termFreqs, length: terms.length });
			}
			if (end === lines.length) {
				break;
			}
		}

		for (const chunk of chunks) {
			for (const term of chunk.termFreqs.keys()) {
				this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
			}
			this.chunkCount++;
			this.totalLength += chunk.length;
		}
		if (chunks.length) {
			this.chunksByFile.set(uri, chunks);
		}
	}

	private removeFile(uri: URI): void {
		const chunks = this.chunksByFile.get(uri);
		if (!chunks) {
			return;
		}
		this.chunksByFile.delete(uri);
		for (const chunk of chunks) {
			for (const term of chunk.termFreqs.keys()) {
				const df = (this.docFreq.get(term) ?? 1) - 1;
				if (df > 0) {
					this.docFreq.set(term, df);
				} else {
					this.docFreq.delete(term);
				}
			}
			this.chunkCount--;
			this.totalLength -= chunk.length;
		}
	}

	private reset(): void {
		this.chunksByFile.clear();
		this.docFreq.clear();
		this.dirty.clear();
		this.chunkCount = 0;
		this.totalLength = 0;
		this.built = undefined;
	}

	private *allChunks(): Iterable<IChunk> {
		for (const chunks of this.chunksByFile.values()) {
			yield* chunks;
		}
	}

	// ---- Keyword ranking (BM25) -----------------------------------------------

	private rankByKeywords(query: string): IChunk[] {
		const terms = [...new Set(tokenize(query))];
		if (terms.length === 0) {
			return [];
		}
		const avgLength = this.totalLength / Math.max(1, this.chunkCount);
		const scored: [IChunk, number][] = [];
		for (const chunk of this.allChunks()) {
			let score = 0;
			for (const term of terms) {
				const tf = chunk.termFreqs.get(term);
				if (!tf) {
					continue;
				}
				const df = this.docFreq.get(term) ?? 0;
				const idf = Math.log(1 + (this.chunkCount - df + 0.5) / (df + 0.5));
				score += idf * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * chunk.length / avgLength));
			}
			if (score > 0) {
				scored.push([chunk, score]);
			}
		}
		return scored.sort((a, b) => b[1] - a[1]).map(([chunk]) => chunk);
	}

	// ---- Vector ranking (embeddings) --------------------------------------------

	private async rankByVector(query: string): Promise<IChunk[]> {
		if (!this.localModelsService.embeddingModel) {
			return [];
		}
		try {
			if (!await this.localModelsService.ensureEmbeddingServer()) {
				return [];
			}
			const [queryVector] = await this.localModelsService.embed([query.slice(0, EMBED_CHARS)]);
			const scored: [IChunk, number][] = [];
			for (const chunk of this.allChunks()) {
				if (chunk.vector && chunk.vector.length === queryVector.length) {
					let dot = 0;
					for (let i = 0; i < queryVector.length; i++) {
						dot += chunk.vector[i] * queryVector[i];
					}
					scored.push([chunk, dot]);
				}
			}
			return scored.sort((a, b) => b[1] - a[1]).map(([chunk]) => chunk);
		} catch (err) {
			this.logService.warn('[LocalModels] embedding search failed, using keywords only', err);
			return [];
		}
	}

	/** Embeds every chunk that has no vector yet, in the background. */
	private startEmbedding(): void {
		const model = this.localModelsService.embeddingModel;
		if (!model || this.embedding) {
			return;
		}
		this.embeddingModelPath = model.path;
		this.embedding = (async () => {
			try {
				const pending = [...this.allChunks()].filter(c => !c.vector);
				for (let i = 0; i < pending.length; i += EMBED_BATCH) {
					if (this.localModelsService.embeddingModel?.path !== model.path) {
						return; // model switched; vectors from two models are not comparable
					}
					const batch = pending.slice(i, i + EMBED_BATCH);
					const vectors = await this.localModelsService.embed(batch.map(c => `${c.uri.path}\n${c.text}`.slice(0, EMBED_CHARS)));
					batch.forEach((chunk, j) => chunk.vector = Float32Array.from(vectors[j]));
				}
			} catch (err) {
				this.logService.warn('[LocalModels] background embedding stopped', err);
			} finally {
				this.embedding = undefined;
			}
		})();
	}

	private dropVectors(): void {
		for (const chunk of this.allChunks()) {
			chunk.vector = undefined;
		}
		this.embeddingModelPath = undefined;
	}
}

function isIndexable(uri: URI): boolean {
	// The hivemind reaches the model through its own context block; indexed as
	// code, its protocol text ("Handoff", "node") would crowd real results out.
	if (uri.path.includes('/.hivemind/')) {
		return false;
	}
	const ext = extname(uri).toLowerCase();
	if (ext) {
		return TEXT_EXTENSIONS.has(ext);
	}
	const name = uri.path.slice(uri.path.lastIndexOf('/') + 1).toLowerCase();
	return TEXT_BASENAMES.has(name);
}

/** Splits identifiers the way people search for them: `parseHTTPRequest` → parse, http, request. */
export function tokenize(text: string): string[] {
	const terms: string[] = [];
	for (const word of text.split(/[^A-Za-z0-9_]+/)) {
		if (word.length < 2) {
			continue;
		}
		const parts = word
			.split('_')
			.flatMap(part => part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/));
		for (const part of parts) {
			const term = part.toLowerCase();
			if (term.length >= 2 && !STOP_WORDS.has(term)) {
				terms.push(term);
			}
		}
		if (parts.length > 1) {
			terms.push(word.toLowerCase());
		}
	}
	return terms;
}
