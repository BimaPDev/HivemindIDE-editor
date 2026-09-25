/*---------------------------------------------------------------------------------------------
 *  Agent spawn tree — shared types, view IDs, and demo detail payloads.
 *
 *  Root node combines author + parent AI + model. Children are sub-agents.
 *  Clicking a node opens AgentDetailEditor (pipeline · meta · activity · diff).
 *--------------------------------------------------------------------------------------------*/

export const HIVEMINDIDE_VIEWLET_ID = 'workbench.view.hivemindide';
export const HIVEMINDIDE_AGENT_TREE_VIEW_ID = 'workbench.view.hivemindide.agentTree';

export type AgentNodeKind = 'root' | 'agent';
export type AgentNodeStatus = 'active' | 'idle' | 'done';

export type AgentPipelineStage =
	| 'requested'
	| 'provisioning'
	| 'running'
	| 'checking'
	| 'rechecking'
	| 'applying'
	| 'auto-merged';

export const AGENT_PIPELINE_STAGES: readonly AgentPipelineStage[] = [
	'requested',
	'provisioning',
	'running',
	'checking',
	'rechecking',
	'applying',
	'auto-merged',
];

export interface IAgentTreeNode {
	readonly id: string;
	readonly kind: AgentNodeKind;
	/**
	 * Whose AI this is — the human session owner in a shared IDE.
	 * Required on every node (root and nested sub-agents) so teammates can tell
	 * agents apart when several people are running at once.
	 */
	readonly author: string;
	readonly label: string;
	/** Short model name only (sonnet-4, gpt-5). Never a provider URL. */
	readonly model: string | null;
	readonly status: AgentNodeStatus;
	readonly children: readonly IAgentTreeNode[];
}

export interface IAgentTree {
	readonly run_id: string;
	readonly root: IAgentTreeNode;
}

export interface IAgentDetailMeta {
	readonly from: string;
	readonly createdBy: string;
	readonly paidBy?: string;
	readonly model: string;
	readonly permission: string;
	readonly base: string;
	readonly worktree: string;
	readonly changes: string;
}

export interface IAgentActivityItem {
	readonly kind: 'subagent' | 'note';
	readonly text: string;
}

export interface IAgentCheck {
	readonly command: string;
	readonly status: 'pending' | 'passed' | 'failed';
}

export interface IAgentDiffLine {
	readonly type: 'add' | 'del' | 'ctx';
	readonly text: string;
}

export interface IAgentDiffFile {
	readonly path: string;
	readonly lines: readonly IAgentDiffLine[];
}

export interface IAgentDetailFooter {
	readonly text: string;
}

export interface IAgentDetail {
	readonly nodeId: string;
	readonly runId: string;
	readonly title: string;
	readonly subtitle: string;
	readonly pipelineStage: AgentPipelineStage;
	readonly meta: IAgentDetailMeta;
	readonly activity: readonly IAgentActivityItem[];
	/** Direct children this agent spawned — for nested drill-down in the detail pane. */
	readonly spawned: readonly IAgentSpawnedChild[];
	readonly checksPinnedBy?: string;
	readonly checks: readonly IAgentCheck[];
	readonly diff?: {
		readonly summary: string;
		readonly file: IAgentDiffFile;
	};
	readonly footers: readonly IAgentDetailFooter[];
}

export interface IAgentSpawnedChild {
	readonly id: string;
	readonly author: string;
	readonly label: string;
	readonly model: string | null;
	readonly status: AgentNodeStatus;
	readonly childCount: number;
}

