/*---------------------------------------------------------------------------------------------
 *  HivemindIDE local models: the Chat panel's default agent.
 *
 *  With Copilot stripped there is no default chat participant, so the panel's
 *  "Build with Agent" view has nothing behind it. This agent takes that place:
 *  it assembles the prompt (attachments, relevant workspace code, history),
 *  sends it to the selected local model, and streams the answer back.
 *
 *  A request that asks to spawn sub-agents creates a child node per task and
 *  runs each one. The graph shows "running" only while a model call is in flight.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { isLocation, Location } from '../../../../../editor/common/languages.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { LocalLlamaServerStatus } from '../../../../../platform/hivemindide/common/localLlama.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IChatProgress } from '../../../chat/common/chatService/chatService.js';
import { ChatMessageRole, IChatMessage, ILanguageModelsService } from '../../../chat/common/languageModels.js';
import { IChatAgentHistoryEntry, IChatAgentImplementation, IChatAgentRequest, IChatAgentResult } from '../../../chat/common/participants/chatAgents.js';
import { HivemindIDESettings } from '../../common/hivemindideConfiguration.js';
import { HivemindService, IHivemindNode, IHivemindService } from '../hivemind/hivemindService.js';
import { isLocalModelIdentifier, LOCAL_MODELS_VENDOR, LOCAL_NOTICE_MIME_TYPE, localMaxOutputTokens, localModelIdentifier } from './localLanguageModelProvider.js';
import { ILocalModel, ILocalModelsService } from './localModelsService.js';
import { IRetrievedChunk, tokenize, WorkspaceIndex } from './workspaceIndex.js';

export const LOCAL_CHAT_AGENT_ID = 'hivemindide.local';
export const LOCAL_MODELS_ADD_COMMAND_ID = 'hivemindide.localModels.addModel';

const CHARS_PER_TOKEN = 4;
/** Share of the input budget that attachments and workspace snippets may use; the rest is history. */
const CONTEXT_SHARE = 0.6;
const MAX_ATTACHMENT_CHARS = 60_000;
const MIN_SNIPPET_CHARS = 1500;
/** Messages with fewer searchable words than this are follow-ups that borrow the previous turn's topic. */
const FOLLOW_UP_MAX_TERMS = 4;
/** Short messages that point back at the previous turn rather than naming a new topic. */
const FOLLOW_UP_CUE = /\b(continue|go on|keep going|carry on|finish|the rest|more|again|elaborate|expand|why|what about|and then|next)\b/i;
const FOLLOW_UP_MAX_WORDS = 12;
/** A message that only asks to carry on with the previous answer. */
const CONTINUE_REQUEST = /^\s*(please\s+)?(continue|go on|keep going|carry on|resume|finish)\b/i;
/** Automatically attached instruction files (AGENTS.md, CLAUDE.md, …) are capped so they cannot starve the prompt. */
const MAX_AUTOMATIC_CHARS = 2000;

const MAX_SUBAGENTS = 4;

const SYSTEM_PROMPT = [
	'You are HivemindIDE\'s coding assistant. You run locally on the user\'s machine through llama.cpp; nothing is sent to a remote service.',
	'Answer in Markdown and keep answers focused. Put code in fenced blocks with a language tag.',
	'Workspace snippets and attachments are given in <context> blocks. Use them when they are relevant and cite them as `path:line`.',
	'If the context does not contain what you need, say so rather than guessing at code you have not seen.',
	'A `.hivemind` block, when present, describes earlier work on this project by people and other AIs; use it to pick up where they left off.',
].join('\n');

const HIVEMIND_AGENT_NAME = 'HivemindIDE Local AI';
const MAX_CONTINUED_NODE_CHARS = 6000;
const MAX_HIVEMIND_CONTEXT_CHARS = 2500;

interface IContextBlock {
	readonly label: string;
	readonly text: string;
	/** Added by the chat UI rather than by the user. */
	readonly automatic?: boolean;
}

export class LocalChatAgent extends Disposable implements IChatAgentImplementation {

