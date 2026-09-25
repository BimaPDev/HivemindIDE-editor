/*---------------------------------------------------------------------------------------------
 *  DOM renderer for the author+AI spawn tree + in-pane detail (no editor tab).
 *--------------------------------------------------------------------------------------------*/

import './media/agentDetail.css';
import { $, append, clearNode, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IAgentDetail, IAgentTree, IAgentTreeNode } from '../common/agentTree.js';
import { AgentDetailWidget } from './agentDetailWidget.js';

export type AgentTreeConnectionState = 'demo' | 'live' | 'connecting' | 'error' | 'empty';

export class AgentTreeWidget extends Disposable {

	private readonly root: HTMLElement;
	private readonly statusEl: HTMLElement;
	private readonly treePane: HTMLElement;
	private readonly scrollEl: HTMLElement;
	private readonly hostEl: HTMLElement;
	private readonly detailWidget: AgentDetailWidget;
	private readonly renderStore = this._register(new DisposableStore());
	private showingDetail = false;

	private readonly _onDidOpenNode = this._register(new Emitter<string>());
	readonly onDidOpenNode: Event<string> = this._onDidOpenNode.event;

	constructor(container: HTMLElement) {
		super();
		this.root = append(container, $('.hivemindide-agent-tree'));
		this.statusEl = append(this.root, $('.hivemindide-agent-tree-status'));
		this.treePane = append(this.root, $('.hivemindide-agent-tree-pane'));
		this.scrollEl = append(this.treePane, $('.hivemindide-agent-tree-scroll'));
		this.hostEl = append(this.scrollEl, $('.hivemindide-agent-tree-host'));
		this.detailWidget = this._register(new AgentDetailWidget(this.root));
		this._register(this.detailWidget.onDidBack(() => this.showTree()));
		this._register(this.detailWidget.onDidOpenChild(id => this._onDidOpenNode.fire(id)));
	}

	setConnectionState(state: AgentTreeConnectionState, detail?: string): void {
		this.statusEl.className = 'hivemindide-agent-tree-status';
		switch (state) {
			case 'live':
				this.statusEl.classList.add('live');
				this.statusEl.textContent = detail ?? 'Live · coordination stream';
				break;
			case 'demo':
				this.statusEl.classList.add('demo');
				this.statusEl.textContent = detail ?? 'Demo run · waiting for agent.spawned';
				break;
			case 'connecting':
				this.statusEl.classList.add('demo');
				this.statusEl.textContent = detail ?? 'Connecting…';
				break;
			case 'error':
				this.statusEl.classList.add('error');
				this.statusEl.textContent = detail ?? 'Stream unavailable';
				break;
			case 'empty':
				this.statusEl.classList.add('demo');
				this.statusEl.textContent = detail ?? 'No active agent run';
				break;
		}
	}

	render(tree: IAgentTree | undefined): void {
		if (this.showingDetail) {
			// Keep detail visible; tree host still updates underneath.
		} else {
			this.showTree();
		}
		this.renderStore.clear();
		clearNode(this.hostEl);
		if (!tree) {
			const empty = append(this.hostEl, $('.hivemindide-agent-tree-empty'));
			empty.textContent = 'No agent run to show.';
			return;
		}
		this.hostEl.appendChild(this.buildBranch(tree.root));
	}

	showDetail(detail: IAgentDetail): void {
		this.showingDetail = true;
		this.statusEl.style.display = 'none';
		this.treePane.style.display = 'none';
		this.detailWidget.show(detail);
	}

	showTree(): void {
		this.showingDetail = false;
		this.detailWidget.hide();
		this.statusEl.style.display = '';
		this.treePane.style.display = '';
	}

	layout(_height: number, _width: number): void {
		// Scroll containers fill the pane.
	}

	private buildBranch(node: IAgentTreeNode): HTMLElement {
		const branch = $('.hivemindide-agent-branch');
		branch.appendChild(this.buildCard(node));

		const kids = node.children;
		if (!kids.length) {
			return branch;
		}

		append(branch, $('.hivemindide-agent-edge'));
		append(branch, $('.hivemindide-agent-junction'));
		append(branch, $('.hivemindide-agent-edge'));

		const row = append(branch, $('.hivemindide-agent-children'));
		for (const child of kids) {
			row.appendChild(this.buildBranch(child));
		}

		requestAnimationFrame(() => this.trimChildBar(row));
		return branch;
	}

	private buildCard(node: IAgentTreeNode): HTMLElement {
		const card = $(`.hivemindide-agent-card.${node.kind}`);
		card.tabIndex = 0;
		card.setAttribute('role', 'button');
		card.title = 'Open agent detail';

		this.renderStore.add(addDisposableListener(card, EventType.CLICK, () => {
			this._onDidOpenNode.fire(node.id);
		}));
		this.renderStore.add(addDisposableListener(card, EventType.KEY_DOWN, e => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this._onDidOpenNode.fire(node.id);
			}
		}));

		if (node.author) {
			const author = append(card, $('.hivemindide-agent-author'));
			author.textContent = node.kind === 'root'
				? node.author
				: `${node.author}'s AI`;
		}

		const who = append(card, $('.hivemindide-agent-who'));
		const name = append(who, $('span'));
		name.textContent = node.label;
		const kindPill = append(who, $(`.hivemindide-agent-pill.kind-${node.kind}`));
		kindPill.textContent = node.kind === 'root' ? 'run' : 'sub';

		if (node.model) {
			const model = append(card, $('.hivemindide-agent-model'));
			model.appendChild(document.createTextNode('model '));
			const strong = append(model, $('strong'));
			strong.textContent = node.model;
		}

		const meta = append(card, $('.hivemindide-agent-meta'));
		const status = append(meta, $(`.hivemindide-agent-pill.${node.status}`));
		status.textContent = node.status;

		return card;
	}

	private trimChildBar(row: HTMLElement): void {
		const branches = Array.from(row.children) as HTMLElement[];
		if (branches.length < 2) {
			row.style.setProperty('--hivemindide-bar-left', '50%');
			row.style.setProperty('--hivemindide-bar-right', '50%');
			return;
		}
		const rowRect = row.getBoundingClientRect();
		const first = branches[0].getBoundingClientRect();
		const last = branches[branches.length - 1].getBoundingClientRect();
		const left = first.left + first.width / 2 - rowRect.left;
		const right = rowRect.right - (last.left + last.width / 2);
		row.style.setProperty('--hivemindide-bar-left', `${left}px`);
		row.style.setProperty('--hivemindide-bar-right', `${right}px`);
	}
}