/** Demo trees shown until coordinationd emits agent.* frames. */
export function createDemoTrees(): IAgentTree[] {
	return [
		{
			run_id: 'run-demo-1',
			root: {
				id: 'run-root',
				kind: 'root',
				author: 'Bima',
				label: 'Hivemind',
				model: 'sonnet-4',
				status: 'active',
				children: [
					{ id: 'a1', kind: 'agent', author: 'Bima', label: 'Explore', model: 'haiku', status: 'active', children: [] },
					{
						id: 'a2', kind: 'agent', author: 'Bima', label: 'Edit', model: 'sonnet-4', status: 'idle', children: [
							{
								id: 'a2a', kind: 'agent', author: 'Bima', label: 'Tests', model: 'haiku', status: 'active', children: [
									{ id: 'a2a1', kind: 'agent', author: 'Bima', label: 'Fix flake', model: 'haiku', status: 'active', children: [] },
								]
							},
						]
					},
					{ id: 'a3', kind: 'agent', author: 'Bima', label: 'Review', model: 'opus', status: 'done', children: [] },
				],
			},
		},
		{
			run_id: 'run-demo-2',
			root: {
				id: 'run-root',
				kind: 'root',
				author: 'Dani',
				label: 'Hivemind',
				model: 'gpt-5',
				status: 'active',
				children: [
					{ id: 'b1', kind: 'agent', author: 'Dani', label: 'Search', model: 'kimi-k2', status: 'active', children: [] },
					{ id: 'b2', kind: 'agent', author: 'Dani', label: 'Patch', model: 'gpt-5', status: 'active', children: [] },
				],
			},
		},
		{
			run_id: 'run-demo-3',
			root: {
				id: 'run-root',
				kind: 'root',
				author: 'Bima',
				label: 'Hivemind',
				model: 'sonnet-4',
				status: 'active',
				children: [
					// Shared IDE: Dani's sub-agent can appear under a run Bima started
					// only if policy allows — demo shows both owners on the tree.
					{ id: 'c1', kind: 'agent', author: 'Bima', label: 'Docs', model: 'haiku', status: 'idle', children: [] },
					{ id: 'c2', kind: 'agent', author: 'Dani', label: 'Lint', model: 'haiku', status: 'active', children: [] },
				],
			},
		},
	];
}

/** Resolve a detail page for a clicked tree node (demo + live fallback). */
export function resolveAgentDetail(tree: IAgentTree, nodeId: string): IAgentDetail | undefined {
	const node = findNode(tree.root, nodeId);
	if (!node) {
		return undefined;
	}
	const spawned = toSpawned(node);
	const demo = DEMO_DETAILS[`${tree.run_id}:${nodeId}`] ?? DEMO_DETAILS[nodeId];
	if (demo) {
		return { ...demo, nodeId, runId: tree.run_id, spawned };
	}
	return buildFallbackDetail(tree, node, spawned);
}

function toSpawned(node: IAgentTreeNode): IAgentSpawnedChild[] {
	return node.children.map(c => ({
		id: c.id,
		author: c.author,
		label: c.label,
		model: c.model,
		status: c.status,
		childCount: countDescendants(c),
	}));
}

function countDescendants(node: IAgentTreeNode): number {
	let n = node.children.length;
	for (const c of node.children) {
		n += countDescendants(c);
	}
	return n;
}

function findNode(node: IAgentTreeNode, id: string): IAgentTreeNode | undefined {
	if (node.id === id) {
		return node;
	}
	for (const child of node.children) {
		const found = findNode(child, id);
		if (found) {
			return found;
		}
	}
	return undefined;
}

function buildFallbackDetail(tree: IAgentTree, node: IAgentTreeNode, spawned: readonly IAgentSpawnedChild[]): IAgentDetail {
	const author = node.author;
	const model = node.model ?? tree.root.model ?? 'unknown';
	const isRoot = node.kind === 'root';
	return {
		nodeId: node.id,
		runId: tree.run_id,
		title: isRoot ? author : node.label,
		subtitle: isRoot
			? `${node.label}'s AI · model ${model}`
			: `${author}'s AI · ${node.label} · model ${model}`,
		pipelineStage: node.status === 'done' ? 'checking' : node.status === 'idle' ? 'provisioning' : 'running',
		meta: {
			from: isRoot ? 'the composer' : tree.root.label,
			createdBy: author,
			model,
			permission: 'Request (inherited)',
			base: 'rev —',
			worktree: isRoot ? 'parent' : `child/${node.label.toLowerCase()}`,
			changes: '—',
		},
		activity: node.children.map(c => ({
			kind: 'subagent' as const,
			text: `${c.author}'s ${c.label}${c.model ? ` · ${c.model}` : ''} · ${c.status}`,
		})),
		spawned,
		checks: [],
		footers: [
			{ text: node.status === 'done' ? 'waiting for a human to review' : 'in progress' },
			{ text: 'parent workspace unchanged' },
		],
	};
}

