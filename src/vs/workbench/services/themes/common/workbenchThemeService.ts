/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { refineServiceDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { Color } from '../../../../base/common/color.js';
import { IColorTheme, IThemeService, IFileIconTheme, IProductIconTheme } from '../../../../platform/theme/common/themeService.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { isBoolean, isString } from '../../../../base/common/types.js';
import { IconContribution, IconDefinition } from '../../../../platform/theme/common/iconRegistry.js';
import { ColorScheme, ThemeTypeSelector } from '../../../../platform/theme/common/theme.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';

export const IWorkbenchThemeService = refineServiceDecorator<IThemeService, IWorkbenchThemeService>(IThemeService);

export const THEME_SCOPE_OPEN_PAREN = '[';
export const THEME_SCOPE_CLOSE_PAREN = ']';
export const THEME_SCOPE_WILDCARD = '*';

export const themeScopeRegex = /\[(.+?)\]/g;

export enum ThemeSettings {
	COLOR_THEME = 'workbench.colorTheme',
	FILE_ICON_THEME = 'workbench.iconTheme',
	PRODUCT_ICON_THEME = 'workbench.productIconTheme',
	COLOR_CUSTOMIZATIONS = 'workbench.colorCustomizations',
	TOKEN_COLOR_CUSTOMIZATIONS = 'editor.tokenColorCustomizations',
	SEMANTIC_TOKEN_COLOR_CUSTOMIZATIONS = 'editor.semanticTokenColorCustomizations',

	PREFERRED_DARK_THEME = 'workbench.preferredDarkColorTheme',
	PREFERRED_LIGHT_THEME = 'workbench.preferredLightColorTheme',
	PREFERRED_HC_DARK_THEME = 'workbench.preferredHighContrastColorTheme', /* id kept for compatibility reasons */
	PREFERRED_HC_LIGHT_THEME = 'workbench.preferredHighContrastLightColorTheme',
	DETECT_COLOR_SCHEME = 'window.autoDetectColorScheme',
	DETECT_HC = 'window.autoDetectHighContrast',

	SYSTEM_COLOR_THEME = 'window.systemColorTheme'
}

export namespace ThemeSettingDefaults {
	export const COLOR_THEME_DARK = 'Catppuccin Macchiato';
	export const COLOR_THEME_LIGHT = 'Catppuccin Latte';
	export const COLOR_THEME_HC_DARK = 'Default High Contrast';
	export const COLOR_THEME_HC_LIGHT = 'Default High Contrast Light';

	export const FILE_ICON_THEME = 'catppuccin-macchiato';
	export const PRODUCT_ICON_THEME = 'Default';
}

/**
 * Migrates legacy theme settings IDs to their current equivalents.
 * Theme IDs were simplified: "Default" prefix was removed from built-in themes,
 * and "Experimental" prefix was replaced when VS Code themes became GA.
 */
export function migrateThemeSettingsId(settingsId: string): string {
	switch (settingsId) {
		case 'Default Dark Modern': return 'Dark Modern';
		case 'Default Light Modern': return 'Light Modern';
		case 'Default Dark+': return 'Dark+';
		case 'Default Light+': return 'Light+';
		case 'Experimental Dark':
		case 'VS Code Dark':
			return ThemeSettingDefaults.COLOR_THEME_DARK;
		case 'Experimental Light':
		case 'VS Code Light':
			return ThemeSettingDefaults.COLOR_THEME_LIGHT;
	}
	return settingsId;
}

export const COLOR_THEME_DARK_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#363a4f',
	'activityBar.activeBorder': '#00000000',
	'activityBar.background': '#181926',
	'activityBar.border': '#00000000',
	'activityBar.foreground': '#c6a0f6',
	'activityBar.inactiveForeground': '#6e738d',
	'activityBarBadge.background': '#c6a0f6',
	'activityBarBadge.foreground': '#181926',
	'badge.background': '#494d64',
	'badge.foreground': '#cad3f5',
	'button.background': '#c6a0f6',
	'button.border': '#00000000',
	'button.foreground': '#181926',
	'button.hoverBackground': '#dac1f9',
	'button.secondaryBackground': '#5b6078',
	'button.secondaryForeground': '#cad3f5',
	'button.secondaryHoverBackground': '#6a708c',
	'chat.slashCommandBackground': '#494d64',
	'chat.slashCommandForeground': '#cad3f5',
	'chat.editedFileForeground': '#eed49f',
	'checkbox.background': '#494d64',
	'checkbox.border': '#00000000',
	'debugToolBar.background': '#181926',
	'descriptionForeground': '#cad3f5',
	'dropdown.background': '#1e2030',
	'dropdown.border': '#c6a0f6',
	'dropdown.foreground': '#cad3f5',
	'dropdown.listBackground': '#5b6078',
	'editor.background': '#24273a',
	'editor.findMatchBackground': '#604456',
	'editor.foreground': '#cad3f5',
	'editor.inactiveSelectionBackground': '#939ab740',
	'editor.selectionHighlightBackground': '#939ab733',
	'editorGroup.border': '#5b6078',
	'editorGroupHeader.tabsBackground': '#181926',
	'editorGroupHeader.tabsBorder': '#1e2030',
	'editorGutter.addedBackground': '#a6da95',
	'editorGutter.deletedBackground': '#ed8796',
	'editorGutter.modifiedBackground': '#eed49f',
	'editorIndentGuide.activeBackground1': '#5b6078',
	'editorIndentGuide.background1': '#494d64',
	'editorLineNumber.activeForeground': '#c6a0f6',
	'editorLineNumber.foreground': '#8087a2',
	'editorOverviewRuler.border': '#cad3f512',
	'editorWidget.background': '#1e2030',
	'errorForeground': '#ed8796',
	'focusBorder': '#c6a0f6',
	'foreground': '#cad3f5',
	'icon.foreground': '#c6a0f6',
	'input.background': '#363a4f',
	'input.border': '#00000000',
	'input.foreground': '#cad3f5',
	'input.placeholderForeground': '#cad3f573',
	'inputOption.activeBackground': '#5b6078',
	'inputOption.activeBorder': '#c6a0f6',
	'keybindingLabel.foreground': '#cad3f5',
	'list.activeSelectionIconForeground': '#cad3f5',
	'list.dropBackground': '#c6a0f633',
	'menu.background': '#24273a',
	'menu.border': '#24273a80',
	'menu.foreground': '#cad3f5',
	'menu.selectionBackground': '#5b6078',
	'menu.separatorBackground': '#5b6078',
	'notificationCenterHeader.background': '#1e2030',
	'notificationCenterHeader.foreground': '#cad3f5',
	'notifications.background': '#1e2030',
	'notifications.border': '#c6a0f6',
	'notifications.foreground': '#cad3f5',
	'panel.background': '#24273a',
	'panel.border': '#5b6078',
	'panelInput.border': '#00000000',
	'panelTitle.activeBorder': '#c6a0f6',
	'panelTitle.activeForeground': '#cad3f5',
	'panelTitle.inactiveForeground': '#a5adcb',
	'peekViewEditor.background': '#1e2030',
	'peekViewEditor.matchHighlightBackground': '#91d7e34d',
	'peekViewResult.background': '#1e2030',
	'peekViewResult.matchHighlightBackground': '#91d7e34d',
	'pickerGroup.border': '#c6a0f6',
	'ports.iconRunningProcessForeground': '#a6da95',
	'progressBar.background': '#c6a0f6',
	'quickInput.background': '#1e2030',
	'quickInput.foreground': '#cad3f5',
	'settings.dropdownBackground': '#494d64',
	'settings.dropdownBorder': '#c6a0f6',
	'settings.headerForeground': '#cad3f5',
	'settings.modifiedItemIndicator': '#c6a0f6',
	'sideBar.background': '#1e2030',
	'sideBar.border': '#00000000',
	'sideBar.foreground': '#cad3f5',
	'sideBarSectionHeader.background': '#1e2030',
	'sideBarSectionHeader.border': '#00000000',
	'sideBarSectionHeader.foreground': '#cad3f5',
	'sideBarTitle.foreground': '#c6a0f6',
	'statusBar.background': '#181926',
	'statusBar.border': '#00000000',
	'statusBar.debuggingBackground': '#f5a97f',
	'statusBar.debuggingForeground': '#181926',
	'statusBar.focusBorder': '#c6a0f6',
	'statusBar.foreground': '#cad3f5',
	'statusBar.noFolderBackground': '#181926',
	'statusBarItem.focusBorder': '#c6a0f6',
	'statusBarItem.prominentBackground': '#00000000',
	'statusBarItem.remoteBackground': '#8aadf4',
	'statusBarItem.remoteForeground': '#181926',
	'tab.activeBackground': '#24273a',
	'tab.activeBorder': '#00000000',
	'tab.activeBorderTop': '#c6a0f6',
	'tab.activeForeground': '#c6a0f6',
	'tab.border': '#1e2030',
	'tab.hoverBackground': '#2e324a',
	'tab.inactiveBackground': '#1e2030',
	'tab.inactiveForeground': '#6e738d',
	'tab.lastPinnedBorder': '#c6a0f6',
	'tab.selectedBackground': '#24273a',
	'tab.selectedBorderTop': '#c6a0f6',
	'tab.selectedForeground': '#c6a0f6',
	'tab.unfocusedActiveBorder': '#00000000',
	'tab.unfocusedActiveBorderTop': '#c6a0f64d',
	'tab.unfocusedHoverBackground': '#2e324a',
	'terminal.foreground': '#cad3f5',
	'terminal.inactiveSelectionBackground': '#5b607880',
	'terminal.tab.activeBorder': '#c6a0f6',
	'textBlockQuote.background': '#1e2030',
	'textBlockQuote.border': '#181926',
	'textCodeBlock.background': '#1e2030',
	'textLink.activeForeground': '#91d7e3',
	'textLink.foreground': '#8aadf4',
	'textPreformat.background': '#1e2030',
	'textPreformat.foreground': '#cad3f5',
	'textSeparator.foreground': '#c6a0f6',
	'titleBar.activeBackground': '#181926',
	'titleBar.activeForeground': '#cad3f5',
	'titleBar.border': '#00000000',
	'titleBar.inactiveBackground': '#181926',
	'titleBar.inactiveForeground': '#cad3f580',
	'welcomePage.progress.foreground': '#c6a0f6',
	'welcomePage.tileBackground': '#1e2030',
	'widget.border': '#24273a80',
};

