/*---------------------------------------------------------------------------------------------
 *  Shared agent detail body (pipeline · meta · activity · checks · diff).
 *  Used in-pane inside the Agents sidebar — no editor tab.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import {
	AGENT_PIPELINE_STAGES,
	AgentPipelineStage,
	IAgentDetail,
	pipelineStageLabel,
} from '../common/agentTree.js';

export class AgentDetailWidget extends Disposable {

	private readonly root: HTMLElement;
	private readonly renderStore = this._register(new DisposableStore());

	private readonly _onDidBack = this._register(new Emitter<void>());
	readonly onDidBack: Event<void> = this._onDidBack.event;

	private readonly _onDidOpenChild = this._register(new Emitter<string>());
	readonly onDidOpenChild: Event<string> = this._onDidOpenChild.event;

	constructor(container: HTMLElement) {
		super();
		this.root = append(container, $('.hivemindide-agent-detail.hivemindide-agent-detail-sidebar'));
		this.root.style.display = 'none';
	}

	get domNode(): HTMLElement {
		return this.root;
	}

	show(detail: IAgentDetail): void {
		this.root.style.display = '';
		this.render(detail);
	}

	hide(): void {
		this.root.style.display = 'none';
		this.renderStore.clear();
		clearNode(this.root);
	}

	private render(detail: IAgentDetail): void {
		this.renderStore.clear();
		clearNode(this.root);

		const back = append(this.root, $('button.hivemindide-agent-detail-back')) as HTMLButtonElement;
		back.type = 'button';
		back.textContent = localize('hivemindide.agentDetail.back', "← Agents");
		this.renderStore.add(addDisposableListener(back, EventType.CLICK, () => this._onDidBack.fire()));

		const layout = append(this.root, $('.hivemindide-agent-detail-layout'));
		layout.appendChild(this.buildRail(detail));
		layout.appendChild(this.buildMain(detail));
	}

	private buildRail(detail: IAgentDetail): HTMLElement {
		const rail = $('.hivemindide-agent-detail-rail');

		const stageHead = append(rail, $('.hivemindide-agent-detail-stage-head'));
		const stageTitle = append(stageHead, $('.hivemindide-agent-detail-stage-title'));
		stageTitle.textContent = pipelineStageLabel(detail.pipelineStage);
		const stageSub = append(stageHead, $('.hivemindide-agent-detail-stage-sub'));
		stageSub.textContent = stageSubtitle(detail.pipelineStage);

		const stepper = append(rail, $('.hivemindide-agent-detail-stepper'));
		const currentIdx = AGENT_PIPELINE_STAGES.indexOf(detail.pipelineStage);
		for (let i = 0; i < AGENT_PIPELINE_STAGES.length; i++) {
			const stage = AGENT_PIPELINE_STAGES[i];
			const row = append(stepper, $('.hivemindide-agent-detail-step'));
			if (i === currentIdx) {
				row.classList.add('current');
			} else if (i < currentIdx) {
				row.classList.add('done');
			}
			const dot = append(row, $('.hivemindide-agent-detail-step-dot'));
			if (i === currentIdx) {
				dot.classList.add('filled');
			}
			const label = append(row, $('span'));
			label.textContent = pipelineStageLabel(stage);
		}

		const meta = append(rail, $('.hivemindide-agent-detail-meta'));
		const rows: [string, string | undefined][] = [
			[localize('hivemindide.agentDetail.from', "From"), detail.meta.from],
			[localize('hivemindide.agentDetail.createdBy', "Created by"), detail.meta.createdBy],
			[localize('hivemindide.agentDetail.paidBy', "Paid by"), detail.meta.paidBy],
			[localize('hivemindide.agentDetail.model', "Model"), detail.meta.model],
			[localize('hivemindide.agentDetail.permission', "Permission"), detail.meta.permission],
			[localize('hivemindide.agentDetail.base', "Base"), detail.meta.base],
			[localize('hivemindide.agentDetail.worktree', "Worktree"), detail.meta.worktree],
			[localize('hivemindide.agentDetail.changes', "Changes"), detail.meta.changes],
		];
		for (const [key, value] of rows) {
			if (!value) {
				continue;
			}
			const row = append(meta, $('.hivemindide-agent-detail-meta-row'));
			const k = append(row, $('.hivemindide-agent-detail-meta-key'));
			k.textContent = key;
			const v = append(row, $('.hivemindide-agent-detail-meta-val'));
			v.textContent = value;
			if (key === localize('hivemindide.agentDetail.model', "Model") || key === localize('hivemindide.agentDetail.worktree', "Worktree")) {
				v.classList.add('mono');
			}
		}

		return rail;
	}

	private buildMain(detail: IAgentDetail): HTMLElement {
		const main = $('.hivemindide-agent-detail-main');

		const header = append(main, $('.hivemindide-agent-detail-header'));
		const badge = append(header, $('.hivemindide-agent-detail-badge'));
		badge.textContent = detail.title;
		const sub = append(header, $('.hivemindide-agent-detail-subtitle'));
		sub.textContent = detail.subtitle;

		if (detail.activity.length) {
			const list = append(main, $('.hivemindide-agent-detail-activity'));
			for (const item of detail.activity) {
				const row = append(list, $('.hivemindide-agent-detail-activity-row'));
				const icon = append(row, $('.hivemindide-agent-detail-activity-icon'));
				icon.textContent = '◫';
				const body = append(row, $('.hivemindide-agent-detail-activity-body'));
				if (item.kind === 'subagent') {
					const tag = append(body, $('strong'));
					tag.textContent = localize('hivemindide.agentDetail.subagent', "Subagent");
					body.appendChild(document.createTextNode(`: ${item.text}`));
				} else {
					body.textContent = item.text;
				}
			}
		}

		if (detail.spawned.length) {
			const spawned = append(main, $('.hivemindide-agent-detail-spawned'));
			const title = append(spawned, $('.hivemindide-agent-detail-section-title'));
			title.textContent = localize('hivemindide.agentDetail.spawned', "Spawned");
			for (const child of detail.spawned) {
				const row = append(spawned, $('button.hivemindide-agent-detail-spawned-row')) as HTMLButtonElement;
				row.type = 'button';
				const left = append(row, $('.left'));
				const owner = append(left, $('span.owner'));
				owner.textContent = `${child.author}'s AI`;
				const name = append(left, $('span.name'));
				name.textContent = child.label;
				const meta = append(row, $('span.meta'));
				const bits = [
					child.model ?? undefined,
					child.status,
					child.childCount > 0 ? localize('hivemindide.agentDetail.nestedCount', "{0} nested", child.childCount) : undefined,
				].filter(Boolean);
				meta.textContent = bits.join(' · ');
				this.renderStore.add(addDisposableListener(row, EventType.CLICK, () => {
					this._onDidOpenChild.fire(child.id);
				}));
			}
		}

		if (detail.checks.length) {
			const checks = append(main, $('.hivemindide-agent-detail-checks'));
			const title = append(checks, $('.hivemindide-agent-detail-section-title'));
			const mark = append(title, $('span.hivemindide-agent-detail-check-mark'));
			mark.textContent = '✓';
			title.appendChild(document.createTextNode(
				detail.checksPinnedBy
					? localize('hivemindide.agentDetail.checksPinned', "Checks pinned by the {0}", detail.checksPinnedBy)
					: localize('hivemindide.agentDetail.checks', "Checks")
			));
			for (const check of detail.checks) {
				const row = append(checks, $('.hivemindide-agent-detail-check-row'));
				const cmd = append(row, $('code'));
				cmd.textContent = check.command;
				const status = append(row, $(`.hivemindide-agent-detail-check-status.${check.status}`));
				status.textContent = check.status;
			}
		}

		if (detail.diff) {
			const diff = append(main, $('.hivemindide-agent-detail-diff'));
			const title = append(diff, $('.hivemindide-agent-detail-section-title'));
			title.textContent = localize('hivemindide.agentDetail.candidateDiff', "Candidate diff");
			const summary = append(title, $('span.hivemindide-agent-detail-diff-summary'));
			summary.textContent = ` ${detail.diff.summary}`;

			const file = append(diff, $('.hivemindide-agent-detail-diff-file'));
			const path = append(file, $('.hivemindide-agent-detail-diff-path'));
			path.textContent = detail.diff.file.path;
			const code = append(file, $('.hivemindide-agent-detail-diff-code'));
			for (const line of detail.diff.file.lines) {
				const row = append(code, $(`.hivemindide-agent-detail-diff-line.${line.type}`));
				const prefix = append(row, $('span.prefix'));
				prefix.textContent = line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' ';
				row.appendChild(document.createTextNode(line.text));
			}
		}

		if (detail.footers.length) {
			const foot = append(main, $('.hivemindide-agent-detail-footers'));
			for (const f of detail.footers) {
				const pill = append(foot, $('.hivemindide-agent-detail-footer-pill'));
				pill.textContent = f.text;
			}
		}

		return main;
	}
}

function stageSubtitle(stage: AgentPipelineStage): string {
	switch (stage) {
		case 'requested': return localize('hivemindide.agentDetail.waitingProvision', "Waiting to provision.");
		case 'provisioning': return localize('hivemindide.agentDetail.provisioning', "Setting up the worktree.");
		case 'running': return localize('hivemindide.agentDetail.running', "Agent is working.");
		case 'checking': return localize('hivemindide.agentDetail.checking', "Running pinned checks.");
		case 'rechecking': return localize('hivemindide.agentDetail.rechecking', "Re-running checks.");
		case 'applying': return localize('hivemindide.agentDetail.applying', "Applying to the parent.");
		case 'auto-merged': return localize('hivemindide.agentDetail.merged', "Merged into the parent.");
	}
}