const DEMO_DETAILS: Record<string, Omit<IAgentDetail, 'nodeId' | 'runId' | 'spawned'>> = {
	'run-root': {
		title: 'Bima',
		subtitle: 'Spawned from the composer, pinned to rev 47.',
		pipelineStage: 'requested',
		meta: {
			from: 'the composer',
			createdBy: 'Bima',
			paidBy: "Bima's subscription",
			model: 'sonnet-4',
			permission: 'Request (inherited)',
			base: 'rev 47',
			worktree: 'child/asd',
			changes: '+74 −5',
		},
		activity: [
			{ kind: 'subagent', text: 'Cloned the parent into an isolated worktree. Reading the target range and its call sites.' },
			{ kind: 'subagent', text: 'Wrote the change in the sandbox and ran it once locally.' },
			{ kind: 'subagent', text: 'Finished with a reviewable diff. Nothing was applied to the parent.' },
		],
		checksPinnedBy: 'Owner',
		checks: [
			{ command: 'npm run typecheck', status: 'pending' },
			{ command: 'npm test -- tests/lobby', status: 'pending' },
		],
		diff: {
			summary: '+74 −5 · rev 47',
			file: {
				path: 'tests/lobby/expired_ticket.test.ts',
				lines: [
					{ type: 'add', text: "import { joinLobby } from '../../src/lobby';" },
					{ type: 'add', text: "import { fakeClock } from '../helpers/clock';" },
					{ type: 'add', text: "import { lobbyFixture } from '../helpers/lobby';" },
					{ type: 'ctx', text: '' },
					{ type: 'add', text: "test('an expired ticket cannot rejoin a dead lobby', async () => {" },
					{ type: 'add', text: "  fakeClock.set('2026-03-01T12:00:00Z');" },
					{ type: 'add', text: '  const lobby = lobbyFixture.dead();' },
					{ type: 'add', text: "  const refusal = await joinLobby(lobby, { ticket: 't_expired' });" },
					{ type: 'add', text: "  expect(refusal).toBe('ticket_expired');" },
					{ type: 'add', text: '});' },
				],
			},
		},
		footers: [
			{ text: 'waiting for a human to review' },
			{ text: 'parent workspace unchanged' },
		],
	},
	'a1': {
		title: 'Explore',
		subtitle: 'Sub-agent of Hivemind · reading call sites before edit.',
		pipelineStage: 'running',
		meta: {
			from: 'Hivemind',
			createdBy: 'Bima',
			model: 'haiku',
			permission: 'Request (inherited)',
			base: 'rev 47',
			worktree: 'child/explore',
			changes: '+0 −0',
		},
		activity: [
			{ kind: 'subagent', text: 'Mapped imports of the target symbol across src/ and tests/.' },
			{ kind: 'subagent', text: 'Queued findings for the Edit sub-agent.' },
		],
		checks: [],
		footers: [
			{ text: 'gathering context' },
			{ text: 'parent workspace unchanged' },
		],
	},
	'a2': {
		title: 'Edit',
		subtitle: 'Sub-agent of Hivemind · writing the change in the sandbox.',
		pipelineStage: 'provisioning',
		meta: {
			from: 'Hivemind',
			createdBy: 'Bima',
			model: 'sonnet-4',
			permission: 'Request (inherited)',
			base: 'rev 47',
			worktree: 'child/edit',
			changes: '+74 −5',
		},
		activity: [
			{ kind: 'subagent', text: 'Applied the patch in the isolated worktree.' },
			{ kind: 'subagent', text: 'Spawned Tests to verify the lobby ticket expiry path.' },
		],
		checksPinnedBy: 'Owner',
		checks: [
			{ command: 'npm run typecheck', status: 'pending' },
		],
		diff: {
			summary: '+74 −5 · rev 47',
			file: {
				path: 'tests/lobby/expired_ticket.test.ts',
				lines: [
					{ type: 'add', text: "test('an expired ticket cannot rejoin a dead lobby', async () => {" },
					{ type: 'add', text: "  expect(refusal).toBe('ticket_expired');" },
					{ type: 'add', text: '});' },
				],
			},
		},
		footers: [
			{ text: 'waiting for tests' },
			{ text: 'parent workspace unchanged' },
		],
	},
	'a2a': {
		title: 'Tests',
		subtitle: 'Sub-agent of Edit · running the lobby suite.',
		pipelineStage: 'checking',
		meta: {
			from: 'Edit',
			createdBy: 'Bima',
			model: 'haiku',
			permission: 'Request (inherited)',
			base: 'rev 47',
			worktree: 'child/edit',
			changes: '+74 −5',
		},
		activity: [
			{ kind: 'subagent', text: 'Scheduled npm test -- tests/lobby in the sandbox.' },
			{ kind: 'subagent', text: 'Spawned Fix flake after a timing failure in expired_ticket.' },
		],
		checksPinnedBy: 'Owner',
		checks: [
			{ command: 'npm test -- tests/lobby', status: 'pending' },
		],
		footers: [
			{ text: 'checks running' },
			{ text: 'parent workspace unchanged' },
		],
	},
	'a2a1': {
		title: 'Fix flake',
		subtitle: 'Sub-agent of Tests · stabilizing the expiry assertion.',
		pipelineStage: 'running',
		meta: {
			from: 'Tests',
			createdBy: 'Bima',
			model: 'haiku',
			permission: 'Request (inherited)',
			base: 'rev 47',
			worktree: 'child/edit',
			changes: '+3 −1',
		},
		activity: [
			{ kind: 'subagent', text: 'Rewrote the fakeClock setup so the ticket expires before joinLobby.' },
		],
		checks: [
			{ command: 'npm test -- tests/lobby/expired_ticket.test.ts', status: 'pending' },
		],
		footers: [
			{ text: 'nested sub-agent' },
			{ text: 'parent workspace unchanged' },
		],
	},
	'a3': {
		title: 'Review',
		subtitle: 'Sub-agent of Hivemind · finished review, awaiting human.',
		pipelineStage: 'checking',
		meta: {
			from: 'Hivemind',
			createdBy: 'Bima',
			model: 'opus',
			permission: 'Request (inherited)',
			base: 'rev 47',
			worktree: 'child/review',
			changes: '+74 −5',
		},
		activity: [
			{ kind: 'subagent', text: 'Reviewed the candidate diff against the ticket-expiry contract.' },
			{ kind: 'subagent', text: 'No apply to parent — left for human review.' },
		],
		checks: [
			{ command: 'npm run typecheck', status: 'passed' },
			{ command: 'npm test -- tests/lobby', status: 'pending' },
		],
		footers: [
			{ text: 'waiting for a human to review' },
			{ text: 'parent workspace unchanged' },
		],
	},
};

