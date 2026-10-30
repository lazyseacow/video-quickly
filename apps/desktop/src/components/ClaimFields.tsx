import { useEffect, useRef, useState } from 'react';
import type { Claim, ClaimEvidence, ResearchSource } from '@video-quickly/contracts';
import { ExternalLink, Trash2, LocateFixed, Plus } from 'lucide-react';
import { Button, Field, IconButton, Select } from './Primitives';

export const claimStatusLabels = { pending: '待核验', verified: '人工已核验', disputed: '存在争议' };
export function sourceLink(url?: string): string | undefined {
  if (!url) return;
  try { const parsed = new URL(url); if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) return parsed.href; } catch { /* Plain source descriptions remain readable text. */ }
}
export function materialClaimChange(claim: Claim, patch: Partial<Claim>): Claim { return { ...claim, ...patch, status: 'pending', reviewedAt: undefined }; }

export default function ClaimFields({ claim, sources, disabled = false, onChange, review = true }: {
  claim: Claim; sources: ResearchSource[]; disabled?: boolean; onChange: (claim: Claim) => void; review?: boolean;
}) {
  return <div className="claim-fields">
    <Field label="事实主张"><textarea rows={3} value={claim.text} disabled={disabled} onChange={event => onChange(materialClaimChange(claim, { text: event.target.value }))} /></Field>
    <Field label="来源说明" hint="填写作者、书名或链接；来源说明不等于核验。"><input value={claim.source} disabled={disabled} onChange={event => onChange(materialClaimChange(claim, { source: event.target.value }))} /></Field>
    {sourceLink(claim.source) && <a className="research-source-link" href={sourceLink(claim.source)} target="_blank" rel="noopener noreferrer"><ExternalLink size={13} />打开来源说明中的链接</a>}
    <Field label="页码或定位"><input value={claim.locator} disabled={disabled} onChange={event => onChange(materialClaimChange(claim, { locator: event.target.value }))} placeholder="例如：第 12 页、第二节或段落标题" /></Field>
    <EvidenceEditor key={claim.id} claim={claim} sources={sources} disabled={disabled} onChange={onChange} />
    {review ? <><Field label="人工核验状态"><Select value={claim.status} disabled={disabled} onChange={event => { const status = event.target.value as Claim['status']; onChange({ ...claim, status, reviewedAt: status === 'pending' ? undefined : new Date().toISOString() }); }}>{Object.entries(claimStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field><Field label="核验备注"><textarea rows={2} value={claim.reviewNote ?? ''} maxLength={10000} disabled={disabled} onChange={event => onChange({ ...claim, reviewNote: event.target.value || undefined })} /></Field><p className="tiny-meta">核对原始资料后选择状态；修改主张、来源或摘录后需重新核验。{claim.reviewedAt && ` 最近核验：${new Date(claim.reviewedAt).toLocaleString('zh-CN')}`}</p></> : <p className="tiny-meta">模型候选需在资料表中人工核验。</p>}
  </div>;
}

function EvidenceEditor({ claim, sources, disabled, onChange }: { claim: Claim; sources: ResearchSource[]; disabled: boolean; onChange: (claim: Claim) => void }) {
  const [sourceId, setSourceId] = useState(claim.evidence?.[0]?.sourceId ?? sources[0]?.id ?? '');
  const [quote, setQuote] = useState(''), [locator, setLocator] = useState(''), [from, setFrom] = useState(0);
  const [selection, setSelection] = useState<{ start: number; end: number }>();
  const [focusRange, setFocusRange] = useState<{ start: number; end: number }>();
  const [expanded, setExpanded] = useState(false);
  const reader = useRef<HTMLTextAreaElement>(null);
  const source = sources.find(item => item.id === sourceId) ?? sources[0];
  const offset = source && quote ? source.content.indexOf(quote, from) : -1;
  const duplicate = claim.evidence?.some(item => item.sourceId === source?.id && item.startOffset === offset && item.quote === quote);
  useEffect(() => {
    if (!expanded || !focusRange || !reader.current) return;
    reader.current.focus(); reader.current.setSelectionRange(focusRange.start, focusRange.end);
  }, [focusRange, source?.id, expanded]);
  function locate(evidence: ClaimEvidence) { setExpanded(true); setSourceId(evidence.sourceId); setQuote(evidence.quote); setLocator(evidence.locator ?? ''); setFrom(evidence.startOffset); setFocusRange({ start: evidence.startOffset, end: evidence.endOffset }); }
  return <section className="claim-evidence" aria-label="原文证据">
    <h3>原文证据 <span>{claim.evidence?.length ?? 0}</span></h3>
    {claim.evidence?.map((evidence, index) => <article className="claim-evidence__item" key={`${evidence.sourceId}:${evidence.startOffset}:${index}`}><div><strong>{sources.find(item => item.id === evidence.sourceId)?.title ?? '来源已移除'}</strong><span className="tiny-meta">{evidence.locator || `原文位置 ${evidence.startOffset + 1}–${evidence.endOffset}`}</span></div><blockquote>{evidence.quote}</blockquote><div className="claim-evidence__actions"><Button variant="ghost" disabled={disabled || !sources.some(item => item.id === evidence.sourceId)} onClick={() => locate(evidence)}><LocateFixed size={13} />定位摘录 {index + 1}</Button><IconButton label={`删除摘录 ${index + 1}`} disabled={disabled} onClick={() => onChange(materialClaimChange(claim, { evidence: claim.evidence?.filter((_, position) => position !== index) }))}><Trash2 size={13} /></IconButton></div></article>)}
    {sources.length ? <details className="claim-evidence__add" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary>添加或查看原文摘录</summary><Field label="摘录来源"><Select value={source?.id ?? ''} disabled={disabled} onChange={event => { setSourceId(event.target.value); setQuote(''); setFrom(0); setSelection(undefined); setFocusRange(undefined); }}>{sources.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</Select></Field>
      {source && <><div className="research-source-meta"><span>{source.kind === 'url' ? '网页快照' : source.kind === 'file' ? '文本文件快照' : '文本快照'}</span><code title={source.sha256}>{source.sha256.slice(0, 12)}</code>{source.url && <a href={sourceLink(source.url)} target="_blank" rel="noopener noreferrer">打开原始网页 <ExternalLink size={12} /></a>}</div><Field label="资料正文（只读）"><textarea ref={reader} rows={8} readOnly value={source.content} onSelect={event => setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })} /></Field><Button aria-label="使用所选原文" variant="ghost" disabled={disabled || !selection || selection.end <= selection.start} onClick={() => { if (selection) { setQuote(source.content.slice(selection.start, selection.end)); setFrom(selection.start); } }}>使用所选原文</Button></>}
      <Field label="引用摘录" hint="须与已保存正文逐字匹配，可在上方选取。"><textarea rows={3} value={quote} maxLength={5000} disabled={disabled} onChange={event => { setQuote(event.target.value); setFrom(0); }} /></Field><Field label="摘录页码或定位"><input value={locator} maxLength={1000} disabled={disabled} onChange={event => setLocator(event.target.value)} /></Field>
      {quote && <p className={offset < 0 || quote.length > 5000 ? 'field-error' : 'tiny-meta'} role={offset < 0 || quote.length > 5000 ? 'alert' : undefined}>{quote.length > 5000 ? '摘录最多 5000 个字符，请缩小原文选择范围。' : offset < 0 ? '摘录未在来源正文中找到，请逐字选择原文。' : `匹配原文位置 ${offset + 1}–${offset + quote.length}${duplicate ? '，此摘录已添加。' : '。'}`}</p>}
      <div className="claim-evidence__actions"><Button disabled={disabled || offset < 0 || quote.length > 5000 || duplicate || (claim.evidence?.length ?? 0) >= 20} onClick={() => { if (!source || offset < 0) return; const evidence: ClaimEvidence = { sourceId: source.id, sourceSha256: source.sha256, startOffset: offset, endOffset: offset + quote.length, quote, ...(locator.trim() ? { locator: locator.trim() } : {}) }; onChange(materialClaimChange(claim, { evidence: [...claim.evidence ?? [], evidence], source: claim.source || source.title, locator: claim.locator || locator })); setQuote(''); setFrom(0); }}><Plus size={13} />添加原文摘录</Button><Button aria-label="查找下一处摘录" variant="ghost" disabled={disabled || !source || offset < 0 || source.content.indexOf(quote, offset + 1) < 0} onClick={() => setFrom(offset + 1)}>下一处摘录</Button></div>
    </details> : <p className="tiny-meta">先导入资料，再关联摘录；已有来源说明会保留。</p>}
  </section>;
}
