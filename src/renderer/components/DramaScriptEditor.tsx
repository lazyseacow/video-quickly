import { useEffect, useRef, useState } from 'react';
import { FileUp, RefreshCw, Sparkles, Square } from 'lucide-react';
import { isRunActive, jsonValueSchema, recordPageSchema, runSummarySchema, type ModelProfile, type ProjectDocument, type RunSummary } from '@video-quickly/contracts';
import { rpc } from '../lib/client';
import type { Action } from '../lib/types';
import { Button, Dialog, Field, Notice, Select } from './Primitives';
import PathPicker from './PathPicker';
import './drama-script-editor.css';

interface Props {
  project: ProjectDocument;
  models: ModelProfile[];
  action: Action;
  disabled?: boolean;
  onClose(): void;
  onDraft(text: string): void;
  onSave(text: string, baseline: ProjectDocument): Promise<ProjectDocument | null>;
  onGenerate(modelId: string, instructions: string, text: string): Promise<RunSummary | null>;
  onApply(runId: string): Promise<ProjectDocument | null>;
}

const statusLabels: Record<RunSummary['status'], string> = { queued: '等待生成', running: '正在创作剧本', waiting_review: '等待继续', waiting_external: '等待模型返回', retry_scheduled: '等待重试', needs_attention: '生成需要处理', succeeded: '剧本草稿已生成', failed: '生成失败', canceled: '生成已停止' };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export default function DramaScriptEditor({ project, models, action, disabled = false, onClose, onDraft, onSave, onGenerate, onApply }: Props) {
  const [baseline, setBaseline] = useState(project);
  const [text, setText] = useState(project.originalText ?? '');
  const [path, setPath] = useState('');
  const [instructions, setInstructions] = useState('');
  const textModels = models.filter(model => model.enabled && model.capabilities.includes('text'));
  const [modelId, setModelId] = useState(project.workflow.production.textModelId ?? textModels[0]?.id ?? '');
  const [run, setRun] = useState<RunSummary>();
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const alive = useRef(true), inFlight = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let current = true;
    void rpc('run.list', { projectId: project.id, purpose: 'prompt-trial', limit: 30 }).then(value => {
      if (current) setRun(previous => previous ?? recordPageSchema(runSummarySchema).parse(value).items.find(item => item.selection?.nodeId === 'screenplay'));
    }).catch(reason => { if (current) setError(message(reason)); });
    return () => { current = false; };
  }, [project.id]);
  useEffect(() => {
    if (!run) return;
    let current = true, timer: ReturnType<typeof setTimeout> | undefined;
    const runId = run.id;
    async function poll() {
      try {
        const latest = runSummarySchema.parse(await rpc('run.get', { runId }));
        const value = jsonValueSchema.nullable().parse(await rpc('node.result', { runId, nodeId: 'screenplay' }));
        if (!current) return;
        setRun(latest);
        setOutput(value && !Array.isArray(value) && typeof value === 'object' && typeof value.text === 'string' ? value.text : '');
        if (isRunActive(latest.status) && !(latest.status === 'queued' && latest.error)) timer = setTimeout(() => void poll(), 800);
      } catch (reason) { if (current) setError(message(reason)); }
    }
    void poll();
    return () => { current = false; if (timer) clearTimeout(timer); };
  }, [run?.id, refresh]);
  async function perform(operation: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(''); setNotice('');
    try { await operation(); } catch (reason) { if (alive.current) setError(message(reason)); }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }
  const running = Boolean(run && isRunActive(run.status) && !(run.status === 'queued' && run.error));
  return <Dialog title={`分集剧本 · 第 ${project.drama?.number ?? 1} 集`} className="dialog--wide drama-script-editor" onClose={onClose} dismissDisabled={busy}>
    <form onSubmit={event => { event.preventDefault(); void perform(async () => {
      const saved = await onSave(text, baseline);
      if (saved && alive.current) { setBaseline(saved); setNotice('剧本已保存。'); }
    }); }}>
      <div className="dialog__body drama-script-editor__body">
        {error && <Notice kind="error">{error}</Notice>}{notice && <Notice kind="success">{notice}</Notice>}
        <fieldset disabled={busy || disabled} className="drama-script-editor__fieldset">
          <legend>剧本与创作</legend>
          <Field label="剧本文件路径" hint="TXT、MD、DOCX、含文本的 PDF。">{field => <div className="drama-script-editor__import"><PathPicker field={field} label="剧本文件路径" value={path} onChange={setPath} extensions={['txt', 'md', 'docx', 'pdf']} /><Button disabled={!path.trim()} onClick={() => void perform(async () => {
            const result = await action<{ fileName: string; text: string }>('dramaScript.read', { path });
            if (result && alive.current) { setText(result.text); onDraft(result.text); setNotice(`已读取 ${result.fileName}，请检查并保存剧本。`); }
          })}><FileUp size={15} aria-hidden="true" />读取剧本</Button></div>}</Field>
          <Field label="剧本正文" hint="草稿保存在本机，保存后用于制作。最多 30,000 字符。"><textarea autoFocus name="screenplay" rows={14} maxLength={30000} value={text} onChange={event => { setText(event.target.value); onDraft(event.target.value); }} placeholder="第一场 · 雨夜巷口\n林夏停下脚步，握紧手中的信。\n林夏：你终于来了。" /></Field>
          <span className="drama-script-editor__count">{text.length.toLocaleString('zh-CN')} / 30,000</span>
          <details open={!text.trim()} className="drama-script-editor__generation"><summary>AI 剧本创作</summary>
            <div className="drama-script-editor__generation-fields">
              <Field label="剧本文本模型"><Select name="screenplay-model" value={modelId} onChange={event => setModelId(event.target.value)}><option value="">请选择文本模型</option>{textModels.map(model => <option key={model.id} value={model.id}>{model.name} · {model.model}</option>)}</Select></Field>
              {!textModels.length && <p className="field__hint">请先在模型连接中配置文本模型，仍可手写或上传剧本。</p>}
              <Field label="本次创作要求" hint="最多 10,000 字符。"><textarea name="screenplay-instructions" rows={3} maxLength={10000} value={instructions} onChange={event => setInstructions(event.target.value)} placeholder="例如：用一封错寄的信开场，突出双方互不信任，以一个新线索收尾。" /></Field>
              <Button disabled={!modelId || running} onClick={() => void perform(async () => {
                const result = await onGenerate(modelId, instructions, text);
                if (result && alive.current) { setBaseline(current => ({ ...current, originalText: text })); setRun(result); setOutput(''); setRefresh(value => value + 1); }
              })}><Sparkles size={15} aria-hidden="true" />生成剧本草稿</Button>
            </div>
          </details>
        </fieldset>
        {run && <section className="drama-script-editor__result" aria-label="AI 剧本草稿">
          <div className="drama-script-editor__result-heading"><h3>{statusLabels[run.status]}</h3><Button disabled={busy} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} aria-hidden="true" />刷新草稿</Button>{running && <Button disabled={busy} onClick={() => void perform(async () => { await action('run.cancel', { runId: run.id }); setRefresh(value => value + 1); })}><Square size={14} aria-hidden="true" />停止生成</Button>}</div>
          {run.error && <Notice kind="error">{run.error}</Notice>}
          {output && <><Field label="生成的剧本草稿"><textarea readOnly rows={12} value={output} /></Field><Button variant="primary" disabled={busy || disabled || run.status !== 'succeeded' || output === baseline.originalText} onClick={() => void perform(async () => {
            if (text !== (baseline.originalText ?? '')) throw new Error('正文有未保存的修改，请先保存或撤销这些修改，再核对生成草稿。');
            const saved = await onApply(run.id);
            if (saved && alive.current) { setBaseline(saved); setText(saved.originalText ?? ''); setNotice('已应用剧本草稿。'); }
          })}>应用到本集剧本</Button></>}
          {!output && <p className="field__hint">{running ? '生成在后台继续，可关闭后重新打开查看。' : '尚无可应用的剧本草稿。'}</p>}
        </section>}
      </div>
      <div className="dialog__footer"><Button disabled={busy} onClick={onClose}>关闭</Button><Button type="submit" variant="primary" busy={busy} disabled={disabled}>保存剧本</Button></div>
    </form>
  </Dialog>;
}
