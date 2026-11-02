import { Plus, Settings, type LucideIcon } from 'lucide-react';
import type { Ref } from 'react';
import { Button } from './Primitives';
import BrandMark from './BrandMark';
import SidebarNavigationButton from './SidebarNavigationButton';

export type Page = 'workbench' | 'projects' | 'assets' | 'characters' | 'templates' | 'models' | 'skills' | 'runs' | 'costs';
export interface SidebarNavigationItem { id: Page; label: string; icon: LucideIcon; group: 'main' | 'resources' | 'tools'; }
interface Props {
  page: Page;
  navigation: SidebarNavigationItem[];
  settingsOpen: boolean; settingsRef: Ref<HTMLButtonElement>;
  onNavigate: (page: Page) => void; onCreate: () => void;
  onSettings: () => void;
}

export default function WorkspaceSidebar({ page, navigation, settingsOpen, settingsRef, onNavigate, onCreate, onSettings }: Props) {
  return <aside className="sidebar" aria-label="工作空间导航">
    <div className="sidebar-rail">
      <div className="brand" title="Video Quickly"><div className="brand-mark"><BrandMark size={24} /></div></div>
      <Button variant="primary" className="sidebar-create" data-guide="create-project" aria-label="新建项目" title="新建项目" onClick={onCreate}><Plus size={17} /></Button>
      <div className="sidebar-rail__navigation">{(['main', 'resources', 'tools'] as const).map(group => <nav key={group} aria-label={group === 'main' ? '主导航' : group === 'resources' ? '资源导航' : '工具导航'} className="nav-group">{navigation.filter(item => item.group === group).map(item => <SidebarNavigationButton key={item.id} label={item.label} icon={item.icon} guide={item.id} current={page === item.id || item.id === 'projects' && page === 'workbench'} onClick={() => onNavigate(item.id)} />)}</nav>)}</div>
      <div className="sidebar-footer"><button ref={settingsRef} type="button" className={`nav-item ${settingsOpen || page === 'costs' ? 'active' : ''}`} data-guide="help" aria-label="设置" title="设置" aria-haspopup="dialog" aria-expanded={settingsOpen} aria-current={page === 'costs' ? 'page' : undefined} onClick={onSettings}><Settings size={18} /></button></div>
    </div>
  </aside>;
}
