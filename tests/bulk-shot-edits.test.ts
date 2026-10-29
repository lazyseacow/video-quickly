import { expect, it } from 'vitest';
import { createHistoryWorkflow, createSceneTemplate, DEFAULT_CAPTION_STYLE, DEFAULT_VIDEO_PROFILE, projectSchema, type Shot } from '@video-quickly/contracts';
import { applyBulkShotEdit, bulkDuplicateShots, bulkMoveShots, bulkRemoveShots, bulkReorderShots } from '../apps/desktop/src/lib/bulk-shot-edits';
import { editContent, ProjectEditSession, type EditContent } from '../apps/desktop/src/lib/project-edits';

function project() { return projectSchema.parse({ id: 'bulk-project', title: '批改项目', brief: '', revision: 1, profile: DEFAULT_VIDEO_PROFILE, workflow: createHistoryWorkflow(), createdAt: '', updatedAt: '', shots: ['A', 'B', 'C', 'D', 'E', 'F'].map(id => ({ id, title: id, narration: `旁白${id}`, visualPrompt: `画面${id}`, durationUs: 2_000_000 })) }); }
function fixture() { return editContent(project()); }
function patch(content: EditContent, id: string, changes: Partial<Shot>): EditContent { return { ...content, shots: content.shots.map(shot => shot.id === id ? { ...shot, ...changes } : shot) }; }
const order = (content: EditContent) => content.shots.map(shot => shot.id);

it('edits only requested fields and targets, preserving unrelated live text, media and other shots', () => {
  const baseline = fixture(), current = { ...patch(baseline, 'B', { title: '最新人工标题', videoAssetId: 'new-video', claimIds: ['new-ref'], captionStyle: DEFAULT_CAPTION_STYLE }), title: '最新项目标题' };
  const result = applyBulkShotEdit(current, baseline, ['B', 'D'], { animation: { panX: .2, panY: -.1, zoom: 1.2, transition: 'wipe' } }, {});
  expect(result.title).toBe(current.title); expect(result.shots[1]).toMatchObject({ title: '最新人工标题', videoAssetId: 'new-video', claimIds: ['new-ref'], captionStyle: DEFAULT_CAPTION_STYLE, animation: { panX: .2, zoom: 1.2 } }); expect(result.shots[3].animation).toEqual(result.shots[1].animation); expect(result.shots[1].animation).not.toBe(result.shots[3].animation);
  expect(result.shots[0]).toBe(current.shots[0]); expect(result.shots[2]).toBe(current.shots[2]); expect(current.shots[3].animation.zoom).toBe(1.05);
});

it('rejects all locked or removed targets atomically and lists the locked names', () => {
  const baseline = fixture(), current = patch(patch(baseline, 'B', { locked: true }), 'D', { locked: true }), before = structuredClone(current);
  expect(() => applyBulkShotEdit(current, baseline, ['A', 'B', 'D'], { captionStyle: null }, {})).toThrow(/「B」、「D」已锁定/); expect(current).toEqual(before);
  expect(() => applyBulkShotEdit({ ...baseline, shots: baseline.shots.filter(shot => shot.id !== 'B') }, baseline, ['A', 'B'], { durationUs: 3_000_000 }, {})).toThrow('已移除');
  expect(() => applyBulkShotEdit(baseline, baseline, ['A', 'A'], { captionStyle: null }, {})).toThrow('不能重复'); expect(() => applyBulkShotEdit(baseline, baseline, [], { captionStyle: null }, {})).toThrow('至少一个');
});

it('blocks only the fields about to be overwritten and checks project frame rate only for duration changes', () => {
  const baseline = fixture(), changedAnimation = patch(baseline, 'D', { animation: { ...baseline.shots[3].animation, zoom: 1.3 } });
  expect(() => applyBulkShotEdit(changedAnimation, baseline, ['B', 'D'], { animation: baseline.shots[1].animation }, {})).toThrow('运镜已变化');
  expect(applyBulkShotEdit(changedAnimation, baseline, ['D'], { captionStyle: null }, {}).shots[3].animation.zoom).toBe(1.3);
  const changedCaption = patch(baseline, 'B', { captionStyle: DEFAULT_CAPTION_STYLE }); expect(() => applyBulkShotEdit(changedCaption, baseline, ['B'], { captionStyle: null }, {})).toThrow('字幕样式已变化');
  const newRate = { ...baseline, profile: { ...baseline.profile, frameRate: { numerator: 24, denominator: 1 } } }; expect(() => applyBulkShotEdit(newRate, baseline, ['A'], { durationUs: 3_000_000 }, {})).toThrow('帧率已变化'); expect(applyBulkShotEdit(newRate, baseline, ['A'], { captionStyle: null }, {}).profile).toBe(newRate.profile);
});

