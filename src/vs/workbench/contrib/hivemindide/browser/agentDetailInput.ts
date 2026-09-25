/*---------------------------------------------------------------------------------------------
 *  Editor input for an agent / sub-agent detail page.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Schemas } from '../../../../base/common/network.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IAgentDetail } from '../common/agentTree.js';

const agentDetailIcon = registerIcon(
	'hivemindide-agent-detail-editor-label-icon',
	Codicon.organization,
	localize('hivemindideAgentDetailEditorLabelIcon', 'Icon of the HivemindIDE agent detail editor.')
);

export class AgentDetailInput extends EditorInput {

	static readonly ID = 'workbench.input.hivemindideAgentDetail';

	readonly resource: URI;

	constructor(readonly detail: IAgentDetail) {
		super();
		this.resource = URI.from({
			scheme: Schemas.vscodeSettings,
			path: `hivemindide-agent/${detail.runId}/${detail.nodeId}`,
		});
	}

	override get typeId(): string {
		return AgentDetailInput.ID;
	}

	override get editorId(): string | undefined {
		return this.typeId;
	}

	override getName(): string {
		return this.detail.title;
	}

	override getDescription(): string | undefined {
		return this.detail.meta.model;
	}

	override getIcon(): ThemeIcon {
		return agentDetailIcon;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(otherInput)) {
			return true;
		}
		return otherInput instanceof AgentDetailInput
			&& otherInput.detail.nodeId === this.detail.nodeId
			&& otherInput.detail.runId === this.detail.runId;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly;
	}
}