	constructor(
		private readonly workspaceIndex: WorkspaceIndex,
		@ILocalModelsService private readonly localModelsService: ILocalModelsService,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileService private readonly fileService: IFileService,
		@ILabelService private readonly labelService: ILabelService,
		@ILogService private readonly logService: ILogService,
		@IHivemindService private readonly hivemindService: IHivemindService,
	) {
		super();
	}

	async invoke(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult> {
		const model = isLocalModelIdentifier(request.userSelectedModelId)
			? this.localModelsService.getModel(request.userSelectedModelId.slice(request.userSelectedModelId.indexOf('/') + 1))
			: this.localModelsService.chatModel;

		if (!model) {
			progress([{
				kind: 'markdownContent',
				content: new MarkdownString(localize('localChat.noModel', "No local model yet. [Add a .gguf model]({0}) to chat with it here. It runs on this machine with llama.cpp.", `command:${LOCAL_MODELS_ADD_COMMAND_ID}`), { isTrusted: { enabledCommands: [LOCAL_MODELS_ADD_COMMAND_ID] } }),
			}]);
			return {};
		}

		// Kept outside the try so a failed answer is still recorded in the hivemind.
		let question = request.message;
		let answerText = '';
		let continuedFrom: string | undefined;
		let runNodeId: string | undefined;
		const usedFiles: URI[] = [];
		try {
			const chatState = this.localModelsService.getServerState('chat');
			if (!model.remote && (chatState.modelPath !== model.path || chatState.status !== LocalLlamaServerStatus.Ready)) {
				progress([{ kind: 'progressMessage', content: new MarkdownString(localize('localChat.loading', "Loading {0}…", model.name)) }]);
			}
			const state = await this.localModelsService.ensureChatServer(model);
			if (token.isCancellationRequested) {
				return {};
			}

			const contextTokens = state.contextSize ?? this.localModelsService.contextSize;
			const inputBudgetChars = Math.max(2000, (contextTokens - localMaxOutputTokens(contextTokens)) * CHARS_PER_TOKEN - SYSTEM_PROMPT.length);
			const contextBudgetChars = Math.floor(inputBudgetChars * CONTEXT_SHARE);

			// "continue" after an answer that was cut off resumes that answer exactly
			// (the model is handed its own partial reply to carry on from) instead of
			// starting a new one — asked from scratch, a small model tends to
			// "continue" whatever text sits in front of it, like the context blocks.
			// "/continue <node>" picks up a hivemind node, possibly left by another AI or person.
			const continuation = request.command === 'continue' ? await this.prepareContinuation(request.message, progress) : undefined;
			if (request.command === 'continue' && !continuation) {
				return {}; // it listed the nodes to choose from
			}
			continuedFrom = continuation?.parent.id;

			const resume = continuation ? undefined : this.cutOffAnswerToResume(request.message, history);
			question = continuation?.question ?? resume?.question ?? request.message;
			const sessionNode = await this.ensureSessionNode(request, question, model.name, continuedFrom);
			runNodeId = sessionNode?.id;
			if (runNodeId) {
				this.hivemindService.setRunning(runNodeId, true);
			}
			const earlierTurns = resume ? history.slice(0, -1) : history;

			const attachments = resume ? [] : await this.readAttachments(request, progress, usedFiles);
			if (continuation) {
				attachments.unshift(continuation.block);
			}
			const hivemindBlock = await this.hivemindContext(request.sessionResource.toString(), continuation?.parent.id);
			if (hivemindBlock) {
				attachments.push(hivemindBlock);
			}
			const searchFor = continuation ? `${continuation.parent.title}\n${continuation.parent.goal}\n${continuation.parent.handoff}\n${continuation.question}` : resume ? resume.question : this.searchQuery(request.message, history);
			const snippets = await this.retrieve(searchFor, progress, token);
			const { text: contextText, snippetCount } = this.formatContext(attachments, snippets.map(s => this.snippetBlock(s)), contextBudgetChars);
			this.logService.trace(`[LocalModels] prompt: ${contextBudgetChars} context chars; attachments ${attachments.map(a => `${a.label} (${a.text.length})`).join(', ') || 'none'}; ${snippetCount} of ${snippets.length} snippets`);
			// Only snippets that made it into the prompt are shown as references.
			for (const chunk of snippets.slice(0, snippetCount)) {
				usedFiles.push(chunk.uri);
				progress([{
					kind: 'reference',
					reference: { uri: chunk.uri, range: { startLineNumber: chunk.startLine, startColumn: 1, endLineNumber: chunk.endLine, endColumn: 1 } },
				}]);
			}

			const userMessage = contextText ? `${contextText}\n\n${question}` : question;
			if (sessionNode && wantsSubagents(question) && !continuation) {
				answerText = await this.spawnSubagents(model, question, sessionNode, progress, token);
			} else {
				const messages: IChatMessage[] = [
					textMessage(ChatMessageRole.System, request.modeInstructions?.content ? `${SYSTEM_PROMPT}\n\n${request.modeInstructions.content}` : SYSTEM_PROMPT),
					...this.historyMessages(earlierTurns, inputBudgetChars - userMessage.length - (resume?.partialAnswer.length ?? 0)),
					textMessage(ChatMessageRole.User, userMessage),
				];
				if (resume?.partialAnswer) {
					// A trailing assistant message is continued rather than answered.
					messages.push(textMessage(ChatMessageRole.Assistant, resume.partialAnswer));
					progress([{ kind: 'markdownContent', content: new MarkdownString('…') }]);
				}

				// Resolving is a no-op once the vendor's models are cached, and a model
				// added moments ago would otherwise be unknown to the service.
				await this.languageModelsService.selectLanguageModels({ vendor: LOCAL_MODELS_VENDOR, id: model.id });
				const response = await this.languageModelsService.sendChatRequest(localModelIdentifier(model.id), undefined, messages, {}, token);
				let answerStarted = false;
				// A resumed answer starts mid-sentence after "…". Markdown will not start
				// a list numbered past 1 (or most other blocks) straight after paragraph
				// text, so break after the first resumed line to let the rest render.
				let breakAfterFirstLine = !!resume?.partialAnswer;
				for await (const part of response.stream) {
					for (const item of Array.isArray(part) ? part : [part]) {
						if (item.type === 'text' && item.value) {
							answerStarted = true;
							answerText += item.value;
							let text = item.value;
							if (breakAfterFirstLine && text.includes('\n')) {
								text = text.replace('\n', '\n\n');
								breakAfterFirstLine = false;
							}
							progress([{ kind: 'markdownContent', content: new MarkdownString(text) }]);
						} else if (item.type === 'thinking' && item.value) {
							progress([{ kind: 'thinking', value: item.value }]);
						} else if (item.type === 'data' && item.mimeType === LOCAL_NOTICE_MIME_TYPE && !answerStarted) {
							// Only before the answer starts: the chat view folds any answer text
							// that precedes a progress message into its collapsed "steps" group,
							// which would hide the first half of a resumed answer. Mid-answer
							// restarts show in the status bar instead, and the text just resumes.
							progress([{ kind: 'progressMessage', content: new MarkdownString(item.data.toString()) }]);
						}
					}
				}
				await response.result;
			}
			await this.recordInHivemind(request, question, answerText, usedFiles, model.name, continuedFrom, token.isCancellationRequested);
			return {};
		} catch (err) {
			if (token.isCancellationRequested) {
				return {};
			}
			this.logService.error('[LocalModels] chat request failed', err);
			await this.recordInHivemind(request, question, answerText, usedFiles, model.name, continuedFrom, true);
			return { errorDetails: { message: err instanceof Error ? err.message : String(err) } };
		} finally {
			if (runNodeId) {
				this.hivemindService.setRunning(runNodeId, false);
			}
		}
	}

	/** The chat's node, created on the first token so the graph can show it running before the answer exists. */
	private async ensureSessionNode(request: IChatAgentRequest, question: string, model: string, parent: string | undefined): Promise<IHivemindNode | undefined> {
		if (!this.hivemindService.folder) {
			return undefined;
		}
		const session = request.sessionResource.toString();
		const existing = this.hivemindService.findByChatSession(session);
		if (existing) {
			return existing;
		}
		const parentNode = parent ? this.hivemindService.getNode(parent) : undefined;
		return this.hivemindService.createNode({
			title: parentNode ? `Continue: ${parentNode.title}` : question.split('\n')[0],
			goal: question.slice(0, 1000),
			agent: HIVEMIND_AGENT_NAME,
			model,
			parent,
			chatSession: session,
		});
	}

	/**
	 * One child node per task, run one after another (one local server). Each child
	 * is "running" only during its own call, and shows up on the graph as it starts.
	 */
	private async spawnSubagents(model: ILocalModel, question: string, parent: IHivemindNode, progress: (parts: IChatProgress[]) => void, token: CancellationToken): Promise<string> {
		progress([{ kind: 'progressMessage', content: new MarkdownString(localize('localChat.planningAgents', "Planning sub-agents…")) }]);
		let tasks: string[] = [];
		try {
			const plan = await this.complete(model, [
				textMessage(ChatMessageRole.System, 'Split the request into 2 to 4 independent tasks. Reply with one task per line, each line starting with "- ". No other text.'),
				textMessage(ChatMessageRole.User, question),
			], token);
			tasks = parseTasks(plan).slice(0, MAX_SUBAGENTS);
		} catch (err) {
			this.logService.warn('[LocalModels] could not plan sub-agents', err);
		}
		if (tasks.length < 2) {
			const brief = oneLine(question).slice(0, 180);
			tasks = [
				`Work out the approach: ${brief}`,
				`Produce the result: ${brief}`,
			];
		}
		progress([{
			kind: 'markdownContent',
			content: new MarkdownString(`${localize('localChat.spawning', "Spawning {0} agents.", tasks.length)}\n\n${tasks.map(task => `- ${task}`).join('\n')}\n\n`),
		}]);

		const parts: string[] = [];
		for (let i = 0; i < tasks.length; i++) {
			if (token.isCancellationRequested) {
				break;
			}
			const task = tasks[i];
			const child = await this.hivemindService.createNode({
				title: task,
				goal: task,
				agent: HIVEMIND_AGENT_NAME,
				model: model.name,
				parent: parent.id,
			});
			if (!child) {
				continue;
			}
			this.hivemindService.setRunning(child.id, true);
			progress([{ kind: 'progressMessage', content: new MarkdownString(localize('localChat.agentN', "Agent {0} of {1}: {2}", i + 1, tasks.length, task)) }]);
			let answer = '';
			try {
				answer = await this.complete(model, [
					textMessage(ChatMessageRole.System, 'You are a sub-agent. Do this task and nothing else. Reply with the result.'),
					textMessage(ChatMessageRole.User, task),
				], token);
				await this.hivemindService.recordTurn(child.id, {
					question: task,
					answer,
					files: [],
					model: model.name,
					interrupted: token.isCancellationRequested,
				});
			} finally {
				this.hivemindService.setRunning(child.id, false);
			}
			const section = `## ${task}\n\n${answer}`;
			parts.push(section);
			progress([{ kind: 'markdownContent', content: new MarkdownString(`${section}\n\n`) }]);
		}
		return parts.join('\n\n');
	}

	/** One completion, collected into a string. Does not record a hivemind turn. */
	private async complete(model: ILocalModel, messages: IChatMessage[], token: CancellationToken): Promise<string> {
		await this.languageModelsService.selectLanguageModels({ vendor: LOCAL_MODELS_VENDOR, id: model.id });
		const response = await this.languageModelsService.sendChatRequest(localModelIdentifier(model.id), undefined, messages, {}, token);
		let text = '';
		for await (const part of response.stream) {
			if (token.isCancellationRequested) {
				break;
			}
			for (const item of Array.isArray(part) ? part : [part]) {
				if (item.type === 'text' && item.value) {
					text += item.value;
				}
			}
		}
		await response.result;
		return text.trim();
	}

	private async readAttachments(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void, usedFiles: URI[]): Promise<IContextBlock[]> {
		const blocks: IContextBlock[] = [];
		for (const entry of request.variables.variables) {
			// The customizations index lists skills and agents for tool-using cloud
			// agents; a local model cannot act on it, and it is easily 15k+ characters.
			if ((entry.kind === 'implicit' && !entry.enabled) || entry.kind === 'promptText') {
				continue;
			}
			if (entry.kind === 'paste') {
				blocks.push({ label: entry.name, text: entry.code });
				continue;
			}
			const value = entry.value;
			if (typeof value === 'string') {
				blocks.push({ label: entry.name, text: value.slice(0, MAX_ATTACHMENT_CHARS) });
			} else if (URI.isUri(value) || isLocation(value)) {
				const block = await this.readResource(value);
				if (block) {
					const automatic = entry.kind === 'promptFile' && entry.automaticallyAdded;
					blocks.push(automatic ? { ...block, text: block.text.slice(0, MAX_AUTOMATIC_CHARS), automatic } : block);
					if (!automatic) {
						usedFiles.push(URI.isUri(value) ? value : value.uri);
					}
					progress([{ kind: 'reference', reference: value }]);
				}
			}
		}
		return blocks;
	}

	private async readResource(value: URI | Location): Promise<IContextBlock | undefined> {
		const uri = URI.isUri(value) ? value : value.uri;
		try {
			const lines = (await this.fileService.readFile(uri)).value.toString().split(/\r?\n/);
			const start = URI.isUri(value) ? 1 : value.range.startLineNumber;
			const end = URI.isUri(value) ? lines.length : value.range.endLineNumber;
			const text = lines.slice(start - 1, end).join('\n').slice(0, MAX_ATTACHMENT_CHARS);
			return { label: `${this.labelService.getUriLabel(uri, { relative: true })}:${start}`, text };
		} catch {
			return undefined; // folders and unreadable resources contribute nothing
		}
	}

	private async retrieve(query: string, progress: (parts: IChatProgress[]) => void, token: CancellationToken): Promise<IRetrievedChunk[]> {
		const limit = this.configurationService.getValue<number>(HivemindIDESettings.LocalModelsMaxContextChunks) ?? 6;
		if (!this.configurationService.getValue<boolean>(HivemindIDESettings.LocalModelsWorkspaceContext) || limit <= 0) {
			return [];
		}
		if (this.workspaceIndex.size === 0) {
			progress([{ kind: 'progressMessage', content: new MarkdownString(localize('localChat.indexing', "Indexing the workspace…")) }]);
		}
		return this.workspaceIndex.search(query, limit, token);
	}

	private snippetBlock(chunk: IRetrievedChunk): IContextBlock {
		return { label: `${this.labelService.getUriLabel(chunk.uri, { relative: true })}:${chunk.startLine}-${chunk.endLine}`, text: chunk.text };
	}

	/**
	 * Explicit attachments are kept whole while they fit. The rest of the budget
	 * goes to as many top-ranked snippets as can each get a useful share, split
	 * evenly so a long first snippet cannot crowd out the rest.
	 */
	private formatContext(attachments: IContextBlock[], snippets: IContextBlock[], budgetChars: number): { text: string; snippetCount: number } {
		const parts: string[] = [];
		let remaining = budgetChars;
		const add = (block: IContextBlock, room: number) => {
			const text = block.text.length > room ? `${block.text.slice(0, room)}\n…` : block.text;
			const formatted = `<context source="${block.label}">\n${text}\n</context>`;
			parts.push(formatted);
			remaining -= formatted.length;
		};

		// The user's own attachments first, then automatic instruction files.
		for (const block of [...attachments.filter(b => !b.automatic), ...attachments.filter(b => b.automatic)]) {
			if (remaining < 200) {
				break;
			}
			add(block, remaining - 100);
		}
		// A snippet cut to a few hundred characters is mostly imports; better to
		// send fewer top-ranked snippets that each carry real code.
		const count = Math.max(0, Math.min(snippets.length, Math.floor(remaining / MIN_SNIPPET_CHARS)));
		for (let i = 0; i < count; i++) {
			add(snippets[i], Math.floor(remaining / (count - i)) - 100);
		}
		return { text: parts.join('\n'), snippetCount: count };
	}

	/**
	 * Loads the node named by `/continue <id> [question]`. When the id is
	 * missing or unknown, lists recent nodes to pick from and returns undefined.
	 */
	private async prepareContinuation(message: string, progress: (parts: IChatProgress[]) => void): Promise<{ parent: IHivemindNode; question: string; block: IContextBlock } | undefined> {
		const [id, ...rest] = message.replace(/^\s*\/continue\b/, '').trim().split(/\s+/);
		const parent = id ? this.hivemindService.getNode(id) : undefined;
		if (!parent) {
			const recent = this.hivemindService.nodes.slice(0, 8);
			const text = recent.length
				? `${localize('hivemind.continue.which', "Which node? Reply with `/continue <id>`, or use **Continue a Hivemind Node…** from the Command Palette.")}\n\n${recent.map(n => `- \`${n.id}\`: ${n.title} (${n.status}, ${n.author}, ${n.agent})`).join('\n')}`
				: localize('hivemind.continue.empty', "This project's hivemind has no nodes yet. They appear as you and other AIs work here.");
			progress([{ kind: 'markdownContent', content: new MarkdownString(text) }]);
			return undefined;
		}
		progress([{ kind: 'reference', reference: parent.uri }]);
		const full = await this.hivemindService.readNodeText(parent.id) ?? '';
		// Spelled out rather than "see the node": small models follow an explicit
		// goal and next step far better than an instruction to go find them.
		const question = rest.join(' ') || [
			`Continue this work, which ${parent.author}'s ${parent.agent} left ${parent.status === 'done' ? 'done' : 'unfinished'}.`,
			`Goal: ${oneLine(parent.goal)}`,
			`Where it stands: ${oneLine(parent.handoff)}`,
			'Do the next step now. Start with one sentence on what you are doing.',
		].join('\n');
		return {
			parent,
			question,
			block: { label: `.hivemind/nodes/${parent.id}.md`, text: full.slice(0, MAX_CONTINUED_NODE_CHARS) },
		};
	}

	/** Project notes and the latest nodes, so every answer starts from what others already did. */
	private async hivemindContext(session: string, exclude: string | undefined): Promise<IContextBlock | undefined> {
		if (!this.hivemindService.folder || this.configurationService.getValue<boolean>(HivemindIDESettings.HivemindIncludeInChat) === false) {
			return undefined;
		}
		const current = this.hivemindService.findByChatSession(session)?.id;
		const notes = await this.hivemindService.readProjectNotes();
		const recent = this.hivemindService.nodes.filter(n => n.id !== current && n.id !== exclude).slice(0, 5);
		if (!notes && recent.length === 0) {
			return undefined;
		}
		const parts: string[] = [];
		if (notes) {
			parts.push(`Project notes:\n${notes.slice(0, 1200)}`);
		}
		if (recent.length) {
			parts.push(`Recent work in this project, newest first:\n${recent.map(n => `- [${n.status}] ${n.title} (${n.author}, ${n.agent}, node ${n.id}): ${n.handoff.replace(/\s+/g, ' ').slice(0, 220)}`).join('\n')}`);
		}
		return { label: '.hivemind', text: parts.join('\n\n').slice(0, MAX_HIVEMIND_CONTEXT_CHARS), automatic: true };
	}

	/** Records the turn on this chat's node, creating the node on the first turn. Never fails the chat. */
	private async recordInHivemind(request: IChatAgentRequest, question: string, answer: string, files: readonly URI[], model: string, parent: string | undefined, interrupted: boolean): Promise<void> {
		const folder = this.hivemindService.folder;
		if (!folder) {
			return;
		}
		try {
			const session = request.sessionResource.toString();
			const parentNode = parent ? this.hivemindService.getNode(parent) : undefined;
			const node = this.hivemindService.findByChatSession(session) ?? await this.hivemindService.createNode({
				title: parentNode ? `Continue: ${parentNode.title}` : question.split('\n')[0],
				goal: question.slice(0, 1000),
				agent: HIVEMIND_AGENT_NAME,
				model,
				parent,
				chatSession: session,
			});
			if (node) {
				await this.hivemindService.recordTurn(node.id, {
					question,
					answer,
					files: [...new Set(files.map(f => HivemindService.relativeTo(folder, f)))],
					model,
					interrupted,
				});
			}
		} catch (err) {
			this.logService.warn('[Hivemind] could not record this turn', err);
		}
	}

	/**
	 * The cut-off answer to resume when `message` just asks to continue and the
	 * previous turn ended in an error. `partialAnswer` is empty when it failed
	 * before writing anything, in which case the question is asked again.
	 */
	private cutOffAnswerToResume(message: string, history: IChatAgentHistoryEntry[]): { question: string; partialAnswer: string } | undefined {
		const previous = history[history.length - 1];
		if (!previous?.result.errorDetails || !CONTINUE_REQUEST.test(message) || message.trim().split(/\s+/).length > FOLLOW_UP_MAX_WORDS) {
			return undefined;
		}
		// An answer that failed before producing any text is simply asked again.
		const partialAnswer = previous.response
			.map(part => part.kind === 'markdownContent' ? part.content.value : '')
			.join('');
		return { question: previous.request.message, partialAnswer: partialAnswer.trim() ? partialAnswer : '' };
	}

	/**
	 * What to search the workspace for. A short follow-up ("continue", "why?")
	 * has almost nothing to search on and pulls in unrelated code, so it borrows
	 * the previous question and the start of the previous answer.
	 */
	private searchQuery(message: string, history: IChatAgentHistoryEntry[]): string {
		const previous = history[history.length - 1];
		const isFollowUp = tokenize(message).length < FOLLOW_UP_MAX_TERMS
			|| (message.trim().split(/\s+/).length <= FOLLOW_UP_MAX_WORDS && FOLLOW_UP_CUE.test(message));
		if (!previous || !isFollowUp) {
			return message;
		}
		const previousAnswer = previous.response
			.map(part => part.kind === 'markdownContent' ? part.content.value : '')
			.join('')
			.slice(0, 500);
		return `${message}\n${previous.request.message}\n${previousAnswer}`;
	}

	/** Most recent turns first until the budget runs out, returned in chronological order. */
	private historyMessages(history: IChatAgentHistoryEntry[], budgetChars: number): IChatMessage[] {
		const messages: IChatMessage[] = [];
		let used = 0;
		for (let i = history.length - 1; i >= 0; i--) {
			const entry = history[i];
			let answer = entry.response
				.map(part => part.kind === 'markdownContent' ? part.content.value : '')
				.join('');
			if (entry.result.errorDetails) {
				// Tell the model the answer is incomplete, so "continue" means something to it.
				answer += '\n\n[This answer was cut off before it finished.]';
			}
			const cost = entry.request.message.length + answer.length;
			if (used + cost > budgetChars) {
				break;
			}
			used += cost;
			messages.unshift(textMessage(ChatMessageRole.User, entry.request.message), textMessage(ChatMessageRole.Assistant, answer));
		}
		return messages;
	}
}

function wantsSubagents(message: string): boolean {
	return /\b(spawn|sub-?agents?|multiple agents)\b/i.test(message);
}

function parseTasks(text: string): string[] {
	return text.split('\n')
		.map(line => /^\s*(?:[-*]|\d+[.)])\s+(\S.*)$/.exec(line)?.[1]?.trim())
		.filter((task): task is string => !!task && task.length > 2);
}

function textMessage(role: ChatMessageRole, value: string): IChatMessage {
	return { role, content: [{ type: 'text', value }] };
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}
