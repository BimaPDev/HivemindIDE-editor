/*---------------------------------------------------------------------------------------------
 *  HivemindIDE feature configuration.
 *
 *  Every HivemindIDE feature registers its settings here and is gated on a
 *  `hivemindide.<feature>.enabled` boolean. Keeping the schema in one file means the
 *  Settings UI groups our features together, and means a new feature is a new
 *  block here rather than a new registration scattered through the tree.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions, ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';

export const HIVEMINDIDE_CONFIG_SECTION = 'hivemindide';

export const enum HivemindIDESettings {
	UsageIndicatorEnabled = 'hivemindide.usageIndicator.enabled',
	UsageIndicatorShowCost = 'hivemindide.usageIndicator.showCost',
	UsageIndicatorDailyTokenBudget = 'hivemindide.usageIndicator.dailyTokenBudget',
	UsageIndicatorRefreshSeconds = 'hivemindide.usageIndicator.refreshSeconds',
	AgentTreeEnabled = 'hivemindide.agentTree.enabled',
	AgentTreeCoordinationUrl = 'hivemindide.agentTree.coordinationUrl',
	AgentTreeRepoId = 'hivemindide.agentTree.repoId',
	AgentTreeDemoMode = 'hivemindide.agentTree.demoMode',
}

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: HIVEMINDIDE_CONFIG_SECTION,
	order: 100,
	title: localize('hivemindide.configuration.title', "HivemindIDE"),
	type: 'object',
	properties: {
		[HivemindIDESettings.UsageIndicatorEnabled]: {
			type: 'boolean',
			default: true,
			// APPLICATION scope: this reads files in your home directory, so it is
			// a property of this machine's install, not of a workspace. A repo you
			// clone must not be able to switch it on for you.
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.usageIndicator.enabled', "Show a status bar indicator with AI coding assistant token usage, read from local tool data. Turning this off removes the indicator and stops all file polling."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.UsageIndicatorShowCost]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.usageIndicator.showCost', "Include estimated cost in the usage indicator's tooltip, when the local data reports it."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.UsageIndicatorDailyTokenBudget]: {
			type: 'number',
			default: 0,
			minimum: 0,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('hivemindide.usageIndicator.dailyTokenBudget', "Daily token budget used to render usage as a percentage. Set to `0` to show the raw token count instead.\n\nLocal tool data does not report your plan's real limit, so this is a budget you choose, not a limit anyone enforces."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.UsageIndicatorRefreshSeconds]: {
			type: 'number',
			default: 60,
			minimum: 10,
			maximum: 3600,
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.usageIndicator.refreshSeconds', "How often to re-read local usage data, in seconds."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.AgentTreeEnabled]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.agentTree.enabled', "Show the HivemindIDE Agents sidebar with the author+AI spawn tree."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.AgentTreeCoordinationUrl]: {
			type: 'string',
			default: 'http://127.0.0.1:8082',
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.agentTree.coordinationUrl', "Base URL of coordinationd. Used for the presence stream and live agent.spawned frames."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.AgentTreeRepoId]: {
			type: 'string',
			default: '11111111-1111-4111-8111-111111111111',
			scope: ConfigurationScope.WINDOW,
			description: localize('hivemindide.agentTree.repoId', "Repo ID passed to coordinationd for the agent tree stream. Use the seeded demo id, or your own."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.AgentTreeDemoMode]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.agentTree.demoMode', "Show a mock author+AI spawn tree when coordinationd has not yet emitted agent.* frames. Live frames always win."),
			tags: ['hivemindide']
		}
	}
});

// Product defaults that must not edit upstream files. Same effect as changing
// ThemeSettingDefaults / telemetry defaults in microsoft/vscode, none of the
// merge cost. apply-branding.sh also flips the registered defaults for
// VSCodium parity; this is the belt that survives if a merge restores them.
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration)
	.registerDefaultConfigurations([{
		overrides: {
			'workbench.colorTheme': 'Catppuccin Macchiato',
			'workbench.iconTheme': 'catppuccin-macchiato',
			'telemetry.telemetryLevel': 'off',
			'telemetry.feedback.enabled': false,
			'telemetry.enableCrashReporter': false,
			'telemetry.editStats.enabled': false,
			'workbench.enableExperiments': false,
			'workbench.settings.enableNaturalLanguageSearch': false,
			'workbench.commandPalette.experimental.enableNaturalLanguageSearch': false,
		}
	}]);
