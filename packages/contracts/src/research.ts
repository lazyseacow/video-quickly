import { z } from 'zod';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, '资料校验值无效');
const httpUrlSchema = z.string().url().refine(value => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
}, '来源地址须为不含账号密码的 HTTP 或 HTTPS 地址');

export const researchSourceSchema = z.object({
  id: z.string().min(1).max(128), title: z.string().min(1).max(500), kind: z.enum(['text', 'file', 'url']),
  content: z.string().min(1).max(100_000), sha256: sha256Schema, capturedAt: z.string().datetime(),
  url: httpUrlSchema.optional(), fileName: z.string().max(500).optional(),
});
export type ResearchSource = z.infer<typeof researchSourceSchema>;
// Offsets are JavaScript UTF-16 string positions in the captured, immutable text.
export const claimEvidenceSchema = z.object({
  sourceId: z.string().min(1), sourceSha256: sha256Schema,
  startOffset: z.number().int().nonnegative(), endOffset: z.number().int().positive(),
  quote: z.string().min(1).max(5_000), locator: z.string().max(1_000).optional(),
}).refine(value => value.endOffset > value.startOffset, '证据摘录的结束位置须晚于开始位置');
export type ClaimEvidence = z.infer<typeof claimEvidenceSchema>;
export const claimSchema = z.object({
  id: z.string(), text: z.string(), source: z.string(), locator: z.string().default(''),
  status: z.enum(['pending', 'verified', 'disputed']).default('pending'),
  evidence: z.array(claimEvidenceSchema).max(20).optional(), reviewNote: z.string().max(10_000).optional(),
  reviewedAt: z.string().datetime().optional(),
  origin: z.object({ runId: z.string().min(1), nodeId: z.string().min(1), candidateId: z.string().min(1) }).optional(),
});
export type Claim = z.infer<typeof claimSchema>;
export const researchResultSchema = z.object({
  version: z.literal(1), kind: z.literal('research'), projectId: z.string().min(1), runId: z.string().min(1), nodeId: z.string().min(1),
  sourceHashes: z.array(z.object({ sourceId: z.string().min(1), sha256: sha256Schema })).min(1).max(20),
  usedRanges: z.array(z.object({ sourceId: z.string().min(1), startOffset: z.number().int().nonnegative(), endOffset: z.number().int().positive() })).max(1_000),
  warnings: z.array(z.string().max(2_000)).max(100),
  claims: z.array(claimSchema).max(100),
  shotSuggestions: z.array(z.object({ shotId: z.string().min(1), claimIds: z.array(z.string()).max(100), reason: z.string().max(2_000).optional() })).max(200),
  text: z.string().max(30_000).optional(),
});
export type ResearchResult = z.infer<typeof researchResultSchema>;
export const researchSearchResultSchema = z.object({
  title: z.string(), url: httpUrlSchema, snippet: z.string(), pageId: z.number().int().positive(),
});
export type ResearchSearchResult = z.infer<typeof researchSearchResultSchema>;
export type ShotClaims = { shotId: string; claimIds: string[] };
export interface ResearchContent {
  claims: Claim[];
  researchSources?: ResearchSource[];
  shots: Array<{ id: string; claimIds: string[]; locked?: boolean }>;
}

/** Reusable at project writes, backup import and before applying a generated suggestion. */
export function validateResearchContent(value: ResearchContent): void {
  const sources = new Map<string, ResearchSource>();
  if ((value.researchSources?.length ?? 0) > 20) throw new Error('项目最多保存 20 份资料，请拆分项目或合并资料。');
  for (const source of value.researchSources ?? []) {
    researchSourceSchema.parse(source);
    if (sources.has(source.id)) throw new Error('资料编号不能重复。');
    sources.set(source.id, source);
  }
  const claims = new Set<string>();
  for (const claim of value.claims) {
    claimSchema.parse(claim);
    if (claims.has(claim.id)) throw new Error('事实主张编号不能重复。');
    claims.add(claim.id);
    for (const evidence of claim.evidence ?? []) {
      const source = sources.get(evidence.sourceId);
      if (!source || source.sha256 !== evidence.sourceSha256) throw new Error('证据来源已移除或替换，请重新核对摘录。');
      if (evidence.endOffset > source.content.length || source.content.slice(evidence.startOffset, evidence.endOffset) !== evidence.quote) throw new Error('证据摘录与已保存资料不一致，请重新选择原文。');
    }
  }
  for (const shot of value.shots) {
    if (new Set(shot.claimIds).size !== shot.claimIds.length) throw new Error('镜头引用不能重复。');
    if (shot.claimIds.some(id => !claims.has(id))) throw new Error('镜头引用了已移除的事实主张，请一并解除引用。');
  }
}

/** A model may propose evidence; only the person's later review can verify a claim. */
export function applyResearchClaims<T extends ResearchContent>(value: T, rawResult: ResearchResult, selected: Claim[], bindings: ShotClaims[] = []): T {
  const result = researchResultSchema.parse(rawResult);
  const sources = new Map((value.researchSources ?? []).map(source => [source.id, source]));
  if (result.sourceHashes.some(reference => sources.get(reference.sourceId)?.sha256 !== reference.sha256)) throw new Error('生成后资料已移除或替换，请基于当前资料重新整理。');
  const candidates = new Set(result.claims.map(claim => claim.id)), existing = new Map(value.claims.map(claim => [claim.id, claim]));
  const chosen = new Set<string>();
  const added: Claim[] = [];
  for (const claim of selected) {
    if (!candidates.has(claim.id) || chosen.has(claim.id)) throw new Error('所选证据候选无效或重复。');
    chosen.add(claim.id);
    const previous = existing.get(claim.id);
    if (previous) {
      if (previous.origin?.runId !== result.runId || previous.origin.nodeId !== result.nodeId || previous.origin.candidateId !== claim.id) throw new Error('候选编号与已有事实主张冲突，未覆盖人工内容。');
      continue;
    }
    added.push(claimSchema.parse({ ...claim, status: 'pending', reviewedAt: undefined, reviewNote: undefined, origin: { runId: result.runId, nodeId: result.nodeId, candidateId: claim.id } }));
  }
  const bindingMap = new Map<string, string[]>();
  for (const binding of bindings) {
    const shot = value.shots.find(shot => shot.id === binding.shotId);
    if (!shot) throw new Error('准备引用的镜头已移除，请重新选择。');
    if (shot.locked && binding.claimIds.some(id => !shot.claimIds.includes(id))) throw new Error('请先解锁镜头，再修改引用。');
    if (bindingMap.has(binding.shotId) || binding.claimIds.some(id => !chosen.has(id))) throw new Error('镜头引用须来自本次选择的候选。');
    bindingMap.set(binding.shotId, binding.claimIds);
  }
  const next = { ...value, claims: [...value.claims, ...added], shots: value.shots.map(shot => ({ ...shot, claimIds: [...new Set([...shot.claimIds, ...(bindingMap.get(shot.id) ?? [])])] })) };
  validateResearchContent(next);
  return next;
}
