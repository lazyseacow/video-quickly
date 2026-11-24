import { Fragment, useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, ArrowUp, BookOpen, Check, ChevronDown, ChevronRight, Clapperboard, FileUp, ImagePlus, Layers, ListVideo, LockKeyhole, Pencil, ScrollText, UserRound, UsersRound } from 'lucide-react';
import {
  assetSchema, dramaScriptReadResultSchema, getMediaAdapters, isRunActive, MAX_DIRECTOR_SCREENPLAY_LENGTH, MAX_NOVEL_ADAPTATION_INSTRUCTION_LENGTH, MAX_NOVEL_SOURCE_LENGTH,
  novelAdaptationStateSchema, novelCharacterAssetsSchema, runInspectionSchema,
  type AssetRecord, type NovelAdaptationState, type NovelCharacterAsset, type ProjectDocument, type Shot,
} from '@video-quickly/contracts';
import { useChargeRpc, useConfirmation } from '../components/ConfirmationDialog';
import CreativeReferencePicker from '../components/CreativeReferencePicker';
import PathPicker from '../components/PathPicker';
import { Button, Field, Notice, Select, Status, statusLabels } from '../components/Primitives';
import ReferenceImage from '../components/ReferenceImage';
import SkillPicker from '../components/SkillPicker';
import { rpc } from '../lib/client';
import type { WorkspaceView } from '../lib/types';
import { useRuntimeRead } from '../lib/use-runtime-read';
import './novel-adaptation.css';

const generationSteps = ['screenplay', 'characters', 'storyboard'] as const;
type GenerationStep = (typeof generationSteps)[number];
type Step = 'source' | GenerationStep;
type ArtifactTarget = { stage: GenerationStep; index?: number };
const stages = ['source', ...generationSteps] as const;
const stageCopy = {
  screenplay: { label: '导演剧本', open: '查看剧本', first: '改写为导演剧本', repeat: '重新改写', revise: '按要求重写', placeholder: '补充改编要求，例如让对白更口语化…' },
  characters: { label: '角色资产', open: '查看角色资产', first: '提取角色资产', repeat: '重新提取', revise: '按要求提取', placeholder: '补充对角色设定的要求…' },
  storyboard: { label: '分镜', open: '查看分镜', first: '生成分镜', repeat: '重新生成分镜', revise: '按要求生成分镜', placeholder: '补充镜头节奏、景别或画面要求…' },
};
const stageLabels = { source: '小说原文', screenplay: stageCopy.screenplay.label, characters: stageCopy.characters.label, storyboard: stageCopy.storyboard.label };
const stageIcons = { source: BookOpen, screenplay: ScrollText, characters: UsersRound, storyboard: ListVideo };
const lockedReasons = { screenplay: '先保存原文', characters: '待剧本审核', storyboard: '待角色确认' };
const draftLabels = { source: '未保存原文', screenplay: '未提交的剧本修改', characters: '未确认的角色修改' };
type AdaptationRun = NonNullable<NovelAdaptationState['runs'][GenerationStep]>;
type Draft<T> = { base: T; value: T };
type Pending = 'source' | 'read-source' | 'start' | 'approve' | 'characters' | 'storyboard' | 'role-image' | 'recovery';
const duration = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const imageProviders = new Set(getMediaAdapters(['image']).map(adapter => adapter.id));
const regenerationEffects = {
  screenplay: '重新改写后需要再次审核导演剧本、确认角色资产并生成分镜。',
  characters: '重新提取后需要再次确认角色资产并生成分镜。',
  storyboard: '重新生成后需要将新分镜应用到工作台。',
};

interface NovelAdaptationConversationProps {
  project: ProjectDocument;
  workspace: WorkspaceView;
  active: boolean;
  onRegisterLeave(check: (() => Promise<boolean>) | null): void;
  saveBeforeAction(): Promise<number | undefined>;
  onOpenStoryboard?(projectRevision: number): void;
  onOpenCharacters?(): void;
}

function availableStep(state: NovelAdaptationState): Step {
  if (state.characters.applied) return 'storyboard';
  if (state.screenplay.approved) return 'characters';
  return state.source ? 'screenplay' : 'source';
}

function runInProgress(run: AdaptationRun) {
  return isRunActive(run.status) && !(run.status === 'queued' && run.error);
}

