import { useEffect, useRef, useState } from 'react';
import { applyResearchClaims, type Claim, type ProjectDocument, type ResearchResult, type ShotClaims } from '@video-quickly/contracts';
import { Button, Dialog, Notice } from './Primitives';
import ClaimFields from './ClaimFields';
import './research-review.css';

export interface ResearchReviewProps {
  project: ProjectDocument; result: ResearchResult; onClose: () => void;
  onApply: (claims: Claim[], bindings: ShotClaims[]) => Promise<boolean>;
}
export default function ResearchReview({ project, result, onClose, onApply }: ResearchReviewProps) {
  const [claims, setClaims] = useState<Claim[]>(() => result.claims.map(claim => ({ ...structuredClone(claim), status: 'pending', reviewedAt: undefined, reviewNote: undefined })));
  const [selected, setSelected] = useState<string[]>([]), [activeId, setActiveId] = useState(result.claims[0]?.id);
  const [bindings, setBindings] = useState<ShotClaims[]>([]), [busy, setBusy] = useState(false), [failure, setFailure] = useState('');
  const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const active = claims.find(claim => claim.id === activeId), sources = project.researchSources ?? [];
  const chosen = claims.filter(claim => selected.includes(claim.id));
  let error = '';
  try { if (result.projectId !== project.id) throw new Error('资料候选不属于当前项目。'); applyResearchClaims(project, result, chosen, bindings); if (chosen.some(claim => !claim.text.trim())) throw new Error('所选主张需要文字。'); }
  catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
  function select(id: string, checked: boolean) {
    setSelected(values => checked ? [...values, id] : values.filter(value => value !== id));
    if (!checked) setBindings(values => values.map(binding => ({ ...binding, claimIds: binding.claimIds.filter(value => value !== id) })).filter(binding => binding.claimIds.length));
    setFailure('');
  }
  function bind(shotId: string, claimId: string, checked: boolean) {
    setBindings(values => { const current = values.find(binding => binding.shotId === shotId)?.claimIds ?? []; return [...values.filter(binding => binding.shotId !== shotId), { shotId, claimIds: checked ? [...new Set([...current, claimId])] : current.filter(id => id !== claimId) }].filter(binding => binding.claimIds.length); });
  }
  async function apply() {
    setBusy(true); setFailure('');
    try { if (await onApply(chosen, bindings.filter(binding => binding.claimIds.length))) { if (alive.current) onClose(); } else if (alive.current) setFailure('候选尚未应用，当前选择和修改已保留。请核对提示后重试。'); }
    catch (reason) { if (alive.current) setFailure(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (alive.current) setBusy(false); }
  }
  return <Dialog title="研究候选审阅" onClose={onClose} className="research-dialog">
    <div className="dialog__body"><Notice>这些主张由模型整理，尚未人工核验。请核对原文后选择加入；加入不会覆盖已有人工资料，也不会自动标记为已核验。</Notice>
      <p className="research-summary">{claims.length} 条候选 · 已选择 {chosen.length} 条 · {result.sourceHashes.length} 份来源</p>
      {result.warnings.length > 0 && <details className="research-warnings" open><summary>整理提示</summary><ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      {claims.length ? <div className="research-workspace"><aside className="research-list" aria-label="主张候选列表">{claims.map((claim, index) => <div className={`research-candidate ${claim.id === activeId ? 'is-active' : ''}`} key={claim.id}><label><input type="checkbox" aria-label={`选择主张候选 ${index + 1}`} disabled={busy} checked={selected.includes(claim.id)} onChange={event => select(claim.id, event.target.checked)} /><span>候选 {index + 1}</span></label><button type="button" disabled={busy} aria-label={`查看主张候选 ${index + 1}`} aria-pressed={claim.id === activeId} onClick={() => setActiveId(claim.id)}><strong>{claim.text || '（待填写主张）'}</strong><small>{project.claims.some(existing => existing.id === claim.id) ? '已加入时保留人工修改' : '待核验'}</small></button></div>)}</aside>
        <section className="research-detail" aria-label="候选内容">{active && <><ClaimFields key={active.id} claim={active} sources={sources} review={false} disabled={busy} onChange={next => { setClaims(values => values.map(claim => claim.id === next.id ? { ...next, status: 'pending' } : claim)); setFailure(''); }} />
          <fieldset className="research-bindings"><legend>加入后引用到镜头</legend>{!selected.includes(active.id) && <p className="tiny-meta">先勾选此候选，再选择引用镜头。</p>}{project.shots.map((shot, index) => <label className="field-inline" key={shot.id}><input type="checkbox" aria-label={`候选引用到镜头 ${index + 1}：${shot.title}`} checked={bindings.find(binding => binding.shotId === shot.id)?.claimIds.includes(active.id) ?? false} disabled={busy || !selected.includes(active.id) || shot.locked} onChange={event => bind(shot.id, active.id, event.target.checked)} /><span>{index + 1}. {shot.title}{shot.locked ? '（已锁定）' : ''}</span></label>)}</fieldset>
          {result.shotSuggestions.some(suggestion => suggestion.claimIds.includes(active.id)) && <details className="research-suggestions"><summary>查看模型的镜头引用建议</summary>{result.shotSuggestions.filter(suggestion => suggestion.claimIds.includes(active.id)).map(suggestion => <p key={suggestion.shotId}>{project.shots.find(shot => shot.id === suggestion.shotId)?.title ?? '镜头已移除'}：{suggestion.reason || '模型建议引用此主张，仍需人工选择。'}</p>)}</details>}
        </>}</section></div> : <p className="research-empty">暂无可加入的主张，可返回资料表手动整理。</p>}
      {result.text && <details className="research-warnings"><summary>查看整理原文</summary><pre className="research-raw">{result.text}</pre></details>}
      {(error || failure) && <Notice kind="error">{error || failure}</Notice>}
    </div><div className="dialog__footer"><Button onClick={onClose}>返回</Button><Button aria-label="加入所选主张与引用" variant="primary" busy={busy} disabled={!chosen.length || Boolean(error)} onClick={() => void apply()}>加入所选</Button></div>
  </Dialog>;
}
