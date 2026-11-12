import { useId, useState } from 'react';
import { ChevronDown, FileCheck2, PencilLine, RotateCcw } from 'lucide-react';
import { runStepPayloadSchema, type RunInspection, type RunStepSummary } from '@video-quickly/contracts';
import { Button, Notice, Select, Status } from '../components/Primitives';
import StepResultView from '../components/StepResultView';
import StepProgress, { ProgressIcon } from '../components/StepProgress';
import { useRuntimeRead } from '../lib/use-runtime-read';
import type { StepOutputSelection } from '../lib/types';
import { runningStep, showsStepProgress, stepProgressText, stepRetryLabel } from '../lib/run-progress';
import { generationLabel } from '../lib/workbench-stages';
import { isPlanningSection, planningLabels, planningResultValue, readRecordedStoryboardDraft, type PlanningControls, type PlanningSection } from '../lib/planning-edits';
import './run-inspector.css';

const stepStates: Record<string, string> = { pending: '待执行', skipped: '未经过', not_recorded: '未记录' };
const date = (value: string) => new Date(value).toLocaleString('zh-CN');

export function SavedOutputIcon() {
  return <FileCheck2 className="run-inspector__output-mark" size={16} role="img" aria-label="已保存产物" />;
}

export function StepStatus({ step, overview = false }: { step: RunStepSummary; overview?: boolean }) {
  if (runningStep(step.status) && !overview) return <span className="run-inspector__state generation-state" data-state={step.status}><ProgressIcon status={step.status} />{stepProgressText(step)}</span>;
  if (step.status === 'succeeded') return <span className="run-inspector__state generation-state" data-state="succeeded"><ProgressIcon status="succeeded" />已完成</span>;
  return stepStates[step.status] ? <span className="run-inspector__state">{stepStates[step.status]}</span> : <Status value={step.status} />;
}

export function CurrentStepResult({ inspection, step, version, onOpenOutput, planning, retry }: StepOutputsProps) {
  const currentPlanning = !inspection.run.selection && inspection.run.stepRetry?.nodeId !== step.id && inspection.steps.filter(item => item.kind !== 'subflow').length > 1 && (!inspection.run.purpose || inspection.run.purpose === 'production') ? planning : undefined;
  const planningSection = currentPlanning && isPlanningSection(step.kind) ? step.kind : undefined;
  // Planning results are saved to the run before downstream work applies them to the project.
  const projectHasNoShots = planningSection === 'script' && currentPlanning?.project.shots.length === 0;
  const showProject = Boolean(planningSection) && (!inspection.snapshotAvailable || (inspection.run.status === 'succeeded' && !(projectHasNoShots && step.outputAvailable)));
  const needsSavedStoryboard = !showProject && projectHasNoShots && step.outputAvailable;
  const output = useRecordedStepOutput(inspection.run.id, step, version, !showProject);
  const outputProgress = output.data?.progress;
  const hasProgress = showsStepProgress(step, outputProgress?.shots.length ? outputProgress : undefined);
  const showTitle = step.kind !== 'animation' || !step.modelGeneration;
  const storyboard = needsSavedStoryboard && output.data?.available
    ? readRecordedStoryboardDraft(output.data.value, currentPlanning?.project.creativeContext)
    : undefined;
  return <section className="run-inspector__detail" aria-label={`步骤详情：${step.label}`}>
    {(showTitle || !hasProgress) && <header className="run-inspector__step-heading">
      <div>
        <div className="run-inspector__step-title">
          {showTitle && <h3>{inspection.workflowId === 'native-video' && step.modelGeneration ? generationLabel(step.label) : step.label}</h3>}
          {!hasProgress && <StepStatus step={step} overview />}
        </div>
        {planningSection && <p className="run-inspector__planning-label">{showProject ? '当前项目内容' : '本次产物'}</p>}
      </div>
      {planningSection && currentPlanning && <Button
        static
        aria-label={`编辑${planningLabels[planningSection]}`}
        disabled={Boolean(currentPlanning.disabledReason) || (needsSavedStoryboard && !output.data?.available)}
        onClick={() => currentPlanning.onEdit(planningSection, storyboard ? { storyboard } : undefined)}
      ><PencilLine size={16} />{showProject || storyboard ? '编辑内容' : '编辑项目内容'}</Button>}
    </header>}
    <StepRetryAction step={step} controls={retry} />
    <div className="run-inspector__panel">
      <ModelResponseDetails runId={inspection.run.id} step={step} version={version} showRawResponse={false} />
      {planningSection && currentPlanning?.disabledReason && <p className="run-inspector__muted">{currentPlanning.disabledReason}</p>}
      {needsSavedStoryboard && output.data?.available && !storyboard && <p className="run-inspector__muted">本次产物无法载入编辑窗口，可手动填写项目分镜。</p>}
      <StepOutputs inspection={inspection} step={step} version={version} onOpenOutput={onOpenOutput} planning={showProject ? currentPlanning : undefined} showApply={!planningSection && step.kind !== 'assets'} showOriginalText={false} output={output} />
    </div>
  </section>;
}