export default function NovelAdaptationConversation({ project, workspace, active, onRegisterLeave, saveBeforeAction, onOpenStoryboard, onOpenCharacters }: NovelAdaptationConversationProps) {
  const confirm = useConfirmation();
  const charge = useChargeRpc();
  const query = useRuntimeRead('novelAdaptation.get', { projectId: project.id }, workspace.version, novelAdaptationStateSchema, active);
  const [mutationState, setMutationState] = useState<NovelAdaptationState>();
  const state = mutationState && (!query.data || mutationState.revision > query.data.revision) ? mutationState : query.data;
  const [view, setView] = useState<Step>();
  const [sourceDraft, setSourceDraft] = useState<Draft<string>>();
  const [screenplayDraft, setScreenplayDraft] = useState<Draft<string>>();
  const [roleDraft, setRoleDraft] = useState<Draft<NovelCharacterAsset[]>>();
  const [instructions, setInstructions] = useState<Partial<Record<GenerationStep, string>>>({});
  const [path, setPath] = useState('');
  const [modelId, setModelId] = useState(project.workflow.production.textModelId ?? '');
  const [imageModelId, setImageModelId] = useState('');
  const [generatedImages, setGeneratedImages] = useState<Record<string, AssetRecord>>({});
  const [generatingRoleKey, setGeneratingRoleKey] = useState<string>();
  const [skillIds, setSkillIds] = useState(() => {
    const roles = project.workflow.nodes.find(node => node.config.documentRole === 'novel-characters');
    return roles?.skillIds.length ? roles.skillIds : project.workflow.nodes.find(node => node.config.documentRole === 'screenplay')?.skillIds ?? [];
  });
  const [pending, setPending] = useState<Pending>();
  const [error, setError] = useState('');
  const [fileNotice, setFileNotice] = useState('');
  const inFlight = useRef(false);
  const request = useRef<{ key: string; id: string } | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const artifactDisclosure = useRef<HTMLDetailsElement>(null);
  const artifactTarget = useRef<ArtifactTarget | undefined>(undefined);
  const panelId = useId();

  const saved = {
    source: Boolean(state?.source), screenplay: Boolean(state?.screenplay.approved),
    characters: Boolean(state?.characters.applied), storyboard: Boolean(state?.storyboard.applied),
  };
  const visible = { screenplay: saved.source, characters: saved.screenplay, storyboard: saved.characters };
  const step = view && (view === 'source' || visible[view]) ? view : state ? availableStep(state) : 'source';
  const source = sourceDraft?.value ?? state?.source ?? '';
  const longSource = Boolean(state && (state.source.length > 160 || state.source.split('\n', 4).length > 3));
  const screenplay = screenplayDraft?.value ?? state?.screenplay.text ?? '';
  const roles = roleDraft?.value ?? state?.characters.items ?? [];
  const sourceChanged = Boolean(state && source.trim() !== state.source);
  const screenplayChanged = Boolean(state && screenplay.trim() !== state.screenplay.text);
  const rolesChanged = Boolean(roleDraft && JSON.stringify(roleDraft.value) !== JSON.stringify(state?.characters.items));
  const hasUnsaved = sourceChanged || screenplayChanged || rolesChanged || Object.values(instructions).some(text => text.trim());
  const activeRun = Object.values(state?.runs ?? {}).find(runInProgress);
  const running = Boolean(activeRun);
  const busy = Boolean(pending);
  const canEdit = !busy && !running && !query.error;
  const textModels = workspace.models.filter(model => model.enabled && model.capabilities.includes('text'));
  const selectedModelId = textModels.find(model => model.id === modelId)?.id ?? textModels[0]?.id ?? '';
  const imageModels = workspace.models.filter(model => model.enabled && model.capabilities.includes('image') && imageProviders.has(model.provider));
  const selectedImageModelId = imageModels.find(model => model.id === imageModelId)?.id ?? imageModels[0]?.id ?? '';
  const availableSkills = workspace.skills.filter(skill => skill.enabled);
  const selectedSkills = skillIds.filter(id => availableSkills.some(skill => skill.id === id));
  const completedSteps = stages.filter(stage => saved[stage]).length;
  const draftStep = sourceChanged ? 'source' : screenplayChanged ? 'screenplay' : rolesChanged ? 'characters' : undefined;
  const nextStep = draftStep ?? (state && !saved.storyboard ? availableStep(state) : undefined);
  const blockers = {
    screenplay: sourceChanged ? 'source' : undefined,
    characters: sourceChanged ? 'source' : screenplayChanged ? 'screenplay' : undefined,
    storyboard: draftStep,
  } as const;
  const enabled = {
    screenplay: visible.screenplay && !blockers.screenplay,
    characters: visible.characters && !blockers.characters,
    storyboard: visible.storyboard && !blockers.storyboard,
  };
  const loaded = Boolean(state);
  const checkBeforeLeave = useCallback(async () => {
    if (inFlight.current) return false;
    if (!hasUnsaved) return true;
    return confirm({ title: '离开小说改编？', description: '本集有未提交的创作要求或编辑。', confirmLabel: '仍然离开', variant: 'primary' });
  }, [confirm, hasUnsaved]);

  useLayoutEffect(() => {
    onRegisterLeave(checkBeforeLeave);
    return () => onRegisterLeave(null);
  }, [checkBeforeLeave, onRegisterLeave]);

  const focusStage = useCallback(() => {
    const area = scroll.current, activeHeading = heading.current;
    if (!area?.getClientRects().length || !activeHeading) return;
    const artifact = artifactTarget.current;
    artifactTarget.current = undefined;
    const detail = artifact?.index === undefined ? undefined : area.querySelector<HTMLDetailsElement>(`details[data-artifact="${artifact.stage}-${artifact.index}"]`);
    if (detail) detail.open = true;
    const destination = detail?.querySelector('summary') ?? activeHeading;
    destination.focus({ preventScroll: true });
    // Move only the conversation transcript, keeping the host view and composer in place.
    const target = destination.getBoundingClientRect(), viewport = area.getBoundingClientRect();
    const inset = Number.parseFloat(getComputedStyle(area).scrollPaddingBlockStart) || 0;
    const offset = target.top - viewport.top - inset;
    const smooth = artifact && Math.abs(offset) <= viewport.height && matchMedia('(prefers-reduced-motion: no-preference)').matches;
    area.scrollTo({ top: area.scrollTop + offset, behavior: smooth ? 'smooth' : 'instant' });
  }, []);

  useLayoutEffect(() => {
    if (active && loaded) focusStage();
  }, [active, loaded, step, focusStage]);

  function navigate(next: Step) {
    if (next !== step) setError('');
    setView(next);
    if (next === step) focusStage();
  }

  function openArtifact(target: ArtifactTarget) {
    if (artifactDisclosure.current) artifactDisclosure.current.open = false;
    artifactTarget.current = target;
    navigate(target.stage);
  }

  async function perform(action: Pending, operation: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(action);
    setError('');
    try { await operation(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { inFlight.current = false; setPending(undefined); }
  }

  async function mutation(method: string, params: object, billable = false) {
    if (!state || await saveBeforeAction() === undefined) return undefined;
    const input = { projectId: state.projectId, revision: state.revision, ...params };
    const result = billable ? await submitCharged(method, input) : await rpc(method, input);
    if (result === null) return undefined;
    const updated = novelAdaptationStateSchema.parse(result);
    setMutationState(updated);
    void query.refresh();
    return updated;
  }

  async function submitCharged(method: string, input: object) {
    const key = JSON.stringify([method, input]);
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    const result = await charge(method, { ...input, requestId: request.current.id });
    if (result !== null) request.current = undefined;
    return result;
  }

  async function confirmReplacement(title: string, description: string, confirmLabel: string) {
    return confirm({ title, description, confirmLabel, variant: 'primary' });
  }

  async function saveSource() {
    if (!state || !source.trim()) return;
    if (!sourceChanged) { setSourceDraft(undefined); navigate('screenplay'); return; }
    if (sourceDraft?.base !== state.source) throw new Error('小说原文已在其他窗口修改。请重新打开后核对你的输入。');
    if (state.screenplay.text && !await confirmReplacement('更新小说原文？', '保存后需按新原文重新改写、审核和生成分镜。', '保存新原文')) return;
    if (await mutation('novelAdaptation.saveSource', { source: source.trim() })) {
      setSourceDraft(undefined);
      setScreenplayDraft(undefined);
      setRoleDraft(undefined);
      navigate('screenplay');
    }
  }

  async function importSource() {
    if (!state) return;
    setFileNotice('');
    const result = dramaScriptReadResultSchema.parse(await rpc('dramaScript.read', { path }));
    setSourceDraft({ base: sourceDraft?.base ?? state.source, value: result.text });
    setFileNotice(`已读取 ${result.fileName}，可编辑后保存。`);
    setPath('');
  }

  async function startGeneration(generationStep: GenerationStep) {
    if (!state || !selectedModelId || !enabled[generationStep]) return;
    const unsaved = generationStep === 'screenplay' ? screenplayChanged : generationStep === 'characters' && rolesChanged;
    const applied = generationStep === 'screenplay' ? state.screenplay.approved : state[generationStep].applied;
    if ((unsaved || applied) && !await confirmReplacement('重新生成当前步骤？',
      applied ? regenerationEffects[generationStep] : '当前步骤的未保存修改将被舍弃。', '重新生成')) return;
    const instruction = instructions[generationStep]?.trim();
    const updated = await mutation('novelAdaptation.start', {
      step: generationStep, modelId: selectedModelId,
      ...(generationStep === 'characters' ? { skillIds: selectedSkills } : {}),
      ...(instruction ? { instruction } : {}),
    }, true);
    if (updated) {
      setInstructions(current => ({ ...current, [generationStep]: '' }));
      if (generationStep === 'screenplay') setScreenplayDraft(undefined);
      if (generationStep === 'characters') setRoleDraft(undefined);
    }
  }

  async function approveScreenplay() {
    if (!state || !screenplay.trim()) return;
    if (screenplayDraft && screenplayDraft.base !== state.screenplay.text) throw new Error('导演剧本已更新。请重新打开后核对你的修改。');
    if (screenplayChanged && state.screenplay.approved && !await confirmReplacement('审核新版导演剧本？', '审核通过后需基于新版剧本重新确认角色资产和生成分镜。', '通过新版剧本')) return;
    if (await mutation('novelAdaptation.approve', { screenplay: screenplay.trim() })) {
      setScreenplayDraft(undefined);
      if (screenplayChanged) setRoleDraft(undefined);
      navigate('characters');
    }
  }

  function updateRole(key: string, patch: Partial<NovelCharacterAsset>) {
    if (!state) return;
    setRoleDraft(draft => ({
      base: draft?.base ?? state.characters.items,
      value: (draft?.value ?? state.characters.items).map(role => role.key === key ? { ...role, ...patch } : role),
    }));
  }

  async function applyRoles() {
    if (!state) return;
    if (roleDraft && JSON.stringify(roleDraft.base) !== JSON.stringify(state.characters.items)) throw new Error('角色资产已更新。请重新打开后核对你的修改。');
    if (rolesChanged && state.characters.applied && !await confirmReplacement('确认新版角色资产？', '确认后需用新角色设定重新生成分镜。', '确认新版角色资产')) return;
    const parsed = novelCharacterAssetsSchema.safeParse(roles);
    if (!parsed.success) throw new Error('请补齐每个角色的名称、设定和视觉提示词。');
    if (await mutation('novelAdaptation.applyCharacters', { characters: parsed.data })) {
      setRoleDraft(undefined);
      navigate('storyboard');
    }
  }

  async function generateRoleImage(role: NovelCharacterAsset) {
    const images = role.referenceAssetIds ?? [];
    if (!selectedImageModelId || !role.name.trim() || !role.visualPrompt.trim() || images.length >= 4) return;
    setGeneratingRoleKey(role.key);
    try {
      const result = await submitCharged('character.generateImage', {
        modelId: selectedImageModelId, name: role.name.trim(), prompt: role.visualPrompt.trim(),
      });
      if (result === null) return;
      const asset = assetSchema.parse(result);
      setGeneratedImages(current => ({ ...current, [role.key]: asset }));
      updateRole(role.key, { referenceAssetIds: [...new Set([...images, asset.id])] });
    } finally { setGeneratingRoleKey(undefined); }
  }

  async function recover(method: 'run.cancel' | 'run.resume' | 'run.step.retry', run: AdaptationRun) {
    if (await charge(method, { runId: run.id, ...(method === 'run.step.retry' ? { nodeId: run.nodeId } : {}) }) !== null) await query.refresh();
  }

  async function applyStoryboard() {
    if (project.shots.length && !await confirmReplacement('应用新分镜？', '应用后将替换工作台中的本集分镜。', '应用新分镜')) return;
    await mutation('novelAdaptation.applyStoryboard', {});
  }

  const generation = step === 'source' ? undefined : step;
  const instruction = generation ? instructions[generation] ?? '' : '';
  const rolesReady = state?.runs.characters?.status === 'succeeded' || Boolean(state?.characters.applied);
  const hasResult = { screenplay: Boolean(state?.screenplay.text), characters: rolesReady, storyboard: Boolean(state?.storyboard.shots.length) };
  const blockedBy = generation && blockers[generation];
  const runningStage = activeRun && generationSteps.find(stage => state?.runs[stage] === activeRun);
  const stageSummaries = {
    screenplay: hasResult.screenplay ? `${screenplay.length.toLocaleString('zh-CN')} 字符` : undefined,
    characters: rolesReady ? `${roles.length} 个角色` : undefined,
    storyboard: state?.storyboard.shots.length ? `${state.storyboard.shots.length} 个镜头 · ${duration.format(state.storyboard.shots.reduce((total, shot) => total + shot.durationUs, 0) / 1_000_000)} 秒` : undefined,
  };
  const awaitingAction = generation === 'screenplay' && hasResult.screenplay && (!saved.screenplay || screenplayChanged)
    || generation === 'characters' && rolesReady && (!saved.characters || rolesChanged)
    || generation === 'storyboard' && hasResult.storyboard && !saved.storyboard;
  const generationLabel = generation && (hasResult[generation]
    ? instruction.trim() ? stageCopy[generation].revise : stageCopy[generation].repeat
    : stageCopy[generation].first);

  function advance(label: string, action: Pending, operation: () => Promise<void>, disabled = false) {
    return <Button variant="primary" busy={pending === action} disabled={disabled || !canEdit}
      onClick={() => void perform(action, operation)}>{label}<ArrowRight size={16} aria-hidden="true" /></Button>;
  }

  function checkpointLabel(stage: Step) {
    if (stage === 'source') return sourceChanged ? '待保存' : saved.source ? '已保存' : '待添加';
    if (!visible[stage]) return lockedReasons[stage];
    if (blockers[stage]) return '待上一步提交';
    const run = state?.runs[stage];
    if (run && run.status !== 'succeeded') return run.status === 'queued' && run.error ? '需要核对' : statusLabels[run.status];
    if (stage === 'screenplay' && screenplayChanged) return '待审核';
    if (stage === 'characters' && rolesChanged) return '待确认';
    if (saved[stage]) return { screenplay: '已审核', characters: '已确认', storyboard: '已应用' }[stage];
    return hasResult[stage] ? { screenplay: '待审核', characters: '待确认', storyboard: '待应用' }[stage] : '待生成';
  }

  const reviewAction = awaitingAction && !blockedBy && (generation === 'screenplay'
    ? advance('审核通过', 'approve', approveScreenplay, !screenplay.trim() || !enabled.screenplay)
    : generation === 'characters' ? advance('确认角色资产', 'characters', applyRoles,
      !enabled.characters || roles.some(role => !role.name.trim() || !role.description.trim() || !role.visualPrompt.trim()))
      : advance('应用分镜', 'storyboard', applyStoryboard, state?.runs.storyboard?.status !== 'succeeded' || !enabled.storyboard));
  const artifactCount = [state?.screenplay.text.trim(), state?.characters.items.length, state?.storyboard.shots.length].filter(Boolean).length;
  const artifacts = state && artifactCount > 0 ? <AdaptationArtifacts state={state} step={step} disabled={busy} onOpen={openArtifact} /> : undefined;

  return <section className="novel-adaptation" aria-labelledby={`${panelId}-workspace-title`} hidden={!active}>
    <header className="novel-adaptation__workspace-header">
      <div className="novel-adaptation__checkpoints">
        <div className="novel-adaptation__overview">
          <h2 id={`${panelId}-workspace-title`}>小说改编</h2>
          {state && <div className="novel-adaptation__completion">
            <span>已完成 {completedSteps} / {stages.length}</span>
            <div className="novel-adaptation__progress" aria-hidden="true">
              {stages.map(stage => <span key={stage} data-complete={saved[stage] || undefined} />)}
            </div>
          </div>}
        </div>
        {state && <nav aria-label="小说改编阶段">
          <ol className="novel-adaptation__stage-list">{stages.map(stage => {
            const reachable = stage === 'source' || visible[stage];
            const complete = saved[stage] && draftStep !== stage && (stage === 'source' || !blockers[stage]);
            const Icon = !reachable ? LockKeyhole : complete ? Check : stageIcons[stage];
            const status = checkpointLabel(stage);
            return <li key={stage}><Button className="novel-adaptation__stage" static variant="ghost" disabled={!reachable || busy}
              aria-label={`${stageLabels[stage]}，${status}`} aria-current={stage === step ? 'step' : undefined}
              aria-controls={reachable ? `${panelId}-${stage}-panel` : undefined} data-next={stage === nextStep || undefined}
              data-status={stage === 'source' ? undefined : state.runs[stage]?.status}
              data-complete={complete || undefined} data-running={stage === runningStage || undefined} onClick={() => navigate(stage)}>
              <span className="novel-adaptation__stage-icon"><Icon size={16} aria-hidden="true" /></span>
              <span className="novel-adaptation__stage-copy"><strong>{stageLabels[stage]}</strong><small>{status}</small></span>
            </Button></li>;
          })}</ol>
        </nav>}
      </div>
    </header>
    {artifacts && <details className="novel-adaptation__artifact-disclosure" ref={artifactDisclosure}>
      <summary><Layers size={16} aria-hidden="true" />本集产物<span>{artifactCount} 项</span><ChevronDown size={16} strokeWidth={1.5} aria-hidden="true" /></summary>
      {artifacts}
    </details>}
    <div ref={scroll} className="novel-adaptation__body">
      <div className="novel-adaptation__thread" role="log" aria-label="创作对话" aria-relevant="additions">
        {query.error && <Notice kind="error">{query.error} <Button onClick={() => void query.refresh()}>重新读取</Button></Notice>}
        {!state && !query.error && <p role="status">正在读取本集改编进度…</p>}
        {state && <>
          {step === 'source' ? <AdaptationTurn human={Boolean(state.source)} card active>
            <section className="novel-adaptation__panel" data-active id={`${panelId}-source-panel`} aria-labelledby={`${panelId}-source-title`}>
              <header className="novel-adaptation__heading">
                <h3 ref={heading} tabIndex={-1} id={`${panelId}-source-title`}>小说原文</h3>
              </header>
              <div className="novel-adaptation__source-layout">
                <div className="novel-adaptation__import">
                  <h4><FileUp size={16} aria-hidden="true" />从文件读取</h4>
                  <Field label="小说文件路径" hint="支持 TXT、Markdown、DOCX 和含文本的 PDF。">{field => <PathPicker field={field} label="小说文件路径"
                    value={path} onChange={value => { setPath(value); setFileNotice(''); }}
                    placeholder="粘贴本地文件路径" extensions={['txt', 'md', 'markdown', 'docx', 'pdf']} disabled={!canEdit} />}</Field>
                  <Button disabled={!canEdit || !path.trim()} busy={pending === 'read-source'} onClick={() => void perform('read-source', importSource)}>读取小说</Button>
                  {fileNotice && <Notice kind="success">{fileNotice}</Notice>}
                </div>
                <div className="novel-adaptation__source-editor">
                  <Field label="小说原文" required hint="粘贴或编辑本集要改编的原文。">
                    <textarea className="novel-adaptation__document" rows={10} maxLength={MAX_NOVEL_SOURCE_LENGTH} value={source} disabled={!canEdit}
                      onChange={event => setSourceDraft({ base: sourceDraft?.base ?? state.source, value: event.target.value })} />
                  </Field>
                  <div className="novel-adaptation__metadata">{source.length.toLocaleString('zh-CN')} / {MAX_NOVEL_SOURCE_LENGTH.toLocaleString('zh-CN')} 字符</div>
                </div>
              </div>
              {sourceChanged && state.screenplay.text && <Notice>保存新原文后，本集需要重新改写和审核导演剧本。</Notice>}
              {running && error && <Notice kind="error">{error}</Notice>}
            </section>
          </AdaptationTurn> : <AdaptationTurn human source>
            <header className="novel-adaptation__heading" id={`${panelId}-source-panel`}>
              <h3 id={`${panelId}-source-title`}>小说原文</h3>
              <span className="novel-adaptation__metadata">{state.source.length.toLocaleString('zh-CN')} 字符</span>
              <Button static variant="ghost" disabled={!canEdit} onClick={() => navigate('source')}><Pencil size={16} aria-hidden="true" />修改原文</Button>
            </header>
            <p className="novel-adaptation__excerpt" data-truncated={longSource || undefined}>{state.source}</p>
            {longSource && <details className="form-disclosure novel-adaptation__original"><summary>查看原文</summary>
              <p className="novel-adaptation__original-text">{state.source}</p>
            </details>}
          </AdaptationTurn>}

          {generationSteps.filter(stage => visible[stage]).map(stage => {
            const active = stage === step;
            const run = state.runs[stage];
            const editable = canEdit && enabled[stage];
            const { label, open } = stageCopy[stage];
            const titleId = `${panelId}-${stage}-title`;
            return <Fragment key={stage}>
              {run?.instruction && <AdaptationTurn human><p className="novel-adaptation__instruction">{run.instruction}</p></AdaptationTurn>}
              <AdaptationTurn card active={active}>
                <section className="novel-adaptation__panel" data-active={active || undefined} id={`${panelId}-${stage}-panel`} aria-labelledby={titleId}>
                  <header className="novel-adaptation__heading">
                    <h3 ref={active ? heading : undefined} tabIndex={active ? -1 : undefined} id={titleId}>{label}</h3>
                    {stageSummaries[stage] && <span className="novel-adaptation__metadata novel-adaptation__result-count">{stageSummaries[stage]}</span>}
                    {!active && <Button static variant="ghost" disabled={busy} onClick={() => navigate(stage)}>{open}<ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" /></Button>}
                  </header>
                  {run && <GenerationStatus key={run.id} run={run} version={workspace.version} disabled={busy} onAction={method => void perform('recovery', () => recover(method, run))} />}
                  {active && stage === 'screenplay' && <>
                    {state.screenplay.text ? <>
                      <Field label="导演剧本文字" required>
                        <textarea className="novel-adaptation__document" rows={11} value={screenplay} maxLength={MAX_DIRECTOR_SCREENPLAY_LENGTH} disabled={!editable}
                          onChange={event => setScreenplayDraft({ base: screenplayDraft?.base ?? state.screenplay.text, value: event.target.value })} />
                      </Field>
                      {screenplayChanged && state.screenplay.approved && <Notice>新版剧本审核通过后，需要重新确认角色资产。</Notice>}
                    </> : <p>我会把原文改写成包含场次、动作和对白的导演剧本。生成后请逐段核对。</p>}
                  </>}

                  {active && stage === 'characters' && <>
                    {!rolesReady && <p>我会根据已审核的剧本，为出场人物整理设定和参考图提示词。</p>}
                    {roles.length > 0 && <ul className="novel-adaptation__results">{roles.map((role, index) => <li key={role.key}>
                      <details className="form-disclosure" data-artifact={`characters-${index}`}><summary>{role.name.trim() || `角色 ${index + 1}`}</summary>
                        <div className="form-disclosure__body novel-adaptation__role">
                          <Field label="角色名称" required><input value={role.name} maxLength={100} disabled={!editable} onChange={event => updateRole(role.key, { name: event.target.value })} /></Field>
                          <Field label="角色设定" required><textarea rows={3} value={role.description} maxLength={2000} disabled={!editable} onChange={event => updateRole(role.key, { description: event.target.value })} /></Field>
                          <Field label="视觉提示词" required><textarea rows={4} value={role.visualPrompt} maxLength={4000} disabled={!editable} onChange={event => updateRole(role.key, { visualPrompt: event.target.value })} /></Field>
                          <fieldset className="novel-adaptation__references" disabled={!editable}><CreativeReferencePicker value={role.referenceAssetIds} version={workspace.version}
                            label={`${role.name.trim() || `角色 ${index + 1}`}的参考图`} onChange={referenceAssetIds => updateRole(role.key, { referenceAssetIds })} /></fieldset>
                          {imageModels.length > 0 && <div className="novel-adaptation__generation">
                            <Field label="参考图模型"><Select value={selectedImageModelId} onChange={event => setImageModelId(event.target.value)} disabled={!editable}>
                              {imageModels.map(model => <option key={model.id} value={model.id}>{model.name} · {model.model}</option>)}
                            </Select></Field>
                            <Button disabled={!editable || !role.name.trim() || !role.visualPrompt.trim() || (role.referenceAssetIds?.length ?? 0) >= 4}
                              busy={generatingRoleKey === role.key} onClick={() => void perform('role-image', () => generateRoleImage(role))}>
                              <ImagePlus size={16} aria-hidden="true" />生成并添加参考图
                            </Button>
                          </div>}
                          {role.referenceAssetIds?.includes(generatedImages[role.key]?.id) && <figure className="novel-adaptation__reference-preview">
                            <ReferenceImage asset={generatedImages[role.key]} context="character" /><figcaption>已添加到角色参考图</figcaption>
                          </figure>}
                        </div>
                      </details>
                      {role.description.trim() && <p className="novel-adaptation__role-summary">{role.description}</p>}
                    </li>)}</ul>}
                    {rolesReady && roles.length === 0 && <Notice>本集未提取到出场角色，可以确认后继续分镜。</Notice>}
                    {rolesChanged && state.characters.applied && <Notice>确认新版角色资产后，需要重新生成分镜。</Notice>}
                  </>}

                  {active && stage === 'storyboard' && <>
                    {state.storyboard.shots.length ? <StoryboardShots shots={state.storyboard.shots} /> : <p>我会用已审核的剧本和确认的角色，把场次拆成可以制作的镜头。</p>}
                    {state.storyboard.applied && onOpenCharacters && <div className="novel-adaptation__actions">
                      <Button variant="ghost" disabled={!editable} onClick={onOpenCharacters}>打开公共角色库</Button>
                    </div>}
                  </>}
                  {active && error && running && <Notice kind="error">{error}</Notice>}
                </section>
              </AdaptationTurn>
            </Fragment>;
          })}
        </>}
      </div>
    </div>
    {state && !query.error && (!running || runningStage !== step) && <div className="novel-adaptation__footer">
      {error && <Notice kind="error">{error}</Notice>}
      {runningStage && activeRun ? <div className="novel-adaptation__footer-row">
        <span role="status">{stageLabels[runningStage]} · {statusLabels[activeRun.status]}</span>
        <Button variant="ghost" onClick={() => navigate(runningStage)}>查看进度<ArrowRight size={16} aria-hidden="true" /></Button>
      </div> : blockedBy ? <div className="novel-adaptation__footer-row">
        <span>请先处理{draftLabels[blockedBy]}。</span><Button onClick={() => navigate(blockedBy)}>返回{stageLabels[blockedBy]}</Button>
      </div> : generation ? <form className="novel-adaptation__composer" aria-label="发送创作要求" onSubmit={event => { event.preventDefault(); void perform('start', () => startGeneration(generation)); }}>
        <Field label="创作要求"><textarea className="novel-adaptation__composer-input" rows={2} maxLength={MAX_NOVEL_ADAPTATION_INSTRUCTION_LENGTH}
          value={instruction} placeholder={stageCopy[generation].placeholder} disabled={!canEdit || !enabled[generation]}
          onChange={event => { const text = event.target.value; setInstructions(current => ({ ...current, [generation]: text })); }}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey
              || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.repeat) return;
            event.preventDefault();
            if (canEdit && selectedModelId && enabled[generation]) event.currentTarget.form?.requestSubmit();
          }} /></Field>
        <div className="novel-adaptation__composer-toolbar">
          <div className="novel-adaptation__composer-tools">
            <Field label="文本模型" required><Select value={selectedModelId} onChange={event => setModelId(event.target.value)} disabled={!canEdit}
              title={textModels.find(model => model.id === selectedModelId)?.name}>
              {textModels.length === 0 && <option value="">暂无可用文本模型</option>}
              {textModels.map(model => <option key={model.id} value={model.id}>{model.name} · {model.model}</option>)}
            </Select></Field>
            {generation === 'characters' && <SkillPicker label="角色创作 Skill" skills={availableSkills} groups={workspace.skillGroups}
              value={selectedSkills} onChange={setSkillIds} disabled={!canEdit} />}
          </div>
          <div className="novel-adaptation__actions novel-adaptation__composer-actions">
            <Button type="submit" className="novel-adaptation__composer-send" variant={hasResult[generation] ? 'default' : 'primary'}
              disabled={!canEdit || !selectedModelId || !enabled[generation]} busy={pending === 'start'}
              title="Enter 发送，Shift+Enter 换行">{generationLabel}<ArrowUp size={16} aria-hidden="true" /></Button>
            {reviewAction}
            {generation === 'storyboard' && state.storyboard.applied && onOpenStoryboard && <Button variant="primary" disabled={!canEdit || !enabled.storyboard}
              onClick={() => onOpenStoryboard(state.projectRevision)}>打开分镜编辑器<ArrowRight size={16} aria-hidden="true" /></Button>}
          </div>
        </div>
        {textModels.length === 0 && <p className="field__hint">可在「模型连接」添加文本模型。</p>}
      </form> : <div className="novel-adaptation__footer-row" data-source>
        {advance('保存原文', 'source', saveSource, !source.trim())}
      </div>}
    </div>}
    {state && <aside className="novel-adaptation__artifact-rail" aria-labelledby={`${panelId}-artifacts-title`}>
      <h3 id={`${panelId}-artifacts-title`}><Layers size={16} aria-hidden="true" />本集产物</h3>
      {artifacts ?? <p>生成的剧本、角色和分镜会汇集在这里。</p>}
    </aside>}
  </section>;
}

