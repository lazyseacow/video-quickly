import { createHash } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { expect, it } from 'vitest';
import { createHistoryWorkflow, createSceneTemplate, DEFAULT_VIDEO_PROFILE, projectSchema, shotSchema, type ProjectDocument } from '@video-quickly/contracts';
import { citationOverlayForShot, createCitationManifest, drawCitationOverlay, drawSceneFrame } from '../src/index.js';
import { reorderShots, splitShot, trimShot } from '../src/editing.js';

function project(): ProjectDocument {
  const content = '私有正文开头，不应整个进入成片目录。😀观察结果是四十二。私有正文结尾。', quote = '😀观察结果是四十二。';
  const sha256 = createHash('sha256').update(content).digest('hex'), startOffset = content.indexOf(quote);
  const evidence = [{ sourceId: 'source', sourceSha256: sha256, startOffset, endOffset: startOffset + quote.length, quote, locator: '第二段' }];
  return projectSchema.parse({ id: 'citations', title: '引用', revision: 1, brief: '', workflow: createHistoryWorkflow(), profile: DEFAULT_VIDEO_PROFILE, createdAt: '', updatedAt: '', referenceDisplay: 'numbers',
    researchSources: [{ id: 'source', title: '实际保存资料', kind: 'text', content, sha256, capturedAt: '2026-10-30T00:00:00.000Z' }],
    claims: [{ id: 'unused', text: '未绑定主张', source: '未绑定资料' }, { id: 'verified', text: '四十二', source: '保存资料', status: 'verified', evidence, reviewedAt: '2026-10-30T01:00:00.000Z', reviewNote: '人工核对原文' }, { id: 'pending', text: '待核对的解释', source: '保存资料', evidence }, { id: 'legacy', text: '旧项目主张', source: '旧书名', locator: '第 12 页', status: 'verified' }, { id: 'disputed', text: '有争议的解释', source: '保存资料', evidence, status: 'disputed' }],
    shots: [shotSchema.parse({ id: 'shot', title: '引用镜头', narration: '', visualPrompt: '', sourceInUs: 0, durationUs: 4_000_000, claimIds: ['verified', 'pending', 'legacy', 'disputed'] })],
  });
}

it('exports only bound claims and immutable evidence metadata, preserving legacy caveats without full source text', () => {
  const input = project(), before = structuredClone(input), manifest = createCitationManifest(input);
  expect(manifest.references.map(value => [value.claimId, value.number])).toEqual([['verified', 2], ['pending', 3], ['legacy', 4], ['disputed', 5]]);
  expect(manifest.references[0]).toMatchObject({ status: 'verified', reviewedAt: input.claims[1].reviewedAt, evidenceState: 'valid', evidence: [{ source: { id: 'source', sha256: input.researchSources?.[0].sha256 }, quote: input.claims[1].evidence?.[0].quote, valid: true }] });
  expect(manifest.references[2]).toMatchObject({ status: 'verified', source: '旧书名', locator: '第 12 页', evidenceState: 'missing', issues: ['无证据摘录'] });
  expect(JSON.stringify(manifest)).not.toContain('私有正文开头'); expect(JSON.stringify(manifest)).not.toContain('"content"');
  expect(citationOverlayForShot(manifest, 'shot')).toMatchObject({ numbers: [2, 3, 4, 5], status: 'missing', notes: ['待核验', '有争议', '无证据或引用异常'] });
  expect(citationOverlayForShot(manifest, 'shot')?.label).toContain('[2–5]');
  expect(manifest.warnings.join('\n')).toContain('无证据摘录'); expect(input).toEqual(before);
});

it('keeps numbering and bindings through splits, trims and reordering while using current clip timeline positions', () => {
  const original = project(), rate = { numerator: 30, denominator: 1 };
  const parts = splitShot(original.shots[0], 2_000_000, rate, 'right');
  const shots = reorderShots([parts[0], trimShot(parts[1], { inUs: 2_500_000, outUs: 4_000_000 }, rate)], 'right', 0);
  const manifest = createCitationManifest({ ...original, shots });
  expect(manifest.references.map(value => value.number)).toEqual([2, 3, 4, 5]);
  expect(manifest.shots.map(value => [value.shotId, value.startUs, value.endUs, value.numbers])).toEqual([['right', 0, 1_500_000, [2, 3, 4, 5]], ['shot', 1_500_000, 3_500_000, [2, 3, 4, 5]]]);
});