export const COLOR_THEME_LIGHT_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#ccd0da',
	'activityBar.activeBorder': '#00000000',
	'activityBar.background': '#dce0e8',
	'activityBar.border': '#00000000',
	'activityBar.foreground': '#8839ef',
	'activityBar.inactiveForeground': '#9ca0b0',
	'activityBarBadge.background': '#8839ef',
	'activityBarBadge.foreground': '#dce0e8',
	'badge.background': '#bcc0cc',
	'badge.foreground': '#4c4f69',
	'button.background': '#8839ef',
	'button.border': '#00000000',
	'button.foreground': '#dce0e8',
	'button.hoverBackground': '#9c5af2',
	'button.secondaryBackground': '#acb0be',
	'button.secondaryForeground': '#4c4f69',
	'button.secondaryHoverBackground': '#c0c3ce',
	'chat.slashCommandBackground': '#bcc0cc',
	'chat.slashCommandForeground': '#4c4f69',
	'chat.editedFileForeground': '#df8e1d',
	'checkbox.background': '#bcc0cc',
	'checkbox.border': '#00000000',
	'descriptionForeground': '#4c4f69',
	'diffEditor.unchangedRegionBackground': '#e6e9ef',
	'dropdown.background': '#e6e9ef',
	'dropdown.border': '#8839ef',
	'dropdown.foreground': '#4c4f69',
	'dropdown.listBackground': '#acb0be',
	'editor.background': '#eff1f5',
	'editor.foreground': '#4c4f69',
	'editor.inactiveSelectionBackground': '#7c7f934d',
	'editor.selectionHighlightBackground': '#7c7f9333',
	'editorGroup.border': '#acb0be',
	'editorGroupHeader.tabsBackground': '#dce0e8',
	'editorGroupHeader.tabsBorder': '#e6e9ef',
	'editorGutter.addedBackground': '#40a02b',
	'editorGutter.deletedBackground': '#d20f39',
	'editorGutter.modifiedBackground': '#df8e1d',
	'editorIndentGuide.activeBackground1': '#acb0be',
	'editorIndentGuide.background1': '#bcc0cc',
	'editorLineNumber.activeForeground': '#8839ef',
	'editorLineNumber.foreground': '#8c8fa1',
	'editorOverviewRuler.border': '#4c4f6912',
	'editorSuggestWidget.background': '#e6e9ef',
	'editorWidget.background': '#e6e9ef',
	'errorForeground': '#d20f39',
	'focusBorder': '#8839ef',
	'foreground': '#4c4f69',
	'icon.foreground': '#8839ef',
	'input.background': '#ccd0da',
	'input.border': '#00000000',
	'input.foreground': '#4c4f69',
	'input.placeholderForeground': '#4c4f6973',
	'inputOption.activeBackground': '#acb0be',
	'inputOption.activeBorder': '#8839ef',
	'inputOption.activeForeground': '#4c4f69',
	'keybindingLabel.foreground': '#4c4f69',
	'list.activeSelectionBackground': '#ccd0da',
	'list.activeSelectionForeground': '#4c4f69',
	'list.activeSelectionIconForeground': '#4c4f69',
	'list.focusAndSelectionOutline': '#8839ef',
	'list.hoverBackground': '#ccd0da80',
	'menu.border': '#eff1f580',
	'menu.selectionBackground': '#acb0be',
	'menu.selectionForeground': '#4c4f69',
	'notebook.cellBorderColor': '#acb0be',
	'notebook.selectedCellBackground': '#ccd0da',
	'notificationCenterHeader.background': '#e6e9ef',
	'notificationCenterHeader.foreground': '#4c4f69',
	'notifications.background': '#e6e9ef',
	'notifications.border': '#8839ef',
	'notifications.foreground': '#4c4f69',
	'panel.background': '#eff1f5',
	'panel.border': '#acb0be',
	'panelInput.border': '#00000000',
	'panelTitle.activeBorder': '#8839ef',
	'panelTitle.activeForeground': '#4c4f69',
	'panelTitle.inactiveForeground': '#6c6f85',
	'peekViewEditor.matchHighlightBackground': '#04a5e54d',
	'peekViewResult.background': '#e6e9ef',
	'peekViewResult.matchHighlightBackground': '#04a5e54d',
	'pickerGroup.border': '#8839ef',
	'pickerGroup.foreground': '#8839ef',
	'ports.iconRunningProcessForeground': '#40a02b',
	'progressBar.background': '#8839ef',
	'quickInput.background': '#e6e9ef',
	'quickInput.foreground': '#4c4f69',
	'searchEditor.textInputBorder': '#00000000',
	'settings.dropdownBackground': '#bcc0cc',
	'settings.dropdownBorder': '#8839ef',
	'settings.headerForeground': '#4c4f69',
	'settings.modifiedItemIndicator': '#8839ef',
	'settings.numberInputBorder': '#00000000',
	'settings.textInputBorder': '#00000000',
	'sideBar.background': '#e6e9ef',
	'sideBar.border': '#00000000',
	'sideBar.foreground': '#4c4f69',
	'sideBarSectionHeader.background': '#e6e9ef',
	'sideBarSectionHeader.border': '#00000000',
	'sideBarSectionHeader.foreground': '#4c4f69',
	'sideBarTitle.foreground': '#8839ef',
	'statusBar.background': '#dce0e8',
	'statusBar.border': '#00000000',
	'statusBar.debuggingBackground': '#fe640b',
	'statusBar.debuggingForeground': '#dce0e8',
	'statusBar.focusBorder': '#8839ef',
	'statusBar.foreground': '#4c4f69',
	'statusBar.noFolderBackground': '#dce0e8',
	'statusBarItem.compactHoverBackground': '#acb0be33',
	'statusBarItem.errorBackground': '#00000000',
	'statusBarItem.focusBorder': '#8839ef',
	'statusBarItem.hoverBackground': '#acb0be33',
	'statusBarItem.prominentBackground': '#00000000',
	'statusBarItem.remoteBackground': '#1e66f5',
	'statusBarItem.remoteForeground': '#dce0e8',
	'tab.activeBackground': '#eff1f5',
	'tab.activeBorder': '#00000000',
	'tab.activeBorderTop': '#8839ef',
	'tab.activeForeground': '#8839ef',
	'tab.border': '#e6e9ef',
	'tab.hoverBackground': '#ffffff',
	'tab.inactiveBackground': '#e6e9ef',
	'tab.inactiveForeground': '#9ca0b0',
	'tab.lastPinnedBorder': '#8839ef',
	'tab.selectedBackground': '#eff1f5',
	'tab.selectedBorderTop': '#8839ef',
	'tab.selectedForeground': '#8839ef',
	'tab.unfocusedActiveBorder': '#00000000',
	'tab.unfocusedActiveBorderTop': '#8839ef4d',
	'tab.unfocusedHoverBackground': '#ffffff',
	'terminal.foreground': '#4c4f69',
	'terminal.inactiveSelectionBackground': '#acb0be80',
	'terminal.tab.activeBorder': '#8839ef',
	'terminalCursor.foreground': '#dc8a78',
	'textBlockQuote.background': '#e6e9ef',
	'textBlockQuote.border': '#dce0e8',
	'textCodeBlock.background': '#e6e9ef',
	'textLink.activeForeground': '#04a5e5',
	'textLink.foreground': '#1e66f5',
	'textPreformat.background': '#e6e9ef',
	'textPreformat.foreground': '#4c4f69',
	'textSeparator.foreground': '#8839ef',
	'titleBar.activeBackground': '#dce0e8',
	'titleBar.activeForeground': '#4c4f69',
	'titleBar.border': '#00000000',
	'titleBar.inactiveBackground': '#dce0e8',
	'titleBar.inactiveForeground': '#4c4f6980',
	'welcomePage.tileBackground': '#e6e9ef',
	'widget.border': '#eff1f580',
};

