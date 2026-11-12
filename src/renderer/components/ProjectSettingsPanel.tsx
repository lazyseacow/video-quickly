import { Captions, ChevronRight, Music2 } from 'lucide-react';
import { Button } from './Primitives';
import './project-settings-panel.css';

const projectActions = {
  caption: { label: '字幕样式', name: '项目字幕样式', icon: Captions },
  music: { label: '背景音乐', name: '背景音乐', icon: Music2 },
};
export type ProjectSettingsAction = keyof typeof projectActions;

export function ProjectSettingsActions({ items, onAction }: { items: ProjectSettingsAction[]; onAction: (action: ProjectSettingsAction) => void }) {
  return <div className="project-settings-panel__actions">{items.map(action => {
    const { label, name, icon: Icon } = projectActions[action];
    return <Button key={action} static variant="ghost" aria-label={name} onClick={() => onAction(action)}><Icon size={16} /><span>{label}</span><ChevronRight size={16} /></Button>;
  })}</div>;
}
