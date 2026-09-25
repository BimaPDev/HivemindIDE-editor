/*---------------------------------------------------------------------------------------------
 *  Registers the HivemindIDE User sidebar (icon rail + content inside the sidebar).
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { HIVEMINDIDE_USER_VIEW_ID, HIVEMINDIDE_USER_VIEWLET_ID } from '../common/userSidebar.js';
import { hivemindideUserViewIcon } from './userSidebarIcons.js';
import { UserSidebarViewPane } from './userSidebarViewPane.js';

const viewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: HIVEMINDIDE_USER_VIEWLET_ID,
	title: localize2('hivemindide.user', 'User'),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [HIVEMINDIDE_USER_VIEWLET_ID, { mergeViewWithContainerWhenSingleView: true }]),
	icon: hivemindideUserViewIcon,
	hideIfEmpty: false,
	order: 98,
	openCommandActionDescriptor: {
		id: HIVEMINDIDE_USER_VIEWLET_ID,
		mnemonicTitle: localize({ key: 'miViewHivemindideUser', comment: ['&& denotes a mnemonic'] }, "&&User"),
		order: 98,
	},
}, ViewContainerLocation.Sidebar);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: HIVEMINDIDE_USER_VIEW_ID,
	name: localize2('hivemindide.user.view', 'User'),
	containerIcon: hivemindideUserViewIcon,
	ctorDescriptor: new SyncDescriptor(UserSidebarViewPane),
	canToggleVisibility: false,
	canMoveView: true,
}], viewContainer);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'hivemindide.user.focus',
			title: localize2('hivemindide.user.focus', 'Focus User View'),
			category: localize2('hivemindide.category', 'HivemindIDE'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IViewsService).openView(HIVEMINDIDE_USER_VIEW_ID, true);
	}
});
