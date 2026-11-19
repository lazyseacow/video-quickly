import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowRight, FileText, FolderOpen, Layers, Upload } from 'lucide-react';
import { dramaNarrativeModeLabels, dramaScriptReadResultSchema, dramaStudioCreateResultSchema, dramaStylePresets, dramaVisualStyleLabels, type DramaTopic, type DramaWork, type ProjectDocument, type SeriesTemplate } from '@video-quickly/contracts';
import { Button, Field, Notice, Select } from '../components/Primitives';
import PathPicker from '../components/PathPicker';
import SkillPicker from '../components/SkillPicker';
import { CharacterPicker } from '../components/CharacterPicker';
import { beginGuideAction } from '../lib/guide-actions';
import type { Action, WorkspaceView } from '../lib/types';
import DramaTopicsDialog from './DramaTopicsDialog';
import DramaSeriesTemplateDialog from './DramaSeriesTemplateDialog';

export type DramaCreationRequest = { sequence: number; template?: SeriesTemplate };
const categories = { 'live-action': '真人写实', '2d': '二维动画', illustration: '绘本与工艺', '3d': '三维动画' } as const;
const defaultDramaSkills = ['builtin-drama-script', 'builtin-drama-characters', 'builtin-drama-continuity', 'builtin-drama-storyboard'];

