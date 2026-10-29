import { Clapperboard, FolderOpen, Moon, PanelLeftClose, Plus, Sun, type LucideIcon } from 'lucide-react';
import type { ProjectDocument } from '@video-quickly/contracts';
import { Button, IconButton } from './Primitives';

export type Page = 'workbench' | 'projects' | 'assets' | 'models' | 'skills' | 'runs';
interface Props {
  page: Page; projectId?: string; projects: ProjectDocument[];
  navigation: Array<{ id: Page; label: string; icon: LucideIcon }>;
  collapsed: boolean; theme: string; onToggle: () => void; onTheme: () => void;
  onNavigate: (page: Page) => void; onOpen: (id: string) => void; onCreate: () => void;
}

export default function WorkspaceSidebar({ page, projectId, projects, navigation, collapsed, theme, onToggle, onTheme, onNavigate, onOpen, onCreate }: Props) {
  const recent = projects.filter(project => !project.archived).toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);
  return <aside className="sidebar" aria-label="工作空间导航">
    <div className="brand"><div className="brand-mark"><Clapperboard size={19} /></div><strong className="brand-title">Video Quickly</strong><IconButton label={collapsed ? '展开工作空间导航' : '收起工作空间导航'} className="brand-toggle" onClick={onToggle}><PanelLeftClose size={16} /></IconButton></div>
    <Button className="sidebar-create" aria-label="新建项目" title="新建项目" onClick={onCreate}><Plus size={17} /><span>新建项目</span></Button>
    <nav aria-label="主导航" className="nav-group">{navigation.slice(0, 3).map(item => <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} aria-current={page === item.id ? 'page' : undefined} title={item.label} onClick={() => onNavigate(item.id)}><item.icon size={18} /><span>{item.label}</span></button>)}</nav>
    <div className="sidebar-projects"><div className="sidebar-section-heading"><span>最近项目</span><span>{projects.filter(project => !project.archived).length}</span></div><div className="sidebar-project-list">{recent.map(project => <button key={project.id} className={`sidebar-project ${page === 'workbench' && projectId === project.id ? 'active' : ''}`} title={project.title} aria-label={`打开项目：${project.title}`} aria-current={page === 'workbench' && projectId === project.id ? 'page' : undefined} onClick={() => onOpen(project.id)}><FolderOpen size={14} /><span>{project.title}</span></button>)}</div></div>
    <div className="sidebar-bottom"><div className="sidebar-section-heading"><span>资源与工具</span></div><nav aria-label="资源导航" className="nav-group">{navigation.slice(3).map(item => <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} aria-current={page === item.id ? 'page' : undefined} title={item.label} onClick={() => onNavigate(item.id)}><item.icon size={18} /><span>{item.label}</span></button>)}</nav><div className="sidebar-footer"><button className="nav-item theme-button" title={theme === 'dark' ? '切换浅色主题' : '切换深色主题'} onClick={onTheme}>{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}<span>{theme === 'dark' ? '浅色外观' : '深色外观'}</span></button><span className="sidebar-local"><i className="online-dot" />本地工作区</span></div></div>
  </aside>;
}
