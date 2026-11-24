import { useEffect, useId, useRef, useState } from 'react';
import { isRunActive, type AssetRecord, type CreativePlanningResult, type ModelProfile, type Shot } from '@video-quickly/contracts';
import { Button, Field, Notice, Select, Status } from '../components/Primitives';
import ReferenceImage from '../components/ReferenceImage';
import { matchingStepModels } from '../lib/workflow-guidance';

type Preview = NonNullable<CreativePlanningResult['preview']>;
type RunAction = 'run.step.retry' | 'run.resume' | 'run.cancel';

export default function CreativePreviewPanel({ preview, shots, models, execution, readError, refreshExecution, pending, onRecommend, onGenerate, onApply, onRunAction }: {
  preview: Preview;
  shots: readonly Shot[];
  models: readonly ModelProfile[];
  execution?: CreativePlanningResult;
  readError: string;
  refreshExecution(): Promise<void>;
  pending: string;
  onRecommend(): void;
  onGenerate(shotIds: string[], imageModelId: string): void;
  onApply(runId: string, shotId: string): void;
  onRunAction(method: RunAction, nodeId?: string): void;
}) {
  const [selection, setSelection] = useState<{ revision: string; shotIds: string[] }>();
  const [modelId, setModelId] = useState('');
  const id = useId();
  const selectionGroup = useRef<HTMLFieldSetElement>(null);
  const focusRecommendation = useRef(false);
  const modelOptions = matchingStepModels({ kind: 'assets', config: {} }, models);
  const selectedModelId = modelOptions.some(model => model.id === modelId) ? modelId : modelOptions[0]?.id ?? '';
  const recommendations = new Map(preview.recommendations?.map(({ shotId, reason }) => [shotId, reason]));
  const unlocked = new Set(shots.filter(shot => !shot.locked).map(shot => shot.id));
  const selected = (selection?.revision === preview.revision ? selection.shotIds : [...recommendations.keys()]).filter(shotId => unlocked.has(shotId));
  const frames = new Map(preview.frames.map(frame => [frame.shotId, frame]));
  const active = Boolean(execution && isRunActive(execution.status));
  const awaitingExecution = Boolean(preview.latestRunId && !execution);
  const disabled = Boolean(pending);
  const canSubmit = !disabled && !active && !awaitingExecution && execution?.status !== 'needs_attention';
  const hasRecommendations = Boolean(preview.recommendations);

  useEffect(() => {
    if (canSubmit && hasRecommendations && focusRecommendation.current) {
      focusRecommendation.current = false;
      selectionGroup.current?.querySelector<HTMLInputElement>('input:checked:enabled')?.focus();
    }
  }, [canSubmit, hasRecommendations]);

  function select(shotId: string, checked: boolean) {
    const shotIds = checked ? [...selected, shotId] : selected.filter(id => id !== shotId);
    if (shotIds.length <= 3) setSelection({ revision: preview.revision, shotIds });
  }

  return <section className="creative-planning__result" aria-labelledby={`${id}-heading`}>
    <div className="creative-planning__result-heading">
      <h3 id={`${id}-heading`}>关键镜头预演</h3>
      {!hasRecommendations && <Button disabled={!canSubmit || !unlocked.size} busy={pending === 'creativePlanning.previewRecommend'} onClick={() => {
        focusRecommendation.current = true;
        onRecommend();
      }}>推荐关键镜头</Button>}
    </div>
    <form className="form-stack" aria-label="生成预演图" onSubmit={event => {
      event.preventDefault();
      if (canSubmit && selected.length && selectedModelId) onGenerate(selected, selectedModelId);
    }}>
      <fieldset ref={selectionGroup} className="creative-planning__timing" aria-describedby={`${id}-selection`} disabled={!canSubmit}>
        <legend>选择预演镜头</legend>
        <span className="tiny-meta" id={`${id}-selection`} role="status">已选 {selected.length} / 3 镜</span>
        {shots.map((shot, index) => {
          const checked = selected.includes(shot.id);
          const reason = recommendations.get(shot.id);
          const controlId = `${id}-shot-${index}`;
          return <div className="creative-planning__preview-choice" key={shot.id}>
            <input type="checkbox" id={controlId} checked={checked} disabled={shot.locked || !checked && selected.length >= 3}
              aria-describedby={reason ? `${controlId}-reason` : undefined} onChange={event => select(shot.id, event.target.checked)} />
            <label htmlFor={controlId}>第 {index + 1} 镜 · {shot.title}</label>
            {reason && <span className="tiny-meta" id={`${controlId}-reason`}>{reason}</span>}
          </div>;
        })}
      </fieldset>
      <Field label="图片模型" required>{field => <Select {...field} required disabled={!canSubmit} value={selectedModelId} onChange={event => setModelId(event.target.value)}>
        <option value="" disabled>暂无可用图片模型</option>
        {modelOptions.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
      </Select>}</Field>
      <div className="creative-planning__revision-actions"><Button type="submit" variant="primary" disabled={!canSubmit || !selected.length || !selectedModelId}
        busy={pending === 'creativePlanning.previewStart'}>生成预演图</Button></div>
    </form>
    {readError && <Notice kind="error">{readError}<Button onClick={() => void refreshExecution()}>重试读取预演</Button></Notice>}
    {awaitingExecution && !readError && <p role="status">正在读取预演进度…</p>}
    {execution && <div className="creative-planning__result-heading">
      <div role="status"><Status value={execution.status} />{active && <span className="tiny-meta">正在生成预演图</span>}</div>
      <div className="creative-planning__revision-actions">
        {(active || execution.status === 'needs_attention') && <Button disabled={disabled} busy={pending === 'run.cancel'} onClick={() => onRunAction('run.cancel')}>停止预演</Button>}
        {execution.failedNodeId && !execution.retryCompleted && <Button disabled={disabled} busy={pending === 'run.step.retry'} onClick={() => onRunAction('run.step.retry', execution.failedNodeId)}>重试预演步骤</Button>}
        {(execution.resumeAllowed || execution.status === 'needs_attention' && execution.retryCompleted) && <Button disabled={disabled} busy={pending === 'run.resume'} onClick={() => onRunAction('run.resume')}>继续预演</Button>}
      </div>
    </div>}
    {execution?.error && <Notice kind="error">{execution.error}</Notice>}
    {execution?.recoveryReason && !execution.resumeAllowed && !execution.failedNodeId && !execution.retryCompleted && <Notice>{execution.recoveryReason}</Notice>}
    {shots.map((shot, index) => {
      const frame = frames.get(shot.id);
      if (!frame?.current && !frame?.candidate) return null;
      const titleId = `${id}-frame-${index}`;
      const candidate = frame.candidate?.asset.id !== frame.current?.id ? frame.candidate : undefined;
      return <section className="creative-planning__result" aria-labelledby={titleId} key={shot.id}>
        <div className="creative-planning__result-heading">
          <h4 id={titleId}>第 {index + 1} 镜 · {shot.title}</h4>
          <Button disabled={!canSubmit || !selectedModelId || shot.locked} onClick={() => onGenerate([shot.id], selectedModelId)}>重做此镜</Button>
        </div>
        <div className="creative-planning__frame-comparison" aria-label="当前与候选对比" role="group">
          <Frame label="当前" asset={frame.current} stale={frame.stale} />
          {candidate && <Frame label="候选" asset={candidate.asset} stale={candidate.stale} />}
        </div>
        {candidate && <div className="creative-planning__revision-actions"><Button variant="primary" disabled={!canSubmit || candidate.stale || shot.locked}
          busy={pending === 'creativePlanning.previewApply'} onClick={() => onApply(candidate.runId, shot.id)}>{frame.current ? '替换预演图' : '应用预演图'}</Button></div>}
      </section>;
    })}
  </section>;
}

function Frame({ label, asset, stale }: { label: string; asset?: AssetRecord; stale: boolean }) {
  return <figure>
    <figcaption>{label}{stale && <Status value="stale" />}</figcaption>
    {asset ? <ReferenceImage asset={{ id: asset.id, path: asset.path, name: `${label}画面` }} context="character" /> : <span className="tiny-meta">尚无预演图</span>}
  </figure>;
}
