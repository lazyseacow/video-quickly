import { useEffect, useRef, useState } from 'react';
import { applyResearchClaims, researchSearchResultSchema, researchSourceSchema, validateResearchContent, type Claim, type ModelProfile, type ProjectDocument, type ResearchResult, type ResearchSearchResult, type ResearchSource } from '@video-quickly/contracts';
import { BookOpen, ExternalLink, Trash2, Plus, Search, Square } from 'lucide-react';
import { claimsEdits, type ClaimsEdits } from '../lib/research-edits';
import { rpc } from '../lib/client';
import { Button, Dialog, Field, IconButton, Notice, Select } from './Primitives';
import PathPicker from './PathPicker';
import ClaimFields, { claimStatusLabels, sourceLink } from './ClaimFields';
import ResearchReview from './ResearchReview';
import './research-review.css';

export { default as ResearchReview } from './ResearchReview';
export type { ClaimsEdits } from '../lib/research-edits';
export interface ClaimsEditorProps {
  project: ProjectDocument; initialShotId?: string; disabled?: boolean; models: ModelProfile[]; onClose: () => void;
  onApply: (edits: ClaimsEdits, baseline: ClaimsEdits) => Promise<boolean>;
  onAnalyze?: (input: { modelId: string; sourceIds: string[]; instruction?: string }, signal: AbortSignal) => Promise<ResearchResult | undefined>;
}

