/*---------------------------------------------------------------------------------------------
 *  Native sidebar pane: author+AI root → sub-agent spawn tree.
 *--------------------------------------------------------------------------------------------*/

import './media/agentTree.css';
import { MutableDisposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { CoordinationClient, StreamEvent } from '../../../services/hivemindide/common/coordinationClient.js';
import { createDemoTrees, IAgentTree, isAgentTree, HIVEMINDIDE_AGENT_TREE_VIEW_ID, resolveAgentDetail } from '../common/agentTree.js';
import { HivemindIDESettings, HIVEMINDIDE_CONFIG_SECTION } from '../common/hivemindideConfiguration.js';
import { AgentTreeWidget } from './agentTreeWidget.js';

export class AgentTreeViewPane extends ViewPane {

	static readonly ID = HIVEMINDIDE_AGENT_TREE_VIEW_ID;

	private widget: AgentTreeWidget | undefined;
	private readonly socket = this._register(new MutableDisposable<IDisposable>());
	private readonly reconnect = this._register(new MutableDisposable<IDisposable>());
	private liveTree: IAgentTree | undefined;
	private currentTree: IAgentTree | undefined;
	private demoIndex = 0;
	private readonly demoTrees = createDemoTrees();

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(HIVEMINDIDE_CONFIG_SECTION)) {
				this.reconnectStream();
				this.refresh();
			}
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.widget = this._register(new AgentTreeWidget(container));
		this._register(this.widget.onDidOpenNode(nodeId => this.openDetail(nodeId)));
		this.reconnectStream();
		this.refresh();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.widget?.layout(height, width);
	}

	/** Toolbar / command: cycle demo trees, or re-pull when live. */
	resample(): void {
		if (this.liveTree) {
			this.refresh();
			return;
		}
		this.demoIndex = (this.demoIndex + 1) % this.demoTrees.length;
		this.refresh();
	}

	private openDetail(nodeId: string): void {
		const tree = this.currentTree;
		if (!tree || !this.widget) {
			return;
		}
		const detail = resolveAgentDetail(tree, nodeId);
		if (!detail) {
			return;
		}
		this.widget.showDetail(detail);
	}

	private refresh(): void {
		if (!this.widget) {
			return;
		}

		if (!this.configurationService.getValue<boolean>(HivemindIDESettings.AgentTreeEnabled)) {
			this.currentTree = undefined;
			this.widget.setConnectionState('empty', localize('hivemindide.agentTree.disabled', "Agents view disabled in settings"));
			this.widget.render(undefined);
			return;
		}

		if (this.liveTree) {
			this.currentTree = this.liveTree;
			this.widget.setConnectionState('live', localize('hivemindide.agentTree.live', "Live · {0}", this.liveTree.run_id));
			this.widget.render(this.liveTree);
			return;
		}

		const demoMode = this.configurationService.getValue<boolean>(HivemindIDESettings.AgentTreeDemoMode) ?? true;
		if (demoMode) {
			const tree = this.demoTrees[this.demoIndex];
			this.currentTree = tree;
			this.widget.setConnectionState('demo', localize('hivemindide.agentTree.demo', "Demo · {0} · click a node", tree.run_id));
			this.widget.render(tree);
			return;
		}

		this.currentTree = undefined;
		this.widget.setConnectionState('empty');
		this.widget.render(undefined);
	}

	private reconnectStream(): void {
		this.socket.clear();
		this.reconnect.clear();

		if (!this.configurationService.getValue<boolean>(HivemindIDESettings.AgentTreeEnabled)) {
			return;
		}

		const baseUrl = this.configurationService.getValue<string>(HivemindIDESettings.AgentTreeCoordinationUrl)?.trim();
		const repoId = this.configurationService.getValue<string>(HivemindIDESettings.AgentTreeRepoId)?.trim();
		if (!baseUrl || !repoId) {
			return;
		}

		this.widget?.setConnectionState('connecting');

		const client = new CoordinationClient(baseUrl);
		const url = client.streamUrl(repoId);

		let socket: WebSocket;
		try {
			socket = new WebSocket(url);
		} catch (err) {
			this.widget?.setConnectionState('error', err instanceof Error ? err.message : String(err));
			this.scheduleReconnect();
			return;
		}

		const store = new DisposableStore();
		store.add(toDisposable(() => {
			try { socket.close(); } catch { /* ignore */ }
		}));
		this.socket.value = store;

		socket.onopen = () => {
			if (!this.liveTree) {
				this.refresh();
			}
		};

		socket.onmessage = (msg) => {
			let ev: StreamEvent;
			try {
				ev = JSON.parse(String(msg.data)) as StreamEvent;
			} catch {
				return;
			}

			if (ev.type === 'agent.tree' || ev.type === 'agent.spawned' || ev.type === 'agent.status' || ev.type === 'agent.finished') {
				if (isAgentTree(ev.data)) {
					this.liveTree = ev.data;
					this.refresh();
				} else if (ev.data && typeof ev.data === 'object' && isAgentTree((ev.data as { tree?: unknown }).tree)) {
					this.liveTree = (ev.data as { tree: IAgentTree }).tree;
					this.refresh();
				}
			}
		};

		socket.onerror = () => {
			if (!this.liveTree && this.configurationService.getValue<boolean>(HivemindIDESettings.AgentTreeDemoMode)) {
				this.refresh();
			} else if (!this.liveTree) {
				this.widget?.setConnectionState('error', localize('hivemindide.agentTree.streamError', "Stream error"));
			}
		};

		socket.onclose = () => {
			this.scheduleReconnect();
		};
	}

	private scheduleReconnect(): void {
		const handle = setTimeout(() => this.reconnectStream(), 3000);
		this.reconnect.value = toDisposable(() => clearTimeout(handle));
	}
}
