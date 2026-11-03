import { Captions, ChevronRight, Layers, Music2, Save, SlidersHorizontal } from 'lucide-react';
import { Button } from './Primitives';
import './project-settings-panel.css';

const projectActions = {
  caption: { label: '字幕样式', name: '项目字幕样式', icon: Captions },
  series: { label: '应用模板', name: '应用系列模板', icon: Layers },
  saveSeries: { label: '保存为模板', name: '保存当前系列为模板', icon: Save },
  music: { label: '背景音乐', name: '背景音乐', icon: Music2 },
  mix: { label: '混音', name: '项目混音设置', icon: SlidersHorizontal },
};
export type ProjectSettingsAction = keyof typeof projectActions;

export function ProjectSettingsActions({ items, onAction }: { items: ProjectSettingsAction[]; onAction: (action: ProjectSettingsAction) => void }) {
  return <div className="project-settings-panel__actions">{items.map(action => {
    const { label, name, icon: Icon } = projectActions[action];
    return <Button key={action} static variant="ghost" aria-label={name} onClick={() => onAction(action)}><Icon size={16} /><span>{label}</span><ChevronRight size={16} /></Button>;
  })}</div>;
}
