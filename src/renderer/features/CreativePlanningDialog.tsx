import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, History } from 'lucide-react';
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
import { matchingStepModels } from '../lib/workflow-guidance';
import './creative-planning.css';

const creationsSchema = recordPageSchema(creativePlanningEntrySchema);
const cardsSchema = recordPageSchema(creativeStyleCardSchema);
type TimingOption = CreativeObjectivePlan['options'][number];
type RevisionField = CreativeRevisionScope['fields'][number];
const revisionLabels: Record<RevisionField, string> = {
  title: '镜头标题', narration: '对白或旁白', visualPrompt: '画面要求', soundPrompt: '声音要求', lineText: '单句台词',
};
const revisionFields: RevisionField[] = ['title', 'narration', 'lineText', 'visualPrompt', 'soundPrompt'];

type ProjectRevisionSource = {
  project: ProjectDocument;
  initialShotId: string;
  saveBeforeRevision(): Promise<number | null>;
  applyRevision(runId: string): Promise<boolean>;
};

export default function CreativePlanningDialog({ workspace, action, onClose, onEdit, projectRevision }: {
  workspace: WorkspaceView; action: Action; onClose(): void; onEdit?(projectId: string): void; projectRevision?: ProjectRevisionSource;
}) {
  const chargeRpc = useChargeRpc();
  const [view, setView] = useState<'compose' | 'proposal' | 'revision' | 'history' | { runId: string }>(projectRevision ? 'revision' : 'compose');
  const [goal, setGoal] = useState('');
  const [path, setPath] = useState('');
  const [selectedCard, setSelectedCard] = useState<CreativeStyleCard>();
  const [modelId, setModelId] = useState(() => projectRevision?.project.workflow.nodes.find(node => node.kind === 'script')?.modelId
    ?? projectRevision?.project.workflow.production.textModelId ?? '');
  const [plan, setPlan] = useState<CreativeObjectivePlan>();
  const [optionId, setOptionId] = useState('');
  const [imageModelId, setImageModelId] = useState('');
  const enabledSkills = workspace.skills.filter(skill => skill.enabled);
  const [skillIds, setSkillIds] = useState(() => enabledSkills.some(skill => skill.id === 'builtin-drama-storyboard') ? ['builtin-drama-storyboard'] : []);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const goalInput = useRef<HTMLTextAreaElement>(null);
  const routeHeading = useRef<HTMLHeadingElement>(null);
  const routeHeadingId = useId();
  const requestIdentity = useRef<{ key: string; id: string } | undefined>(undefined);
  const runId = typeof view === 'object' ? view.runId : undefined;
  const detail = useRuntimeRead('creativePlanning.get', { runId }, workspace.version, creativePlanningResultSchema, Boolean(runId));
  const run = detail.data;
  const parentRunId = run?.parentRunId;
  const models = workspace.models.filter(model => model.enabled && model.capabilities.includes('text')
    && ['openai-compatible', 'ollama'].includes(model.provider));
  const sourceModels = !projectRevision && !selectedCard && path.trim() ? models.filter(model => model.capabilities.includes('vision')) : models;
  const defaultModel = !projectRevision && !selectedCard ? sourceModels.find(model => model.capabilities.includes('vision')) ?? sourceModels[0] : sourceModels[0];
  const selectedModel = sourceModels.some(model => model.id === modelId) ? modelId : defaultModel?.id ?? '';
  const planModel = models.find(model => model.id === plan?.modelId);
  const styleOnly = plan?.route === 'style-only';
  const needsKeyframes = plan?.route === 'keyframe-preview';
  const timingOption = plan?.options.find(option => option.id === optionId);
  const imageModels = needsKeyframes ? matchingStepModels({ kind: 'assets', config: {} }, workspace.models) : [];
  const selectedImageModel = imageModels.some(model => model.id === imageModelId) ? imageModelId : imageModels[0]?.id ?? '';
  const needsReferenceImage = styleOnly || !selectedCard;
  const canReadReference = Boolean(planModel && (!needsReferenceImage || planModel.capabilities.includes('vision')));
  useEffect(() => {
    if (view === 'compose') goalInput.current?.focus();
    if (view === 'proposal') routeHeading.current?.focus();
  }, [view]);

  function navigate(next: typeof view) { setError(''); setView(next); }
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
    if (!plan || !timingOption || !canReadReference || (needsKeyframes && !selectedImageModel)) return;
    const selectedSkills = skillIds.filter(id => enabledSkills.some(skill => skill.id === id));
    if (!selectedSkills.length || (needsReferenceImage && !path.trim())) {
      setError(!selectedSkills.length ? '请至少选用一个创作 Skill。' : '请选择参考图。');
      return;
    }
    return submit('creativePlanning.start', {
      title: Array.from(plan.goal.split(/\r?\n/u, 1)[0]).slice(0, 60).join(''), goal: plan.goal,
      modelId: plan.modelId, skillIds: selectedSkills, reference: selectedCard && !styleOnly ? { styleCardId: selectedCard.id } : { path: path.trim() },
      plan: { id: plan.id, optionId: timingOption.id }, ...(needsKeyframes ? { imageModelId: selectedImageModel } : {}),
    });
  }
  function runAction(method: 'run.step.retry' | 'run.resume' | 'run.cancel', nodeId?: string) {
    if (!runId) return;
    return perform(method, async () => {
      if (await chargeRpc(method, { runId, ...(nodeId ? { nodeId } : {}) }) !== null) await detail.refresh();
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
      onEdit?.(projectSchema.parse(result).id);
    });
  }

  const disabled = Boolean(pending);
  const historyButton = <Button disabled={disabled} onClick={() => navigate('history')}><History size={16} aria-hidden="true" />创作记录</Button>;
  const confirmSource = view === 'proposal';
  const showCardPicker = !confirmSource || !styleOnly;
  const showReferencePicker = confirmSource ? needsReferenceImage : !selectedCard;
  const sourceFields = <>
    {showCardPicker && <StyleCardPicker version={workspace.version} value={selectedCard} disabled={disabled} onChange={setSelectedCard} />}
    {showReferencePicker && <Field label="参考图" hint={confirmSource ? `PNG、JPEG 或 WebP，最多 ${CREATIVE_REFERENCE_IMAGE_MAX_BYTES / 1024 ** 2} MB。` : undefined}
      required={confirmSource}>{field => <PathPicker field={field} label="参考图" value={path} onChange={setPath} required={confirmSource} disabled={disabled}
        extensions={['png', 'jpg', 'jpeg', 'webp']} placeholder="选择文件或输入本机路径" />}</Field>}
    <SkillPicker label="创作 Skill" skills={enabledSkills} groups={workspace.skillGroups} value={skillIds} disabled={disabled} onChange={setSkillIds} />
  </>;
  return <Dialog title={projectRevision ? '修改镜头' : '创作分镜'} className="dialog--wide creative-planning" initialFocus={goalInput} dismissDisabled={disabled} dismissOnBackdrop={false} onClose={onClose}>
    {view === 'compose' && <form aria-label="分镜创作目标" onSubmit={event => { event.preventDefault(); void analyzeGoal(); }}>
      <div className="dialog__body form-stack">
        <Field label="创作目标" required>{field => <textarea {...field} ref={goalInput} name="goal" required rows={3} maxLength={3000} disabled={disabled} value={goal}
          placeholder="雨夜，侦探穿过霓虹街道找到留下线索的信封" onChange={event => setGoal(event.target.value)} />}</Field>
        {sourceFields}
        <Field label="文本模型" required>{field => <Select {...field} name="modelId" required disabled={disabled} value={selectedModel} onChange={event => setModelId(event.target.value)}>
          <option value="" disabled>{sourceModels.length < models.length ? '暂无支持视觉的文本模型' : '暂无可用文本模型'}</option>
          {sourceModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        </Select>}</Field>
        {!sourceModels.length && <Notice>请在模型连接中添加或启用{!selectedCard && path.trim() ? '支持视觉的' : ''}文本模型。</Notice>}
        {error && <Notice kind="error">{error}</Notice>}
      </div>
      <div className="dialog__footer creative-planning__footer">
        {historyButton}
        <Button type="submit" variant="primary" disabled={disabled || !selectedModel} busy={pending === 'creativePlanning.plan'}>分析创作目标<ArrowRight size={15} aria-hidden="true" /></Button>
      </div>
    </form>}
    {view === 'proposal' && plan && <form aria-labelledby={routeHeadingId} onSubmit={event => { event.preventDefault(); void start(); }}>
      <div className="dialog__body form-stack">
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
          {sourceFields}
          {!planModel && <Notice>已选文本模型不可用。请返回创作目标更换模型。</Notice>}
          {planModel && !canReadReference && <Notice>{styleOnly ? '提取风格需要支持视觉的文本模型。' : '参考图需要支持视觉的文本模型，也可选择已有风格卡。'}</Notice>}
          {needsKeyframes && <Field label="图片模型" required>{field => <Select {...field} name="imageModelId" required disabled={disabled} value={selectedImageModel} onChange={event => setImageModelId(event.target.value)}>
            <option value="" disabled>暂无可用图片模型</option>
            {imageModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
          </Select>}</Field>}
          {needsKeyframes && !imageModels.length && <Notice>请在模型连接中添加或启用图片模型。</Notice>}
        </>}
        {error && <Notice kind="error">{error}</Notice>}
      </div>
      <div className="dialog__footer creative-planning__footer">
        <Button disabled={disabled} onClick={() => navigate('compose')}><ArrowLeft size={16} aria-hidden="true" />返回创作目标</Button>
        <Button type="submit" variant="primary" disabled={disabled || !timingOption || !canReadReference || (needsKeyframes && !selectedImageModel)}
          busy={pending === 'creativePlanning.start'}>确认并开始制作<ArrowRight size={15} aria-hidden="true" /></Button>
      </div>
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
    {view === 'history' && <PlanningHistory version={workspace.version} projectId={projectRevision?.project.id}
      onSelect={id => navigate({ runId: id })} onCompose={() => navigate(projectRevision ? 'revision' : 'compose')} />}
    {runId && <>
      <div className="dialog__body form-stack">
        {detail.error && <Notice kind="error">{detail.error}<Button onClick={() => void detail.refresh()}>重试读取</Button></Notice>}
        {!run && !detail.error && <p role="status">正在读取创作结果…</p>}
        {run && <PlanningResult key={run.id} run={run} disabled={disabled} busy={pending === 'creativePlanning.revise'} scopedOnly={Boolean(projectRevision)}
          onRevise={(scope, instruction) => void submit('creativePlanning.revise', { runId: run.id, scope, instruction })} />}
        {error && <Notice kind="error">{error}</Notice>}
      </div>
      <div className="dialog__footer creative-planning__footer">
        {historyButton}
        {run && (isRunActive(run.status) || run.status === 'needs_attention') && <Button disabled={disabled} busy={pending === 'run.cancel'} onClick={() => void runAction('run.cancel')}>停止</Button>}
        {run?.failedNodeId && !run.retryCompleted && <Button variant="primary" disabled={disabled} busy={pending === 'run.step.retry'} onClick={() => void runAction('run.step.retry', run.failedNodeId)}>重试此步骤</Button>}
        {run && (run.resumeAllowed || run.status === 'needs_attention' && run.retryCompleted) && <Button disabled={disabled} busy={pending === 'run.resume'} onClick={() => void runAction('run.resume')}>继续</Button>}
        {projectRevision && run && !isRunActive(run.status) && <Button disabled={disabled} onClick={() => navigate('revision')}>返回修改</Button>}
        {!projectRevision && run && parentRunId && !isRunActive(run.status) && <Button disabled={disabled} onClick={() => navigate({ runId: parentRunId })}>返回分镜</Button>}
        {run?.route === 'style-only' && run.status === 'succeeded' && <Button disabled={disabled} variant="primary" onClick={onClose}>完成</Button>}
        {run?.status === 'succeeded' && run.route !== 'style-only' && Boolean(run.target ? run.changes?.length : run.shots?.length) && <Button variant="primary" disabled={disabled} busy={pending === 'creativePlanning.apply'} onClick={() => void apply()}>{run.appliedRevision !== undefined ? (projectRevision ? '完成' : '编辑分镜') : run.target ? '确认应用' : '应用分镜并编辑'}</Button>}
      </div>
    </>}
  </Dialog>;
}

function TimingDetails({ option }: { option: TimingOption }) {
  const { shotDurationsUs, keyframeShots } = option;
  if (!shotDurationsUs.length) return null;
  const seconds = shotDurationsUs.map(duration => duration / 1_000_000);
  const total = shotDurationsUs.reduce((sum, duration) => sum + duration, 0) / 1_000_000;
  const durations = seconds.every(duration => duration === seconds[0]) ? `每镜 ${seconds[0]} 秒` : `${seconds.join(' / ')} 秒`;
  return <span className="creative-planning__timing-meta">
    <span>{seconds.length} 镜 · 共 {total} 秒 · {durations}</span>
    {keyframeShots.length > 0 && <span>预演第 {keyframeShots.join('、')} 镜</span>}
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

function PlanningHistory({ version, projectId, onSelect, onCompose }: { version: number; projectId?: string; onSelect(id: string): void; onCompose(): void }) {
  const focus = useRef<HTMLHeadingElement>(null);
  useEffect(() => { focus.current?.focus(); }, []);
  const history = useRecordPage('creativePlanning.list', { limit: 20, projectId }, version, creationsSchema);
  return <>
    <div className="dialog__body form-stack">
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
    <div className="dialog__footer"><Button onClick={onCompose}><ArrowLeft size={16} aria-hidden="true" />{projectId ? '返回修改' : '返回创作'}</Button></div>
  </>;
}

function PlanningResult({ run, disabled, busy, scopedOnly, onRevise }: {
  run: CreativePlanningResult; disabled: boolean; busy: boolean; scopedOnly: boolean; onRevise(scope: CreativeRevisionScope, instruction: string): void;
}) {
  const [revise, setRevise] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const keyframeHeadingId = useId();
  const hasChanges = Boolean(run.changes?.length);
  useEffect(() => { if (!hasChanges) heading.current?.focus(); }, [hasChanges]);
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
      <h3 ref={heading} tabIndex={-1}>{run.title}</h3>
      <div role="status"><Status value={run.status} />{active && <span className="tiny-meta">{activeLabel}</span>}</div>
    </header>
    {run.error && <Notice kind="error">{run.error}</Notice>}
    {run.recoveryReason && !run.resumeAllowed && !run.failedNodeId && !run.retryCompleted && <Notice>{run.recoveryReason}</Notice>}
    {run.retryCompleted && <Notice kind="success">此步骤已完成重试。可继续生成剩余产物。</Notice>}
    {run.target && hasChanges && <RevisionChanges run={run} />}
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

function RevisionChanges({ run }: { run: CreativePlanningResult }) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
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
