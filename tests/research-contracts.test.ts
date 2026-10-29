import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { applyResearchClaims, createHistoryWorkflow, DEFAULT_VIDEO_PROFILE, projectSchema, researchResultSchema, validateResearchContent, type Claim, type ResearchSource } from '@video-quickly/contracts';
import { ProjectEditSession, savedEditsSchema } from '../apps/desktop/src/lib/project-edits';

const content = '第一行：文献记载。\n第二行：这一结论仍有争议。';
const source: ResearchSource = { id: 'source', title: '实际摘录', kind: 'text', content, sha256: createHash('sha256').update(content).digest('hex'), capturedAt: '2026-10-30T00:00:00.000Z' };
const quote = '这一结论仍有争议。', startOffset = content.indexOf(quote);
const claim: Claim = { id: 'candidate', text: '历史结论', source: source.title, locator: '第二行', status: 'verified', evidence: [{ sourceId: source.id, sourceSha256: source.sha256, startOffset, endOffset: startOffset + quote.length, quote }] };
function project() { return projectSchema.parse({ id: 'project', title: '资料核验', brief: '', revision: 1, profile: DEFAULT_VIDEO_PROFILE, workflow: createHistoryWorkflow(), claims: [], researchSources: [source], shots: [{ id: 'shot', title: '镜头', narration: '', visualPrompt: '', durationUs: 1_000_000 }], createdAt: '', updatedAt: '' }); }
function result() { return researchResultSchema.parse({ version: 1, kind: 'research', projectId: 'project', runId: 'run', nodeId: 'research', sourceHashes: [{ sourceId: source.id, sha256: source.sha256 }], usedRanges: [{ sourceId: source.id, startOffset: 0, endOffset: content.length }], warnings: [], claims: [claim], shotSuggestions: [{ shotId: 'shot', claimIds: [claim.id] }] }); }

it('applies only explicitly selected claims and bindings as pending without trusting model verification', () => {
  const original = project();
  expect(applyResearchClaims(original, result(), [])).toEqual(original);
  const next = applyResearchClaims(original, result(), [claim], [{ shotId: 'shot', claimIds: [claim.id] }]);
  expect(next.claims).toEqual([{ ...claim, status: 'pending', origin: { runId: 'run', nodeId: 'research', candidateId: claim.id } }]);
  expect(next.shots[0].claimIds).toEqual([claim.id]); expect(original.claims).toEqual([]);
});

it('keeps reviewed human content when the same candidate is applied again and refuses a colliding unrelated id', () => {
  const first = applyResearchClaims(project(), result(), [claim]);
  const edited = { ...first, claims: first.claims.map(claim => ({ ...claim, text: '人工修改的结论', status: 'disputed' as const, reviewNote: '两份文献观点不一' })) };
  expect(applyResearchClaims(edited, result(), [claim])).toEqual(edited);
  expect(() => applyResearchClaims({ ...project(), claims: [claim] }, result(), [claim])).toThrow('编号');
});

it('rejects changed sources, invented quotes and out-of-range offsets even when slice would clamp the end', () => {
  expect(() => applyResearchClaims({ ...project(), researchSources: [] }, result(), [claim])).toThrow('资料');
  for (const evidence of [
    { ...claim.evidence![0], quote: '不存在的证据' }, { ...claim.evidence![0], endOffset: content.length + 100 },
    { ...claim.evidence![0], sourceSha256: '0'.repeat(64) },
  ]) expect(() => validateResearchContent({ ...project(), claims: [{ ...claim, evidence: [evidence] }] })).toThrow();
});

it('rejects dangling, duplicate or locked-shot binding changes', () => {
  const original = project();
  expect(() => validateResearchContent({ ...original, shots: [{ ...original.shots[0], claimIds: ['missing'] }] })).toThrow('移除');
  expect(() => validateResearchContent({ ...original, claims: [claim, claim] })).toThrow('编号');
  expect(() => applyResearchClaims({ ...original, shots: [{ ...original.shots[0], locked: true }] }, result(), [claim], [{ shotId: 'shot', claimIds: [claim.id] }])).toThrow('解锁');
});

it('restores source capture, candidate application, reference settings and bindings together through undo and redo', () => {
  const original = projectSchema.parse({ ...project(), researchSources: undefined });
  const session = new ProjectEditSession(original);
  session.edit({ ...session.state.present, researchSources: [source] }, '导入资料');
  session.edit({ ...applyResearchClaims(session.state.present, result(), [claim], [{ shotId: 'shot', claimIds: [claim.id] }]), referenceDisplay: 'numbers' }, '应用核验候选');
  const restored = new ProjectEditSession(original, savedEditsSchema.parse(JSON.parse(JSON.stringify(session.state))));
  expect(restored.state.present.shots[0].claimIds).toEqual([claim.id]);
  restored.undo(); expect(restored.state.present.claims).toEqual([]); expect(restored.state.present.referenceDisplay).toBe('hidden');
  expect(restored.state.present.researchSources).toEqual([source]);
  restored.undo(); expect(restored.state.present.researchSources).toEqual([]);
  restored.redo(); restored.redo(); expect(restored.state.present.claims[0].evidence?.[0].quote).toBe(quote);
});

it('does not clear captured sources or citation settings when restoring a command for an unrelated title', () => {
  const original = projectSchema.parse({ ...project(), referenceDisplay: 'numbers' }), session = new ProjectEditSession(original);
  session.edit({ ...session.state.present, title: '新标题' }, '修改标题');
  const restored = new ProjectEditSession(original, savedEditsSchema.parse(JSON.parse(JSON.stringify(session.state))));
  restored.undo(); restored.redo();
  expect(restored.state.present.researchSources).toEqual([source]); expect(restored.state.present.referenceDisplay).toBe('numbers');
});
