import { Menu, PanelLeftClose, PanelLeftOpen, Settings, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type Ref } from 'react';
import SidebarNavigationButton from './SidebarNavigationButton';
import StudioNavigationMenu, { type StudioNavigationMenuProps } from './StudioNavigationMenu';

export type { StudioMenuCommand } from './StudioNavigationMenu';

export type Page = 'workbench' | 'projects' | 'assets' | 'templates' | 'models' | 'skills' | 'costs';
export interface SidebarNavigationItem { id: Page; label: string; icon: LucideIcon; group: 'main' | 'resources' | 'tools'; }
interface Props {
  page: Page;
  navigation: SidebarNavigationItem[];
  studioMenu: StudioNavigationMenuProps;
  settingsOpen: boolean; settingsRef: Ref<HTMLButtonElement>;
  onNavigate: (page: Page) => void;
  onSettings: () => void;
}

const compactLayout = '(max-width: 980px)';

export default function WorkspaceSidebar({ page, navigation, studioMenu, settingsOpen, settingsRef, onNavigate, onSettings }: Props) {
  const menuId = useId();
  const sidebarBodyId = useId();
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const [compact, setCompact] = useState(() => matchMedia(compactLayout).matches);
  const [expanded, setExpanded] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const iconRail = !compact && collapsed;
  const toggleLabel = compact ? '工作室菜单' : iconRail ? '展开侧栏' : '收起侧栏';
  const ToggleIcon = compact ? Menu : iconRail ? PanelLeftOpen : PanelLeftClose;

  useEffect(() => {
    const media = matchMedia(compactLayout);
    const update = () => { setCompact(media.matches); setExpanded(false); };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  function closeMenu(restoreFocus = false) {
    if (!expanded) return;
    setExpanded(false);
    if (restoreFocus) menuTrigger.current?.focus({ preventScroll: true });
  }

  function renderGroup(group: SidebarNavigationItem['group'], label: string) {
    return <nav aria-label={label} className={`nav-group workspace-sidebar__${group}`}>
      {navigation.filter(item => item.group === group).map(item => <SidebarNavigationButton key={item.id} label={item.label} icon={item.icon} guide={item.id} tooltipPlacement={compact ? 'bottom' : iconRail ? 'right' : undefined}
        current={page === item.id || item.id === 'projects' && page === 'workbench'} onClick={() => { closeMenu(); onNavigate(item.id); }} />)}
    </nav>;
  }

  return <aside className="sidebar workspace-sidebar" aria-label="工作空间导航" data-collapsed={iconRail || undefined} data-expanded={compact && expanded || undefined}
    onKeyDown={event => { if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); closeMenu(true); } }}>
    <div className="workspace-sidebar__header">
      {renderGroup('main', '主导航')}
      <button ref={menuTrigger} type="button" className="nav-item workspace-sidebar__toggle" aria-controls={compact ? menuId : sidebarBodyId}
        aria-expanded={compact ? expanded : !iconRail} aria-label={toggleLabel} title={toggleLabel}
        data-guide={compact && studioMenu.guideLibrary ? 'work-library' : undefined}
        onClick={() => compact ? setExpanded(value => !value) : setCollapsed(value => !value)}>
        <ToggleIcon size={18} aria-hidden="true" /><span>工作室菜单</span>
      </button>
    </div>
    <div className="workspace-sidebar__body" id={sidebarBodyId}>
      <StudioNavigationMenu {...studioMenu} id={menuId} hidden={compact && !expanded} iconOnly={iconRail}
        onChoose={command => { closeMenu(true); studioMenu.onChoose(command); }}
        onOpenEpisode={id => { closeMenu(true); studioMenu.onOpenEpisode(id); }} />
      {renderGroup('resources', '资源导航')}
      {renderGroup('tools', '工具导航')}
    </div>
    <div className="sidebar-footer"><button ref={settingsRef} type="button" className={`nav-item${settingsOpen || page === 'costs' ? ' active' : ''}`}
      data-guide="help" aria-label="设置" title="设置" aria-haspopup="dialog" aria-expanded={settingsOpen} aria-current={page === 'costs' ? 'page' : undefined}
      onClick={() => { closeMenu(); onSettings(); }}><Settings size={18} aria-hidden="true" /><span>设置</span></button></div>
  </aside>;
}
