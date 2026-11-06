import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  costSummarySchema, jsonValueSchema, projectDetailSchema, promptBindingsSchema, promptPreviewSchema, promptSessionSchema, recordPageSchema, runSummarySchema, shotCandidateSchema,
  type CostSummary, type CostTaskDetail, type JsonValue, type ModelProfile, type PromptBindings, type PromptDraft, type PromptPreview, type PromptSession, type ProjectDocument, type RunSummary, type SkillGroup, type SkillPackage, type WorkflowNode,
} from '@video-quickly/contracts';
import { rpc } from '../lib/client';
import SkillPicker from './SkillPicker';
import type { StepOutputSelection } from '../lib/types';
import { matchingStepModels } from '../lib/workflow-guidance';
import { Button, Dialog, Field, Notice, Select, Status } from './Primitives';
import PromptLibraryPanel from './PromptLibraryPanel';
import './prompt-workbench.css';

const StepResultView = lazy(() => import('./StepResultView'));
const RunInspector = lazy(() => import('../features/RunInspector'));
const TaskUsage = lazy(() => import('../features/CostsPage').then(module => ({ default: module.TaskUsage })));
type Context = PromptDraft['context'];
type Variable = { id: string; name: string; source: 'text' | 'json' | 'project' | 'shot' | 'upstream'; value: string; nodeId: string };
const activeStatuses = ['queued', 'running', 'waiting_external', 'retry_scheduled'];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
function variableRows(bindings?: PromptBindings): Variable[] {
  return Object.entries(bindings ?? {}).map(([name, binding]) => ({ id: crypto.randomUUID(), name,
    source: 'literal' in binding ? typeof binding.literal === 'string' ? 'text' : 'json' : 'projectPath' in binding ? 'project' : 'shotPath' in binding ? 'shot' : 'upstream',
    value: 'literal' in binding ? typeof binding.literal === 'string' ? binding.literal : JSON.stringify(binding.literal) : 'projectPath' in binding ? binding.projectPath.join('.') : 'shotPath' in binding ? binding.shotPath.join('.') : binding.path.join('.'),
    nodeId: 'nodeId' in binding ? binding.nodeId : '',
  }));
}
function readBindings(rows: Variable[]): PromptBindings | undefined {
  if (!rows.length) return undefined;
  if (new Set(rows.map(row => row.name)).size !== rows.length) throw new Error('提示词变量名不能重复。');
  return promptBindingsSchema.parse(Object.fromEntries(rows.map(row => [row.name, row.source === 'text' ? { literal: row.value } : row.source === 'json' ? { literal: JSON.parse(row.value) } : row.source === 'project' ? { projectPath: row.value.split('.') } : row.source === 'shot' ? { shotPath: row.value.split('.') } : { nodeId: row.nodeId, path: row.value ? row.value.split('.') : [] }])));
}

