import { validateResearchContent, type Claim, type ResearchSource, type ShotClaims } from '@video-quickly/contracts';
import { sameContent, type EditContent } from './project-edits';

export type ClaimsEdits = { claims: Claim[]; researchSources: ResearchSource[]; shotClaims: ShotClaims[] };
export function claimsEdits(content: Pick<EditContent, 'claims' | 'researchSources' | 'shots'>): ClaimsEdits {
  return { claims: content.claims, researchSources: content.researchSources, shotClaims: content.shots.map(shot => ({ shotId: shot.id, claimIds: shot.claimIds })) };
}

/** Merge only reference edits, retaining unrelated live shot/media/property changes. */
export function applyClaimsEdits(current: EditContent, next: ClaimsEdits, baseline: ClaimsEdits, submitted?: ClaimsEdits): EditContent {
  for (const key of ['claims', 'researchSources'] as const) {
    if (!sameContent(current[key], baseline[key]) && !sameContent(current[key], submitted?.[key])) throw new Error('资料或核验结论已在其他视图更新，当前输入已保留。请重新打开后核对修改。');
  }
  const original = new Map(baseline.shotClaims.map(binding => [binding.shotId, binding.claimIds]));
  const own = new Map(submitted?.shotClaims.map(binding => [binding.shotId, binding.claimIds]));
  const patches = new Map<string, string[]>();
  for (const binding of next.shotClaims) {
    const before = original.get(binding.shotId);
    const previouslyChanged = own.has(binding.shotId) && !sameContent(own.get(binding.shotId), before);
    if (sameContent(before, binding.claimIds) && !previouslyChanged) continue;
    const shot = current.shots.find(shot => shot.id === binding.shotId);
    if (!shot) throw new Error('准备修改引用的镜头已移除，请重新打开资料编辑器。');
    if (!sameContent(shot.claimIds, before) && !sameContent(shot.claimIds, own.get(shot.id))) throw new Error('镜头引用已在其他视图更新，当前输入已保留。');
    if (shot.locked && !sameContent(shot.claimIds, binding.claimIds)) throw new Error('请先解锁镜头，再修改或移除引用。');
    if (patches.has(shot.id)) throw new Error('镜头引用修改不能重复。');
    patches.set(shot.id, binding.claimIds);
  }
  const merged = { ...current, claims: next.claims, researchSources: next.researchSources, shots: current.shots.map(shot => patches.has(shot.id) ? { ...shot, claimIds: patches.get(shot.id)! } : shot) };
  validateResearchContent(merged);
  return merged;
}
