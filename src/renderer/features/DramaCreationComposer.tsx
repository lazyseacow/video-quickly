import { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react';
import { ArrowRight, ArrowUp, BookOpen, Check, Clapperboard, FileText, FileUp, History, Layers, ListVideo, Pencil, PenLine, Plus, Route, Settings2, X } from 'lucide-react';
import { creativeObjectiveInputSchema, dramaNarrativeModeLabels, dramaScriptReadResultSchema, dramaStudioCreateResultSchema, dramaStylePresets, dramaVisualStyleLabels, MAX_NOVEL_SOURCE_LENGTH, type DramaTopic, type DramaWork, type ProjectDocument, type SeriesTemplate } from '@video-quickly/contracts';
import { Button, Dialog, Field, IconButton, Notice, Select } from '../components/Primitives';
import PathPicker from '../components/PathPicker';
import SkillPicker from '../components/SkillPicker';
import { CharacterPicker } from '../components/CharacterPicker';
import { beginGuideAction } from '../lib/guide-actions';
import { resolveStudioIntent, type StudioCreationFlow } from '../lib/studio-intent';
import type { Action, WorkspaceView } from '../lib/types';
import DramaTopicsDialog from './DramaTopicsDialog';
import DramaSeriesTemplateDialog from './DramaSeriesTemplateDialog';
import DramaStylePicker, { DramaStyleField, DramaStylePreview } from './DramaStylePicker';

export type DramaCreationRequest = { sequence: number; template?: SeriesTemplate };
export interface DramaComposerHandle { draftStatus(): 'empty' | 'edited' | 'busy'; }
export interface StudioPlanningInput { goal?: string; history?: boolean; }
const defaultDramaSkills = ['builtin-drama-script', 'builtin-drama-characters', 'builtin-drama-continuity', 'builtin-drama-storyboard'];
const creationModes = {
  auto: { label: '自动判断', prompt: '从小说、剧本或一个故事想法开始。', placeholder: '描述你的创作想法，或粘贴文稿…', icon: Route },
  novel: { label: '改编小说', prompt: '把本集的小说原文发给我。', placeholder: '粘贴本集小说原文，或添加文件…', icon: BookOpen },
  upload: { label: '上传剧本', prompt: '把已经写好的剧本发给我。', placeholder: '粘贴剧本正文，或添加文件…', icon: FileUp },
  write: { label: '制作剧本', prompt: '说说你想拍一个怎样的故事。', placeholder: '写下故事设定、人物或一场戏…', icon: PenLine },
  planning: { label: '创作分镜', prompt: '描述想拍的画面，以及时长或镜头数。', placeholder: '例如：雨夜候船厅，20 秒，4 个镜头。', icon: ListVideo },
} as const;
type CreationMode = keyof typeof creationModes;
const sourceModes = ['novel', 'upload', 'write'] as const;
const creationModeOptions = ['auto', ...sourceModes, 'planning'] as const;
const featuredStyles = ['suspense-cinema', 'urban-drama', 'ink-wash']
  .map(id => dramaStylePresets.find(preset => preset.id === id))
  .filter(preset => preset !== undefined);
const startingPoints = [
  { mode: 'novel', label: '改编小说' },
  { mode: 'write', label: '从想法写剧本' },
  { mode: 'planning', label: '规划一组分镜' },
] as const;
const nextSteps = {
  novel: '创建后，在分集对话中生成并审核导演剧本。',
  upload: '创建后，剧本正文会进入首集的分集工作台。',
  write: '创建后，可以在首集的分集工作台继续写作。',
} as const;
interface CreationDraft {
  step: 'source' | 'review';
  text: string;
  title: string;
  fileName?: string;
  fromFile?: boolean;
  initialRequest?: string;
  editing?: boolean;
}
const emptyDraft: CreationDraft = { step: 'source', text: '', title: '' };
const previewLength = 260;

function hasDraft(draft: CreationDraft) {
  return draft.step !== 'source' || Boolean(draft.text.trim() || draft.title.trim() || draft.fileName);
}

function titleFromFile(fileName?: string) {
  return fileName?.replace(/\.[^.]+$/, '').slice(0, 160) ?? '';
}

export default function DramaCreationComposer({ ref, workspace, action, request, focusOnMount, onCreated, onPlanning }: {
  ref?: Ref<DramaComposerHandle>; workspace: WorkspaceView; action: Action; request?: DramaCreationRequest;
  focusOnMount?: boolean; onCreated(project: ProjectDocument): void; onPlanning(input: StudioPlanningInput): Promise<boolean>;
}) {
  const id = useId();
  const root = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const choiceHeading = useRef<HTMLParagraphElement>(null);
  const pending = useRef(false), reading = useRef(false), mounted = useRef(true);
  const appliedRequest = useRef<number | undefined>(undefined);
  const [mode, setMode] = useState<CreationMode>('auto');
  const [drafts, setDrafts] = useState<Partial<Record<CreationMode, CreationDraft>>>({});
  const [awaitingIntent, setAwaitingIntent] = useState(false);
  const [focusRequest, setFocusRequest] = useState(focusOnMount ? 1 : 0);
  const [storySetting, setStorySetting] = useState('');
  const [stylePresetOverride, setStylePresetOverride] = useState<string>();
  const [visualStyleOverride, setVisualStyleOverride] = useState<DramaWork['visualStyle']>();
  const [narrativeMode, setNarrativeMode] = useState<DramaWork['narrativeMode']>('mixed');
  const [topics, setTopics] = useState<DramaTopic[]>([]);
  const [skillSelection, setSkillSelection] = useState<string[]>();
  const [characterIds, setCharacterIds] = useState<string[]>([]);
  const [template, setTemplate] = useState<SeriesTemplate>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [topicsOpen, setTopicsOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [path, setPath] = useState('');
  const [importError, setImportError] = useState('');
  const [busy, setBusy] = useState(false), [readBusy, setReadBusy] = useState(false);
  const [error, setError] = useState('');
  const draft = drafts[mode] ?? emptyDraft;
  const manualTitle = draft.title.trim() && draft.title !== titleFromFile(draft.fileName) ? draft.title : '';
  const route = creationModes[mode];
  const chooseIntent = mode === 'auto' && awaitingIntent;
  const stylePresetId = stylePresetOverride ?? (template ? '' : 'natural-live-action');
  const visualStyle = visualStyleOverride ?? template?.creationDefaults?.visualStyle ?? (template ? 'mixed' : 'live-action');
  const enabledSkills = new Set(workspace.skills.filter(skill => skill.enabled).map(skill => skill.id));
  const skillIds = skillSelection ?? (template ? template.creationDefaults?.skillIds ?? [] : defaultDramaSkills).filter(skillId => enabledSkills.has(skillId));
  const style = dramaStylePresets.find(value => value.id === stylePresetId);
  const fileKind = mode === 'auto' ? '文稿' : mode === 'novel' ? '小说' : '剧本';

  useImperativeHandle(ref, () => ({
    draftStatus() {
      if (pending.current || reading.current) return 'busy';
      const enteredDraft = Object.values(drafts).some(hasDraft);
      return enteredDraft || storySetting.trim() || stylePresetOverride !== undefined || visualStyleOverride !== undefined
        || narrativeMode !== 'mixed' || topics.length || skillSelection || characterIds.length || template ? 'edited' : 'empty';
    },
  }));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!request || appliedRequest.current === request.sequence) return;
    appliedRequest.current = request.sequence;
    if (request.template) {
      const chosen = request.template;
      setTemplate(chosen); setMode('write'); setStorySetting(chosen.description); setAwaitingIntent(false);
      setDrafts(current => ({ ...current, write: { ...emptyDraft, text: chosen.description, title: chosen.name } }));
      setStylePresetOverride(undefined); setVisualStyleOverride(undefined); setSkillSelection(undefined); setError('');
    }
    root.current?.scrollIntoView({ block: 'start' });
    setFocusRequest(value => value + 1);
  }, [request]);
  useLayoutEffect(() => {
    if (focusRequest) (input.current ?? titleInput.current ?? choiceHeading.current)?.focus();
  }, [focusRequest]);

  function updateDraft(patch: Partial<CreationDraft>) {
    setDrafts(current => ({ ...current, [mode]: { ...emptyDraft, ...current[mode], ...patch } }));
  }
  function selectMode(next: CreationMode, focusComposer = true) {
    setError('');
    setAwaitingIntent(false);
    if (mode === 'auto' && next !== 'auto' && !(next === 'planning' && draft.fromFile)
      && hasDraft(draft) && !hasDraft(drafts[next] ?? emptyDraft)) {
      setDrafts(current => ({ ...current, auto: undefined, [next]: draft }));
    }
    setMode(next);
    if (focusComposer || drafts[next]?.step === 'review') setFocusRequest(value => value + 1);
  }

  function selectStylePreset(presetId: string) {
    setStylePresetOverride(presetId);
    const preset = dramaStylePresets.find(value => value.id === presetId);
    if (!preset) return;
    setVisualStyleOverride(preset.visualStyle);
    setSkillSelection([...new Set([...skillIds, ...preset.skillIds.filter(skillId => enabledSkills.has(skillId))])]);
  }
  function editSource() {
    setError('');
    updateDraft({ step: 'source', editing: true });
    setFocusRequest(value => value + 1);
  }
  async function enterPlanning(input: StudioPlanningInput) {
    if (pending.current || reading.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      if (!await onPlanning(input)) {
        if (input.history) setSettingsOpen(false);
        setError('消息已保留，可以稍后继续分镜创作。');
        return;
      }
      if (input.history) setSettingsOpen(false);
      else {
        setDrafts(current => ({ ...current, [mode]: undefined }));
        setMode('auto'); setAwaitingIntent(false);
      }
    } finally { pending.current = false; setBusy(false); }
  }
  function acceptIntent(flow: StudioCreationFlow, content: string) {
    if (flow === 'planning') {
      if (content && !creativeObjectiveInputSchema.shape.goal.safeParse(content).success) {
        setError('分镜目标最多 3,000 字符，请编辑消息后重试。'); return;
      }
      void enterPlanning({ goal: content || undefined });
      return;
    }
    if (hasDraft(drafts[flow] ?? emptyDraft)) {
      setAwaitingIntent(true);
      setError(`「${creationModes[flow].label}」已有草稿。可编辑这条消息，或用创作方式选择器继续原草稿。`);
      setFocusRequest(value => value + 1);
      return;
    }
    setDrafts(current => ({ ...current, auto: undefined, [flow]: {
      ...draft, text: content, step: content ? 'review' : 'source', initialRequest: content ? undefined : draft.text.trim(),
    } }));
    setMode(flow); setAwaitingIntent(false); setError('');
    setFocusRequest(value => value + 1);
  }
  function send() {
    if (pending.current || reading.current || draft.step === 'review') return;
    const text = draft.text.trim();
    if (!text && mode !== 'write') return;
    if (mode === 'planning') {
      acceptIntent('planning', text);
      return;
    }
    if (mode === 'auto') {
      const intent = draft.fromFile ? undefined : resolveStudioIntent(text);
      if (intent) acceptIntent(intent.flow, intent.content);
      else { setAwaitingIntent(true); setError(''); setFocusRequest(value => value + 1); }
      return;
    }
    updateDraft({ text, step: 'review', editing: false });
    setError('');
    setFocusRequest(value => value + 1);
  }

  function openImport() {
    setImportError('');
    setImportOpen(true);
  }

  async function readSource() {
    if (reading.current || !path.trim()) return;
    reading.current = true; setReadBusy(true); setImportError('');
    try {
      const result = await action('dramaScript.read', { path: path.trim() });
      if (!mounted.current) return;
      if (!result) { setImportError('文件尚未读取，请核对格式和路径。也可以直接粘贴原文。'); return; }
      const imported = dramaScriptReadResultSchema.parse(result);
      updateDraft({ text: imported.text, fileName: imported.fileName, fromFile: true, title: manualTitle || titleFromFile(imported.fileName) });
      setPath(''); setError(''); setImportOpen(false);
      setFocusRequest(value => value + 1);
    } catch (reason) { if (mounted.current) setImportError(reason instanceof Error ? reason.message : String(reason)); }
    finally { reading.current = false; if (mounted.current) setReadBusy(false); }
  }

  async function create() {
    if (mode === 'auto' || mode === 'planning' || pending.current || reading.current || draft.step !== 'review') return;
    const title = draft.title.trim();
    if (!title) { setError('请输入短剧名称。'); titleInput.current?.focus(); return; }
    pending.current = true; setBusy(true); setError('');
    const complete = beginGuideAction('project-created');
    try {
      const result = await action('dramaStudio.create', {
        work: { title, description: mode === 'write' ? draft.text : storySetting,
          visualStyle: style?.visualStyle ?? visualStyle, narrativeMode, characterIds, topicIds: topics.map(topic => topic.id),
          ...(style ? { stylePresetId: style.id } : {}), skillIds },
        originalText: mode === 'upload' ? draft.text : '', mode,
        ...(mode === 'novel' ? { novelSource: draft.text } : {}),
        ...(template ? { seriesTemplateId: template.id, seriesTemplateRevision: template.revision } : {}),
      }, '短剧已创建');
      if (!mounted.current) return;
      if (result) {
        const created = dramaStudioCreateResultSchema.parse(result);
        setDrafts(current => ({ ...current, [mode]: undefined }));
        setMode('auto'); setAwaitingIntent(false); setPath('');
        if (!Object.entries(drafts).some(([name, value]) => name !== mode && value && hasDraft(value))) {
          setStorySetting(''); setStylePresetOverride(undefined); setVisualStyleOverride(undefined);
          setNarrativeMode('mixed'); setTopics([]); setSkillSelection(undefined); setCharacterIds([]); setTemplate(undefined);
        }
        complete(); onCreated(created.project);
      } else setError('短剧尚未创建，已保留你的输入，可以修改后重试。');
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }

  const showWelcome = draft.step === 'source' && !draft.editing && !draft.initialRequest && !chooseIntent;
  const canAttach = mode === 'auto' || mode === 'novel' || mode === 'upload';
  const reviewMode = draft.step === 'review' && mode !== 'auto' && mode !== 'planning' ? mode : undefined;
  const settingsButton = <Button static variant="ghost" className="drama-composer__settings" aria-haspopup="dialog" disabled={busy} onClick={() => setSettingsOpen(true)}>
    <Settings2 size={16} aria-hidden="true" />创作设置
  </Button>;
  const attachment = draft.fileName && <span className="drama-composer__attachment" title={draft.fileName}><FileText size={15} aria-hidden="true" /><span>{draft.fileName}</span></span>;

  return <>
    <section ref={root} className="drama-composer" data-guide="create-project" aria-label="新建短剧">
      {showWelcome && <header className="drama-composer__welcome" data-with-styles={mode !== 'planning' || undefined}>
        <div className="drama-composer__welcome-copy">
          <h2>把故事拍成短剧</h2>
          <p>{route.prompt}</p>
        </div>
        {mode !== 'planning' && <div className="drama-composer__style-list" role="group" aria-label="试一种画风">
          {featuredStyles.map(preset => <Button key={preset.id} static variant="ghost" className="drama-composer__style-tile"
            aria-pressed={preset.id === stylePresetId} disabled={busy || readBusy} onClick={() => selectStylePreset(preset.id)}>
            <span className="drama-composer__style-picture"><DramaStylePreview presetId={preset.id} /></span>
            <span className="drama-composer__style-label">{preset.name}{preset.id === stylePresetId && <Check size={14} aria-hidden="true" />}</span>
          </Button>)}
        </div>}
      </header>}
      <div className="drama-composer__thread" role="log" aria-label="创作对话">
        {draft.step === 'source' && draft.initialRequest && <>
          <StudioUserText text={draft.initialRequest} />
          <StudioReply><p>{route.prompt}</p></StudioReply>
        </>}
        {chooseIntent && <>
          <StudioUserText text={draft.text} attachment={attachment} />
          <StudioReply card>
            <p ref={choiceHeading} tabIndex={-1}>{draft.fromFile ? '你想怎么使用这份文稿？' : '你想用这段内容做什么？'}</p>
            <div className="drama-composer__choices" role="group" aria-label="选择创作流程">
              {sourceModes.map(flow => <Button key={flow} disabled={busy} onClick={() => acceptIntent(flow, draft.text.trim())}>{creationModes[flow].label}</Button>)}
              {!draft.fromFile && <Button disabled={busy} onClick={() => acceptIntent('planning', draft.text.trim())}>创作分镜</Button>}
              <Button variant="ghost" disabled={busy} onClick={() => { setAwaitingIntent(false); setError(''); setFocusRequest(value => value + 1); }}>编辑消息</Button>
            </div>
            {error && <Notice kind="error">{error}</Notice>}
          </StudioReply>
        </>}
        {reviewMode && <>
          <StudioUserText text={draft.text || '从空白剧本开始'} attachment={attachment}>
              <div className="drama-composer__message-actions">
                <Button static variant="ghost" disabled={busy} onClick={editSource}><Pencil size={14} aria-hidden="true" />编辑内容</Button>
              </div>
          </StudioUserText>
          <StudioReply card>
            <form className="drama-composer__project" aria-labelledby={`${id}-review`} onSubmit={event => { event.preventDefault(); void create(); }}>
              <header>
                <h3 id={`${id}-review`}>确认新短剧</h3>
                <p>{nextSteps[reviewMode]}</p>
              </header>
              <Field label="短剧名称" required>{field => <input {...field} ref={titleInput} name="title" required maxLength={160}
                value={draft.title} disabled={busy} placeholder="为这部短剧起个名字"
                onChange={event => { updateDraft({ title: event.target.value }); setError(''); }} />}</Field>
              <dl>
                <div><dt>创作方式</dt><dd>{route.label}</dd></div>
                <div><dt>画风</dt><dd>{style?.name ?? (template ? '沿用系列模板' : dramaVisualStyleLabels[visualStyle])}</dd></div>
                <div><dt>讲述方式</dt><dd>{dramaNarrativeModeLabels[narrativeMode]}</dd></div>
                {template && <div><dt>系列模板</dt><dd>{template.name}</dd></div>}
              </dl>
              {error && <Notice kind="error">{error}</Notice>}
              <footer>
                {settingsButton}
                <Button type="submit" variant="primary" busy={busy} disabled={!draft.title.trim()}>创建短剧<ArrowRight size={16} aria-hidden="true" /></Button>
              </footer>
            </form>
          </StudioReply>
        </>}
      </div>
      {!chooseIntent && draft.step === 'source' && <div className="drama-composer__entry">
        <div className="drama-composer__mode-bar">
          <div className="drama-composer__modes" role="radiogroup" aria-label="创作方式" style={{
            '--studio-mode-count': creationModeOptions.length,
            '--studio-mode-index': creationModeOptions.indexOf(mode),
          } as CSSProperties}>
            {creationModeOptions.map(option => {
              const selected = mode === option;
              const { label, icon: ModeIcon } = creationModes[option];
              const Icon = selected ? Check : ModeIcon;
              return <label className="drama-composer__mode-option" key={option}>
                <input type="radio" name={`${id}-mode`} value={option} checked={selected} disabled={busy || readBusy}
                  onChange={() => selectMode(option, false)} />
                <span><Icon size={16} aria-hidden="true" />{label}</span>
              </label>;
            })}
          </div>
        </div>
        <form className="drama-composer__input" aria-label="发送创作信息" onSubmit={event => { event.preventDefault(); send(); }}>
          <div className="drama-composer__source-grid" data-with-intake={canAttach || Boolean(draft.fileName) || undefined}>
            {draft.fileName ? <div className="drama-composer__intake" role="group" aria-label="已读取文件">
              <span className="drama-composer__intake-icon"><FileText size={18} strokeWidth={1.75} aria-hidden="true" /></span>
              <div className="drama-composer__intake-copy">
                <strong title={draft.fileName}>{draft.fileName}</strong>
                <small>{draft.text.length.toLocaleString('zh-CN')} 字符</small>
              </div>
              <div className="drama-composer__intake-actions">
                {canAttach && <Button static variant="ghost" aria-haspopup="dialog" disabled={busy || readBusy} onClick={openImport}>替换文件</Button>}
                <IconButton label="移除文件" disabled={busy || readBusy} onClick={() => {
                  updateDraft({ fileName: undefined, fromFile: false, text: '', title: manualTitle });
                  input.current?.focus();
                }}><X size={16} aria-hidden="true" /></IconButton>
              </div>
            </div> : canAttach && <Button variant="ghost" className="drama-composer__add-file" aria-label="添加文件" aria-haspopup="dialog"
              aria-describedby={`${id}-formats`} disabled={busy || readBusy} onClick={openImport}>
              <span className="drama-composer__intake-icon"><Plus size={18} strokeWidth={1.75} aria-hidden="true" /></span>
              <span className="drama-composer__intake-copy"><strong>添加文件</strong><small id={`${id}-formats`}>TXT / MD / DOCX / PDF</small></span>
            </Button>}
            <div className="drama-composer__editor">
              <label className="drama-composer__label" htmlFor={`${id}-message`}>创作输入</label>
              <textarea ref={input} id={`${id}-message`} name="content"
                className="drama-composer__textarea" rows={3} required={mode !== 'write'} maxLength={MAX_NOVEL_SOURCE_LENGTH} value={draft.text} disabled={busy}
                placeholder={draft.editing ? '修改创作内容…' : route.placeholder} onChange={event => {
                  const text = event.target.value;
                  updateDraft({ text, fileName: text ? draft.fileName : undefined, fromFile: draft.fromFile && Boolean(text), title: text ? draft.title : manualTitle }); setError('');
                }}
                onKeyDown={event => {
                  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                  event.preventDefault();
                  if (event.currentTarget.value.trim()) event.currentTarget.form?.requestSubmit();
                }} />
            </div>
          </div>
          {error && <div className="drama-composer__notice"><Notice kind="error">{error}</Notice></div>}
          <div className="drama-composer__toolbar">
            <div className="drama-composer__tools" role="group" aria-label="创作工具">
              {mode !== 'planning' && <>
                <DramaStylePicker value={stylePresetId} usingTemplate={Boolean(template)} disabled={busy || readBusy} onChange={selectStylePreset} />
                <Button static variant="ghost" aria-haspopup="dialog" disabled={busy || readBusy} onClick={() => setTopicsOpen(true)}>
                  <Layers size={16} aria-hidden="true" />选题库{topics.length ? ` · ${topics.length}` : ''}
                </Button>
                {settingsButton}
              </>}
              {mode === 'planning' && <Button static variant="ghost" disabled={busy} onClick={() => void enterPlanning({ history: true })}>
                <History size={16} aria-hidden="true" />分镜创作记录
              </Button>}
              {mode === 'write' && !draft.text.trim() && <Button variant="ghost" static disabled={busy} onClick={send}>跳过故事想法</Button>}
            </div>
            <IconButton type="submit" className="drama-composer__send" label="发送" busy={busy} disabled={!draft.text.trim()} title="Enter 发送，Shift+Enter 换行"><ArrowUp size={18} aria-hidden="true" /></IconButton>
          </div>
        </form>
      </div>}
      {showWelcome && mode === 'auto' && <ul className="drama-composer__starters" aria-label="创作起点">
        {startingPoints.map(({ mode: flow, label }) => {
          const { icon: Icon } = creationModes[flow];
          return <li key={flow}>
            <Button static variant="ghost" disabled={busy || readBusy} onClick={() => selectMode(flow)}>
              <Icon size={16} aria-hidden="true" />{label}
            </Button>
          </li>;
        })}
      </ul>}
    </section>

    {importOpen && <Dialog title={`导入${fileKind}`} onClose={() => setImportOpen(false)} dismissDisabled={readBusy} dismissOnBackdrop={false} className="drama-editor">
      <form onSubmit={event => { event.preventDefault(); void readSource(); }}>
        <div className="dialog__body form-stack">
          {draft.text.trim() && <p>读取成功后，所选文件会替换输入区中的内容。</p>}
          <Field label={`${fileKind}文件`} required hint="TXT、Markdown、DOCX、含文本的 PDF。">{field => <PathPicker field={field} label={`${fileKind}文件`} value={path}
            onChange={setPath} extensions={['txt', 'md', 'markdown', 'docx', 'pdf']} required disabled={readBusy} placeholder="选择文件，或填写完整路径" />}</Field>
          {importError && <Notice kind="error">{importError}</Notice>}
        </div>
        <div className="dialog__footer"><Button disabled={readBusy} onClick={() => setImportOpen(false)}>取消</Button><Button type="submit" variant="primary" busy={readBusy}>读取文件</Button></div>
      </form>
    </Dialog>}
    {settingsOpen && <Dialog title="创作设置" onClose={() => setSettingsOpen(false)} className="drama-editor">
      <div className="dialog__body drama-composer-settings form-stack">
        <Button static className="drama-template-button" aria-haspopup="dialog" onClick={() => setTemplatesOpen(true)}>
          <Layers size={16} aria-hidden="true" />{template ? `系列模板 · ${template.name}` : '选择系列模板'}
        </Button>
        <Button static className="drama-template-button" disabled={busy} onClick={() => void enterPlanning({ history: true })}>
          <History size={16} aria-hidden="true" />分镜创作记录
        </Button>
        <div className="drama-form-grid">
          <DramaStyleField value={stylePresetId} usingTemplate={Boolean(template)} onChange={selectStylePreset} />
          <Field label="讲述方式"><Select name="narrativeMode" value={narrativeMode} onChange={event => setNarrativeMode(event.target.value as DramaWork['narrativeMode'])}>{Object.entries(dramaNarrativeModeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
        </div>
        {!style && <Field label="视觉类型"><Select value={visualStyle} onChange={event => setVisualStyleOverride(event.target.value as DramaWork['visualStyle'])}>{Object.entries(dramaVisualStyleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>}
        <div className="drama-composer-topics">
          <div className="drama-section__heading"><h3>选题</h3><Button onClick={() => setTopicsOpen(true)}>打开选题库{topics.length ? ` · ${topics.length}` : ''}</Button></div>
          {topics.length > 0 && <div className="drama-topic-selection">{topics.map(topic => <Button key={topic.id} variant="ghost" aria-label={`移除选题 ${topic.title}`} onClick={() => setTopics(topics.filter(value => value.id !== topic.id))}>{topic.title} ×</Button>)}</div>}
        </div>
        <SkillPicker skills={workspace.skills} groups={workspace.skillGroups} value={skillIds} onChange={setSkillSelection} label="创作 Skill" />
        <details className="drama-composer-advanced"><summary>共享角色与故事设定</summary><div className="form-stack">
          <CharacterPicker label="作品共享角色" maximum={50} version={workspace.version} value={characterIds} onChange={setCharacterIds} />
          {mode !== 'write' && <Field label="故事设定"><textarea name="description" rows={3} maxLength={MAX_NOVEL_SOURCE_LENGTH} value={storySetting} onChange={event => setStorySetting(event.target.value)} /></Field>}
        </div></details>
      </div>
      <div className="dialog__footer"><Button variant="primary" onClick={() => setSettingsOpen(false)}>完成</Button></div>
    </Dialog>}
    {topicsOpen && <DramaTopicsDialog value={topics} action={action} version={workspace.version} onChange={setTopics} onClose={() => setTopicsOpen(false)} />}
    {templatesOpen && <DramaSeriesTemplateDialog current={template} version={workspace.version} onClose={() => setTemplatesOpen(false)}
      onChoose={value => { setTemplate(value); setError(''); setTemplatesOpen(false); }} />}
  </>;
}

function StudioReply({ children, card = false }: { children: ReactNode; card?: boolean }) {
  return <div className="drama-composer__turn drama-composer__turn--assistant">
    <Clapperboard size={19} aria-hidden="true" />
    <div className={card ? 'drama-composer__card' : 'drama-composer__bubble'}>{children}</div>
  </div>;
}

function StudioUserText({ text, attachment, children }: { text: string; attachment?: ReactNode; children?: ReactNode }) {
  return <div className="drama-composer__turn drama-composer__turn--user">
    <div className="drama-composer__bubble">
      {attachment}
      {text.length > previewLength
        ? <details><summary>{text.slice(0, previewLength)}…</summary><p>{text}</p></details>
        : <p>{text}</p>}
      {children}
    </div>
  </div>;
}