it('preserves independent media in points and uses the longer source tail while requiring both real durations', () => {
  const baseline = patch(fixture(), 'A', { sourceInUs: 1_000_000, audioInUs: 0, videoInUs: 2_000_000, sceneInUs: 1_000_000, sceneDurationUs: 6_000_000, durationUs: 1_000_000, audioAssetId: 'audio', videoAssetId: 'video' });
  const result = applyBulkShotEdit(baseline, baseline, ['A'], { durationUs: 3_000_000 }, { audio: 2_000_000, video: 5_000_000 }); expect(result.shots[0]).toMatchObject({ durationUs: 3_000_000, sourceInUs: 1_000_000, audioInUs: 0, videoInUs: 2_000_000, sceneInUs: 1_000_000, sceneDurationUs: 6_000_000 });
  expect(() => applyBulkShotEdit(baseline, baseline, ['A'], { durationUs: 3_000_001 }, { audio: 2_000_000, video: 5_000_000 })).toThrow('超出真实时长');
  expect(() => applyBulkShotEdit(baseline, baseline, ['A'], { durationUs: 2_000_000 }, { audio: 2_000_000 })).toThrow('视频素材时长尚未读取'); expect(() => applyBulkShotEdit(baseline, baseline, ['A'], { durationUs: 2_000_000 }, { video: 5_000_000 })).toThrow('音频素材时长尚未读取');
  for (const invalid of [0, NaN, Infinity]) expect(() => applyBulkShotEdit(baseline, baseline, ['A'], { durationUs: 2_000_000 }, { audio: invalid, video: 5_000_000 })).toThrow('读取失败');
});

it.each([{ numerator: 30_000, duration: 1_968_633 }, { numerator: 60_000, duration: 1_985_317 }])('keeps a real two-second endpoint inside complete frames at $numerator/1001 fps', ({ numerator, duration }) => {
  const original = patch(fixture(), 'A', { durationUs: 1_000_000, audioAssetId: 'audio' }), baseline = { ...original, profile: { ...original.profile, frameRate: { numerator, denominator: 1001 } } };
  expect(applyBulkShotEdit(baseline, baseline, ['A'], { durationUs: 2_000_000 }, { audio: 2_000_000 }).shots[0]).toMatchObject({ durationUs: duration, sourceInUs: 0, sceneDurationUs: 1_000_000 });
  expect(() => applyBulkShotEdit(baseline, baseline, ['A'], { durationUs: 2_000_001 }, { audio: 2_000_000 })).toThrow('超出真实时长');
});

it('ignores dormant template video while still checking narration and allows a media-free diagram to extend', () => {
  const baseline = patch(fixture(), 'A', { sceneTemplate: createSceneTemplate('process'), videoAssetId: 'missing-dormant-video' });
  expect(applyBulkShotEdit(baseline, baseline, ['A'], { durationUs: 10_000_000 }, {}).shots[0].durationUs).toBe(10_000_000);
  const narrated = patch(baseline, 'A', { audioAssetId: 'voice' }); expect(() => applyBulkShotEdit(narrated, narrated, ['A'], { durationUs: 4_000_000 }, {})).toThrow('音频素材时长'); expect(() => applyBulkShotEdit(narrated, narrated, ['A'], { durationUs: 4_000_000 }, { voice: 3_000_000 })).toThrow('超出真实时长');
});

it('rejects stale timing or active media but preserves unrelated live edits during a duration command', () => {
  const baseline = patch(fixture(), 'A', { audioAssetId: 'old-audio' }), changed = patch(baseline, 'A', { audioAssetId: 'new-audio' }); expect(() => applyBulkShotEdit(changed, baseline, ['A'], { durationUs: 3_000_000 }, { 'new-audio': 4_000_000 })).toThrow('素材区间已变化');
  expect(() => applyBulkShotEdit(patch(baseline, 'A', { sourceInUs: 1_000 }), baseline, ['A'], { durationUs: 3_000_000 }, { 'old-audio': 4_000_000 })).toThrow('素材区间已变化');
  const live = patch(baseline, 'A', { title: '', narration: '新人工旁白', animation: { ...baseline.shots[0].animation, zoom: 1.4 } }); const result = applyBulkShotEdit(live, baseline, ['A'], { durationUs: 3_000_000 }, { 'old-audio': 4_000_000 }); expect(result.shots[0]).toMatchObject({ title: '', narration: '新人工旁白', animation: { zoom: 1.4 }, durationUs: 3_000_000 });
});