export function ModelResponseDetails({ runId, step, version, showRawResponse = true }: { runId: string; step: RunStepSummary; version: number; showRawResponse?: boolean }) {
  const part = step.progress?.storyboard;
  const key = part?.kind === 'batch' ? part.index : part?.kind;
  return step.responseAvailable ? <SavedModelResponse key={key} runId={runId} nodeId={step.id} label={part?.kind === 'outline' ? '大纲' : step.kind === 'script' ? '分镜' : step.label} version={version} showRawResponse={showRawResponse} /> : null;
}
function SavedModelResponse({ runId, nodeId, label, version, showRawResponse }: { runId: string; nodeId: string; label: string; version: number; showRawResponse: boolean }) {
  const [attempt, setAttempt] = useState('');
  const output = useRuntimeRead('run.step.payload', { runId, nodeId, kind: 'output', ...(attempt ? { responseAttempt: Number(attempt) } : {}) }, version, runStepPayloadSchema);
  const response = output.data?.modelResponse;
  const showVersions = Boolean(attempt) || (output.data?.modelResponseHistory?.length ?? 0) > (response ? 1 : 0);
  const hasBody = Boolean(response?.text.trim());
  const showBody = showRawResponse && hasBody;
  const missingBody = response && !hasBody;
  if (!output.error && !showVersions && !response?.issues?.length && !showBody && !missingBody) return null;
  return <section className="run-inspector__model-response" aria-label="模型返回记录">
    {output.error && <Notice kind="error">{output.error}<Button aria-label="重试读取模型返回" onClick={output.refresh}>重试</Button></Notice>}
    {showVersions && <Select aria-label="模型返回版本" value={attempt} onChange={event => setAttempt(event.target.value)}><option value="">最新返回</option>{output.data?.modelResponseHistory?.map(item => <option key={item.attempt} value={item.attempt}>第 {item.attempt} 次 · {item.invalid ? '校验未通过' : '已收到'}</option>)}</Select>}
    {response && <>{Boolean(response.issues?.length) && <Notice kind="error"><div><strong>{response.incomplete ? '模型未生成完整结果' : `模型已返回，${label}校验未通过`}</strong><ul>{response.issues?.map((issue, index) => <li key={index}>{issue.path !== '$' && <><code>{issue.path}</code>：</>}{issue.message}</li>)}</ul></div></Notice>}
      {showBody ? <details><summary><ChevronDown size={14} aria-hidden="true" />查看模型原始返回</summary><p className="run-inspector__muted">第 {response.attempt} 次返回 · {date(response.receivedAt)} · 只读，敏感内容已隐藏</p><pre className="run-inspector__json">{response.text}</pre></details>
        : missingBody && <p className="run-inspector__muted">第 {response.attempt} 次返回 · {date(response.receivedAt)} · 模型未返回正文</p>}
    </>}
  </section>;
}

interface StepRetryControls { busy: boolean; disabled: boolean; onRetry: () => void; footerDescriptionId?: string }
export interface StepOutputsProps { inspection: RunInspection; step: RunStepSummary; version: number; onOpenOutput: (selection: StepOutputSelection) => void; planning?: PlanningControls; retry?: StepRetryControls; showApply?: boolean; showOriginalText?: boolean }
type StepOutputViewProps = StepOutputsProps & { output: ReturnType<typeof useRecordedStepOutput> };