// Aliases so demo run-2 / run-3 nodes also open rich pages.
DEMO_DETAILS['run-demo-1:run-root'] = DEMO_DETAILS['run-root'];
DEMO_DETAILS['run-demo-2:run-root'] = {
	...DEMO_DETAILS['run-root'],
	title: 'Dani',
	meta: { ...DEMO_DETAILS['run-root'].meta, createdBy: 'Dani', paidBy: "Dani's subscription", model: 'gpt-5' },
};
DEMO_DETAILS['b1'] = {
	...DEMO_DETAILS['a1'],
	title: 'Search',
	meta: { ...DEMO_DETAILS['a1'].meta, model: 'kimi-k2', worktree: 'child/search', createdBy: 'Dani' },
};
DEMO_DETAILS['b2'] = {
	...DEMO_DETAILS['a2'],
	title: 'Patch',
	meta: { ...DEMO_DETAILS['a2'].meta, model: 'gpt-5', worktree: 'child/patch', createdBy: 'Dani' },
};
DEMO_DETAILS['c1'] = {
	...DEMO_DETAILS['a1'],
	title: 'Docs',
	pipelineStage: 'provisioning',
	meta: { ...DEMO_DETAILS['a1'].meta, model: 'haiku', worktree: 'child/docs', createdBy: 'Bima' },
};
DEMO_DETAILS['c2'] = {
	title: 'Lint',
	subtitle: "Dani's AI · nested under Bima's run in the shared IDE.",
	pipelineStage: 'running',
	meta: {
		from: 'Hivemind',
		createdBy: 'Dani',
		model: 'haiku',
		permission: 'Request (inherited)',
		base: 'rev 47',
		worktree: 'child/lint',
		changes: '+2 −0',
	},
	activity: [
		{ kind: 'subagent', text: "Running Dani's lint pass on the shared worktree." },
	],
	checks: [],
	footers: [
		{ text: "Dani's AI" },
		{ text: 'parent workspace unchanged' },
	],
};


export function isAgentTree(value: unknown): value is IAgentTree {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const v = value as Record<string, unknown>;
	return typeof v.run_id === 'string' && isAgentTreeNode(v.root);
}

function isAgentTreeNode(value: unknown): value is IAgentTreeNode {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const v = value as Record<string, unknown>;
	return (v.kind === 'root' || v.kind === 'agent')
		&& typeof v.id === 'string'
		&& typeof v.author === 'string'
		&& typeof v.label === 'string'
		&& Array.isArray(v.children);
}

export function pipelineStageLabel(stage: AgentPipelineStage): string {
	switch (stage) {
		case 'requested': return 'Requested';
		case 'provisioning': return 'Provisioning';
		case 'running': return 'Running';
		case 'checking': return 'Checking';
		case 'rechecking': return 'Rechecking';
		case 'applying': return 'Applying';
		case 'auto-merged': return 'Auto-merged';
	}
}