export default function PromptWorkbench({ projectId, projectRevision, node: initialNode, context: initialContext, models, skills, groups, version, onClose, onApplyPrompt, onOpenOutput, onOpenCandidate }: {
  projectId: string; projectRevision: number; node: WorkflowNode; context?: Context; models: ModelProfile[]; skills: SkillPackage[]; groups?: SkillGroup[]; version: number;
  onClose(): void; onApplyPrompt(node: WorkflowNode): Promise<void> | void; onOpenOutput(selection: StepOutputSelection): void; onOpenCandidate?(shotId: string): void;
}) {
  const [node, setNode] = useState(initialNode), [variables, setVariables] = useState(() => variableRows(initialNode.promptBindings));
  const [context, setContext] = useState(initialContext), [revision, setRevision] = useState(projectRevision);
  const [project, setProject] = useState<ProjectDocument>(), [upstreamRuns, setUpstreamRuns] = useState<RunSummary[]>([]);
  const [shotId, setShotId] = useState(''), [upstreamRunId, setUpstreamRunId] = useState('');
  const [preview, setPreview] = useState<PromptPreview>(), [session, setSession] = useState<PromptSession>();
  const [sessions, setSessions] = useState<PromptSession[]>([]), [sessionCursor, setSessionCursor] = useState<number | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]), [run, setRun] = useState<RunSummary>();
  const [output, setOutput] = useState<JsonValue | null>(null), [cost, setCost] = useState<CostSummary>();
  const [tab, setTab] = useState<'draft' | 'trial' | 'library'>('draft'), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const [inspected, setInspected] = useState<string>();
  const [usageRun, setUsageRun] = useState<string>();
  const receiveCost = useCallback((task: CostTaskDetail) => setCost(task.summary), []);
  const inFlight = useRef(false), alive = useRef(true), request = useRef<{ session: string; revision: number; id: string } | undefined>(undefined);
  const media = ['assets', 'animation'].includes(node.kind);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let current = true;
    void Promise.all([
      rpc('project.get', { projectId }).then(value => projectDetailSchema.parse(value).project),
      rpc('run.list', { projectId, purpose: 'production', status: 'succeeded', limit: 100 }).then(value => recordPageSchema(runSummarySchema).parse(value).items),
      rpc('promptSession.list', { projectId, nodeId: initialNode.id, limit: 30 }).then(value => recordPageSchema(promptSessionSchema).parse(value)),
    ]).then(([project, runs, sessions]) => { if (current) { setProject(project); setUpstreamRuns(runs); setSessions(sessions.items); setSessionCursor(sessions.nextCursor); } }).catch(error => { if (current) setError(message(error)); });
    return () => { current = false; };
  }, [projectId, initialNode.id, refresh]);
  useEffect(() => {
    if (!session) return;
    let current = true;
    void rpc('run.list', { projectId, purpose: 'prompt-trial', promptSessionId: session.id, limit: 100 }).then(value => {
      if (!current) return;
      const items = recordPageSchema(runSummarySchema).parse(value).items;
      setRuns(items); setRun(previous => items.find(item => item.id === previous?.id) ?? items[0]);
    }).catch(error => { if (current) setError(message(error)); });
    return () => { current = false; };
  }, [session?.id, version, refresh, projectId]);
  useEffect(() => {
    if (!run) return;
    let current = true, timer: ReturnType<typeof setTimeout> | undefined;
    setOutput(null); setCost(undefined);
    async function poll() {
      try {
        const value = runSummarySchema.parse(await rpc('run.get', { runId: run!.id }));
        if (!current) return;
        setRun(value);
        const [output, cost] = await Promise.all([rpc('node.result', { runId: value.id, nodeId: value.selection?.nodeId ?? initialNode.id }), rpc('cost.summary', { runId: value.id })]);
        if (!current) return;
        setOutput(jsonValueSchema.nullable().parse(output)); setCost(costSummarySchema.parse(cost));
        if (activeStatuses.includes(value.status) && !(value.status === 'queued' && value.error)) timer = setTimeout(() => void poll(), 800);
      } catch (error) { if (current) setError(message(error)); }
    }
    void poll();
    return () => { current = false; if (timer) clearTimeout(timer); };
  }, [run?.id, refresh]);

  function invalidate() { setPreview(undefined); setNotice(''); setError(''); }
  function editNode(next: WorkflowNode) { setNode({ ...next, id: initialNode.id }); setVariables(variableRows(next.promptBindings)); invalidate(); }
  function currentNode(): WorkflowNode { return { ...node, promptBindings: readBindings(variables) }; }
  function draft(): PromptDraft { return { projectId, projectRevision: revision, node: currentNode(), context, shotId: shotId || undefined, upstreamRunId: upstreamRunId || undefined }; }
  async function perform(work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (error) { if (alive.current) setError(message(error)); }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }
  async function saveSession() {
    if (!preview) return;
    const value = promptSessionSchema.parse(await rpc('promptSession.save', { id: session?.id, revision: session?.revision, draft: draft(), previewDigest: preview.digest }));
    if (alive.current) { setSession(value); setRefresh(value => value + 1); setNotice('实验草稿已保存。'); }
  }
  async function trial() {
    if (!session || !preview || preview.digest !== session.preview.digest) return;
    const key = `${session.id}@${session.revision}`;
    if (!request.current || request.current.session !== key) request.current = { session: key, revision: session.revision, id: crypto.randomUUID() };
    const value = runSummarySchema.parse(await rpc('promptTrial.start', { sessionId: session.id, revision: session.revision, requestId: request.current.id }));
    if (alive.current) { setRun(value); setTab('trial'); setRefresh(value => value + 1); }
  }
  function restoreSession(value: PromptSession) {
    editNode(value.draft.node); setSession(value); setRevision(value.draft.projectRevision); setContext(value.draft.context); setShotId(value.draft.shotId ?? ''); setUpstreamRunId(value.draft.upstreamRunId ?? ''); setPreview(value.preview); setRun(undefined); setOutput(null); setCost(undefined); setRefresh(value => value + 1);
  }
  const running = run && activeStatuses.includes(run.status) && !(run.status === 'queued' && run.error);
  return <Dialog title="提示词实验" className="dialog--wide prompt-workbench" onClose={onClose}>
    <div className="dialog__body prompt-workbench__body">
      <p className="prompt-workbench__subtitle">{initialNode.label} · 项目修订 {revision}{session ? ` · 实验 v${session.revision}` : ''}</p>
      <nav className="tabs" aria-label="提示词实验视图">{([['draft', '编辑与预览'], ['trial', '试运行'], ['library', '模板与片段']] as const).map(([id, label]) => <button key={id} type="button" className={tab === id ? 'active' : ''} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>{label}</button>)}</nav>
      {error && <Notice kind="error">{error}</Notice>}{notice && <Notice kind="success">{notice}</Notice>}
      <fieldset disabled={busy} className="prompt-workbench__fieldset">
        {tab === 'draft' && <div className="prompt-workbench__columns"><section aria-label="实验草稿">
          <Field label="继续实验"><Select value={session?.id ?? ''} onChange={event => { const saved = sessions.find(item => item.id === event.target.value); if (saved) restoreSession(saved); else { setSession(undefined); setRun(undefined); request.current = undefined; invalidate(); } }}><option value="">新实验</option>{sessions.map(item => <option key={item.id} value={item.id}>{new Date(item.updatedAt).toLocaleString('zh-CN')} · v{item.revision} · {item.draft.node.prompt.slice(0, 24)}</option>)}</Select></Field>
          {sessionCursor && <Button onClick={() => void perform(async () => { const page = recordPageSchema(promptSessionSchema).parse(await rpc('promptSession.list', { projectId, nodeId: initialNode.id, before: sessionCursor, limit: 30 })); setSessions(items => [...items, ...page.items]); setSessionCursor(page.nextCursor); })}>更早的实验</Button>}
          <Field label="实验模型"><Select value={node.modelId ?? ''} onChange={event => { setNode(value => ({ ...value, modelId: event.target.value || undefined })); invalidate(); }}><option value="">选择模型</option>{matchingStepModels(node.kind === 'assets' ? { ...node, config: { ...node.config, referenceMode: 'generate' } } : node, models).map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</Select></Field>
          {(media || node.kind === 'script' || variables.some(variable => variable.source === 'shot')) && <Field label="目标镜头"><Select value={shotId} onChange={event => { setShotId(event.target.value); invalidate(); }}><option value="">{media ? '请选择一个镜头' : node.kind === 'script' ? '完整分镜' : '项目上下文'}</option>{project?.shots.filter(shot => !shot.locked).map(shot => <option key={shot.id} value={shot.id}>{shot.title}</option>)}</Select></Field>}
          <Field label="上游输入"><Select value={upstreamRunId} onChange={event => { setUpstreamRunId(event.target.value); invalidate(); }}><option value="">当前项目内容</option>{upstreamRuns.map(run => <option key={run.id} value={run.id}>{new Date(run.createdAt).toLocaleString('zh-CN')} · 修订 {run.projectRevision}</option>)}</Select></Field>
          <Field label="实验提示词"><textarea rows={8} value={node.prompt} onChange={event => { setNode(value => ({ ...value, prompt: event.target.value, promptTemplate: undefined })); invalidate(); }} /></Field>
          <details><summary>变量与 Skill</summary><p className="muted">使用 {'{{变量名}}'} 插入数据。字段路径使用点号分隔。</p>
            {variables.map((variable, index) => <div className="prompt-variable" key={variable.id}>
              <Field label={`变量 ${index + 1} 名称`}><input value={variable.name} onChange={event => { setVariables(rows => rows.map(row => row.id === variable.id ? { ...row, name: event.target.value } : row)); invalidate(); }} /></Field>
              <Field label={`变量 ${index + 1} 来源`}><Select value={variable.source} onChange={event => { setVariables(rows => rows.map(row => row.id === variable.id ? { ...row, source: event.target.value as Variable['source'] } : row)); invalidate(); }}>{[['text', '文本'], ['json', 'JSON 字面值'], ['project', '项目字段'], ['shot', '镜头字段'], ['upstream', '上游产物']].map(([id, label]) => <option key={id} value={id}>{label}</option>)}</Select></Field>
              {variable.source === 'upstream' && <Field label={`变量 ${index + 1} 上游任务`}><Select value={variable.nodeId} onChange={event => { setVariables(rows => rows.map(row => row.id === variable.id ? { ...row, nodeId: event.target.value } : row)); invalidate(); }}><option value="">选择任务</option>{project?.workflow.nodes.filter(item => item.id !== initialNode.id).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</Select></Field>}
              <Field label={`变量 ${index + 1} ${['text', 'json'].includes(variable.source) ? '值' : '字段路径'}`}><input value={variable.value} placeholder={variable.source === 'project' ? 'brief 或 profile.width' : variable.source === 'shot' ? 'narration' : variable.source === 'upstream' ? 'text' : ''} onChange={event => { setVariables(rows => rows.map(row => row.id === variable.id ? { ...row, value: event.target.value } : row)); invalidate(); }} /></Field>
              <Button aria-label={`移除变量 ${index + 1}`} onClick={() => { setVariables(rows => rows.filter(row => row.id !== variable.id)); invalidate(); }}><Trash2 size={14} /></Button>
            </div>)}<Button onClick={() => { setVariables(rows => [...rows, { id: crypto.randomUUID(), name: '', source: 'text', value: '', nodeId: '' }]); invalidate(); }}><Plus size={14} />添加变量</Button>
            <SkillPicker skills={skills} groups={groups} value={node.skillIds} onChange={skillIds => { setNode(value => ({ ...value, skillIds })); invalidate(); }} />
          </details>
          <div className="prompt-workbench__actions"><Button variant="primary" busy={busy} onClick={() => void perform(async () => { const value = promptPreviewSchema.parse(await rpc('prompt.preview', draft())); if (alive.current) setPreview(value); })}>离线预览</Button><Button disabled={!preview} onClick={() => void perform(saveSession)}>保存实验草稿</Button></div>
          {project && revision !== project.revision && <Button onClick={() => { setRevision(project.revision); invalidate(); }}>使用当前项目修订 {project.revision}</Button>}
        </section><section aria-label="最终提示词" className="prompt-workbench__preview"><h3>最终提示词</h3>{preview ? <><p className="muted">引用已校验 · {preview.references.length} 份参考素材 · {preview.upstream.length} 个上游产物</p>{preview.model && <p className="muted">快照模型：{preview.model.name} · {preview.model.model}</p>}{preview.skills.map(skill => <p className="muted" key={skill.id}>Skill {skill.name} · {skill.version.slice(0, 12)}</p>)}<pre tabIndex={0}>{preview.prompt}</pre>
          {preview.variables.length > 0 && <details><summary>变量来源</summary>{preview.variables.map(variable => <p key={variable.name}><strong>{variable.name}</strong> · {variable.source}<br />{typeof variable.value === 'string' ? variable.value : JSON.stringify(variable.value)}</p>)}</details>}
          {preview.references.length > 0 && <details><summary>参考素材</summary><ul>{preview.references.map(reference => <li key={reference.id}>{reference.name} · {reference.kind}</li>)}</ul></details>}
        </> : <p className="muted">选择输入后点击“离线预览”，查看与实际执行共用的提示词。预览只读取本地数据。</p>}</section></div>}
        {tab === 'library' && <PromptLibraryPanel node={node} readNode={currentNode} onChange={editNode} version={version} />}
        {tab === 'trial' && <section aria-label="试运行记录"><Notice>试运行会提交模型请求并产生用量。结果保留在实验记录和镜头候选中，应用产物需单独操作。</Notice>
          <div className="prompt-workbench__actions"><Button variant="primary" disabled={!session || !preview || preview.digest !== session.preview.digest || Boolean(running) || Boolean(request.current && run && request.current.session === `${session?.id}@${session?.revision}`)} onClick={() => void perform(trial)}>试运行（产生用量）</Button>
            {run && !running && <Button onClick={() => { request.current = undefined; setRun(undefined); setOutput(null); setCost(undefined); }}>准备新的试运行</Button>}
            {running && <Button onClick={() => void perform(async () => { await rpc('run.cancel', { runId: run!.id }); setRefresh(value => value + 1); })}>停止试运行</Button>}
            {run && (['failed', 'needs_attention', 'waiting_external'].includes(run.status) || run.status === 'queued' && run.error) && <Button onClick={() => void perform(async () => { await rpc('run.resume', { runId: run.id }); setRefresh(value => value + 1); })}>继续原试运行</Button>}
            {run && <Button onClick={() => setInspected(run.id)}>查看冻结输入</Button>}
          </div>{!session && <p className="muted">请先离线预览并保存实验草稿。</p>}
          {runs.length > 0 && <Field label="实验记录"><Select value={run?.id ?? ''} onChange={event => { setRun(runs.find(run => run.id === event.target.value)); }}><option value="">选择记录</option>{runs.map(run => <option key={run.id} value={run.id}>{new Date(run.createdAt).toLocaleString('zh-CN')} · {run.status} · 草稿 v{run.promptSessionRevision}</option>)}</Select></Field>}
          {run && <><div className="prompt-workbench__run-meta"><Status value={run.status} /><span>{new Date(run.createdAt).toLocaleString('zh-CN')}</span><span>耗时 {Math.max(0, Math.round((Date.parse(run.updatedAt) - Date.parse(run.createdAt)) / 1000))} 秒</span></div>{run.error && <Notice kind="error">{run.error}</Notice>}</>}
          {cost && <div aria-label="实验费用"><p>{cost.total} 条用量记录{cost.unknownActual ? ` · ${cost.unknownActual} 条待核对实付` : ''}</p><p>输入 Token {cost.tokens.inputTokens ?? '未返回'} · 输出 Token {cost.tokens.outputTokens ?? '未返回'}</p>{cost.currencies.map(currency => <p key={currency.currency}>{currency.currency} · 预估 {currency.estimatedAmount ?? '未知'} · 实付 {currency.actualAmount ?? '待核对'}</p>)}{run && cost.total > 0 && <Button onClick={() => setUsageRun(run.id)}>查看与核对费用</Button>}</div>}
          {output !== null && <Suspense fallback={<p role="status">正在打开结果…</p>}><StepResultView value={output} kind={node.kind} /></Suspense>}
          {run?.status === 'succeeded' && output !== null && <div className="prompt-workbench__actions"><Button onClick={() => { onClose(); onOpenOutput({ projectId, runId: run.id, nodeId: run.selection?.nodeId ?? initialNode.id, kind: node.kind }); }}>查看并应用产物</Button>{typeof output === 'object' && !Array.isArray(output) && output?.candidateId && onOpenCandidate && <Button onClick={() => void perform(async () => { const value = shotCandidateSchema.parse(await rpc('shot.candidate.get', { projectId, candidateId: output.candidateId })); onClose(); onOpenCandidate(value.shotId); })}>在镜头候选中对比</Button>}</div>}
        </section>}
      </fieldset>
    </div>
    <div className="dialog__footer"><Button onClick={onClose}>关闭</Button><Button disabled={busy} onClick={() => void perform(async () => { await onApplyPrompt(currentNode()); if (alive.current) setNotice('提示词已应用到制作设置，请在设置中确认保存。'); })}>应用提示词到设置</Button><Button disabled={!session || !preview} onClick={() => setTab('trial')}>查看试运行</Button></div>
    {inspected && <Suspense fallback={null}><RunInspector runId={inspected} version={version} onClose={() => setInspected(undefined)} onChanged={() => setRefresh(value => value + 1)} onRestart={() => { setInspected(undefined); setTab('trial'); request.current = undefined; setRun(undefined); }} onOpenOutput={selection => { onClose(); onOpenOutput(selection); }} /></Suspense>}
    {usageRun && <Dialog title="实验费用" className="dialog--wide" onClose={() => setUsageRun(undefined)}><div className="dialog__body"><Suspense fallback={<p role="status">正在读取费用…</p>}><TaskUsage runId={usageRun} version={version} onBack={() => setUsageRun(undefined)} backLabel="返回提示词实验" onTaskUpdated={receiveCost} /></Suspense></div></Dialog>}
  </Dialog>;
}