export function useRecordedStepOutput(runId: string, step: RunStepSummary, version: number, visible: boolean) {
  return useRuntimeRead('run.step.payload', { runId, nodeId: step.id, kind: 'output' }, version, runStepPayloadSchema, visible && (step.status !== 'pending' || step.outputAvailable));
}

export function StepRetryAction({ step, controls }: { step: RunStepSummary; controls?: StepRetryControls }) {
  const id = useId();
  if (!step.retry || !controls) return null;
  const hint = step.progress?.storyboard?.kind === 'batch' ? '从这一批接续，保留已校验的镜头和全片大纲。' : '沿用本次制作的配置与上游产物，完成后停在此步骤。';
  return <div className="run-inspector__retry">{!controls.footerDescriptionId && <Button static aria-describedby={id} busy={controls.busy} disabled={controls.disabled || !step.retry.allowed} onClick={controls.onRetry}><RotateCcw size={16} aria-hidden="true" />{stepRetryLabel(step)}</Button>}<p id={controls.footerDescriptionId ?? id} className="run-inspector__muted">{step.retry.reason || hint}</p></div>;
}
export function StepOutputs(props: StepOutputViewProps) {
  if (props.step.status === 'pending' && !props.step.outputAvailable) return <p>等待上游步骤完成后执行。</p>;
  if (props.planning && isPlanningSection(props.step.kind) && props.inspection.run.purpose !== 'workflow-assistant') {
    return <><StepProgress step={props.step} /><PlanningOutput section={props.step.kind} planning={props.planning} showOriginalText={props.showOriginalText} /></>;
  }
  return <RecordedStepOutput {...props} />;
}

function PlanningOutput({ section, planning, showOriginalText }: { section: PlanningSection; planning: PlanningControls; showOriginalText?: boolean }) {
  return <section aria-label="当前项目内容">
    {section === 'script' && !planning.project.shots.length ? <p>当前项目还没有分镜。</p> : <StepResultView value={planningResultValue(planning.project, section)} kind={section} showOriginalText={showOriginalText} />}
  </section>;
}

function RecordedStepOutput({ inspection, step, onOpenOutput, showApply = true, showOriginalText, output }: StepOutputViewProps) {
  const data = output.data, value = data?.value;
  const mediaStep = data?.progress?.shots.length ? step : undefined;
  const hasMediaAssets = Boolean(value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.assets) && value.assets.length);
  const applicable = showApply && inspection.run.purpose !== 'workflow-assistant' && ['script', 'style', 'assets', 'animation', 'research'].includes(step.kind)
    && (!['assets', 'animation'].includes(step.kind) || hasMediaAssets);
  const open = () => onOpenOutput({ projectId: inspection.run.projectId, runId: inspection.run.id, nodeId: step.id, kind: step.kind });
  return <>
    {!mediaStep && <StepProgress step={step} />}
    {output.error && <Notice kind="error">{output.error}<Button aria-label="重试读取产物" onClick={output.refresh}>重试</Button></Notice>}
    {!data && !output.error && <p role="status">正在读取步骤产物…</p>}
    {data && !data.available && !data.partialStoryboard && !runningStep(step.status) && !mediaStep && <p>{step.status === 'pending' ? '等待上游步骤完成后执行。' : '这个步骤尚未保存产物。'}</p>}
    {data?.partialStoryboard && <section aria-label="已保存分镜"><StepResultView value={data.partialStoryboard} kind="script" showOriginalText={showOriginalText} /></section>}
    {data && (data.available || mediaStep) && <section aria-label="本次产物"><StepResultView value={data.value} kind={step.kind} mediaShots={data.mediaShots} mediaGeneration={data.mediaGeneration} progress={data.progress} step={mediaStep} showOriginalText={showOriginalText} onRegenerate={data.available && !runningStep(step.status) && (!inspection.run.purpose || inspection.run.purpose === 'production') ? (shotId, kind) => onOpenOutput({ projectId: inspection.run.projectId, runId: inspection.run.id, nodeId: step.id, kind: step.kind, regeneration: { shotId, kind, modelName: data.mediaGeneration?.modelName ?? '' } }) : undefined} /></section>}
    {applicable && data?.available && <div className="run-inspector__output-actions"><Button aria-label="在项目中查看与应用" onClick={open}>在工作台使用</Button></div>}
  </>;
}
