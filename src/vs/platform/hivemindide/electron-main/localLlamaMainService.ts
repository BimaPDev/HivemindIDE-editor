/*---------------------------------------------------------------------------------------------
 *  HivemindIDE local models: llama.cpp server manager (main process).
 *
 *  Runs llama.cpp's own `llama-server` as a child process, one per role, bound
 *  to 127.0.0.1 on a free port with a per-launch API key so other local
 *  processes cannot borrow it. Servers are shared by every window and killed
 *  when the app shuts down.
 *
 *  The engine is a pinned upstream release, downloaded on first use and
 *  verified against its sha256 — a republished archive fails loudly instead of
 *  silently running different code. Same idea as the pinned Catppuccin VSIX.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import { createHash } from 'crypto';
import { createWriteStream, promises as fs } from 'fs';
import { networkInterfaces } from 'os';
import { net } from 'electron';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { delimiter, dirname, join } from '../../../base/common/path.js';
import { isWindows } from '../../../base/common/platform.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { findFreePortFaster } from '../../../base/node/ports.js';
import { extract } from '../../../base/node/zip.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILifecycleMainService } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { ILocalLlamaChatChunk, ILocalLlamaChatOptions, ILocalLlamaDevice, ILocalLlamaEngine, ILocalLlamaInstallProgress, ILocalLlamaMessage, ILocalLlamaRemote, ILocalLlamaServerState, ILocalLlamaService, ILocalLlamaStartOptions, LocalLlamaRole, LocalLlamaServerStatus } from '../common/localLlama.js';

/** Pinned llama.cpp release. Bump the build and every digest together. */
const LLAMA_CPP_BUILD = 'b11175';

const LLAMA_CPP_ASSETS: { readonly [platformArch: string]: { readonly name: string; readonly sha256: string } } = {
	'darwin-arm64': { name: `llama-${LLAMA_CPP_BUILD}-bin-macos-arm64.tar.gz`, sha256: 'd02a894d4e3dac287f23e1b514f3db4090809e99e44c1a75807af1c60bdf7089' },
	'darwin-x64': { name: `llama-${LLAMA_CPP_BUILD}-bin-macos-x64.tar.gz`, sha256: '36a48fd514d838036e9f478f03ea74f71a630772ef1cfc666536896ceb5e1510' },
	'linux-x64': { name: `llama-${LLAMA_CPP_BUILD}-bin-ubuntu-x64.tar.gz`, sha256: 'bf4507dd3810a1a203b15a6ba2fbde4d21ab78f11885203cd48cfda1ae003b88' },
	'linux-arm64': { name: `llama-${LLAMA_CPP_BUILD}-bin-ubuntu-arm64.tar.gz`, sha256: '4eb31ed978f7d3cd77a203469f4a51009804998b806bc1c4aeeee08e5126c5bb' },
	'win32-x64': { name: `llama-${LLAMA_CPP_BUILD}-bin-win-cpu-x64.zip`, sha256: '174dcd380f2519ddc48e5ccac183dde246e8579a0b315d3062c3ed4f0889ede1' },
	'win32-arm64': { name: `llama-${LLAMA_CPP_BUILD}-bin-win-cpu-arm64.zip`, sha256: '2e5551c597bf64cb4ddb0c60c61c493d5c9f3cf28d6f93db13f96fe0876704a1' },
};

const SERVER_EXECUTABLE = isWindows ? 'llama-server.exe' : 'llama-server';

/** Loading a large model from a slow disk can take minutes; anything past this is treated as hung. */
const STARTUP_TIMEOUT_MS = 5 * 60 * 1000;

/** Longest wait for the first token: a long prompt on a CPU-only machine can take minutes to read. */
const FIRST_TOKEN_TIMEOUT_MS = 3 * 60 * 1000;
/** Longest gap between tokens once an answer is streaming. Past this the model is treated as hung. */
const TOKEN_GAP_TIMEOUT_MS = 60 * 1000;
/** llama.cpp's own log lines when an allocation fails (CPU, Metal, CUDA, Vulkan). */
const OUT_OF_MEMORY = /out of memory|failed to allocate|unable to allocate|insufficient memory|cudaMalloc failed|ErrorOutOfMemory|vk::OutOfDeviceMemory/i;
/** Never shrink a context below this after running out of memory; smaller is not useful for chat. */
const MIN_CONTEXT_AFTER_OOM = 2048;

/** How long a stopped llama-server gets to exit before it is force-killed. */
const KILL_GRACE_MS = 5000;
/** Automatic restarts allowed while producing one answer. */
const MAX_RESTARTS_PER_ANSWER = 2;
/** More crashes than this within the window means restarting will not help (usually out of memory). */
const CRASH_LOOP_LIMIT = 3;
const CRASH_LOOP_WINDOW_MS = 5 * 60 * 1000;

/**
 * End-of-turn markers some GGUF chat templates leak as text, notably when an
 * assistant reply is prefilled to resume it. They are never part of an answer.
 */