export default function ClaimsEditor({ project, initialShotId, disabled = false, models, onClose, onApply, onAnalyze }: ClaimsEditorProps) {
  const [edits, setEdits] = useState(() => structuredClone(claimsEdits({ ...project, researchSources: project.researchSources ?? [] })));
  const [baseline, setBaseline] = useState(() => structuredClone(edits));
  const [view, setView] = useState<'claims' | 'sources'>('claims');
  const [claimId, setClaimId] = useState(project.shots.find(shot => shot.id === initialShotId)?.claimIds[0] ?? edits.claims[0]?.id);
  const [query, setQuery] = useState(''), [status, setStatus] = useState('all');
  const [importKind, setImportKind] = useState<ResearchSource['kind']>('text'), [sourceTitle, setSourceTitle] = useState(''), [sourceInput, setSourceInput] = useState('');
  const [preview, setPreview] = useState<ResearchSource>(), [sourceId, setSourceId] = useState(edits.researchSources[0]?.id);
  const [searchQuery, setSearchQuery] = useState(''), [language, setLanguage] = useState<'zh' | 'en'>('zh'), [results, setResults] = useState<ResearchSearchResult[]>([]);
  const [io, setIo] = useState<'read' | 'search'>(), [applying, setApplying] = useState(false), [analyzing, setAnalyzing] = useState(false), [failure, setFailure] = useState('');
  const textModels = models.filter(model => model.enabled && model.capabilities.includes('text') && ['openai-compatible', 'ollama'].includes(model.provider));
  const [modelId, setModelId] = useState(textModels[0]?.id ?? ''), [instruction, setInstruction] = useState('');
  const [sourceIds, setSourceIds] = useState(edits.researchSources.map(source => source.id));
  const [result, setResult] = useState<ResearchResult>(), [reviewing, setReviewing] = useState(false);
  const active = useRef(true), controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); }; }, []);
  const busy = disabled || applying || analyzing || Boolean(io), claim = edits.claims.find(item => item.id === claimId);
  const selectedModelId = textModels.some(model => model.id === modelId) ? modelId : textModels[0]?.id ?? '';
  const bindingMap = new Map(edits.shotClaims.map(binding => [binding.shotId, binding.claimIds]));
  const knownClaims = new Set(edits.claims.map(item => item.id));
  const invalidBindings = project.shots.flatMap(shot => {
    const ids = bindingMap.get(shot.id) ?? shot.claimIds, cleaned = [...new Set(ids.filter(id => knownClaims.has(id)))];
    return cleaned.length === ids.length ? [] : [{ shot, ids, cleaned }];
  });
  const content = { ...project, claims: edits.claims, researchSources: edits.researchSources, shots: project.shots.map(shot => ({ ...shot, claimIds: bindingMap.get(shot.id) ?? shot.claimIds })) };
  let error = '';
  try { validateResearchContent(content); if (edits.claims.some(item => !item.text.trim())) throw new Error('请填写每条事实主张，或删除空白主张。'); }
  catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
  function close() { controller.current?.abort(); onClose(); }
  function updateClaim(next: Claim) { setEdits(value => ({ ...value, claims: value.claims.map(item => item.id === next.id ? next : item) })); setFailure(''); }
  function removeClaim(id: string) {
    const remaining = edits.claims.filter(item => item.id !== id);
    setEdits(value => ({ ...value, claims: remaining, shotClaims: value.shotClaims.map(binding => ({ ...binding, claimIds: binding.claimIds.filter(claimId => claimId !== id) })) })); setClaimId(remaining[0]?.id); setFailure('');
  }
  async function readSource(url?: string, title?: string) {
    if (!url && !sourceInput.trim()) { setFailure('请先填写要读取的资料。'); return; }
    setIo('read'); setFailure(''); setPreview(undefined);
    try {
      const params = url ? { url, title } : { [importKind === 'file' ? 'path' : importKind]: sourceInput, ...(sourceTitle.trim() ? { title: sourceTitle.trim() } : {}) };
      const value = researchSourceSchema.parse(await rpc('research.source.read', params)); if (active.current) setPreview(value);
    } catch (reason) { if (active.current) setFailure(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (active.current) setIo(undefined); }
  }
  async function search() {
    if (!searchQuery.trim()) return;
    setIo('search'); setFailure(''); setResults([]);
    try { const values = await rpc<unknown>('research.search', { query: searchQuery.trim(), language, limit: 5 }); if (!Array.isArray(values)) throw new Error('检索服务未返回有效条目。'); const items = values.map(value => researchSearchResultSchema.parse(value)); if (active.current) setResults(items); }
    catch (reason) { if (active.current) setFailure(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (active.current) setIo(undefined); }
  }
  async function apply() {
    setApplying(true); setFailure('');
    try { if (await onApply(structuredClone(edits), baseline)) { if (active.current) onClose(); } else if (active.current) setFailure('资料修改尚未保存，输入已保留，可重试。'); }
    catch (reason) { if (active.current) setFailure(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (active.current) setApplying(false); }
  }
  async function analyze() {
    if (!onAnalyze || !selectedModelId) return;
    const saved = structuredClone(edits), request = new AbortController(); controller.current = request; setAnalyzing(true); setFailure(''); setResult(undefined);
    try {
      if (!await onApply(saved, baseline)) { if (active.current) setFailure('资料尚未保存，未提交整理请求。输入已保留，可重试。'); return; }
      if (!active.current || request.signal.aborted) return;
      setBaseline(structuredClone(saved));
      const value = await onAnalyze({ modelId: selectedModelId, sourceIds: sourceIds.filter(id => saved.researchSources.some(source => source.id === id)), ...(instruction.trim() ? { instruction: instruction.trim() } : {}) }, request.signal);
      if (active.current && !request.signal.aborted) { if (value) setResult(value); else setFailure('资料已保存，整理尚未完成。请在制作记录中核对。'); }
    } catch (reason) { if (active.current) setFailure(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (active.current) setAnalyzing(false); if (controller.current === request) controller.current = undefined; }
  }
  if (reviewing && result) return <ResearchReview project={content} result={result} onClose={() => setReviewing(false)} onApply={async (selected, bindings) => {
    const next = applyResearchClaims(content, result, selected, bindings), nextEdits = claimsEdits(next);
    const success = await onApply(nextEdits, baseline); if (success && active.current) onClose(); return success;
  }} />;
  const filtered = edits.claims.filter(item => (status === 'all' || item.status === status) && `${item.text} ${item.source}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const source = edits.researchSources.find(item => item.id === sourceId) ?? edits.researchSources[0];
  const currentShot = project.shots.find(shot => shot.id === initialShotId);
  return <Dialog title="资料与事实主张" onClose={close} className="research-dialog">
    <div className="dialog__body"><div className="research-view" role="group" aria-label="资料视图"><Button aria-pressed={view === 'claims'} variant={view === 'claims' ? 'primary' : 'default'} onClick={() => setView('claims')}>主张与镜头引用（{edits.claims.length}）</Button><Button aria-pressed={view === 'sources'} variant={view === 'sources' ? 'primary' : 'default'} onClick={() => setView('sources')}>来源资料（{edits.researchSources.length}）</Button></div>
      {currentShot && <p className="research-summary">当前镜头：{currentShot.title} · 已引用 {bindingMap.get(currentShot.id)?.length ?? 0} 条主张</p>}
      {invalidBindings.length > 0 && <section className="research-invalid-references" aria-label="失效镜头引用"><h3>失效镜头引用</h3><p className="tiny-meta">旧项目保留了已不存在或重复的主张编号。可以只解除这些失效引用，保留有效主张；锁定镜头需要先解锁。</p>{invalidBindings.map(({ shot, ids, cleaned }) => <article key={shot.id}><div><strong>{shot.title}{shot.locked ? '（已锁定）' : ''}</strong><code>{[...new Set(ids.filter(id => !knownClaims.has(id)))].map(id => id || '（空编号）').join('、') || '重复引用编号'}</code><small>清理后保留 {cleaned.length} 条有效引用</small></div><Button aria-label={`解除失效引用：${shot.title}`} disabled={busy || shot.locked} onClick={() => { setEdits(value => ({ ...value, shotClaims: [...value.shotClaims.filter(binding => binding.shotId !== shot.id), { shotId: shot.id, claimIds: cleaned }] })); setFailure(''); }}>解除失效引用</Button></article>)}</section>}
      {view === 'claims' ? <>
        <div className="research-toolbar"><Field label="搜索主张"><input type="search" value={query} onChange={event => setQuery(event.target.value)} /></Field><Field label="筛选核验状态"><Select value={status} onChange={event => setStatus(event.target.value)}><option value="all">全部状态</option>{Object.entries(claimStatusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</Select></Field><Button disabled={busy} onClick={() => { const item: Claim = { id: crypto.randomUUID(), text: '', source: '', locator: '', status: 'pending' }; setEdits(value => ({ ...value, claims: [...value.claims, item] })); setClaimId(item.id); setQuery(''); setStatus('all'); }}><Plus size={13} />添加事实主张</Button></div>
        {edits.claims.length ? <div className="research-workspace"><aside className="research-list" aria-label="事实主张列表">{filtered.map((item, index) => <button className={`research-list__claim ${item.id === claimId ? 'is-active' : ''}`} type="button" key={item.id} aria-label={`编辑主张 ${index + 1}：${item.text || '待填写'}`} aria-pressed={item.id === claimId} onClick={() => setClaimId(item.id)}><strong>{item.text || '（待填写主张）'}</strong><small>{claimStatusLabels[item.status]} · {edits.shotClaims.filter(binding => binding.claimIds.includes(item.id)).length} 个镜头</small></button>)}{!filtered.length && <p className="tiny-meta">没有匹配的主张。</p>}</aside><section className="research-detail" aria-label="主张编辑">{claim && <><ClaimFields key={claim.id} claim={claim} sources={edits.researchSources} disabled={busy} onChange={updateClaim} />
          <fieldset className="research-bindings"><legend>引用此主张的镜头</legend>{project.shots.map((shot, index) => <label className="field-inline" key={shot.id}><input type="checkbox" aria-label={`引用到镜头 ${index + 1}：${shot.title}`} checked={bindingMap.get(shot.id)?.includes(claim.id) ?? false} disabled={busy || shot.locked} onChange={event => { const ids = bindingMap.get(shot.id) ?? []; setEdits(value => ({ ...value, shotClaims: [...value.shotClaims.filter(binding => binding.shotId !== shot.id), { shotId: shot.id, claimIds: event.target.checked ? [...new Set([...ids, claim.id])] : ids.filter(id => id !== claim.id) }] })); }} /><span>{index + 1}. {shot.title}{shot.locked ? '（已锁定）' : ''}</span></label>)}</fieldset>
          <Button variant="danger" disabled={busy || project.shots.some(shot => shot.locked && bindingMap.get(shot.id)?.includes(claim.id))} title={project.shots.some(shot => shot.locked && bindingMap.get(shot.id)?.includes(claim.id)) ? '请先解锁引用此主张的镜头。' : undefined} onClick={() => removeClaim(claim.id)}><Trash2 size={13} />删除主张并解除引用</Button>
        </>}</section></div> : <div className="research-empty"><BookOpen size={24} /><p>还没有事实主张。</p><span>可以手工添加，也可以先导入资料，再由模型整理待核验候选。</span></div>}
      </> : <>
        <section className="research-import" aria-label="读取来源资料"><div className="field-row"><Field label="来源读取方式"><Select value={importKind} disabled={busy} onChange={event => { setImportKind(event.target.value as ResearchSource['kind']); setSourceInput(''); setPreview(undefined); }}><option value="text">粘贴文本</option><option value="file">本地资料文件</option><option value="url">网页地址</option></Select></Field><Field label="来源标题"><input value={sourceTitle} maxLength={500} disabled={busy} onChange={event => setSourceTitle(event.target.value)} placeholder="可选，便于之后辨认" /></Field></div>
          {importKind === 'text' ? <Field label="来源文本"><textarea rows={6} maxLength={100000} value={sourceInput} disabled={busy} onChange={event => setSourceInput(event.target.value)} placeholder="粘贴需要引用的资料正文…" /></Field> : importKind === 'file' ? <Field label="资料文件路径" hint="支持 UTF-8 TXT、Markdown 和有文字层的 PDF；文件最多 10 MB，PDF 最多 80 页。扫描件请先 OCR。"><PathPicker label="资料文件路径" extensions={['txt', 'md', 'pdf']} disabled={busy} value={sourceInput} onChange={setSourceInput} /></Field> : <Field label="来源网页地址" hint="读取时会访问网页，结果需人工核对。"><input type="url" value={sourceInput} disabled={busy} onChange={event => setSourceInput(event.target.value)} placeholder="https://…" /></Field>}
          <Button busy={io === 'read'} disabled={busy && io !== 'read' || !sourceInput.trim()} onClick={() => void readSource()}>读取来源预览</Button>
          {preview && <div className="research-source-preview" aria-label="来源读取预览"><h3>{preview.title}</h3><p className="tiny-meta">尚未加入项目。{preview.content.length} 个字符 · {preview.kind === 'url' ? '网页读取结果' : preview.kind === 'file' ? preview.fileName : '粘贴文本'}</p><Field label="来源预览正文"><textarea readOnly rows={7} value={preview.content} /></Field><Button aria-label={edits.researchSources.some(item => item.id === preview.id) ? '该来源已加入草稿' : '将来源加入草稿'} disabled={busy || edits.researchSources.length >= 20 || edits.researchSources.some(item => item.id === preview.id)} onClick={() => { setEdits(value => ({ ...value, researchSources: [...value.researchSources, preview] })); setSourceIds(values => [...new Set([...values, preview.id])]); setSourceId(preview.id); setPreview(undefined); }}>{edits.researchSources.some(item => item.id === preview.id) ? "已加入" : "加入草稿"}</Button></div>}
        </section>
        <details className="research-search"><summary>检索 Wikipedia 资料</summary><p className="tiny-meta">检索结果需读取并加入项目后才能引用，内容仍需核验。</p><div className="research-toolbar"><Field label="资料检索关键词"><input value={searchQuery} disabled={busy} onChange={event => setSearchQuery(event.target.value)} /></Field><Field label="检索语言"><Select value={language} disabled={busy} onChange={event => setLanguage(event.target.value as 'zh' | 'en')}><option value="zh">中文</option><option value="en">English</option></Select></Field><Button busy={io === 'search'} disabled={busy && io !== 'search' || !searchQuery.trim()} onClick={() => void search()}><Search size={13} />检索资料</Button></div>{results.map(item => <article className="research-search__result" key={item.pageId}><h3><a href={sourceLink(item.url)} target="_blank" rel="noopener noreferrer">{item.title} <ExternalLink size={12} /></a></h3><p>{item.snippet}</p><Button disabled={busy} onClick={() => void readSource(item.url, item.title)}>读取检索来源：{item.title}</Button></article>)}</details>
        <section className="research-sources" aria-label="项目来源资料"><h3>项目来源资料 <span>{edits.researchSources.length}/20</span></h3><div className="research-source-list">{edits.researchSources.map(item => { const used = edits.claims.some(claim => claim.evidence?.some(evidence => evidence.sourceId === item.id)); return <div className={`research-source-list__item ${source?.id === item.id ? 'is-active' : ''}`} key={item.id}><button type="button" aria-label={`查看来源：${item.title}`} aria-pressed={source?.id === item.id} onClick={() => setSourceId(item.id)}><strong>{item.title}</strong><small>{item.kind === 'url' ? '网页快照' : item.kind === 'file' ? '文本文件' : '文本'}{used ? ' · 已被摘录引用' : ''}</small></button><IconButton label={`删除来源：${item.title}`} title={used ? '请先移除引用此来源的原文摘录。' : '删除来源'} disabled={busy || used} onClick={() => { setEdits(value => ({ ...value, researchSources: value.researchSources.filter(source => source.id !== item.id) })); setSourceIds(values => values.filter(id => id !== item.id)); }}><Trash2 size={13} /></IconButton></div>; })}</div>
          {source && <><div className="research-source-meta"><strong>{source.title}</strong><span>{new Date(source.capturedAt).toLocaleString('zh-CN')}</span><code title={source.sha256}>{source.sha256.slice(0, 12)}</code>{source.url && <a href={sourceLink(source.url)} target="_blank" rel="noopener noreferrer">打开原始网页 <ExternalLink size={12} /></a>}</div><Field label="来源正文快照（只读）"><textarea readOnly rows={9} value={source.content} /></Field></>}
        </section>
      </>}
      <section className="research-analysis" aria-label="模型资料整理"><h3>整理研究候选</h3><p className="tiny-meta">保存资料与引用后整理候选；事实需人工核验。</p><div className="research-source-checks">{edits.researchSources.map(item => <label className="field-inline" key={item.id}><input type="checkbox" aria-label={`用于整理：${item.title}`} disabled={busy} checked={sourceIds.includes(item.id)} onChange={event => setSourceIds(values => event.target.checked ? [...values, item.id] : values.filter(id => id !== item.id))} />{item.title}</label>)}</div><div className="field-row"><Field label="资料整理模型"><Select value={selectedModelId} disabled={busy} onChange={event => setModelId(event.target.value)}><option value="" disabled>选择文字模型</option>{textModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</Select></Field><Field label="整理补充要求"><input value={instruction} maxLength={10000} disabled={busy} onChange={event => setInstruction(event.target.value)} /></Field></div><div className="research-analysis__actions"><Button aria-label="保存并整理" variant="primary" busy={analyzing} disabled={!onAnalyze || busy && !analyzing || !selectedModelId || !sourceIds.length || Boolean(error)} onClick={() => void analyze()}>保存并整理</Button>{analyzing && <Button onClick={() => { controller.current?.abort(); setFailure('已请求停止整理，已保存资料保留；请在制作记录中核对任务状态。'); }}><Square size={13} />停止整理</Button>}<span className="tiny-meta">所选资料片段将发送到该模型。</span></div>{!textModels.length && <p className="tiny-meta">可继续手工整理；添加文字模型后才能请求模型候选。</p>}
        {result && <Notice kind="success">已整理 {result.claims.length} 条待核验候选，尚未加入项目。<Button aria-label="审阅候选" onClick={() => setReviewing(true)}>审阅候选</Button></Notice>}
      </section>
      {(error || failure) && <Notice kind="error">{error || failure}</Notice>}
    </div><div className="dialog__footer"><Button onClick={close}>取消</Button><Button aria-label="应用资料与引用" variant="primary" busy={applying} disabled={disabled || analyzing || Boolean(io) || Boolean(error)} onClick={() => void apply()}>应用</Button></div>
  </Dialog>;
}
