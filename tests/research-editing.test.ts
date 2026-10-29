import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { createHistoryWorkflow, DEFAULT_VIDEO_PROFILE, projectSchema } from '@video-quickly/contracts';
import { applyClaimsEdits, claimsEdits } from '../apps/desktop/src/lib/research-edits';
import { editContent } from '../apps/desktop/src/lib/project-edits';
import { readRpcRequest } from '../apps/desktop/dev/read-rpc-request';

function content() { return editContent(projectSchema.parse({ id: 'p', title: '资料', brief: '', revision: 1, profile: DEFAULT_VIDEO_PROFILE, workflow: createHistoryWorkflow(), shots: [{ id: 'shot', title: '镜头', narration: '', visualPrompt: '', durationUs: 1_000_000 }], claims: [{ id: 'claim', text: '待核验事实', source: '文献', status: 'pending' }], createdAt: '', updatedAt: '' })); }

it('merges reference edits into current shots without overwriting intervening media or project changes', () => {
  const initial = content(), baseline = claimsEdits(initial);
  const latest = { ...initial, title: '新项目标题', shots: initial.shots.map(shot => ({ ...shot, videoAssetId: 'new-video' })) };
  const next = { ...baseline, shotClaims: [{ shotId: 'shot', claimIds: ['claim'] }] };
  const applied = applyClaimsEdits(latest, next, baseline);
  expect(applied.title).toBe(latest.title); expect(applied.shots[0]).toMatchObject({ videoAssetId: 'new-video', claimIds: ['claim'] });
  expect(() => applyClaimsEdits({ ...latest, shots: [] }, next, baseline)).toThrow('已移除');
});

it('keeps failed-save retries owned by the same dialog and rejects unrelated reference conflicts', () => {
  const initial = content(), baseline = claimsEdits(initial), next = { ...baseline, claims: baseline.claims.map(claim => ({ ...claim, text: '核验草稿' })), shotClaims: [{ shotId: 'shot', claimIds: ['claim'] }] };
  const submitted = applyClaimsEdits(initial, next, baseline);
  expect(applyClaimsEdits(submitted, next, baseline, claimsEdits(submitted))).toEqual(submitted);
  expect(() => applyClaimsEdits(submitted, next, baseline)).toThrow('其他视图');
  expect(() => applyClaimsEdits({ ...initial, shots: initial.shots.map(shot => ({ ...shot, locked: true })) }, next, baseline)).toThrow('解锁');
});

it('requires removing claim bindings atomically with a deleted claim', () => {
  const initial = content(); initial.shots[0].claimIds = ['claim']; const baseline = claimsEdits(initial);
  expect(() => applyClaimsEdits(initial, { ...baseline, claims: [] }, baseline)).toThrow('移除');
  const next = applyClaimsEdits(initial, { ...baseline, claims: [], shotClaims: [{ shotId: 'shot', claimIds: [] }] }, baseline);
  expect(next.claims).toEqual([]); expect(next.shots[0].claimIds).toEqual([]);
});

it('can revert its own failed reference submission to the original value without undoing an unrelated external reference', () => {
  const initial = content(), baseline = claimsEdits(initial);
  const first = { ...baseline, shotClaims: [{ shotId: 'shot', claimIds: ['claim'] }] };
  const pending = applyClaimsEdits(initial, first, baseline);
  expect(applyClaimsEdits(pending, baseline, baseline, first).shots[0].claimIds).toEqual([]);
  const external = { ...initial, shots: initial.shots.map(shot => ({ ...shot, claimIds: ['claim'] })) };
  const requested = { ...baseline, claims: baseline.claims.map(claim => ({ ...claim, text: '只修改事实文字' })) };
  const preserved = applyClaimsEdits(external, requested, baseline);
  expect(applyClaimsEdits(preserved, requested, baseline, requested).shots[0].claimIds).toEqual(['claim']);
});

async function* chunks(bytes: Uint8Array, sizes: number[]) { let cursor = 0; for (const size of sizes) { yield bytes.subarray(cursor, cursor + size); cursor += size; } if (cursor < bytes.length) yield bytes.subarray(cursor); }
it('reads actual UTF-8 material across multibyte network boundaries without replacement characters', async () => {
  const value = { method: 'research.source.read', params: { text: '历史📚原文与证据' } }, bytes = Buffer.from(JSON.stringify(value)), offset = bytes.indexOf(Buffer.from('历'));
  expect(await readRpcRequest(chunks(bytes, [offset + 1, 1, 2, 1, 2]))).toEqual(value);
  await expect(readRpcRequest(chunks(bytes, [10]), 12)).rejects.toThrow('超过');
});

it('accepts the advertised twenty captured sources without the old two-million-character transport ceiling', async () => {
  const text = '历史'.repeat(50_000), sha256 = createHash('sha256').update(text).digest('hex');
  const value = { method: 'project.update', params: { researchSources: Array.from({ length: 20 }, (_, index) => ({ id: String(index), content: text, sha256 })) } };
  const bytes = Buffer.from(JSON.stringify(value)); expect(bytes.length).toBeGreaterThan(6_000_000);
  expect(await readRpcRequest(chunks(bytes, [65_535, 65_536]))).toEqual(value);
});