function AdaptationArtifacts({ state, step, disabled, onOpen }: { state: NovelAdaptationState; step: Step; disabled: boolean; onOpen(target: ArtifactTarget): void }) {
  const screenplay = state.screenplay.text.trim();
  const excerpt = screenplay.length > 96 ? `${screenplay.slice(0, 96).trimEnd()}…` : screenplay;
  const groups = [
    {
      stage: 'characters', count: state.characters.items.length, unit: '个角色',
      items: state.characters.items.slice(0, 3).map((role, index) => ({
        id: role.key, label: role.name.trim() || `角色 ${index + 1}`,
        meta: role.referenceAssetIds?.length ? `${role.referenceAssetIds.length} 张参考图` : undefined,
      })),
    },
    {
      stage: 'storyboard', count: state.storyboard.shots.length, unit: '个镜头',
      items: state.storyboard.shots.slice(0, 3).map((shot, index) => ({
        id: shot.id, label: `${index + 1}. ${shot.title}`, meta: `${duration.format(shot.durationUs / 1_000_000)} 秒`,
      })),
    },
  ] as const;
  return <div className="novel-adaptation__artifacts">
    {screenplay && <div className="novel-adaptation__artifact" data-current={step === 'screenplay' || undefined}>
      <Button static variant="ghost" className="novel-adaptation__artifact-heading" aria-label="定位导演剧本" disabled={disabled} onClick={() => onOpen({ stage: 'screenplay' })}>
        <ScrollText size={16} aria-hidden="true" /><strong>导演剧本</strong><ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" />
      </Button>
      <p>{excerpt}</p>
    </div>}
    {groups.map(({ stage, count, unit, items }) => {
      if (!count) return null;
      const Icon = stageIcons[stage];
      return <div className="novel-adaptation__artifact" data-current={stage === step || undefined} key={stage}>
        <Button static variant="ghost" className="novel-adaptation__artifact-heading" aria-label={`定位${stageLabels[stage]}`} disabled={disabled} onClick={() => onOpen({ stage })}>
          <Icon size={16} aria-hidden="true" /><strong>{stageLabels[stage]}</strong><small>{count} {unit}</small><ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" />
        </Button>
        <ul aria-label={stageLabels[stage]}>
          {items.map(({ id, label, meta }, index) => <li key={id}>
            <Button static variant="ghost" className="novel-adaptation__artifact-link" disabled={disabled} onClick={() => onOpen({ stage, index })}>
              <span>{label}</span>{meta && <small>{meta}</small>}
            </Button>
          </li>)}
        </ul>
      </div>;
    })}
  </div>;
}

