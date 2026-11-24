import { useEffect, useId, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import { ArrowLeft, ArrowRight, Check, Clapperboard, FileText, History, ListVideo, Plus, Workflow } from 'lucide-react';
import {
  CREATIVE_REFERENCE_IMAGE_MAX_BYTES, creativeObjectivePlanSchema, creativeObjectiveRoutes,
  creativeNarrationSentences, creativePlanningEntrySchema, creativePlanningResultSchema, creativeStyleCardSchema, isRunActive,
  planningDocumentSections, projectSchema, recordPageSchema, type CreativeObjectivePlan, type CreativePlanningResult, type CreativeRevisionScope, type CreativeStyleCard,
  type ProjectDocument, type Shot,
} from '@video-quickly/contracts';
import { useChargeRpc } from '../components/ConfirmationDialog';
import PathPicker from '../components/PathPicker';
import { Button, Dialog, Field, Notice, Select, Status, formatTime } from '../components/Primitives';
import ReferenceImage from '../components/ReferenceImage';
import SkillPicker from '../components/SkillPicker';
import type { Action, WorkspaceView } from '../lib/types';
import { useRecordPage } from '../lib/use-record-page';
import { useRuntimeRead } from '../lib/use-runtime-read';
import CreativePreviewPanel from './CreativePreviewPanel';
import './creative-planning.css';

const creationsSchema = recordPageSchema(creativePlanningEntrySchema);
const cardsSchema = recordPageSchema(creativeStyleCardSchema);
type TimingOption = CreativeObjectivePlan['options'][number];
type RevisionField = CreativeRevisionScope['fields'][number];
type PlanningView = 'compose' | 'proposal' | 'revision' | 'history' | { runId: string };
const maxGoalLength = 3000;
export type CreativePlanningThreadRequest = { sequence: number; goal?: string; history?: boolean };
export type CreativePlanningHandle = { draftStatus(): 'empty' | 'edited' | 'busy' };
const revisionLabels: Record<RevisionField, string> = {
  title: '镜头标题', narration: '对白或旁白', visualPrompt: '画面要求', soundPrompt: '声音要求', lineText: '单句台词',
};
const revisionFields: RevisionField[] = ['title', 'narration', 'lineText', 'visualPrompt', 'soundPrompt'];
const planningStages = [
  { label: '创作目标', icon: FileText },
  { label: '确认方案', icon: Workflow },
  { label: '创作结果', icon: ListVideo },
];

type ProjectRevisionSource = {
  project: ProjectDocument;
  initialShotId: string;
  saveBeforeRevision(): Promise<number | null>;
  applyRevision(runId: string): Promise<boolean>;
};

export default function CreativePlanningDialog({ ref, workspace, action, onClose, onEdit, projectRevision, presentation = 'dialog', active = true, threadRequest }: {
  ref?: Ref<CreativePlanningHandle>;
  workspace: WorkspaceView; action: Action; onClose(): void; onEdit?(projectId: string): void; projectRevision?: ProjectRevisionSource;
  presentation?: 'dialog' | 'workspace'; active?: boolean; threadRequest?: CreativePlanningThreadRequest;
}) {
  const inWorkspace = presentation === 'workspace' && !projectRevision;
  const chargeRpc = useChargeRpc();
  const [view, setView] = useState<PlanningView>(projectRevision ? 'revision' : 'compose');
  const [historyReturnView, setHistoryReturnView] = useState<Exclude<PlanningView, 'history'>>();
  const [goal, setGoal] = useState('');
  const [threadGoal, setThreadGoal] = useState<string>();
  const [path, setPath] = useState('');
  const [selectedCard, setSelectedCard] = useState<CreativeStyleCard>();
  const [modelId, setModelId] = useState(() => projectRevision?.project.workflow.nodes.find(node => node.kind === 'script')?.modelId
    ?? projectRevision?.project.workflow.production.textModelId ?? '');
  const [plan, setPlan] = useState<CreativeObjectivePlan>();
  const [optionId, setOptionId] = useState('');
  const enabledSkills = workspace.skills.filter(skill => skill.enabled);
  const [skillIds, setSkillIds] = useState(() => enabledSkills.some(skill => skill.id === 'builtin-drama-storyboard') ? ['builtin-drama-storyboard'] : []);
  const initialSkills = useRef(skillIds);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const goalInput = useRef<HTMLTextAreaElement>(null);
  const routeHeading = useRef<HTMLHeadingElement>(null);
  const routeHeadingId = useId();
  const workspaceHeadingId = useId();
  const requestIdentity = useRef<{ key: string; id: string } | undefined>(undefined);
  const appliedThreadRequest = useRef<number | undefined>(undefined);
  const runId = typeof view === 'object' ? view.runId : undefined;
  const detail = useRuntimeRead('creativePlanning.get', { runId }, workspace.version, creativePlanningResultSchema, active && Boolean(runId));
  const run = detail.data;
  const parentRunId = run?.parentRunId;
  const previewRunId = run?.preview?.latestRunId;
  const previewDetail = useRuntimeRead('creativePlanning.get', { runId: previewRunId }, workspace.version, creativePlanningResultSchema, active && Boolean(previewRunId));
  const models = workspace.models.filter(model => model.enabled && model.capabilities.includes('text')
    && ['openai-compatible', 'ollama'].includes(model.provider));
  const sourceModels = !projectRevision && !selectedCard && path.trim() ? models.filter(model => model.capabilities.includes('vision')) : models;
  const defaultModel = !projectRevision && !selectedCard ? sourceModels.find(model => model.capabilities.includes('vision')) ?? sourceModels[0] : sourceModels[0];
  const selectedModel = sourceModels.some(model => model.id === modelId) ? modelId : defaultModel?.id ?? '';
  const planModel = models.find(model => model.id === plan?.modelId);
  const styleOnly = plan?.route === 'style-only';
  const timingOption = plan?.options.find(option => option.id === optionId);
  const needsReferenceImage = styleOnly || !selectedCard;
  const canReadReference = Boolean(planModel && (!needsReferenceImage || planModel.capabilities.includes('vision')));
  const hasDraftInput = Boolean(goal.trim() || path.trim() || selectedCard || plan || modelId
    || skillIds.length !== initialSkills.current.length || skillIds.some((id, index) => id !== initialSkills.current[index]));
  const hasDraftInHistory = hasDraftInput && (historyReturnView === 'compose' || historyReturnView === 'proposal');
  useImperativeHandle(ref, () => ({
    draftStatus() {
      if (inFlight.current) return 'busy';
      return hasDraftInHistory || (view === 'compose' || view === 'proposal') && hasDraftInput ? 'edited' : 'empty';
    },
  }));
  useEffect(() => {
    if (!inWorkspace || !active || !threadRequest || appliedThreadRequest.current === threadRequest.sequence) return;
    appliedThreadRequest.current = threadRequest.sequence;
    if (inFlight.current) return;
    if (threadRequest.history) { openHistory(); return; }
    if (threadRequest.goal === undefined) return;
    const nextGoal = threadRequest.goal.trim();
    if (nextGoal.length > maxGoalLength) { setError(`创作目标最多 ${maxGoalLength} 字。`); return; }
    setGoal(nextGoal); setThreadGoal(nextGoal); setPlan(undefined); setOptionId(''); setHistoryReturnView(undefined);
    requestIdentity.current = undefined;
    navigate('compose');
  }, [inWorkspace, active, threadRequest, view]);
  useEffect(() => {
    if (!active) return;
    if (view === 'compose') goalInput.current?.focus();
    if (view === 'proposal') routeHeading.current?.focus();
  }, [active, view]);

  function navigate(next: PlanningView) { setError(''); setView(next); }
  function openHistory() {
    if (view === 'history') return;
    if (!hasDraftInHistory) setHistoryReturnView(view);
    navigate('history');
  }
  function returnFromHistory() {
    const previous = historyReturnView ?? (projectRevision ? 'revision' : 'compose');
    setHistoryReturnView(undefined);
    navigate(previous);
  }
  async function perform(name: string, operation: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setPending(name); setError('');
    try { await operation(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { inFlight.current = false; setPending(''); }
  }
  function identifyRequest(method: string, input: object) {
    const key = JSON.stringify([method, input]);
    const requestId = requestIdentity.current?.key === key ? requestIdentity.current.id : crypto.randomUUID();
    requestIdentity.current = { key, id: requestId };
    return { ...input, requestId };
  }
  async function submit(method: 'creativePlanning.start' | 'creativePlanning.revise', params: object | (() => Promise<object | null>)) {
    await perform(method, async () => {
      const input = typeof params === 'function' ? await params() : params;
      if (!input) return;
      const value = await chargeRpc(method, identifyRequest(method, input));
      if (value === null) return;
      const result = creativePlanningResultSchema.parse(value);
      requestIdentity.current = undefined;
      if (method === 'creativePlanning.start') setPlan(undefined);
      navigate({ runId: result.id });
    });
  }
  function analyzeGoal() {
    const instruction = goal.trim();
    if (!instruction || !selectedModel) {
      setError(!selectedModel ? '请选择可用的文本模型。' : '请填写创作目标。');
      return;
    }
    if (inWorkspace) setThreadGoal(instruction);
    if (plan?.goal === instruction && plan.modelId === selectedModel) {
      navigate('proposal');
      return;
    }
    const method = 'creativePlanning.plan';
    return perform(method, async () => {
      const value = await chargeRpc(method, identifyRequest(method, { goal: instruction, modelId: selectedModel }));
      if (value === null) return;
      const nextPlan = creativeObjectivePlanSchema.parse(value);
      requestIdentity.current = undefined;
      setOptionId(!nextPlan.issues.length && nextPlan.options.length === 1 ? nextPlan.options[0].id : '');
      setPlan(nextPlan);
      navigate('proposal');
    });
  }
  function start() {
    if (!plan || !timingOption || !canReadReference) return;
    const selectedSkills = skillIds.filter(id => enabledSkills.some(skill => skill.id === id));
    if (!selectedSkills.length || (needsReferenceImage && !path.trim())) {
      setError(!selectedSkills.length ? '请至少选用一个创作 Skill。' : '请选择参考图。');
      return;
    }
    return submit('creativePlanning.start', {
      title: Array.from(plan.goal.split(/\r?\n/u, 1)[0]).slice(0, 60).join(''), goal: plan.goal,
      modelId: plan.modelId, skillIds: selectedSkills, reference: selectedCard && !styleOnly ? { styleCardId: selectedCard.id } : { path: path.trim() },
      plan: { id: plan.id, optionId: timingOption.id },
    });
  }
  function runAction(method: 'run.step.retry' | 'run.resume' | 'run.cancel', nodeId?: string, targetId = runId) {
    if (!targetId) return;
    return perform(method, async () => {
      if (await chargeRpc(method, { runId: targetId, ...(nodeId ? { nodeId } : {}) }) !== null) {
        await Promise.all([detail.refresh(), ...(targetId === previewRunId ? [previewDetail.refresh()] : [])]);
      }
    });
  }
  function runPreview(method: 'creativePlanning.previewRecommend' | 'creativePlanning.previewStart', input: object = {}) {
    if (!run?.preview) return;
    const params = { runId: run.id, revision: run.preview.revision, ...input };
    return perform(method, async () => {
      try {
        if (await chargeRpc(method, identifyRequest(method, params)) === null) return;
      } catch (reason) {
        if (method === 'creativePlanning.previewRecommend') requestIdentity.current = undefined;
        throw reason;
      }
      requestIdentity.current = undefined;
      await detail.refresh();
    });
  }
  function applyPreview(childId: string, shotId: string) {
    return perform('creativePlanning.previewApply', async () => {
      if (await action('creativePlanning.previewApply', { runId: childId, shotId }) === null) throw new Error('预演图尚未应用，请核对镜头状态后重试。');
      await detail.refresh();
    });
  }
  function reviseProject(scope: CreativeRevisionScope, instruction: string) {
    if (!projectRevision || !selectedModel) return;
    return submit('creativePlanning.revise', async () => {
      const revision = await projectRevision.saveBeforeRevision();
      return revision === null ? null : { projectId: projectRevision.project.id, revision, modelId: selectedModel, scope, instruction };
    });
  }
  function apply() {
    if (!run || !(run.target ? run.changes?.length : run.shots?.length)) return;
    if (run.appliedRevision !== undefined) { if (onEdit) onEdit(run.projectId); else onClose(); return; }
    return perform('creativePlanning.apply', async () => {
      if (projectRevision) {
        if (run.projectId !== projectRevision.project.id) throw new Error('改稿与当前项目不匹配。');
        if (!await projectRevision.applyRevision(run.id)) throw new Error('改稿尚未应用，请核对项目状态后重试。');
        onClose(); return;
      }
      const result = await action('creativePlanning.apply', { runId: run.id });
      if (result === null) throw new Error('分镜尚未应用，请核对项目状态后重试。');
      if (run.previewRootRunId) navigate({ runId: run.previewRootRunId });
      else onEdit?.(projectSchema.parse(result).id);
    });
  }

  const disabled = Boolean(pending);
  const bodyClass = inWorkspace ? 'creative-planning__workspace-body' : 'dialog__body form-stack';
  const historyButton = <Button static={inWorkspace} variant={inWorkspace ? 'ghost' : 'default'} disabled={disabled}
    onClick={inWorkspace ? openHistory : () => navigate('history')}><History size={16} aria-hidden="true" />创作记录</Button>;
  const confirmSource = view === 'proposal';
  const showCardPicker = !confirmSource || !styleOnly;
  const showReferencePicker = confirmSource ? needsReferenceImage : !selectedCard;
  const referenceFields = <>
    {showCardPicker && <StyleCardPicker version={workspace.version} value={selectedCard} disabled={disabled} onChange={setSelectedCard} />}
    {showReferencePicker && <Field label="参考图" hint={confirmSource ? `PNG、JPEG 或 WebP，最多 ${CREATIVE_REFERENCE_IMAGE_MAX_BYTES / 1024 ** 2} MB。` : undefined}
      required={confirmSource}>{field => <PathPicker field={field} label="参考图" value={path} onChange={setPath} required={confirmSource} disabled={disabled}
        extensions={['png', 'jpg', 'jpeg', 'webp']} placeholder="选择文件或输入本机路径" />}</Field>}
  </>;
  const skillField = <SkillPicker label="创作 Skill" skills={enabledSkills} groups={workspace.skillGroups} value={skillIds} disabled={disabled} onChange={setSkillIds} />;
  const goalField = <Field label="创作目标" required>{field => <textarea {...field} ref={goalInput} name="goal" required rows={3} maxLength={maxGoalLength} disabled={disabled} value={goal}
    placeholder="雨夜，侦探穿过霓虹街道找到留下线索的信封" onChange={event => setGoal(event.target.value)} onKeyDown={inWorkspace ? event => {
      if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.repeat) return;
      event.preventDefault();
      if (!disabled && selectedModel) event.currentTarget.form?.requestSubmit();
    } : undefined} />}</Field>;
  const modelField = <Field label="文本模型" required>{field => <Select {...field} name="modelId" required disabled={disabled} value={selectedModel} onChange={event => setModelId(event.target.value)}>
    <option value="" disabled>{sourceModels.length < models.length ? '暂无支持视觉的文本模型' : '暂无可用文本模型'}</option>
    {sourceModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
  </Select>}</Field>;
  const modelNotice = !sourceModels.length && <Notice>请在模型连接中添加或启用{!selectedCard && path.trim() ? '支持视觉的' : ''}文本模型。</Notice>;
  const analyzeButton = <Button type="submit" variant="primary" disabled={disabled || !selectedModel || inWorkspace && !goal.trim()} busy={pending === 'creativePlanning.plan'}
    title={inWorkspace ? 'Enter 发送，Shift+Enter 换行' : undefined}>
    分析创作目标<ArrowRight size={15} aria-hidden="true" />
  </Button>;
  const proposal = view === 'proposal' && plan && <>
        <div className="creative-planning__proposal">
          <h3 id={routeHeadingId} ref={routeHeading} tabIndex={-1}>{creativeObjectiveRoutes[plan.route]}</h3>
          <p>{plan.reason}</p>
        </div>
        {plan.issues.length > 0 && <Notice><span className="creative-planning__issues">{plan.issues.map((issue, index) => <span key={index}>{issue}</span>)}</span></Notice>}
        {plan.options.length === 0 && <p>请调整创作目标后重新分析。</p>}
        {plan.options.length > 0 && <>
          {plan.issues.length > 0 || plan.options.length > 1
            ? <fieldset className="creative-planning__timing" disabled={disabled}>
              <legend>选择时长方案</legend>
              {plan.options.map(option => <label className="creative-planning__option" key={option.id}>
                <input type="radio" name="timingOption" value={option.id} required checked={optionId === option.id} onChange={() => setOptionId(option.id)} />
                <span><strong>{option.label}</strong><TimingDetails option={option} /></span>
              </label>)}
            </fieldset>
            : <TimingDetails option={plan.options[0]} />}
          {referenceFields}{skillField}
          {!planModel && <Notice>已选文本模型不可用。请返回创作目标更换模型。</Notice>}
          {planModel && !canReadReference && <Notice>{styleOnly ? '提取风格需要支持视觉的文本模型。' : '参考图需要支持视觉的文本模型，也可选择已有风格卡。'}</Notice>}
        </>}
        {error && <Notice kind="error">{error}</Notice>}
  </>;
  const result = runId && <>
    {detail.error && <Notice kind="error">{detail.error}<Button onClick={() => void detail.refresh()}>重试读取</Button></Notice>}
    {!run && !detail.error && <p role="status">正在读取创作结果…</p>}
    {run && <PlanningResult key={run.id} run={run} disabled={disabled} busy={pending === 'creativePlanning.revise'} scopedOnly={Boolean(projectRevision)}
      inWorkspace={inWorkspace} visible={active} onRevise={(scope, instruction) => void submit('creativePlanning.revise', { runId: run.id, scope, instruction })} />}
    {!projectRevision && run?.preview && run.shots?.length && <CreativePreviewPanel key={`preview:${run.id}`} preview={run.preview} shots={run.shots} models={workspace.models}
      execution={previewDetail.data} readError={previewDetail.error} refreshExecution={previewDetail.refresh} pending={pending}
      onRecommend={() => void runPreview('creativePlanning.previewRecommend')}
      onGenerate={(shotIds, imageModelId) => void runPreview('creativePlanning.previewStart', { shotIds, imageModelId })}
      onApply={(childId, shotId) => void applyPreview(childId, shotId)}
      onRunAction={(method, nodeId) => { if (previewRunId) void runAction(method, nodeId, previewRunId); }} />}
    {error && <Notice kind="error">{error}</Notice>}
  </>;

  function newPlanning() {
    setGoal(''); setThreadGoal(undefined); setPlan(undefined); setOptionId(''); setPath(''); setSelectedCard(undefined); setHistoryReturnView(undefined);
    requestIdentity.current = undefined;
    navigate('compose');
  }

  const content = <>
    {view === 'compose' && <form className={inWorkspace ? 'creative-planning__workspace-form' : undefined} aria-label="分镜创作目标"
      onSubmit={event => { event.preventDefault(); void analyzeGoal(); }}>
      {inWorkspace ? <>
        <div className={bodyClass}>
          <PlanningTranscript goal={threadGoal}>
            <h3>{threadGoal ? '先梳理分镜方案' : '想拍什么样的镜头？'}</h3>
            <p>{threadGoal ? '可以补充时长、镜头数或画面风格，再开始分析。' : '描述画面、时长和镜头数，我会在制作前给出可确认的方案。'}</p>
            <div className="creative-planning__workspace-composer form-stack">
              {goalField}
              <div className="creative-planning__workspace-settings">{modelField}{referenceFields}{skillField}</div>
            </div>
            {modelNotice}
            {error && <Notice kind="error">{error}</Notice>}
          </PlanningTranscript>
        </div>
        <PlanningActions inWorkspace>
          {pending === 'creativePlanning.plan' && <span className="tiny-meta" role="status">正在分析创作目标…</span>}
          {analyzeButton}
        </PlanningActions>
      </> : <>
        <div className={bodyClass}>{goalField}{referenceFields}{skillField}{modelField}{modelNotice}{error && <Notice kind="error">{error}</Notice>}</div>
        <PlanningActions inWorkspace={false}>{historyButton}{analyzeButton}</PlanningActions>
      </>}
    </form>}
    {view === 'proposal' && plan && <form className={inWorkspace ? 'creative-planning__workspace-form' : undefined} aria-labelledby={routeHeadingId}
      onSubmit={event => { event.preventDefault(); void start(); }}>
      <div className={bodyClass}>
        {inWorkspace ? <PlanningTranscript goal={plan.goal}>{proposal}</PlanningTranscript> : proposal}
      </div>
      <PlanningActions inWorkspace={inWorkspace}>
        <Button disabled={disabled} onClick={() => navigate('compose')}><ArrowLeft size={16} aria-hidden="true" />返回创作目标</Button>
        <Button type="submit" variant="primary" disabled={disabled || !timingOption || !canReadReference}
          busy={pending === 'creativePlanning.start'}>确认并开始制作<ArrowRight size={15} aria-hidden="true" /></Button>
      </PlanningActions>
    </form>}
    {view === 'revision' && projectRevision && <div className="dialog__body"><RevisionForm shots={projectRevision.project.shots} initialShotId={projectRevision.initialShotId}
      disabled={disabled} busy={pending === 'creativePlanning.revise'} canSubmit={Boolean(selectedModel)}
      onRevise={(scope, instruction) => void reviseProject(scope, instruction)}>
      <Field label="文本模型" required>{field => <Select {...field} required disabled={disabled} value={selectedModel} onChange={event => setModelId(event.target.value)}>
        <option value="" disabled>暂无可用文本模型</option>
        {models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
      </Select>}</Field>
      {error && <Notice kind="error">{error}</Notice>}
    </RevisionForm></div>}
    {view === 'revision' && <div className="dialog__footer">{historyButton}</div>}
    {view === 'history' && <PlanningHistory version={workspace.version} projectId={projectRevision?.project.id} inWorkspace={inWorkspace} visible={active}
      onSelect={id => navigate({ runId: id })} onCompose={inWorkspace ? returnFromHistory : () => navigate(projectRevision ? 'revision' : 'compose')} />}
    {runId && <>
      <div className={bodyClass}>
        {inWorkspace ? <PlanningTranscript goal={run?.goal}>{result}</PlanningTranscript> : result}
      </div>
      <PlanningActions inWorkspace={inWorkspace}>
        {!inWorkspace && historyButton}
        {inWorkspace && (hasDraftInHistory
          ? <Button disabled={disabled} onClick={returnFromHistory}>继续分镜草稿</Button>
          : <Button disabled={disabled} onClick={newPlanning}><Plus size={16} aria-hidden="true" />新建分镜</Button>)}
        {run && (isRunActive(run.status) || run.status === 'needs_attention') && <Button disabled={disabled} busy={pending === 'run.cancel'} onClick={() => void runAction('run.cancel')}>停止</Button>}
        {run?.failedNodeId && !run.retryCompleted && <Button variant="primary" disabled={disabled} busy={pending === 'run.step.retry'} onClick={() => void runAction('run.step.retry', run.failedNodeId)}>重试此步骤</Button>}
        {run && (run.resumeAllowed || run.status === 'needs_attention' && run.retryCompleted) && <Button disabled={disabled} busy={pending === 'run.resume'} onClick={() => void runAction('run.resume')}>继续</Button>}
        {projectRevision && run && !isRunActive(run.status) && <Button disabled={disabled} onClick={() => navigate('revision')}>返回修改</Button>}
        {!projectRevision && run && parentRunId && !isRunActive(run.status) && <Button disabled={disabled} onClick={() => navigate({ runId: parentRunId })}>返回分镜</Button>}
        {run?.route === 'style-only' && run.status === 'succeeded' && <Button disabled={disabled} variant="primary" onClick={onClose}>完成</Button>}
        {run?.status === 'succeeded' && run.route !== 'style-only' && Boolean(run.target ? run.changes?.length : run.shots?.length) && <Button variant="primary" disabled={disabled} busy={pending === 'creativePlanning.apply'} onClick={() => void apply()}>{run.appliedRevision !== undefined ? (projectRevision ? '完成' : '编辑分镜') : run.target ? '确认应用' : '应用分镜并编辑'}</Button>}
      </PlanningActions>
    </>}
  </>;

  if (inWorkspace) return <section className="creative-planning creative-planning--workspace" aria-labelledby={workspaceHeadingId} hidden={!active}>
    <header className="creative-planning__workspace-header">
      <div className="creative-planning__workspace-heading">
        <h2 id={workspaceHeadingId}>创作分镜</h2>
        <div className="creative-planning__workspace-nav">
          {view !== 'history' && historyButton}
          <Button static variant="ghost" disabled={disabled} onClick={onClose}><ArrowLeft size={16} aria-hidden="true" />返回创作对话</Button>
        </div>
      </div>
      {view !== 'history' && <PlanningStages current={runId ? 2 : view === 'proposal' ? 1 : 0} finished={run?.status === 'succeeded'} />}
    </header>
    {content}
  </section>;

  return <Dialog title={projectRevision ? '修改镜头' : '创作分镜'} className="dialog--wide creative-planning" initialFocus={goalInput}
    dismissDisabled={disabled} dismissOnBackdrop={false} onClose={onClose}>{content}</Dialog>;
}

function PlanningActions({ inWorkspace, children }: { inWorkspace: boolean; children: ReactNode }) {
  if (!inWorkspace) return <div className="dialog__footer creative-planning__footer">{children}</div>;
  return <div className="creative-planning__workspace-dock"><div className="creative-planning__workspace-actions">{children}</div></div>;
}

function PlanningStages({ current, finished }: { current: number; finished: boolean }) {
  return <ol className="creative-planning__stages" role="list" aria-label="分镜创作进度">
    {planningStages.map(({ label, icon: Icon }, index) => {
      const done = index < current || index === current && finished;
      return <li key={label} data-complete={done || undefined} aria-current={index === current ? 'step' : undefined}>
        {done ? <span role="img" aria-label="已完成"><Check size={15} aria-hidden="true" /></span> : <span aria-hidden="true"><Icon size={15} /></span>}{label}
      </li>;
    })}
  </ol>;
}

function PlanningTranscript({ goal, children }: { goal?: string; children: ReactNode }) {
  return <div className="creative-planning__transcript" role="log" aria-label="分镜创作对话" aria-relevant="additions">
    {goal && <div className="creative-planning__turn creative-planning__turn--user">
      {goal.length <= 220 ? <p className="creative-planning__bubble">{goal}</p> : <details className="creative-planning__bubble">
        <summary>查看完整创作目标</summary><p>{goal}</p>
      </details>}
    </div>}
    <div className="creative-planning__turn">
      <Clapperboard size={18} aria-hidden="true" /><div className="creative-planning__bubble form-stack">{children}</div>
    </div>
  </div>;
}

function TimingDetails({ option }: { option: TimingOption }) {
  const { shotDurationsUs } = option;
  if (!shotDurationsUs.length) return null;
  const seconds = shotDurationsUs.map(duration => duration / 1_000_000);
  const total = shotDurationsUs.reduce((sum, duration) => sum + duration, 0) / 1_000_000;
  const durations = seconds.every(duration => duration === seconds[0]) ? `每镜 ${seconds[0]} 秒` : `${seconds.join(' / ')} 秒`;
  return <span className="creative-planning__timing-meta">
    <span>{seconds.length} 镜 · 共 {total} 秒 · {durations}</span>
  </span>;
}

function PaletteSwatches({ card }: { card: CreativeStyleCard }) {
  return <ul className="creative-planning__swatches" aria-label="色板">{card.swatches.map(({ hex, label }, index) => <li key={`${hex}:${index}`}>
    <span className="creative-planning__swatch" style={{ backgroundColor: hex }} aria-hidden="true" />
    <span>{label} <code>{hex}</code></span>
  </li>)}</ul>;
}

function StyleCardPicker({ version, value, disabled, onChange }: { version: number; value?: CreativeStyleCard; disabled: boolean; onChange(card?: CreativeStyleCard): void }) {
  const cards = useRecordPage('creativePlanning.styleCards', { limit: 20 }, version, cardsSchema);
  const choices = value && !cards.items.some(card => card.id === value.id) ? [value, ...cards.items] : cards.items;
  return <>
    {choices.length > 0 && <Field label="已有风格卡">{field => <Select {...field} disabled={disabled} value={value?.id ?? ''} onChange={event => onChange(choices.find(card => card.id === event.target.value))}>
      <option value="">从参考图提取新风格</option>
      {choices.map(card => <option key={card.id} value={card.id}>{card.title}</option>)}
    </Select>}</Field>}
    {value && <PaletteSwatches card={value} />}
    {cards.error && <Notice kind="error">{cards.error}<Button onClick={cards.refresh}>重试读取风格卡</Button></Notice>}
    {cards.nextCursor !== null && <Button disabled={disabled || !cards.canLoadMore} busy={cards.loadingMore} onClick={() => void cards.loadMore()}>加载更多风格卡</Button>}
  </>;
}

function PlanningHistory({ version, projectId, inWorkspace, visible, onSelect, onCompose }: {
  version: number; projectId?: string; inWorkspace: boolean; visible: boolean;
  onSelect(id: string): void; onCompose(): void;
}) {
  const focus = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (visible) focus.current?.focus(); }, [visible]);
  const history = useRecordPage('creativePlanning.list', { limit: 20, projectId }, version, creationsSchema);
  return <>
    <div className={inWorkspace ? 'creative-planning__workspace-body creative-planning__workspace-history form-stack' : 'dialog__body form-stack'}>
      <h3 ref={focus} tabIndex={-1}>创作记录</h3>
      {history.error && <Notice kind="error">{history.error}<Button onClick={history.refresh}>重试读取记录</Button></Notice>}
      {history.busy && !history.hasLoaded && <p role="status">正在读取创作记录…</p>}
      {history.hasLoaded && !history.items.length && !history.error && <p>还没有已保存的创作。</p>}
      <ul className="creative-planning__history" aria-label="已保存的创作">{history.items.map(item => <li key={item.id}>
        <Button static variant="ghost" onClick={() => onSelect(item.id)}>
          <span>{item.title}{item.parentRunId ? ' · 镜头修改' : ''}</span><Status value={item.status} /><ArrowRight size={15} aria-hidden="true" />
        </Button>
      </li>)}</ul>
      {history.nextCursor !== null && <Button disabled={!history.canLoadMore} busy={history.loadingMore} onClick={() => void history.loadMore()}>加载更多记录</Button>}
    </div>
    <PlanningActions inWorkspace={inWorkspace}><Button onClick={onCompose}><ArrowLeft size={16} aria-hidden="true" />{projectId ? '返回修改' : '返回创作'}</Button></PlanningActions>
  </>;
}

function PlanningResult({ run, disabled, busy, scopedOnly, inWorkspace, visible, onRevise }: {
  run: CreativePlanningResult; disabled: boolean; busy: boolean; scopedOnly: boolean; visible: boolean;
  inWorkspace: boolean;
  onRevise(scope: CreativeRevisionScope, instruction: string): void;
}) {
  const [revise, setRevise] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const keyframeHeadingId = useId();
  const hasChanges = Boolean(run.changes?.length);
  useEffect(() => { if (visible && !hasChanges) heading.current?.focus(); }, [hasChanges, visible]);
  const active = isRunActive(run.status);
  const card = run.styleCard;
  const shots = run.shots ?? [];
  const keyframes = run.keyframes ?? [];
  const activeLabel = run.target || run.parentRunId ? '正在生成镜头改稿'
    : run.currentNodeId === 'assets' ? '正在预演关键镜头'
    : run.currentNodeId === 'script' || card && run.route !== 'style-only' ? '正在生成分镜' : '正在提取风格';
  const canRevise = run.status === 'succeeded' && shots.some(shot => !shot.locked) && !scopedOnly;
  return <>
    <header className="creative-planning__result-heading">
      <div className="creative-planning__result-title">
        <h3 ref={heading} tabIndex={-1}>{run.title}</h3>
        {inWorkspace && run.route && !run.target && <p className="tiny-meta">{creativeObjectiveRoutes[run.route]}</p>}
      </div>
      <div role="status">
        {inWorkspace && run.appliedRevision !== undefined ? <span className="creative-planning__applied"><Check size={14} aria-hidden="true" />已应用</span> : <Status value={run.status} />}
        {active && <span className="tiny-meta">{activeLabel}</span>}
      </div>
    </header>
    {run.error && <Notice kind="error">{run.error}</Notice>}
    {run.recoveryReason && !run.resumeAllowed && !run.failedNodeId && !run.retryCompleted && <Notice>{run.recoveryReason}</Notice>}
    {run.retryCompleted && <Notice kind="success">此步骤已完成重试。可继续生成剩余产物。</Notice>}
    {run.target && hasChanges && <RevisionChanges run={run} visible={visible} />}
    {!scopedOnly && keyframes.length > 0 && <section className="creative-planning__result" aria-labelledby={keyframeHeadingId}>
      <h3 id={keyframeHeadingId}>关键镜头预演</h3>
      <div className="creative-planning__keyframes">{keyframes.map(asset => {
        const shotIndex = shots.findIndex(shot => shot.id === asset.shotId);
        return <figure key={asset.id}>
          <ReferenceImage asset={asset} context="character" />
          <figcaption>{shotIndex < 0 ? asset.name : `第 ${shotIndex + 1} 镜 · ${shots[shotIndex].title}`}</figcaption>
        </figure>;
      })}</div>
    </section>}
    {card && <section className="creative-planning__result">
      <h3>风格卡</h3>
      <div className="creative-planning__style-preview">
        {run.reference && <figure><ReferenceImage asset={run.reference} context="character" /><figcaption>{run.reference.name}</figcaption></figure>}
        <PaletteSwatches card={card} />
      </div>
      <details className="form-disclosure">
        <summary>风格设定</summary>
        <dl className="form-disclosure__body">{planningDocumentSections('style', card.fields).map(({ heading, text }) => <div key={heading}><dt>{heading}</dt><dd>{text}</dd></div>)}</dl>
      </details>
    </section>}
    {!scopedOnly && shots.length > 0 && <section className="creative-planning__result">
      <div className="creative-planning__result-heading"><h3>分镜</h3><span className="tiny-meta">{shots.length} 段 · {shots.reduce((sum, shot) => sum + shot.durationUs, 0) / 1_000_000} 秒</span></div>
      {canRevise && <div className="creative-planning__revision-actions">
        <Button aria-expanded={revise} disabled={disabled} onClick={() => setRevise(value => !value)}>修改镜头</Button>
      </div>}
      {canRevise && revise && <RevisionForm shots={shots} disabled={disabled} busy={busy} onRevise={onRevise} />}
      <ol className="creative-planning__shots">{shots.map((shot, index) => <li key={shot.id} data-shot-id={shot.id}>
        <div className="creative-planning__result-heading"><h4>第 {index + 1} 段 · {shot.title}</h4><span className="tiny-meta">{shot.durationUs / 1_000_000} 秒</span></div>
        <p>{shot.visualPrompt}</p>
        {shot.narration && <p>对白或旁白　{shot.narration}</p>}
        {shot.soundPrompt && <p>声音　{shot.soundPrompt}</p>}
      </li>)}</ol>
    </section>}
  </>;
}

function RevisionForm({ shots, initialShotId, disabled, busy, canSubmit = true, onRevise, children }: {
  shots: readonly Shot[]; initialShotId?: string; disabled: boolean; busy: boolean; canSubmit?: boolean;
  onRevise(scope: CreativeRevisionScope, instruction: string): void; children?: ReactNode;
}) {
  const [shotId, setShotId] = useState(initialShotId ?? '');
  const [fields, setFields] = useState<RevisionField[]>([]);
  const [lineValue, setLineValue] = useState('');
  const [instruction, setInstruction] = useState('');
  const targetInput = useRef<HTMLSelectElement>(null);
  const prefix = useId();
  useEffect(() => { targetInput.current?.focus(); }, []);
  const target = shots.find(shot => shot.id === shotId && !shot.locked);
  const structured = target?.drama?.lines ?? [];
  const sentences = structured.length ? [] : creativeNarrationSentences(target?.narration ?? '');
  const lines = structured.length ? structured.map(line => ({ value: line.id, text: line.text })) : sentences.map((line, index) => ({ value: String(index), text: line.text }));
  const wantsLine = fields.includes('lineText');
  const selectedLine = wantsLine && lines.find(line => line.value === lineValue);
  const valid = Boolean(target && fields.length && (!wantsLine || selectedLine) && instruction.trim() && canSubmit);

  function toggle(field: RevisionField, checked: boolean) {
    setFields(current => {
      if (!checked) return current.filter(item => item !== field);
      const conflicting = field === 'lineText' ? 'narration' : field === 'narration' ? 'lineText' : undefined;
      return [...current.filter(item => item !== conflicting), field];
    });
  }

  return <form className="form-stack creative-planning__revision" aria-label="修改镜头" onSubmit={event => {
    event.preventDefault();
    if (!valid || !target || disabled) return;
    onRevise({ shotId: target.id, fields, ...(selectedLine ? structured.length ? { lineId: selectedLine.value } : { sentenceIndex: Number(selectedLine.value) } : {}) }, instruction.trim());
  }}>
    <Field label="目标镜头" required>{field => <Select {...field} ref={targetInput} required disabled={disabled} value={target?.id ?? ''} onChange={event => {
      setShotId(event.target.value); setFields([]); setLineValue('');
    }}>
      <option value="" disabled>选择镜头</option>
      {shots.map((shot, index) => <option key={shot.id} value={shot.id} disabled={shot.locked}>{index + 1}. {shot.title}{shot.locked ? ' · 已锁定' : ''}</option>)}
    </Select>}</Field>
    <fieldset className="creative-planning__fields" disabled={disabled || !target}>
      <legend>修改字段</legend>
      <div>{revisionFields.filter(field => field === 'lineText' ? lines.length > 0 : field !== 'narration' || !structured.length).map(field => {
        const id = `${prefix}-${field}`;
        return <span key={field}><input type="checkbox" id={id} checked={fields.includes(field)} onChange={event => toggle(field, event.target.checked)} /><label htmlFor={id}>{revisionLabels[field]}</label></span>;
      })}</div>
    </fieldset>
    {wantsLine && <Field label="目标台词" required>{field => <Select {...field} required disabled={disabled} value={lineValue} onChange={event => setLineValue(event.target.value)}>
      <option value="" disabled>选择一句台词</option>
      {lines.map((line, index) => <option key={line.value} value={line.value}>{index + 1}. {line.text}</option>)}
    </Select>}</Field>}
    <Field label="修改要求" required>{field => <textarea {...field} rows={3} required maxLength={3000} disabled={disabled}
      value={instruction} onChange={event => setInstruction(event.target.value)} />}</Field>
    {children}
    <div className="creative-planning__revision-actions"><Button type="submit" variant="primary" busy={busy} disabled={disabled || !valid}>生成修改预览</Button></div>
  </form>;
}

function RevisionChanges({ run, visible }: { run: CreativePlanningResult; visible: boolean }) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (visible) heading.current?.focus(); }, [visible]);
  const targetShot = run.shots?.find(shot => shot.id === run.target?.shotId);
  return <section className="creative-planning__result" aria-labelledby={id}>
    <div className="creative-planning__result-heading">
      <h3 id={id} ref={heading} tabIndex={-1}>修改差异</h3>
      <span className="tiny-meta">{run.target?.shotTitle}{targetShot ? ` · ${formatTime(targetShot.durationUs)}` : ''}</span>
    </div>
    {run.changes?.map(({ field, before, after }) => <div key={field}>
      <h4>{revisionLabels[field]}</h4>
      <dl className="creative-planning__comparison">
        <div><dt>修改前</dt><dd>{before || '空白'}</dd></div>
        <div><dt>修改后</dt><dd>{after || '空白'}</dd></div>
      </dl>
    </div>)}
  </section>;
}