export default function DramaCreationComposer({ workspace, action, request, onCreated }: {
  workspace: WorkspaceView; action: Action; request?: DramaCreationRequest; onCreated(project: ProjectDocument): void;
}) {
  const id = useId();
  const root = useRef<HTMLElement>(null), titleInput = useRef<HTMLInputElement>(null);
  const pending = useRef(false), reading = useRef(false), mounted = useRef(true);
  const appliedRequest = useRef<number | undefined>(undefined);
  const [mode, setMode] = useState<'upload' | 'write'>('upload');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [originalText, setOriginalText] = useState('');
  const [path, setPath] = useState('');
  const [fileName, setFileName] = useState('');
  const [stylePresetOverride, setStylePresetOverride] = useState<string>();
  const [visualStyleOverride, setVisualStyleOverride] = useState<DramaWork['visualStyle']>();
  const [narrativeMode, setNarrativeMode] = useState<DramaWork['narrativeMode']>('mixed');
  const [topics, setTopics] = useState<DramaTopic[]>([]);
  const [topicsOpen, setTopicsOpen] = useState(false);
  const [skillSelection, setSkillSelection] = useState<string[]>();
  const [characterIds, setCharacterIds] = useState<string[]>([]);
  const [template, setTemplate] = useState<SeriesTemplate>();
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [busy, setBusy] = useState(false), [readBusy, setReadBusy] = useState(false);
  const [error, setError] = useState('');
  const stylePresetId = stylePresetOverride ?? (template ? '' : 'natural-live-action');
  const visualStyle = visualStyleOverride ?? template?.creationDefaults?.visualStyle ?? (template ? 'mixed' : 'live-action');
  const enabledSkills = new Set(workspace.skills.filter(skill => skill.enabled).map(skill => skill.id));
  const skillIds = skillSelection ?? (template ? template.creationDefaults?.skillIds ?? [] : defaultDramaSkills).filter(id => enabledSkills.has(id));
  const style = dramaStylePresets.find(value => value.id === stylePresetId);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!request || appliedRequest.current === request.sequence) return;
    appliedRequest.current = request.sequence;
    if (request.template) {
      setTemplate(request.template); setTitle(request.template.name); setDescription(request.template.description); setMode('write');
      setStylePresetOverride(undefined); setVisualStyleOverride(undefined); setSkillSelection(undefined);
    }
    root.current?.scrollIntoView({ block: 'start' });
    titleInput.current?.focus({ preventScroll: true });
  }, [request]);
  function tabs(event: KeyboardEvent<HTMLDivElement>) {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'upload' : event.key === 'End' ? 'write' : mode === 'upload' ? 'write' : 'upload';
    setMode(next); root.current?.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)?.focus();
  }
  async function readScript() {
    if (reading.current || !path.trim()) return;
    reading.current = true; setReadBusy(true); setError('');
    try {
      const result = await action('dramaScript.read', { path: path.trim() });
      if (!mounted.current) return;
      if (!result) { setError('剧本尚未导入，请核对文件格式和路径。也可以直接粘贴正文。'); return; }
      const imported = dramaScriptReadResultSchema.parse(result);
      setOriginalText(imported.text); setFileName(imported.fileName);
      if (!title.trim()) setTitle(imported.fileName.replace(/\.[^.]+$/, '').slice(0, 160));
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { reading.current = false; if (mounted.current) setReadBusy(false); }
  }
  async function create() {
    if (pending.current || reading.current) return;
    pending.current = true; setBusy(true); setError('');
    const complete = beginGuideAction('project-created');
    try {
      const result = await action('dramaStudio.create', {
        work: { title, description, visualStyle: style?.visualStyle ?? visualStyle, narrativeMode, characterIds, topicIds: topics.map(topic => topic.id), ...(style ? { stylePresetId: style.id } : {}), skillIds },
        originalText: mode === 'upload' ? originalText : '', mode,
        ...(template ? { seriesTemplateId: template.id, seriesTemplateRevision: template.revision } : {}),
      }, '短剧已创建');
      if (!mounted.current) return;
      if (result) {
        const created = dramaStudioCreateResultSchema.parse(result);
        setTitle(''); setDescription(''); setOriginalText(''); setPath(''); setFileName(''); setTemplate(undefined);
        complete(); onCreated(created.project);
      } else setError('短剧尚未创建，已保留你的输入，请核对提示后重试。');
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return <>
    <section ref={root} className="drama-composer" data-guide="create-project" aria-labelledby={`${id}-heading`}>
      <header className="drama-composer-heading">
        <h2 id={`${id}-heading`}>新建短剧</h2>
        <div className="tabs drama-composer-tabs" role="tablist" aria-label="剧本来源" onKeyDown={tabs}>
          <button id={`${id}-upload-tab`} type="button" role="tab" data-mode="upload" aria-selected={mode === 'upload'} aria-controls={`${id}-upload`} tabIndex={mode === 'upload' ? 0 : -1} className={mode === 'upload' ? 'active' : ''} disabled={busy || readBusy} onClick={() => setMode('upload')}><Upload size={16} aria-hidden="true" />上传剧本</button>
          <button id={`${id}-write-tab`} type="button" role="tab" data-mode="write" aria-selected={mode === 'write'} aria-controls={`${id}-write`} tabIndex={mode === 'write' ? 0 : -1} className={mode === 'write' ? 'active' : ''} disabled={busy || readBusy} onClick={() => setMode('write')}><FileText size={16} aria-hidden="true" />制作剧本</button>
        </div>
      </header>
      <form onSubmit={event => { event.preventDefault(); void create(); }}>
        <div className="drama-composer-body">
          <div className="drama-composer-script form-stack">
            <Field label="短剧名称" required>{field => <input {...field} ref={titleInput} name="title" required maxLength={160} value={title} disabled={busy || readBusy} onChange={event => setTitle(event.target.value)} />}</Field>
            <div id={`${id}-upload`} role="tabpanel" aria-labelledby={`${id}-upload-tab`} hidden={mode !== 'upload'} className="form-stack">
              <Field label="剧本文件" hint="TXT、MD、DOCX、含文本的 PDF。">{field => (
                <div className="drama-script-import">
                  <div className="drama-script-path">
                    <PathPicker field={field} label="剧本文件" value={path} onChange={setPath} extensions={['txt', 'md', 'docx', 'pdf']} disabled={busy || readBusy} placeholder="选择文件，或填写完整路径" />
                  </div>
                  <Button disabled={busy || !path.trim()} busy={readBusy} onClick={() => void readScript()}><FolderOpen size={15} aria-hidden="true" />读取文件</Button>
                </div>
              )}</Field>
              <Field label="剧本正文" required hint={fileName ? `已读取 ${fileName}` : undefined}>{field => <textarea {...field} name="originalText" required={mode === 'upload'} rows={8} maxLength={30000} value={originalText} disabled={busy || readBusy} onChange={event => { setOriginalText(event.target.value); setFileName(''); }} placeholder="粘贴剧本、小说章节或分集故事…" />}</Field>
              <span className="tiny-meta drama-character-count">{originalText.length.toLocaleString()} / 30,000</span>
            </div>
            <div id={`${id}-write`} role="tabpanel" aria-labelledby={`${id}-write-tab`} hidden={mode !== 'write'} className="form-stack">
              <Field label="故事想法" hint="创建后在工作台编写或生成剧本。"><textarea name="description" rows={10} maxLength={30000} value={description} disabled={busy} onChange={event => setDescription(event.target.value)} placeholder="谁想得到什么？遇到什么阻碍？希望发生怎样的反转？" /></Field>
            </div>
          </div>
          <div className="drama-composer-settings form-stack">
            <Button static className="drama-template-button" disabled={busy || readBusy} aria-haspopup="dialog" onClick={() => setTemplatesOpen(true)}>
              <Layers size={16} aria-hidden="true" />{template ? `系列模板：${template.name}` : '选择系列模板'}
            </Button>
            <div className="drama-form-grid">
              <Field label="画风"><Select name="stylePresetId" value={stylePresetId} disabled={busy} onChange={event => {
                const next = dramaStylePresets.find(value => value.id === event.target.value); setStylePresetOverride(event.target.value);
                if (next) { setVisualStyleOverride(next.visualStyle); setSkillSelection([...new Set([...skillIds, ...next.skillIds.filter(id => enabledSkills.has(id))])]); }
              }}><option value="">{template ? '沿用系列模板画风' : '自由画风'}</option>{Object.entries(categories).map(([category, label]) => <optgroup key={category} label={label}>{dramaStylePresets.filter(preset => preset.category === category).map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</optgroup>)}</Select></Field>
              <Field label="讲述方式"><Select name="narrativeMode" value={narrativeMode} disabled={busy} onChange={event => setNarrativeMode(event.target.value as DramaWork['narrativeMode'])}>{Object.entries(dramaNarrativeModeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
            </div>
            {!style && <Field label="视觉类型"><Select value={visualStyle} disabled={busy} onChange={event => setVisualStyleOverride(event.target.value as DramaWork['visualStyle'])}>{Object.entries(dramaVisualStyleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>}
            <div className="drama-composer-topics"><div className="drama-section__heading"><h3>选题</h3><Button disabled={busy} onClick={() => setTopicsOpen(true)}>打开选题库{topics.length ? ` · ${topics.length}` : ''}</Button></div>{topics.length > 0 && <div className="drama-topic-selection">{topics.map(topic => <Button key={topic.id} variant="ghost" disabled={busy} aria-label={`移除选题：${topic.title}`} onClick={() => setTopics(topics.filter(value => value.id !== topic.id))}>{topic.title} ×</Button>)}</div>}</div>
            <SkillPicker skills={workspace.skills} groups={workspace.skillGroups} value={skillIds} onChange={setSkillSelection} disabled={busy} label="创作 Skill" />
            <details className="drama-composer-advanced"><summary>共享角色与故事设定</summary><div className="form-stack"><CharacterPicker label="作品共享角色" maximum={50} version={workspace.version} value={characterIds} onChange={setCharacterIds} disabled={busy} />{mode === 'upload' && <Field label="故事设定"><textarea name="description" rows={3} maxLength={30000} value={description} disabled={busy} onChange={event => setDescription(event.target.value)} /></Field>}</div></details>
          </div>
        </div>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="drama-composer-footer"><Button type="submit" variant="primary" busy={busy} disabled={readBusy}>创建短剧<ArrowRight size={16} aria-hidden="true" /></Button></div>
      </form>
    </section>
    {topicsOpen && <DramaTopicsDialog value={topics} action={action} version={workspace.version} onChange={setTopics} onClose={() => setTopicsOpen(false)} />}
    {templatesOpen && <DramaSeriesTemplateDialog current={template} version={workspace.version} onClose={() => setTemplatesOpen(false)}
      onChoose={value => { setTemplate(value); setError(''); setTemplatesOpen(false); }} />}
  </>;
}
