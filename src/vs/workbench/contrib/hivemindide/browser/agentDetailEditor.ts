/*---------------------------------------------------------------------------------------------
 *  Agent detail editor — pipeline, meta, activity, checks, candidate diff.
 *  Opened when a spawn-tree node is clicked.
 *--------------------------------------------------------------------------------------------*/

import './media/agentDetail.css';
import { $, append, clearNode, Dimension } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import {
	AGENT_PIPELINE_STAGES,
	AgentPipelineStage,
	IAgentDetail,
	pipelineStageLabel,
} from '../common/agentTree.js';
import { AgentDetailInput } from './agentDetailInput.js';

export class AgentDetailEditor extends EditorPane {

	static readonly ID = 'workbench.editor.hivemindideAgentDetail';

	private container: HTMLElement | undefined;
	private readonly content = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(AgentDetailEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.hivemindide-agent-detail'));
	}

	override async setInput(input: AgentDetailInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (token.isCancellationRequested || !this.container) {
			return;
		}
		this.render(input.detail);
	}

	override clearInput(): void {
		this.content.clear();
		if (this.container) {
			clearNode(this.container);
		}
		super.clearInput();
	}

	layout(dimension: Dimension): void {
		if (this.container) {
			this.container.style.height = `${dimension.height}px`;
		}
	}

	private render(detail: IAgentDetail): void {
		if (!this.container) {
			return;
		}
		const store = new DisposableStore();
		this.content.value = store;
		clearNode(this.container);

		const layout = append(this.container, $('.hivemindide-agent-detail-layout'));
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