const LEAKED_SPECIAL_TOKENS = /<\/?\|?(?:im_end|im_start|eot_id|end_of_text|endoftext|end_of_turn|start_of_turn)\|?>|<\/?end_of_turn>|<\/s>/g;
/** The start of something that may become a leaked marker once the next chunk arrives. */
const PARTIAL_SPECIAL_TOKEN = /<\/?\|?[a-z_]*\|?$/;

/** Finder-launched apps get a minimal PATH, so also look where package managers install. */
const EXTRA_SEARCH_DIRS = isWindows ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

interface IRunningServer {
	readonly process: ChildProcess;
	readonly port: number;
	readonly apiKey: string;
	readonly options: ILocalLlamaStartOptions;
	readonly stderrTail: string[];
	state: ILocalLlamaServerState;
	ready: Promise<ILocalLlamaServerState>;
	/** Last time a request used this server, for keep-alive. */
	lastUsed: number;
	/** Resolves with a reason when the process exits, for whatever cause. */
	readonly exited: Promise<string>;
	/** Set when HivemindIDE stopped it (Stop, model switch, idle unload), so the exit is not a crash. */
	stoppedOnPurpose?: boolean;
}

type AttemptOutcome =
	| { readonly kind: 'done' }
	| { readonly kind: 'cancelled' }
	/** The local model died or hung mid-answer; restarting and resuming may recover it. */
	| { readonly kind: 'interrupted'; readonly reason: string };

/** Where a request goes: a local server, or a remote OpenAI-compatible one. */
interface IEndpoint {
	readonly baseUrl: string;
	readonly apiKey?: string;
	readonly model?: string;
}