it('copies effective caption and animation plus only shared template appearance, preserving every topic and media field', () => {
  let baseline = fixture(); baseline = { ...baseline, captionStyle: { ...DEFAULT_CAPTION_STYLE, textColor: '#123456' } };
  baseline = patch(baseline, 'F', { locked: true, animation: { panX: .1, panY: .2, zoom: 1.2, transition: 'wipe' }, sceneTemplate: { ...createSceneTemplate('process'), palette: 'blue', motion: 'none', heading: '来源主题' } });
  const chart = { ...createSceneTemplate('comparison'), heading: '目标自己的事实内容' }; baseline = patch(baseline, 'A', { sceneTemplate: chart, assetId: 'image', audioAssetId: 'audio', claimIds: ['reference'], captionTrack: { timeBase: 'scene', alignment: 'manual', cues: [{ id: 'cue', startUs: 0, endUs: 1_000_000, text: '目标自己的字幕' }] } });
  const result = applyBulkShotEdit(baseline, baseline, ['A', 'B'], { copyStyleFromId: 'F' }, {});
  expect(result.shots[0].sceneTemplate).toEqual({ ...chart, palette: 'blue', motion: 'none' }); expect(result.shots[1].sceneTemplate).toBeUndefined(); expect(result.shots[0].captionStyle).toEqual(baseline.captionStyle); expect(result.shots[1].captionStyle).toEqual(baseline.captionStyle); expect(result.shots[0].captionStyle).not.toBe(result.shots[1].captionStyle);
  expect(result.shots[0]).toMatchObject({ id: 'A', title: 'A', narration: '旁白A', assetId: 'image', audioAssetId: 'audio', claimIds: ['reference'], captionTrack: baseline.shots[0].captionTrack, animation: baseline.shots[5].animation }); expect(result.shots[5]).toBe(baseline.shots[5]);
});

it('compares only the copy source values actually consumed and rejects a removed source or conflicting modes', () => {
  const baseline = { ...fixture(), captionStyle: DEFAULT_CAPTION_STYLE };
  const sourceTextChanged = patch(baseline, 'F', { narration: '来源无关文字修改', title: '来源新标题' }); expect(applyBulkShotEdit(sourceTextChanged, baseline, ['A'], { copyStyleFromId: 'F' }, {}).shots[0].captionStyle).toEqual(DEFAULT_CAPTION_STYLE);
  expect(() => applyBulkShotEdit({ ...baseline, captionStyle: { ...DEFAULT_CAPTION_STYLE, textColor: '#445566' } }, baseline, ['A'], { copyStyleFromId: 'F' }, {})).toThrow('来源镜头');
  const explicit = patch(baseline, 'F', { captionStyle: DEFAULT_CAPTION_STYLE }); expect(applyBulkShotEdit({ ...explicit, captionStyle: null }, explicit, ['A'], { copyStyleFromId: 'F' }, {}).shots[0].captionStyle).toEqual(DEFAULT_CAPTION_STYLE);
  expect(() => applyBulkShotEdit({ ...baseline, shots: baseline.shots.slice(0, 5) }, baseline, ['A'], { copyStyleFromId: 'F' }, {})).toThrow('来源镜头已移除'); expect(() => applyBulkShotEdit(baseline, baseline, ['A'], { copyStyleFromId: 'F', captionStyle: null }, {})).toThrow('不能与显式');
  const extended = applyBulkShotEdit(baseline, baseline, ['A'], { copyStyleFromId: 'F', durationUs: 3_000_000 }, {}); expect(extended.shots[0].durationUs).toBe(3_000_000);
});

it('rejects external appearance edits only when copying template appearance would overwrite them', () => {
  const baseline = patch(patch(fixture(), 'F', { sceneTemplate: createSceneTemplate('process') }), 'A', { sceneTemplate: createSceneTemplate('comparison') });
  const changed = patch(baseline, 'A', { sceneTemplate: { ...baseline.shots[0].sceneTemplate!, palette: 'blue' } }); expect(() => applyBulkShotEdit(changed, baseline, ['A'], { copyStyleFromId: 'F' }, {})).toThrow('图解外观已变化');
  const noSourceTemplate = patch(baseline, 'F', { sceneTemplate: undefined }); expect(applyBulkShotEdit(patch(noSourceTemplate, 'A', { sceneTemplate: changed.shots[0].sceneTemplate }), noSourceTemplate, ['A'], { copyStyleFromId: 'F' }, {}).shots[0].sceneTemplate).toEqual(changed.shots[0].sceneTemplate);
});

