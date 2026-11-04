import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { applyWorkflowProposal, workflowAssistantContextSchema, workflowProposalChanges, workflowProposalSchema, modelPriceDescription, costSummarySchema, runSummarySchema, runInspectionSchema, type WorkflowProposal, type CostSummary, type ModelProfile, type RunSummary, type WorkflowNode } from '@video-quickly/contracts';
import { rpc } from '../lib/client';
import { Button, Dialog, Field, Notice, Select, Status } from './Primitives';
import { useConfirmation } from './ConfirmationDialog';
import './workflow-assistant.css';

const startResultSchema = z.object({ run: runSummarySchema, nodeId: z.string() });
const latestResultSchema = startResultSchema.extend({ context: workflowAssistantContextSchema, modelId: z.string().optional() }).nullable();
const runningStates = ['queued', 'running', 'waiting_review', 'waiting_external', 'retry_scheduled'];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export default function WorkflowAssistant({ projectId, projectRevision, node, models, onClose, onApply }: {
  projectId: string; projectRevision: number; node: WorkflowNode; models: ModelProfile[];
  onClose(): void; onApply(node: WorkflowNode, proposal: WorkflowProposal): void | Promise<void>;
}) {
  const confirm = useConfirmation();
  const available = models.filter(model => model.enabled && model.capabilities.includes('text') && ['openai-compatible', 'ollama'].includes(model.provider));
  const [instruction, setInstruction] = useState(''), [modelId, setModelId] = useState(available[0]?.id ?? '');
  const [run, setRun] = useState<RunSummary>(), [nodeId, setNodeId] = useState(''), [proposal, setProposal] = useState<WorkflowProposal>();
  const [cost, setCost] = useState<CostSummary>(), [unknown, setUnknown] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [historyState, setHistoryState] = useState<'loading' | 'ready' | 'failed'>('loading'), [historyRefresh, setHistoryRefresh] = useState(0), [verified, setVerified] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const request = useRef<{ id: string; input: { projectId: string; revision: number; node: WorkflowNode; modelId: string; instruction: string } } | undefined>(undefined);
  const alive = useRef(true), inFlight = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let current = true; setHistoryState('loading');
    void rpc('workflowAssistant.latest', { projectId, nodeId: node.id }).then(value => {
      if (!current) return;
      const result = latestResultSchema.parse(value);
      setError('');
      if (result) { setRun(result.run); setNodeId(result.nodeId); setInstruction(result.context.instruction); if (result.modelId) setModelId(result.modelId); setVerified(false); }
      setHistoryState('ready');
    }).catch(error => { if (current) { setError(message(error)); setHistoryState('failed'); } });
    return () => { current = false; };
  }, [projectId, node.id, historyRefresh]);
  useEffect(() => {
    if (!run || !nodeId) return;
    let current = true, timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const latest = runSummarySchema.parse(await rpc('run.get', { runId: run!.id }));
        if (!current) return;
        setRun(latest);
        const [output, usage, inspection] = await Promise.all([rpc('node.result', { runId: latest.id, nodeId }), rpc('cost.summary', { runId: latest.id }), rpc('run.inspect', { runId: latest.id })]);
        if (!current) return;
        setCost(costSummarySchema.parse(usage));
        setUnknown(runInspectionSchema.parse(inspection).steps.some(step => step.unknownSubmission));
        setVerified(true);
        if (output && typeof output === 'object' && 'proposalError' in output && typeof output.proposalError === 'string') {
          setError(output.proposalError);
        } else if (latest.status === 'succeeded') {
          const result = z.object({ proposal: workflowProposalSchema }).parse(output);
          setProposal(result.proposal); setError('');
        } else if (latest.error) setError(latest.error);
        if (runningStates.includes(latest.status) && !(latest.status === 'queued' && latest.error)) timer = setTimeout(() => void poll(), 900);
      } catch (error) { if (current) setError(message(error)); }
    }
    void poll();
    return () => { current = false; if (timer) clearTimeout(timer); };
  }, [run?.id, nodeId, refresh]);
  async function perform(work: () => Promise<void>, clearError = true) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); if (clearError) setError('');
    try { await work(); } catch (error) { if (alive.current) setError(message(error)); }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }
  async function start() {
    request.current ??= { id: crypto.randomUUID(), input: { projectId, revision: projectRevision, node: structuredClone(node), modelId, instruction } };
    const result = startResultSchema.parse(await rpc('workflowAssistant.start', { ...request.current.input, requestId: request.current.id }));
    if (alive.current) { setRun(result.run); setNodeId(result.nodeId); setUnknown(false); setVerified(false); setRefresh(value => value + 1); }
  }
  function newSuggestion() {
    request.current = undefined; setRun(undefined); setNodeId(''); setProposal(undefined); setCost(undefined); setError(''); setUnknown(false); setVerified(false);
  }
  let next: WorkflowNode | undefined, stale = '';
  if (proposal) try { next = applyWorkflowProposal({ id: projectId, revision: projectRevision }, node, proposal); } catch (error) { stale = message(error); }
  const active = Boolean(run && runningStates.includes(run.status));
  const canReviewUnknown = Boolean(verified && unknown && run && ['canceled', 'failed', 'needs_attention'].includes(run.status));
  const locked = busy || Boolean(request.current) || Boolean(run) || historyState !== 'ready';
  const changes = proposal ? workflowProposalChanges(proposal) : [];
  return <Dialog title="对话修改任务" className="dialog--wide workflow-assistant" onClose={onClose}>
    <div className="dialog__body workflow-assistant__body">
      <p className="workflow-assistant__hint">{node.label} · 项目修订 {projectRevision}。建议可修改名称、提示词和模型；应用后可在编辑器中撤销。</p>
      {historyState === 'loading' && <p role="status">正在读取已保存的建议…</p>}{historyState === 'failed' && <Button onClick={() => setHistoryRefresh(value => value + 1)}>重试读取已保存建议</Button>}
      <Field label="修改要求"><textarea rows={4} maxLength={10000} value={instruction} disabled={locked} onChange={event => setInstruction(event.target.value)} placeholder="例如：保留已有变量，让提示词更注重人物动作与镜头节奏。" /></Field>
      <Field label="建议生成模型"><Select value={modelId} disabled={locked} onChange={event => setModelId(event.target.value)}><option value="">选择文本模型</option>{modelId && !available.some(model => model.id === modelId) && <option value={modelId} disabled>已保存建议使用的模型（当前不可用）</option>}{available.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</Select></Field>
      <p className="workflow-assistant__hint">{modelPriceDescription(available.find(model => model.id === modelId) ?? {}, 'text')}。生成预览会调用所选模型并记录用量。</p>
      {error && <Notice kind="error">{error}</Notice>}{stale && <Notice kind="error">{stale}</Notice>}
      {run && <div className="workflow-assistant__run"><Status value={run.status} /><code>{run.id}</code><Button onClick={() => setRefresh(value => value + 1)} disabled={busy}>刷新结果</Button>{active && <Button variant="danger" onClick={() => void perform(async () => { await rpc('run.cancel', { runId: run.id }); setRefresh(value => value + 1); })}>停止建议任务</Button>}</div>}
      {unknown && <Notice>本次提交结果尚未确认。请核对原任务的服务端状态与用量，再选择是否新建建议。</Notice>}
      {cost && <p className="workflow-assistant__hint">已记录 {cost.total} 次用量{cost.tokens.inputTokens !== undefined ? ` · 输入 ${cost.tokens.inputTokens} Token` : ''}{cost.tokens.outputTokens !== undefined ? ` · 输出 ${cost.tokens.outputTokens} Token` : ''}；具体金额以服务账单为准。</p>}
      {proposal && <section aria-label="修改预览"><h3>{proposal.summary}</h3>{changes.map(change => <div key={change.field} className="workflow-assistant__change"><h4>{change.label}</h4><div className="workflow-assistant__comparison"><section><span>当前内容</span><pre>{change.before || '未设置'}</pre></section><section><span>建议内容</span><pre>{change.after || '未设置'}</pre></section></div></div>)}</section>}
    </div>
    <div className="dialog__footer"><Button onClick={onClose}>关闭</Button>{!run ? <Button variant="primary" disabled={!instruction.trim() || !available.some(model => model.id === modelId) || historyState !== 'ready'} busy={busy} onClick={() => void perform(start)}>{request.current ? '重试读取建议任务' : '生成修改预览'}</Button> : canReviewUnknown ? <Button disabled={busy} onClick={() => void perform(async () => {
      const accepted = await confirm({ title: '核对后准备新建建议？', description: '请确认你已人工核对原任务的服务端状态与用量。新建议会创建独立任务，生成时可能另行计费；原任务和提交记录将保留。确认后仍需点击“生成修改预览”才会提交。', confirmLabel: '已核对，准备新建', variant: 'primary' });
      if (accepted && alive.current) newSuggestion();
    }, false)}>核对后新建</Button> : <Button disabled={active || unknown || busy || !verified} onClick={newSuggestion}>新建建议</Button>}{proposal && <Button variant="primary" disabled={!next || busy} onClick={() => void perform(async () => { if (next) await onApply(next, proposal); })}>应用到任务草稿</Button>}</div>
  </Dialog>;
}