function AdaptationTurn({ children, human = false, card = false, source = false, active = false }: { children: ReactNode; human?: boolean; card?: boolean; source?: boolean; active?: boolean }) {
  const Icon = human ? UserRound : Clapperboard;
  const alignment = human ? 'user' : 'assistant';
  const appearance = card ? ' novel-adaptation__message--card' : source ? ' novel-adaptation__message--source' : '';
  return <div className={`novel-adaptation__turn novel-adaptation__turn--${alignment}`} data-active={active || undefined}>
    <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
    <div className={`novel-adaptation__message${appearance}`}>{children}</div>
  </div>;
}

function GenerationStatus({ run, version, disabled, onAction }: { run: AdaptationRun; version: number; disabled: boolean; onAction(method: 'run.cancel' | 'run.resume' | 'run.step.retry'): void }) {
  const running = runInProgress(run);
  const needsRecovery = !running && run.status !== 'succeeded';
  const inspection = useRuntimeRead('run.inspect', { runId: run.id }, version, runInspectionSchema, needsRecovery);
  const failed = inspection.data?.steps.find(step => step.id === run.nodeId)?.retry;
  const resume = inspection.data?.recovery.resume;
  if (run.status === 'succeeded') return null;
  return <div className="novel-adaptation__run" data-running={running || undefined}>
    <div className="novel-adaptation__run-status" role="status"><Status value={run.status} />{running && <span>任务在后台继续，可稍后回来查看结果。</span>}</div>
    {run.error && <Notice kind="error">{run.error}</Notice>}
    {inspection.error && needsRecovery && <Notice kind="error">{inspection.error} <Button disabled={disabled} onClick={() => void inspection.refresh()}>重新读取恢复状态</Button></Notice>}
    <div className="novel-adaptation__actions">
      {running && <Button disabled={disabled} onClick={() => onAction('run.cancel')}>停止生成</Button>}
      {needsRecovery && failed?.allowed && <Button disabled={disabled} onClick={() => onAction('run.step.retry')}>重试此步骤</Button>}
      {needsRecovery && resume && <Button disabled={disabled} onClick={() => onAction('run.resume')}>继续生成</Button>}
    </div>
  </div>;
}

function StoryboardShots({ shots }: { shots: Shot[] }) {
  return <ol className="novel-adaptation__results novel-adaptation__shots" aria-label="生成的分镜">{shots.map((shot, index) => <li key={shot.id}>
    <details className="form-disclosure" data-artifact={`storyboard-${index}`}><summary><span>{index + 1}. {shot.title}</span><span>{duration.format(shot.durationUs / 1_000_000)} 秒</span></summary>
      <dl className="form-disclosure__body">
        <div><dt>画面</dt><dd>{shot.visualPrompt}</dd></div>
        {shot.narration && <div><dt>对白与旁白</dt><dd>{shot.narration}</dd></div>}
        {shot.soundPrompt && <div><dt>声音</dt><dd>{shot.soundPrompt}</dd></div>}
      </dl>
    </details>
  </li>)}</ol>;
}
