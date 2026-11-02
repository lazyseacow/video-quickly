import { Captions, ChevronRight, Download, Layers, Music2, Save, SlidersHorizontal } from 'lucide-react';
import { videoProfileSchema, type ProjectDocument, type VideoProfile } from '@video-quickly/contracts';
import { Button, Field } from './Primitives';
import SettingsSections from './SettingsSections';
import VideoSettings from './VideoSettings';
import './project-settings-panel.css';

interface Props {
  project: Pick<ProjectDocument, 'profile' | 'brief' | 'style'>;
  section: string; onSectionChange: (value: string) => void;
  onBriefChange: (value: string) => void; onStyleChange: (value: string) => void; onProfileChange: (value: VideoProfile) => void;
  dirty: boolean; saving: boolean; onSave: () => void;
  actions: Record<'caption' | 'series' | 'saveSeries' | 'music' | 'mix' | 'backup', () => void>;
}

export default function ProjectSettingsPanel({ project, section, onSectionChange, onBriefChange, onStyleChange, onProfileChange, dirty, saving, onSave, actions }: Props) {
  return <div className="project-settings-panel"><SettingsSections layout="tabs" label="项目设置分类" value={section} onValueChange={onSectionChange} sections={[
    { id: 'creative', label: '创作', content: <><h3>创意简报</h3><Field label="主题与核心问题"><textarea data-project-brief value={project.brief} onChange={event => onBriefChange(event.target.value)} placeholder="视频讲什么、面向谁，以及希望观众看完后记住什么？" /></Field><Field label="系列风格"><textarea value={project.style} onChange={event => onStyleChange(event.target.value)} /></Field><div className="project-settings-panel__actions"><Button static variant="ghost" aria-label="应用系列模板" onClick={actions.series}><Layers size={16} /><span>应用模板</span><ChevronRight size={16} /></Button><Button static variant="ghost" aria-label="保存当前系列为模板" onClick={actions.saveSeries}><Save size={16} /><span>保存为模板</span><ChevronRight size={16} /></Button></div></> },
    { id: 'video', label: '画面', content: <><div className="project-settings-panel__actions"><Button static variant="ghost" aria-label="项目字幕样式" onClick={actions.caption}><Captions size={16} /><span>字幕样式</span><ChevronRight size={16} /></Button></div><h3 className="project-settings-panel__heading">视频规格</h3><VideoSettings profile={project.profile} onChange={onProfileChange} /></> },
    { id: 'audio', label: '声音', content: <><h3>声音与配乐</h3><div className="project-settings-panel__actions"><Button static variant="ghost" onClick={actions.music}><Music2 size={16} /><span>背景音乐</span><ChevronRight size={16} /></Button><Button static variant="ghost" aria-label="项目混音设置" onClick={actions.mix}><SlidersHorizontal size={16} /><span>混音</span><ChevronRight size={16} /></Button></div></> },
  ]} /><div className="project-settings-panel__footer"><Button aria-label="备份项目与素材" onClick={actions.backup}><Download size={16} />备份</Button><Button aria-label="保存项目设置" variant="primary" busy={saving} disabled={!dirty || !videoProfileSchema.safeParse(project.profile).success} onClick={onSave}><Save size={16} />保存</Button></div></div>;
}
