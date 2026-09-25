/*---------------------------------------------------------------------------------------------
 *  Shared ids + active tab for the HivemindIDE user rail / sidebar pair.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';

export const HIVEMINDIDE_USER_VIEWLET_ID = 'workbench.view.extension.hivemindideUser';
export const HIVEMINDIDE_USER_VIEW_ID = 'workbench.view.hivemindide.user';

export type UserRailTab = 'settings' | 'code' | 'account';

class UserRailStateImpl {
	private _tab: UserRailTab = 'settings';
	private readonly _onDidChangeTab = new Emitter<UserRailTab>();
	readonly onDidChangeTab: Event<UserRailTab> = this._onDidChangeTab.event;

	get tab(): UserRailTab {
		return this._tab;
	}

	setTab(tab: UserRailTab): void {
		this._tab = tab;
		this._onDidChangeTab.fire(tab);
	}
}

/** Singleton coordinating the outer user rail with the User sidebar content. */
export const UserRailState = new UserRailStateImpl();