it('marks missing claims, stale evidence hashes, wrong UTF-16 ranges and duplicate identities as invalid', () => {
  const original = project();
  const claims = original.claims.map(claim => claim.id === 'verified' ? { ...claim, evidence: claim.evidence?.map(value => ({ ...value, sourceSha256: 'a'.repeat(64) })) } : claim.id === 'pending' ? { ...claim, evidence: claim.evidence?.map(value => ({ ...value, startOffset: value.startOffset + 1 })) } : claim);
  const manifest = createCitationManifest({ ...original, claims, shots: [{ ...original.shots[0], claimIds: ['verified', 'pending', 'missing'] }] });
  expect(manifest.references.every(value => value.evidenceState === 'invalid')).toBe(true);
  expect(manifest.references.at(-1)).toMatchObject({ claimId: 'missing', status: 'pending', issues: ['引用的事实主张缺失'] });
  expect(manifest.warnings.join('\n')).toContain('校验值不一致'); expect(manifest.warnings.join('\n')).toContain('摘录与保存资料不一致');
  expect(citationOverlayForShot(manifest, 'shot')?.status).toBe('missing');
  expect(createCitationManifest({ ...original, claims: [...original.claims, original.claims[1]] }).references[0].evidenceState).toBe('invalid');
  expect(createCitationManifest({ ...original, researchSources: [...original.researchSources!, original.researchSources![0]] }).references[0].evidenceState).toBe('invalid');
  const source = original.researchSources![0], initial = original.claims[1];
  const outOfRange = { ...initial, evidence: [{ ...initial.evidence![0], endOffset: source.content.length + 100, quote: source.content.slice(initial.evidence![0].startOffset) }] };
  expect(createCitationManifest({ ...original, claims: original.claims.map(claim => claim.id === initial.id ? outOfRange : claim) }).references[0]).toMatchObject({ evidenceState: 'invalid', issues: ['证据摘录超出保存资料范围'] });
});

it.each([[640, 360], [360, 640], [480, 480], [256, 144], [64, 64]])('reserves a separate opt-in footer below subtitles over existing art and templates at %i×%i', (width, height) => {
  const input = project(), manifest = createCitationManifest(input), citation = citationOverlayForShot(manifest, 'shot');
  const footer = createCanvas(width, height); drawCitationOverlay(footer as unknown as HTMLCanvasElement, citation);
  const alpha = footer.getContext('2d').getImageData(0, 0, width, height).data;
  let firstFooter = height;
  for (let offset = 3; offset < alpha.length; offset += 4) if (alpha[offset]) { firstFooter = Math.floor(offset / 4 / width); break; }
  for (const sceneTemplate of [undefined, createSceneTemplate('comparison')]) {
    const profile = { ...DEFAULT_VIDEO_PROFILE, width, height }, shot = { ...input.shots[0], narration: '实际字幕保持原位置。', sceneTemplate };
    function pixels(visible: boolean, narration = shot.narration) {
      const canvas = createCanvas(width, height);
      drawSceneFrame(canvas as unknown as HTMLCanvasElement, { ...shot, narration, shotIndex: 0, profile, citation: visible ? citation : undefined }, 1_000_000);
      return canvas.getContext('2d').getImageData(0, 0, width, height).data;
    }
    const before = pixels(false), after = pixels(true), withoutCaption = pixels(true, ''); let footerChanged = 0, lastCaption = -1;
    for (let offset = 0; offset < before.length; offset++) {
      const row = Math.floor(offset / 4 / width);
      if (row >= firstFooter && before[offset] !== after[offset]) footerChanged++;
      if (after[offset] !== withoutCaption[offset]) lastCaption = row;
    }
    expect(footerChanged).toBeGreaterThan(50); expect(lastCaption).toBeGreaterThanOrEqual(0); expect(lastCaption).toBeLessThan(firstFooter);
  }
  expect(citationOverlayForShot(createCitationManifest({ ...input, referenceDisplay: undefined }), 'shot')).toBeUndefined();
  expect(citationOverlayForShot(createCitationManifest({ ...input, shots: [{ ...input.shots[0], claimIds: [] }] }), 'shot')).toBeUndefined();
});

it('keeps the same low-resolution caption pages and safe layout on uncited shots in a project that reserves the reference footer', () => {
  const input = project(), citation = citationOverlayForShot(createCitationManifest(input), 'shot');
  for (const [width, height] of [[256, 144], [180, 320]]) for (const sceneTemplate of [undefined, createSceneTemplate('comparison')]) {
    const profile = { ...DEFAULT_VIDEO_PROFILE, width, height }, shot = { ...input.shots[0], sceneTemplate, narration: '引用镜头与没有引用的镜头必须共用字幕分页和安全区。'.repeat(3) };
    const overlay = createCanvas(width, height); drawCitationOverlay(overlay as unknown as HTMLCanvasElement, citation);
    const values = overlay.getContext('2d').getImageData(0, 0, width, height).data;
    let footerRow = height;
    for (let offset = 3; offset < values.length; offset += 4) if (values[offset]) { footerRow = Math.floor(offset / 4 / width); break; }
    function pixels(cited: boolean) {
      const canvas = createCanvas(width, height), scene = { ...shot, profile, shotIndex: 0, referenceFooter: true, citation: cited ? citation : undefined };
      drawSceneFrame(canvas as unknown as HTMLCanvasElement, scene, 1_700_000);
      return Buffer.from(canvas.getContext('2d').getImageData(0, 0, width, height).data).subarray(0, footerRow * width * 4);
    }
    expect(pixels(false).equals(pixels(true))).toBe(true);
  }
});