it('allows an explicit inherit choice, retains no-ops and creates one undoable payload with no retry duplication', () => {
  const original = project(), session = new ProjectEditSession(original), baseline = editContent(original), before = structuredClone(baseline);
  const changed = applyBulkShotEdit(baseline, baseline, ['B', 'D'], { captionStyle: DEFAULT_CAPTION_STYLE, durationUs: 3_000_000 }, {}); session.edit(changed, '批量修改镜头'); expect(session.state.undo).toHaveLength(1);
  session.beginSave(); session.endSave(); expect(session.state.undo).toHaveLength(1); expect(session.state.present).toEqual(changed); session.undo(); expect(session.state.present).toEqual(before); session.redo(); expect(session.state.present).toEqual(changed);
  expect(applyBulkShotEdit(baseline, baseline, ['B'], { animation: baseline.shots[1].animation }, {})).toBe(baseline); expect(applyBulkShotEdit(changed, changed, ['B', 'D'], { captionStyle: null }, {}).shots[1].captionStyle).toBeNull();
});

it('reorders a noncontiguous group by after-removal slots and fixes all old sample scene indexes', () => {
  const baseline = patch(fixture(), 'E', { sceneIndex: 42 }), result = bulkReorderShots(baseline, ['D', 'B'], 4); expect(order(result)).toEqual(['A', 'C', 'E', 'F', 'B', 'D']); expect(Object.fromEntries(result.shots.map(shot => [shot.id, shot.sceneIndex]))).toEqual({ A: 0, B: 1, C: 2, D: 3, E: 42, F: 5 }); expect(baseline.shots[0].sceneIndex).toBeUndefined();
  expect(() => bulkReorderShots(baseline, ['B', 'D'], 5)).toThrow('位置无效'); expect(bulkReorderShots(baseline, ['B', 'C'], 1)).toBe(baseline);
});

it('moves each selected run one neighboring slot without gathering unrelated selected runs', () => {
  const baseline = fixture(); expect(order(bulkMoveShots(baseline, ['B', 'D'], -1))).toEqual(['B', 'A', 'D', 'C', 'E', 'F']); expect(order(bulkMoveShots(baseline, ['B', 'D'], 1))).toEqual(['A', 'C', 'B', 'E', 'D', 'F']); expect(order(bulkMoveShots(baseline, ['B', 'C'], -1))).toEqual(['B', 'C', 'A', 'D', 'E', 'F']); expect(order(bulkMoveShots(baseline, ['A', 'F'], -1))).toEqual(['A', 'B', 'C', 'D', 'F', 'E']); expect(bulkMoveShots(baseline, ['A', 'B'], -1)).toBe(baseline);
});

it('duplicates each original in place with stable sample identity and independent nested caption objects', () => {
  const baseline = patch(fixture(), 'B', { captionTrack: { timeBase: 'scene', alignment: 'manual', cues: [{ id: 'cue', startUs: 0, endUs: 1_000_000, text: '原字幕' }] }, captionStyle: DEFAULT_CAPTION_STYLE }), result = bulkDuplicateShots(baseline, ['D', 'B'], { B: 'B2', D: 'D2' });
  expect(order(result)).toEqual(['A', 'B', 'B2', 'C', 'D', 'D2', 'E', 'F']); expect(result.shots[2]).toMatchObject({ id: 'B2', title: 'B · 副本', sceneIndex: 1, captionTrack: baseline.shots[1].captionTrack, captionStyle: DEFAULT_CAPTION_STYLE }); expect(result.shots[5].sceneIndex).toBe(3); expect(result.shots[7].sceneIndex).toBe(5);
  result.shots[2].captionTrack!.cues[0].text = '副本独立修改'; expect(baseline.shots[1].captionTrack!.cues[0].text).toBe('原字幕');
  for (const map of [{ B: 'A', D: 'D2' }, { B: 'same', D: 'same' }, { B: 'B2' }]) expect(() => bulkDuplicateShots(baseline, ['B', 'D'], map)).toThrow('新编号');
});

it('removes atomically without moving BGM, and refuses locked targets in every structural command', () => {
  const baseline = { ...fixture(), musicClips: [{ id: 'music', assetId: 'bgm', startUs: 1_000_000, sourceInUs: 0, durationUs: 5_000_000, gainDb: -18, fadeInUs: 0, fadeOutUs: 0, loop: false }] }, result = bulkRemoveShots(baseline, ['B', 'D']); expect(order(result)).toEqual(['A', 'C', 'E', 'F']); expect(result.musicClips).toBe(baseline.musicClips); expect(result.shots[1].sceneIndex).toBe(2); expect(bulkRemoveShots(baseline, order(baseline)).shots).toEqual([]);
  const locked = patch(baseline, 'B', { locked: true });
  for (const action of [() => bulkRemoveShots(locked, ['A', 'B']), () => bulkMoveShots(locked, ['A', 'B'], 1), () => bulkReorderShots(locked, ['A', 'B'], 1), () => bulkDuplicateShots(locked, ['A', 'B'], { A: 'A2', B: 'B2' })]) expect(action).toThrow('「B」已锁定');
});