export interface IWorkbenchTheme {
	readonly id: string;
	readonly label: string;
	readonly extensionData?: ExtensionData;
	readonly description?: string;
	readonly settingsId: string | null;
}

export interface IWorkbenchColorTheme extends IWorkbenchTheme, IColorTheme {
	readonly settingsId: string;
	readonly tokenColors: ITextMateThemingRule[];
}

export interface IColorMap {
	[id: string]: Color;
}

export interface IWorkbenchFileIconTheme extends IWorkbenchTheme, IFileIconTheme {
}

export interface IWorkbenchProductIconTheme extends IWorkbenchTheme, IProductIconTheme {
	readonly settingsId: string;

	getIcon(icon: IconContribution): IconDefinition | undefined;
}

export type ThemeSettingTarget = ConfigurationTarget | undefined | 'auto' | 'preview';


export interface IWorkbenchThemeService extends IThemeService {
	readonly _serviceBrand: undefined;
	setColorTheme(themeId: string | undefined | IWorkbenchColorTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchColorTheme | null>;
	getColorTheme(): IWorkbenchColorTheme;
	/** Returns the selected theme and user customizations without window-local overlays. */
	getBaseColorTheme(): IWorkbenchColorTheme;
	getColorThemes(): Promise<IWorkbenchColorTheme[]>;
	getMarketplaceColorThemes(publisher: string, name: string, version: string): Promise<IWorkbenchColorTheme[]>;
	readonly onDidColorThemeChange: Event<IWorkbenchColorTheme>;

	/** Applies window-local colors computed from the base theme, without persisting them or changing the selected theme. */
	registerColorThemeOverlay(getColors: (theme: IWorkbenchColorTheme) => IColorMap): IDisposable;

	getPreferredColorScheme(): ColorScheme | undefined;

	setFileIconTheme(iconThemeId: string | undefined | IWorkbenchFileIconTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchFileIconTheme>;
	getFileIconTheme(): IWorkbenchFileIconTheme;
	getFileIconThemes(): Promise<IWorkbenchFileIconTheme[]>;
	getMarketplaceFileIconThemes(publisher: string, name: string, version: string): Promise<IWorkbenchFileIconTheme[]>;
	readonly onDidFileIconThemeChange: Event<IWorkbenchFileIconTheme>;

	setProductIconTheme(iconThemeId: string | undefined | IWorkbenchProductIconTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchProductIconTheme>;
	getProductIconTheme(): IWorkbenchProductIconTheme;
	getProductIconThemes(): Promise<IWorkbenchProductIconTheme[]>;
	getMarketplaceProductIconThemes(publisher: string, name: string, version: string): Promise<IWorkbenchProductIconTheme[]>;
	readonly onDidProductIconThemeChange: Event<IWorkbenchProductIconTheme>;
}

export interface IThemeScopedColorCustomizations {
	[colorId: string]: string;
}

export interface IColorCustomizations {
	[colorIdOrThemeScope: string]: IThemeScopedColorCustomizations | string;
}

export interface IThemeScopedTokenColorCustomizations {
	[groupId: string]: ITextMateThemingRule[] | ITokenColorizationSetting | boolean | string | undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface ITokenColorCustomizations {
	[groupIdOrThemeScope: string]: IThemeScopedTokenColorCustomizations | ITextMateThemingRule[] | ITokenColorizationSetting | boolean | string | undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface IThemeScopedSemanticTokenColorCustomizations {
	[styleRule: string]: ISemanticTokenRules | boolean | undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface ISemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]: IThemeScopedSemanticTokenColorCustomizations | ISemanticTokenRules | boolean | undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface IThemeScopedExperimentalSemanticTokenColorCustomizations {
	[themeScope: string]: ISemanticTokenRules | undefined;
}

export interface IExperimentalSemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]: IThemeScopedExperimentalSemanticTokenColorCustomizations | ISemanticTokenRules | undefined;
}

export type IThemeScopedCustomizations =
	IThemeScopedColorCustomizations
	| IThemeScopedTokenColorCustomizations
	| IThemeScopedExperimentalSemanticTokenColorCustomizations
	| IThemeScopedSemanticTokenColorCustomizations;

export type IThemeScopableCustomizations =
	IColorCustomizations
	| ITokenColorCustomizations
	| IExperimentalSemanticTokenColorCustomizations
	| ISemanticTokenColorCustomizations;

export interface ISemanticTokenRules {
	[selector: string]: string | ISemanticTokenColorizationSetting | undefined;
}

export interface ITextMateThemingRule {
	name?: string;
	scope?: string | string[];
	settings: ITokenColorizationSetting;
}

export interface ITokenColorizationSetting {
	foreground?: string;
	background?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
	fontFamily?: string;
	fontSize?: number;
	lineHeight?: number;
}

export interface ISemanticTokenColorizationSetting {
	foreground?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
	bold?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	italic?: boolean;
}

export interface ExtensionData {
	extensionId: string;
	extensionPublisher: string;
	extensionName: string;
	extensionIsBuiltin: boolean;
}

export namespace ExtensionData {
	export function toJSONObject(d: ExtensionData | undefined): any {
		return d && { _extensionId: d.extensionId, _extensionIsBuiltin: d.extensionIsBuiltin, _extensionName: d.extensionName, _extensionPublisher: d.extensionPublisher };
	}
	export function fromJSONObject(o: any): ExtensionData | undefined {
		if (o && isString(o._extensionId) && isBoolean(o._extensionIsBuiltin) && isString(o._extensionName) && isString(o._extensionPublisher)) {
			return { extensionId: o._extensionId, extensionIsBuiltin: o._extensionIsBuiltin, extensionName: o._extensionName, extensionPublisher: o._extensionPublisher };
		}
		return undefined;
	}
	export function fromName(publisher: string, name: string, isBuiltin = false): ExtensionData {
		return { extensionPublisher: publisher, extensionId: `${publisher}.${name}`, extensionName: name, extensionIsBuiltin: isBuiltin };
	}
}

export interface IThemeExtensionPoint {
	id: string;
	label?: string;
	description?: string;
	path: string;
	uiTheme?: ThemeTypeSelector;
	_watch: boolean; // unsupported options to watch location
}