export class LocalLlamaMainService extends Disposable implements ILocalLlamaService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeServerState = this._register(new Emitter<ILocalLlamaServerState>());
	readonly onDidChangeServerState = this._onDidChangeServerState.event;

	private readonly _onDidChatChunk = this._register(new Emitter<ILocalLlamaChatChunk>());
	readonly onDidChatChunk = this._onDidChatChunk.event;

	private readonly _onDidInstallProgress = this._register(new Emitter<ILocalLlamaInstallProgress>());
	readonly onDidInstallProgress = this._onDidInstallProgress.event;

	private readonly servers = new Map<LocalLlamaRole, IRunningServer>();
	private readonly lastStates = new Map<LocalLlamaRole, ILocalLlamaServerState>();
	private readonly pendingStarts = new Map<LocalLlamaRole, { readonly options: ILocalLlamaStartOptions; readonly promise: Promise<ILocalLlamaServerState> }>();
	private readonly chatRequests = new Map<string, AbortController>();
	/** Options the chat server was last started with, to restart it the same way after a crash. */
	private lastChatOptions: ILocalLlamaStartOptions | undefined;
	/** When the chat model last died unexpectedly (crash or hang), for the crash-loop guard. */
	private readonly chatCrashes: number[] = [];
	/** Per model file: a smaller context forced by running out of memory, valid while the configured size stays the same. */
	private readonly contextOverrides = new Map<string, { readonly requested: number; readonly context: number }>();
	private installing: Promise<ILocalLlamaEngine> | undefined;

	constructor(
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
		@IProductService private readonly productService: IProductService,
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(lifecycleMainService.onWillShutdown(() => this.killAll()));

		// Keep-alive: unload models nobody has used for a while, like Ollama does.
		const sweep = setInterval(() => this.unloadIdle(), 60 * 1000);
		this._register(toDisposable(() => clearInterval(sweep)));
	}

	private unloadIdle(): void {
		const now = Date.now();
		for (const [role, server] of this.servers) {
			const minutes = server.options.keepAliveMinutes ?? 0;
			if (minutes > 0 && !server.options.share && server.state.status === LocalLlamaServerStatus.Ready && now - server.lastUsed > minutes * 60 * 1000) {
				this.logService.info(`[LocalLlama] unloading idle ${role} model after ${minutes} minutes`);
				this.kill(role);
			}
		}
	}

	override dispose(): void {
		this.killAll();
		super.dispose();
	}

	// ---- Engine ----------------------------------------------------------------

	private get engineRoot(): string {
		return join(this.environmentMainService.userHome.fsPath, this.productService.dataFolderName, 'llama.cpp', LLAMA_CPP_BUILD);
	}

	async resolveEngine(serverPath?: string): Promise<ILocalLlamaEngine | undefined> {
		if (serverPath) {
			if (await isExecutable(serverPath)) {
				return { path: serverPath, source: 'setting' };
			}
			throw new Error(`llama-server not found or not executable at ${serverPath}`);
		}

		const managed = await findFile(this.engineRoot, SERVER_EXECUTABLE, 3);
		if (managed) {
			return { path: managed, source: 'managed' };
		}

		const dirs = [...(process.env.PATH ?? '').split(delimiter), ...EXTRA_SEARCH_DIRS];
		for (const dir of dirs) {
			if (dir && await isExecutable(join(dir, SERVER_EXECUTABLE))) {
				return { path: join(dir, SERVER_EXECUTABLE), source: 'path' };
			}
		}
		return undefined;
	}

	installEngine(): Promise<ILocalLlamaEngine> {
		if (!this.installing) {
			this.installing = this.doInstallEngine().finally(() => this.installing = undefined);
		}
		return this.installing;
	}

	private async doInstallEngine(): Promise<ILocalLlamaEngine> {
		const asset = LLAMA_CPP_ASSETS[`${process.platform}-${process.arch}`];
		if (!asset) {
			throw new Error(`No prebuilt llama.cpp for ${process.platform}-${process.arch}. Install llama.cpp yourself and set hivemindide.localModels.serverPath.`);
		}

		const root = this.engineRoot;
		const staging = `${root}.partial`;
		const archive = join(dirname(root), asset.name);
		await fs.rm(staging, { recursive: true, force: true });
		await fs.mkdir(staging, { recursive: true });

		try {
			const url = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_BUILD}/${asset.name}`;
			this.logService.info(`[LocalLlama] downloading ${url}`);
			const digest = await this.download(url, archive);
			if (digest !== asset.sha256) {
				throw new Error(`llama.cpp download failed verification (sha256 ${digest}, expected ${asset.sha256}).`);
			}

			if (asset.name.endsWith('.zip')) {
				await extract(archive, staging, { overwrite: true }, CancellationToken.None);
			} else {
				await run('tar', ['-xzf', archive, '-C', staging]);
			}

			await fs.rm(root, { recursive: true, force: true });
			await fs.rename(staging, root);
		} finally {
			await fs.rm(staging, { recursive: true, force: true });
			await fs.rm(archive, { force: true });
		}

		const path = await findFile(root, SERVER_EXECUTABLE, 3);
		if (!path) {
			throw new Error(`The llama.cpp ${LLAMA_CPP_BUILD} archive did not contain ${SERVER_EXECUTABLE}.`);
		}
		this.logService.info(`[LocalLlama] installed ${path}`);
		return { path, source: 'managed' };
	}

	/** Streams `url` to `target`, reporting progress, and returns the sha256 of what was written. */
	private async download(url: string, target: string): Promise<string> {
		const response = await net.fetch(url);
		if (!response.ok || !response.body) {
			throw new Error(`Downloading llama.cpp failed: HTTP ${response.status}`);
		}
		const totalBytes = Number(response.headers.get('content-length')) || 0;
		const hash = createHash('sha256');
		const out = createWriteStream(target);
		let receivedBytes = 0;
		let lastReport = 0;
		try {
			const reader = response.body.getReader();
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				hash.update(value);
				if (!out.write(value)) {
					await new Promise<void>(resolve => out.once('drain', () => resolve()));
				}
				receivedBytes += value.byteLength;
				if (receivedBytes - lastReport > 256 * 1024) {
					lastReport = receivedBytes;
					this._onDidInstallProgress.fire({ receivedBytes, totalBytes });
				}
			}
		} finally {
			await new Promise<void>(resolve => out.end(() => resolve()));
		}
		this._onDidInstallProgress.fire({ receivedBytes, totalBytes: totalBytes || receivedBytes });
		return hash.digest('hex');
	}

	// ---- Servers -----------------------------------------------------------------

	async getServerState(role: LocalLlamaRole): Promise<ILocalLlamaServerState> {
		return this.servers.get(role)?.state ?? this.lastStates.get(role) ?? { role, status: LocalLlamaServerStatus.Stopped };
	}

	startServer(role: LocalLlamaRole, options: ILocalLlamaStartOptions): Promise<ILocalLlamaServerState> {
		// Concurrent callers asking for the same thing share one start.
		const pending = this.pendingStarts.get(role);
		if (pending && sameOptions(pending.options, options)) {
			return pending.promise;
		}
		const promise = this.doStartServer(role, options).finally(() => {
			if (this.pendingStarts.get(role)?.promise === promise) {
				this.pendingStarts.delete(role);
			}
		});
		this.pendingStarts.set(role, { options, promise });
		return promise;
	}

	private async doStartServer(role: LocalLlamaRole, options: ILocalLlamaStartOptions): Promise<ILocalLlamaServerState> {
		const existing = this.servers.get(role);
		if (existing && sameOptions(existing.options, options) && existing.state.status !== LocalLlamaServerStatus.Error) {
			return existing.ready;
		}
		if (existing) {
			this.kill(role);
		}

		if (!await exists(options.modelPath)) {
			throw new Error(`Model file not found: ${options.modelPath}`);
		}
		const engine = await this.resolveEngine(options.serverPath);
		if (!engine) {
			throw new Error('The llama.cpp engine is not installed.');
		}

		if (role === 'chat') {
			this.lastChatOptions = options;
			const context = this.effectiveContext(options);
			return this.launch(role, options, engine, context > 0 ? ['--ctx-size', String(context)] : []);
		}

		// Embedding models declare their pooling in GGUF metadata; models that do
		// not (pooling "none") are rejected by the OpenAI-style endpoint, so probe
		// once and fall back to mean pooling.
		const state = await this.launch(role, options, engine, ['--embedding']);
		try {
			await this.embed(['probe']);
			return state;
		} catch (err) {
			if (!/pooling/i.test(err instanceof Error ? err.message : String(err))) {
				throw err;
			}
			this.logService.info('[LocalLlama] embedding model has no pooling type; restarting with --pooling mean');
			this.kill(role);
			return this.launch(role, options, engine, ['--embedding', '--pooling', 'mean']);
		}
	}

	private async launch(role: LocalLlamaRole, options: ILocalLlamaStartOptions, engine: ILocalLlamaEngine, roleArgs: string[]): Promise<ILocalLlamaServerState> {
		// Sharing binds every interface on the user's port with the user's key;
		// otherwise loopback only, a random port, and a key nobody else sees.
		const share = role === 'chat' ? options.share : undefined;
		const port = share?.port ?? await findFreePortFaster(39000 + Math.floor(Math.random() * 2000), 100, 3000);
		if (!port) {
			throw new Error('No free local port for llama-server.');
		}
		const apiKey = share?.apiKey ?? generateUuid();
		const args = [
			'--model', options.modelPath,
			'--host', share ? '0.0.0.0' : '127.0.0.1',
			'--port', String(port),
			'--api-key', apiKey,
			// Unset GPU layers let llama.cpp's --fit (on by default) offload only what fits.
			...(options.gpuLayers >= 0 ? ['--n-gpu-layers', String(options.gpuLayers)] : []),
			'--parallel', '1',
			'--no-webui',
			...hardwareArgs(options),
			...roleArgs,
		];

		this.logService.info(`[LocalLlama] starting ${role} server: ${engine.path} ${args.filter(a => a !== apiKey).join(' ')}`);
		const child = spawn(engine.path, args, { cwd: dirname(engine.path), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

		const server: IRunningServer = {
			process: child,
			port,
			apiKey,
			options,
			stderrTail: [],
			state: { role, status: LocalLlamaServerStatus.Starting, modelPath: options.modelPath },
			ready: Promise.resolve(undefined!),
			lastUsed: Date.now(),
			exited: new Promise<string>(resolve => {
				child.once('error', err => resolve(err.message));
				child.once('exit', (code, signal) => resolve(signal ? `llama-server was killed (${signal})` : `llama-server exited with code ${code}`));
			}),
		};
		this.servers.set(role, server);
		this.setState(server, server.state);

		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (data: string) => {
			for (const line of data.split('\n')) {
				if (line.trim()) {
					server.stderrTail.push(line);
				}
			}
			server.stderrTail.splice(0, Math.max(0, server.stderrTail.length - 40));
		});

		const exited = server.exited;
		exited.then(reason => {
			if (this.servers.get(role) !== server) {
				return; // replaced or stopped on purpose
			}
			this.servers.delete(role);
			if (role === 'chat') {
				this.chatCrashes.push(Date.now());
				this.reduceContextIfOutOfMemory(server);
			}
			const detail = errorLines(server.stderrTail);
			this.setState(server, { role, status: LocalLlamaServerStatus.Error, modelPath: options.modelPath, error: detail ? `${reason}\n${detail}` : reason });
		});

		server.ready = this.waitUntilReady(server, exited);
		return server.ready;
	}

	private async waitUntilReady(server: IRunningServer, exited: Promise<string>): Promise<ILocalLlamaServerState> {
		const deadline = Date.now() + STARTUP_TIMEOUT_MS;
		let exitReason: string | undefined;
		exited.then(reason => exitReason = reason);

		while (Date.now() < deadline) {
			if (exitReason !== undefined) {
				throw new Error(this.describeFailure(server, exitReason));
			}
			if (this.servers.get(server.state.role) !== server) {
				throw new Error('llama-server was stopped before it finished loading.');
			}
			try {
				const res = await fetch(`http://127.0.0.1:${server.port}/health`, { headers: { Authorization: `Bearer ${server.apiKey}` } });
				if (res.ok) {
					const contextSize = await this.readContextSize(server);
					const reducedForMemory = server.state.role === 'chat' && this.contextOverride(server.options) !== undefined;
					const state: ILocalLlamaServerState = { role: server.state.role, status: LocalLlamaServerStatus.Ready, modelPath: server.options.modelPath, contextSize, reducedForMemory };
					this.setState(server, state);
					return state;
				}
			} catch {
				// not listening yet
			}
			await new Promise(resolve => setTimeout(resolve, 300));
		}

		this.kill(server.state.role);
		throw new Error('llama-server did not become ready within 5 minutes.');
	}

	private async readContextSize(server: IRunningServer): Promise<number | undefined> {
		try {
			const res = await fetch(`http://127.0.0.1:${server.port}/props`, { headers: { Authorization: `Bearer ${server.apiKey}` } });
			const props = await res.json() as { default_generation_settings?: { n_ctx?: number } };
			return props.default_generation_settings?.n_ctx ?? server.options.contextSize;
		} catch {
			return server.options.contextSize;
		}
	}

	private describeFailure(server: IRunningServer, reason: string): string {
		const tail = errorLines(server.stderrTail);
		return tail ? `${reason}\n${tail}` : reason;
	}

	async stopServer(role: LocalLlamaRole): Promise<void> {
		this.kill(role);
	}

	private kill(role: LocalLlamaRole): void {
		const server = this.servers.get(role);
		if (!server) {
			return;
		}
		this.servers.delete(role);
		server.stoppedOnPurpose = true;
		server.process.kill();
		// A hung process (stuck in a GPU driver, or frozen) never acts on SIGTERM
		// and would keep holding the model's memory; force it after a grace period.
		const force = setTimeout(() => server.process.kill('SIGKILL'), KILL_GRACE_MS);
		server.exited.then(() => clearTimeout(force));
		this.setState(server, { role, status: LocalLlamaServerStatus.Stopped });
	}

	private killAll(): void {
		for (const role of [...this.servers.keys()]) {
			this.kill(role);
		}
		for (const controller of this.chatRequests.values()) {
			controller.abort();
		}
		this.chatRequests.clear();
	}

	private setState(server: IRunningServer, state: ILocalLlamaServerState): void {
		server.state = state;
		this.lastStates.set(state.role, state);
		this._onDidChangeServerState.fire(state);
	}

	private readyServer(role: LocalLlamaRole): IRunningServer {
		const server = this.servers.get(role);
		if (!server || server.state.status !== LocalLlamaServerStatus.Ready) {
			throw new Error(role === 'chat' ? 'The local chat model is not running.' : 'The local embedding model is not running.');
		}
		return server;
	}

	// ---- Inference ---------------------------------------------------------------

	/**
	 * Streams an answer. If the local model crashes or hangs part-way, it is
	 * restarted and asked to continue its own partial answer (llama.cpp prefills
	 * a trailing assistant message), so the caller sees one uninterrupted
	 * answer with a notice in between rather than an error.
	 */
	async chat(requestId: string, messages: readonly ILocalLlamaMessage[], options: ILocalLlamaChatOptions): Promise<void> {
		const cancel = new AbortController();
		this.chatRequests.set(requestId, cancel);
		// A conversation ending in an assistant message asks to continue that
		// answer (the caller resuming a cut-off reply). Treat it exactly like an
		// automatic resume: the text is already on screen, only new text is sent.
		const last = messages[messages.length - 1];
		const prefill = last?.role === 'assistant' ? last.content : '';
		if (prefill) {
			messages = messages.slice(0, -1);
		}
		const progress = { answer: prefill, thinkingShown: false };
		let restarts = 0;
		try {
			while (true) {
				const outcome = await this.streamAttempt(requestId, messages, options, progress, cancel.signal);
				if (outcome.kind !== 'interrupted') {
					break;
				}
				if (options.remote) {
					throw new Error(`Lost the connection to the remote server (${remoteBaseUrl(options.remote.url)}): ${outcome.reason}`);
				}
				const refusal = this.restartRefusal(restarts);
				if (refusal) {
					throw new Error(`${refusal}\n\n${outcome.reason}`);
				}
				restarts++;
				this.logService.warn(`[LocalLlama] chat model interrupted (${outcome.reason}); restarting, attempt ${restarts}`);
				const reduced = this.lastChatOptions && this.contextOverride(this.lastChatOptions);
				this._onDidChatChunk.fire({
					requestId,
					notice: reduced
						? `The model ran out of memory. Restarting it with a smaller context (${reduced} tokens)…`
						: progress.answer
							? 'The model stopped unexpectedly. Restarting it and continuing where it left off…'
							: 'The model stopped unexpectedly. Restarting it…',
				});
				await this.restartChatServer();
				if (cancel.signal.aborted) {
					break;
				}
			}
			this._onDidChatChunk.fire({ requestId, done: true });
		} catch (err) {
			if (cancel.signal.aborted) {
				this._onDidChatChunk.fire({ requestId, done: true });
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			this._onDidChatChunk.fire({ requestId, done: true, error: message });
			throw err;
		} finally {
			this.chatRequests.delete(requestId);
		}
	}

	/** One request to the model. Resumes from `progress.answer` when it is not empty. */
	private async streamAttempt(requestId: string, messages: readonly ILocalLlamaMessage[], options: ILocalLlamaChatOptions, progress: { answer: string; thinkingShown: boolean }, cancel: AbortSignal): Promise<AttemptOutcome> {
		const server = options.remote ? undefined : this.servers.get('chat');
		let endpoint: IEndpoint;
		try {
			endpoint = this.endpoint('chat', options.remote);
		} catch (err) {
			// The model died between requests; that is recoverable the same way.
			return { kind: 'interrupted', reason: err instanceof Error ? err.message : String(err) };
		}

		// Watchdog: a model that stops producing tokens is as dead as one that exited.
		const stall = new AbortController();
		let stalledAfter: number | undefined;
		let watchdog: ReturnType<typeof setTimeout> | undefined;
		const arm = (ms: number) => {
			clearTimeout(watchdog);
			watchdog = setTimeout(() => {
				stalledAfter = ms;
				stall.abort();
			}, ms);
		};
		arm(FIRST_TOKEN_TIMEOUT_MS);

		const resuming = progress.answer.length > 0;
		const echo = new EchoFilter(progress.answer);
		const cleaner = new MarkerCleaner();
		let finished = false;
		try {
			const res = await fetch(`${endpoint.baseUrl}/v1/chat/completions`, {
				method: 'POST',
				signal: AbortSignal.any([cancel, stall.signal]),
				headers: authHeaders(endpoint),
				body: JSON.stringify({
					model: endpoint.model,
					messages: resuming ? [...messages, { role: 'assistant', content: progress.answer }] : messages,
					stream: true,
					temperature: options.temperature ?? 0.2,
					max_tokens: options.maxTokens,
					cache_prompt: true,
				}),
			});
			if (!res.ok || !res.body) {
				throw new Error(`The model server returned HTTP ${res.status}: ${await res.text().catch(() => '')}`);
			}

			const decoder = new TextDecoder();
			const reader = res.body.getReader();
			let buffer = '';
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				let newline: number;
				while ((newline = buffer.indexOf('\n')) >= 0) {
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					if (!line.startsWith('data:')) {
						continue;
					}
					const data = line.slice(5).trim();
					if (data === '[DONE]') {
						finished = true;
						continue;
					}
					const event = JSON.parse(data) as { choices?: { delta?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string | null }[]; error?: { message?: string } };
					if (event.error) {
						throw new Error(event.error.message ?? 'The model server reported an error.');
					}
					const choice = event.choices?.[0];
					if (choice?.finish_reason) {
						finished = true;
					}
					arm(TOKEN_GAP_TIMEOUT_MS);
					if (server) {
						server.lastUsed = Date.now(); // a long answer is activity, not idleness
					}
					const text = choice?.delta?.content ? cleaner.push(echo.push(choice.delta.content)) : '';
					// Reasoning already shown is not repeated when a resumed request re-thinks.
					const thinking = choice?.delta?.reasoning_content && !(resuming && progress.thinkingShown) ? choice.delta.reasoning_content : undefined;
					if (text || thinking) {
						progress.answer += text;
						progress.thinkingShown ||= !!thinking;
						this._onDidChatChunk.fire({ requestId, text: text || undefined, thinking });
					}
				}
			}
		} catch (err) {
			if (cancel.aborted) {
				return { kind: 'cancelled' };
			}
			if (stalledAfter !== undefined) {
				return this.onStalled(stalledAfter);
			}
			const died = await this.diedDuring(server);
			if (died) {
				return { kind: 'interrupted', reason: died };
			}
			if (options.remote && !(err instanceof Error && err.message.startsWith('The model server'))) {
				return { kind: 'interrupted', reason: err instanceof Error ? err.message : String(err) };
			}
			throw err;
		} finally {
			clearTimeout(watchdog);
		}

		// Whatever was held back as a possible marker turned out to be text.
		const rest = cleaner.flush();
		if (rest) {
			progress.answer += rest;
			this._onDidChatChunk.fire({ requestId, text: rest });
		}

		// A stream that ends without a finish marker was cut, not completed.
		if (!finished) {
			const died = await this.diedDuring(server);
			if (died || options.remote) {
				return { kind: 'interrupted', reason: died ?? 'The connection closed before the answer finished.' };
			}
		}
		return { kind: 'done' };
	}

	/** Why a local server a request was using went away, or undefined if it is still running. */
	private async diedDuring(server: IRunningServer | undefined): Promise<string | undefined> {
		if (!server) {
			return undefined;
		}
		// The exit event can land just after the socket error; give it a moment.
		const reason = await Promise.race([server.exited, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 1000))]);
		if (reason === undefined) {
			return undefined;
		}
		if (server.stoppedOnPurpose) {
			throw new Error('The model was stopped while it was answering.');
		}
		const tail = errorLines(server.stderrTail);
		return tail ? `${reason}\n${tail}` : reason;
	}

	private onStalled(afterMs: number): AttemptOutcome {
		const server = this.servers.get('chat');
		this.chatCrashes.push(Date.now());
		this.kill('chat');
		if (server) {
			// kill() marks it as a deliberate stop; this one is a failure.
			server.stoppedOnPurpose = false;
		}
		return { kind: 'interrupted', reason: `The model produced nothing for ${Math.round(afterMs / 1000)} seconds and was restarted.` };
	}

	/** The context to start a chat model with: the configured one, unless it ran out of memory before. */
	private effectiveContext(options: ILocalLlamaStartOptions): number {
		return this.contextOverride(options) ?? options.contextSize;
	}

	/** A smaller context forced by an earlier out-of-memory crash, while the configured size is unchanged. */
	private contextOverride(options: ILocalLlamaStartOptions): number | undefined {
		const override = this.contextOverrides.get(options.modelPath);
		return override && override.requested === options.contextSize ? override.context : undefined;
	}

	/**
	 * After a crash that llama.cpp itself reports as a failed allocation, halve
	 * the context for that model so the automatic restart has a chance. Only
	 * explicit allocation errors count: a bare SIGKILL has too many causes.
	 */
	private reduceContextIfOutOfMemory(server: IRunningServer): void {
		if (!server.stderrTail.some(line => OUT_OF_MEMORY.test(line))) {
			return;
		}
		const loaded = server.state.contextSize ?? this.effectiveContext(server.options) ?? 0;
		const current = loaded > 0 ? loaded : 8192;
		const reduced = Math.max(MIN_CONTEXT_AFTER_OOM, Math.floor(current / 2));
		if (reduced >= current) {
			return;
		}
		this.contextOverrides.set(server.options.modelPath, { requested: server.options.contextSize, context: reduced });
		this.logService.warn(`[LocalLlama] chat model ran out of memory; context reduced from ${current} to ${reduced} tokens`);
	}

	/** Undefined when another automatic restart is reasonable; otherwise what to tell the user. */
	private restartRefusal(restartsSoFar: number): string | undefined {
		if (!this.lastChatOptions) {
			return 'The model stopped unexpectedly.';
		}
		if (restartsSoFar >= MAX_RESTARTS_PER_ANSWER) {
			return `The model stopped again after ${restartsSoFar} restarts, so HivemindIDE gave up on this answer.`;
		}
		const since = Date.now() - CRASH_LOOP_WINDOW_MS;
		const recent = this.chatCrashes.filter(t => t >= since);
		this.chatCrashes.splice(0, this.chatCrashes.length, ...recent);
		if (recent.length >= CRASH_LOOP_LIMIT) {
			return `The model has stopped ${recent.length} times in the last ${CRASH_LOOP_WINDOW_MS / 60000} minutes. It may not fit in memory: try a smaller context size or fewer GPU layers in Local AI settings.`;
		}
		return undefined;
	}

	private async restartChatServer(): Promise<void> {
		const options = this.lastChatOptions;
		if (!options) {
			throw new Error('The model stopped unexpectedly.');
		}
		await this.startServer('chat', options);
	}

	async cancelChat(requestId: string): Promise<void> {
		this.chatRequests.get(requestId)?.abort();
	}

	async embed(texts: readonly string[], remote?: ILocalLlamaRemote): Promise<number[][]> {
		if (texts.length === 0) {
			return [];
		}
		const endpoint = this.endpoint('embedding', remote);
		const res = await fetch(`${endpoint.baseUrl}/v1/embeddings`, {
			method: 'POST',
			headers: authHeaders(endpoint),
			body: JSON.stringify({ model: endpoint.model, input: texts }),
		});
		if (!res.ok) {
			throw new Error(`Embeddings request returned HTTP ${res.status}: ${await res.text().catch(() => '')}`);
		}
		const body = await res.json() as { data: { index: number; embedding: number[] }[] };
		return body.data
			.sort((a, b) => a.index - b.index)
			.map(d => normalize(d.embedding));
	}

	/** Resolves where a request goes, and marks a local server as recently used. */
	private endpoint(role: LocalLlamaRole, remote: ILocalLlamaRemote | undefined): IEndpoint {
		if (remote) {
			return { baseUrl: remoteBaseUrl(remote.url), apiKey: remote.apiKey, model: remote.model };
		}
		const server = this.readyServer(role);
		server.lastUsed = Date.now();
		return { baseUrl: `http://127.0.0.1:${server.port}`, apiKey: server.apiKey };
	}

	// ---- Hardware and network ------------------------------------------------------

	async listDevices(serverPath?: string): Promise<ILocalLlamaDevice[]> {
		const engine = await this.resolveEngine(serverPath);
		if (!engine) {
			return [];
		}
		const output = await new Promise<string>((resolve, reject) => {
			const child = spawn(engine.path, ['--list-devices'], { cwd: dirname(engine.path), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
			let text = '';
			child.stdout?.on('data', d => text += d);
			child.stderr?.on('data', d => text += d);
			child.once('error', reject);
			child.once('exit', () => resolve(text));
		});
		const devices: ILocalLlamaDevice[] = [];
		for (const line of output.split('\n')) {
			// "  MTL0: Apple M3 (12124 MiB, 12123 MiB free)"
			const match = /^\s+(\S+): (.+?) \((\d+) MiB, (\d+) MiB free\)\s*$/.exec(line);
			// CPU-side backends (BLAS, CPU) report no memory and are not offload targets.
			if (match && Number(match[3]) > 0) {
				devices.push({ id: match[1], name: match[2], totalMiB: Number(match[3]), freeMiB: Number(match[4]) });
			}
		}
		return devices;
	}

	async listRemoteModels(url: string, apiKey?: string): Promise<string[]> {
		const res = await fetch(`${remoteBaseUrl(url)}/v1/models`, { headers: authHeaders({ baseUrl: url, apiKey }), signal: AbortSignal.timeout(10_000) });
		if (!res.ok) {
			throw new Error(res.status === 401 ? 'The remote server rejected the API key.' : `The remote server returned HTTP ${res.status}.`);
		}
		const body = await res.json() as { data?: { id: string }[] };
		return (body.data ?? []).map(m => m.id);
	}

	async getNetworkAddresses(): Promise<string[]> {
		const addresses: string[] = [];
		for (const infos of Object.values(networkInterfaces())) {
			for (const info of infos ?? []) {
				if (info.family === 'IPv4' && !info.internal) {
					addresses.push(info.address);
				}
			}
		}
		return addresses;
	}
}

/**
 * The lines of llama-server's log worth showing a person: errors only. Warnings
 * are mostly about quirks in the model file, and the info level is chatter. llama.cpp prefixes each line with a timestamp and a
 * level letter (`0.00.716 E ...`).
 */
function errorLines(tail: readonly string[]): string {
	return tail
		.filter(line => /^\s*[\d.]+\s+E\s/.test(line) || /\berror\b|failed|out of memory|unable to allocate/i.test(line))
		.slice(-3)
		.map(line => line.replace(/^\s*[\d.]+\s+[EWI]\s+/, ''))
		.join('\n');
}

function sameOptions(a: ILocalLlamaStartOptions, b: ILocalLlamaStartOptions): boolean {
	// keepAliveMinutes only affects unloading, so changing it must not restart a loaded model.
	return JSON.stringify({ ...a, keepAliveMinutes: undefined }) === JSON.stringify({ ...b, keepAliveMinutes: undefined });
}

function hardwareArgs(options: ILocalLlamaStartOptions): string[] {
	const args: string[] = [];
	if (options.devices?.length) {
		args.push('--device', options.devices.join(','));
	}
	if (options.splitMode) {
		args.push('--split-mode', options.splitMode);
	}
	if (options.mainGpu) {
		args.push('--main-gpu', String(options.mainGpu));
	}
	if (options.tensorSplit?.trim()) {
		args.push('--tensor-split', options.tensorSplit.trim());
	}
	if (options.threads && options.threads > 0) {
		args.push('--threads', String(options.threads));
	}
	if (options.flashAttention) {
		args.push('--flash-attn', options.flashAttention);
	}
	return args;
}

/** Accepts `http://host:port`, with or without a trailing `/` or `/v1`. */
function remoteBaseUrl(url: string): string {
	return url.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

function authHeaders(endpoint: IEndpoint): Record<string, string> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (endpoint.apiKey) {
		headers.Authorization = `Bearer ${endpoint.apiKey}`;
	}
	return headers;
}

function normalize(vector: number[]): number[] {
	let norm = 0;
	for (const v of vector) {
		norm += v * v;
	}
	norm = Math.sqrt(norm) || 1;
	return vector.map(v => v / norm);
}

async function exists(path: string): Promise<boolean> {
	try {
		await fs.access(path);
		return true;
	} catch {
		return false;
	}
}

async function isExecutable(path: string): Promise<boolean> {
	try {
		const stat = await fs.stat(path);
		if (!stat.isFile()) {
			return false;
		}
		await fs.access(path, isWindows ? fs.constants.F_OK : fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function findFile(root: string, name: string, depth: number): Promise<string | undefined> {
	let entries;
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch {
		return undefined;
	}
	for (const entry of entries) {
		if (entry.isFile() && entry.name === name) {
			return join(root, name);
		}
	}
	if (depth > 0) {
		for (const entry of entries) {
			if (entry.isDirectory()) {
				const found = await findFile(join(root, entry.name), name, depth - 1);
				if (found) {
					return found;
				}
			}
		}
	}
	return undefined;
}

function run(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
		let stderr = '';
		child.stderr?.on('data', d => stderr += d);
		child.once('error', reject);
		child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`)));
	});
}

/**
 * llama.cpp echoes a prefilled assistant message at the start of its response.
 * When resuming, hold back output while it still matches the text already
 * delivered, then pass through only what is new. If the server does not echo,
 * the held text is released unchanged.
 */
class EchoFilter {

	private pending = '';
	private decided: boolean;

	constructor(private readonly prefix: string) {
		this.decided = prefix.length === 0;
	}

	push(delta: string): string {
		if (this.decided) {
			return delta;
		}
		this.pending += delta;
		if (this.prefix.startsWith(this.pending)) {
			if (this.pending.length === this.prefix.length) {
				this.decided = true;
				this.pending = '';
			}
			return '';
		}
		this.decided = true;
		const out = this.pending.startsWith(this.prefix) ? this.pending.slice(this.prefix.length) : this.pending;
		this.pending = '';
		return out;
	}
}

/**
 * Removes end-of-turn markers some GGUF chat templates leak as text. A marker
 * can arrive split across chunks, so a trailing `<…` that could still grow
 * into one is held back until the next chunk (or the end) decides it.
 */
class MarkerCleaner {

	private pending = '';

	push(delta: string): string {
		const text = (this.pending + delta).replace(LEAKED_SPECIAL_TOKENS, '');
		const partial = PARTIAL_SPECIAL_TOKEN.exec(text);
		if (partial && partial[0].length <= 16) {
			this.pending = partial[0];
			return text.slice(0, partial.index);
		}
		this.pending = '';
		return text;
	}

	flush(): string {
		const rest = this.pending.replace(LEAKED_SPECIAL_TOKENS, '');
		this.pending = '';
		return rest;
	}
}
