import { expect, it } from 'vitest';
import { assetSchema, createHistoryWorkflow, DEFAULT_CAPTION_STYLE, DEFAULT_VIDEO_PROFILE, projectSchema, type ProjectDocument, type SilenceDetection } from '@video-quickly/contracts';
import { deleteShotRanges, resolveShotTime, type ClipEditIdFactory } from '../packages/video/src/clip-edits';
import { splitShot, trimShot } from '../packages/video/src/editing';
import { editContent, ProjectEditSession } from '../apps/desktop/src/lib/project-edits';
import { applyTranscriptEdit, previewTranscriptEdit, projectSilenceRanges, transcriptMixOffset, transcriptPreviewTime, transcriptRows, type TranscriptEditAction } from '../apps/desktop/src/lib/transcript-edits';

const second = 1_000_000, rate = { numerator: 30, denominator: 1 }, hash = 'a'.repeat(64);
const assets = ['audio', 'video', 'image', 'new-audio'].map((id, index) => assetSchema.parse({ id, projectId: 'project', name: id, kind: id.includes('audio') ? 'audio' : id, path: `/media/${id}`, mimeType: 'application/octet-stream', size: 100, sha256: hash, version: index + 1, createdAt: '', provenance: 'fixture' }));
function fixture(): ProjectDocument {
  return projectSchema.parse({ id: 'project', title: '文稿剪辑', brief: '', revision: 1, profile: { ...DEFAULT_VIDEO_PROFILE, frameRate: rate }, workflow: createHistoryWorkflow(), createdAt: '', updatedAt: '', shots: [{ id: 'shot', title: '保留标题', narration: '原始旁白', visualPrompt: '原画面', durationUs: 8 * second, sourceInUs: 5 * second, audioInUs: second, videoInUs: 2 * second, sceneInUs: 3 * second, sceneDurationUs: 12 * second, sceneIndex: 2, audioAssetId: 'audio', videoAssetId: 'video', assetId: 'image', captionTrack: { alignment: 'speech', granularity: 'word', timeBase: 'source', sourceAssetId: 'audio', sourceSha256: hash, cues: Array.from({ length: 8 }, (_, index) => ({ id: `cue-${index}`, text: `词${index}`, startUs: (index + 1) * second, endUs: (index + 2) * second })) } }, { id: 'other', title: '另一个镜头', narration: '另一个旁白', visualPrompt: '', durationUs: second }] });
}
function factory() { let count = 0; const id: ClipEditIdFactory = kind => `${kind}-${++count}`; return { id, count: () => count }; }
const action: TranscriptEditAction = { kind: 'delete', ranges: [{ startUs: 2 * second, endUs: 4 * second }] };
function cut(project = fixture()) { return deleteShotRanges(project, 'shot', action.kind === 'delete' ? action.ranges : [], rate, assets, factory().id); }

it('enables word cuts only for matching real speech timestamps, preserving manual and estimated segment semantics', () => {
  const project = fixture(); expect(transcriptRows(project, 'shot', assets)).toMatchObject({ granularity: 'word', alignment: 'speech', staleSpeech: false });
  for (const alignment of ['manual', 'estimated'] as const) { const changed = { ...project, shots: project.shots.map(shot => shot.id === 'shot' ? { ...shot, captionTrack: { ...shot.captionTrack!, alignment } } : shot) }; expect(transcriptRows(changed, 'shot', assets)).toMatchObject({ granularity: 'segment', alignment, staleSpeech: false }); }
  const stale = transcriptRows(project, 'shot', assets.map(asset => asset.id === 'audio' ? { ...asset, sha256: 'b'.repeat(64) } : asset)); expect(stale).toMatchObject({ granularity: 'segment', staleSpeech: true });
  const segmented = { ...project, shots: project.shots.map(shot => shot.id === 'shot' ? { ...shot, captionTrack: { ...shot.captionTrack!, granularity: 'segment' as const } } : shot) }; expect(transcriptRows(segmented, 'shot', assets).granularity).toBe('segment');
});

it('previews a synchronized media cut without changing the source and stores the original cue track once', () => {
  const original = fixture(), copy = structuredClone(original), preview = previewTranscriptEdit(original, 'shot', action, assets, factory().id);
  expect(original).toEqual(copy); expect(preview.shots[0].durationUs).toBe(6 * second); expect(preview.shots[0].captionTrack).toBeUndefined(); expect(preview.clipEditSources).toHaveLength(1); expect(preview.clipEditSources![0].original.captionTrack).toEqual(original.shots[0].captionTrack);
  expect(resolveShotTime(preview.shots[0], preview, 2 * second)).toMatchObject({ audioUs: 5 * second, videoUs: 6 * second, sceneUs: 7 * second }); expect(transcriptRows(preview, 'shot', assets).cues.map(cue => cue.text)).toEqual(['词0', '词1', '词4', '词5', '词6', '词7']);
});

it('locates transcript positions through cuts rather than subtracting a single media offset', () => {
  const original = fixture(), first = cut(original);
  expect(transcriptPreviewTime(original, first, 'shot', second)).toBe(second); expect(transcriptPreviewTime(original, first, 'shot', 3 * second)).toBe(2 * second); expect(transcriptPreviewTime(original, first, 'shot', 6 * second)).toBe(4 * second);
  const next = previewTranscriptEdit(first, 'shot', { kind: 'delete', ranges: [{ startUs: second, endUs: 2 * second }] }, assets, kind => `next-${kind}`);
  expect(transcriptPreviewTime(first, next, 'shot', 3 * second)).toBe(2 * second);
});

it('uses the prepared mix order after an unrelated reorder and rejects an ambiguous target window', () => {
  const project = fixture(), opened = { ...project, shots: [project.shots[1], project.shots[0]] };
  const mixed = { shotDurations: [{ shotId: 'shot', durationUs: 8 * second }, { shotId: 'other', durationUs: second }] };
  expect(transcriptMixOffset(opened, mixed, 'shot')).toBe(0);
  expect(transcriptMixOffset(project, { shotDurations: [...mixed.shotDurations].reverse() }, 'shot')).toBe(second);
  expect(() => transcriptMixOffset(opened, {}, 'shot')).toThrow('镜头顺序');
  expect(() => transcriptMixOffset(opened, { shotDurations: [{ shotId: 'other', durationUs: second }] }, 'shot')).toThrow('目标镜头');
  expect(() => transcriptMixOffset(opened, { shotDurations: [{ shotId: 'shot', durationUs: 7 * second }] }, 'shot')).toThrow('时长');
});

it('projects real source silence through surviving audio spans without inferring silence from transcript gaps', () => {
  const project = cut(), detection: SilenceDetection = { assetId: 'audio', sourceSha256: hash, thresholdDb: -35, minimumDurationUs: 200000, paddingUs: 50000, ranges: [{ startUs: 1.5 * second, endUs: 2 * second }, { startUs: 3 * second, endUs: 6 * second }] };
  expect(projectSilenceRanges(project, 'shot', assets, detection)).toEqual([{ startUs: .5 * second, endUs: second }, { startUs: 2 * second, endUs: 3 * second }]); expect(projectSilenceRanges(project, 'shot', assets, { ...detection, ranges: [] })).toEqual([]);
  expect(() => projectSilenceRanges(project, 'shot', assets, { ...detection, sourceSha256: 'b'.repeat(64) })).toThrow('不匹配'); expect(() => projectSilenceRanges(project, 'shot', assets, { ...detection, assetId: 'new-audio' })).toThrow('不匹配');
});

it('preserves unrelated title, appearance, other-shot edits and unrelated plan records', () => {
  const project = fixture(), current = editContent(project), live = { ...current, title: '外部项目标题', style: '外部风格', shots: current.shots.map(shot => shot.id === 'shot' ? { ...shot, title: '外部镜头标题', captionStyle: DEFAULT_CAPTION_STYLE } : { ...shot, narration: '另一个镜头的新输入' }), clipEditSources: [{ id: 'unrelated-source', original: { durationUs: second }, assetHashes: [] }] };
  const next = applyTranscriptEdit(live, project, 'shot', action, assets, assets, factory().id).content;
  expect(next.title).toBe(live.title); expect(next.style).toBe(live.style); expect(next.shots[0]).toMatchObject({ title: '外部镜头标题', captionStyle: DEFAULT_CAPTION_STYLE, durationUs: 6 * second }); expect(next.shots[1]).toEqual(live.shots[1]); expect(next.clipEditSources[0]).toEqual(live.clipEditSources[0]);
});

it('rejects related time, narration, media or caption edits and frame-rate changes', () => {
  const project = fixture(), original = project.shots[0];
  const changes = [{ durationUs: 7 * second }, { sourceInUs: 6 * second }, { audioInUs: 2 * second }, { videoInUs: 3 * second }, { sceneInUs: 4 * second }, { sceneDurationUs: 14 * second }, { narration: '外部新旁白' }, { audioAssetId: 'new-audio' }, { captionTrack: { ...original.captionTrack!, cues: original.captionTrack!.cues.map((cue, index) => index ? cue : { ...cue, text: '外部字幕' }) } }];
  for (const patch of changes) expect(() => applyTranscriptEdit(editContent({ ...project, shots: [{ ...original, ...patch }, project.shots[1]] }), project, 'shot', action, assets, assets, factory().id)).toThrow(/其他视图|素材/);
  expect(() => applyTranscriptEdit({ ...editContent(project), profile: { ...project.profile, frameRate: { numerator: 24, denominator: 1 } } }, project, 'shot', action, assets, assets, factory().id)).toThrow('帧率');
});

it('rejects asset hash, version, path, size, active and ownership changes but allows a cosmetic rename', () => {
  const project = fixture(), changes = [{ sha256: 'b'.repeat(64) }, { version: 20 }, { path: '/elsewhere/audio' }, { size: 101 }, { active: false }, { projectId: 'other-project' }];
  for (const patch of changes) expect(() => applyTranscriptEdit(editContent(project), project, 'shot', action, assets.map(asset => asset.id === 'audio' ? { ...asset, ...patch } : asset), assets, factory().id)).toThrow('素材');
  expect(() => applyTranscriptEdit(editContent(project), project, 'shot', action, assets.map(asset => ({ ...asset, name: `${asset.name}改名` })), assets, factory().id)).not.toThrow();
});

it('retries its own failed save without allocating more plans or adding an undo command', () => {
  const project = fixture(), id = factory(), session = new ProjectEditSession(project), first = applyTranscriptEdit(session.state.present, project, 'shot', action, assets, assets, id.id); session.edit(first.content, '文稿剪辑'); const count = id.count();
  const retry = applyTranscriptEdit(session.state.present, project, 'shot', structuredClone(action), assets, assets, id.id, first.submission); expect(retry.content).toBe(session.state.present); expect(id.count()).toBe(count);
  session.edit(retry.content, '重试保存同一剪辑'); expect(session.state.undo).toHaveLength(1);
  const live = { ...session.state.present, title: '失败后无关标题' }; expect(applyTranscriptEdit(live, project, 'shot', action, assets, assets, id.id, first.submission).content).toBe(live);
  session.undo(); expect(session.state.present.shots).toEqual(project.shots);
});

it('does not claim another edit merely because a previous submission failed to save', () => {
  const project = fixture(), id = factory(), first = applyTranscriptEdit(editContent(project), project, 'shot', action, assets, assets, id.id);
  const external = { ...first.content, shots: first.content.shots.map(shot => shot.id === 'shot' ? { ...shot, captionTrack: { timeBase: 'clip' as const, alignment: 'manual' as const, cues: [{ id: 'new', startUs: 0, endUs: second, text: '外部校对' }] } } : shot) };
  expect(() => applyTranscriptEdit(external, project, 'shot', action, assets, assets, id.id, first.submission)).toThrow('其他视图');
});

it('restores only the split and trimmed source window while preserving current title and styles', () => {
  const first = cut(), [left, right] = splitShot(first.shots[0], 2 * second, rate, 'right', first), split = { ...first, shots: [left, right, first.shots[1]] };
  const trimmed = trimShot(right, { inUs: 3 * second, outUs: 5 * second }, rate, undefined, split), project = { ...split, shots: [left, { ...trimmed, title: '分割后标题', captionStyle: DEFAULT_CAPTION_STYLE }, split.shots[2]] };
  const preview = previewTranscriptEdit(project, 'right', { kind: 'restore' }, assets, factory().id), restored = preview.shots[1];
  expect(restored).toMatchObject({ durationUs: 2 * second, sourceInUs: 10 * second, audioInUs: 6 * second, videoInUs: 7 * second, sceneInUs: 8 * second, title: '分割后标题', captionStyle: DEFAULT_CAPTION_STYLE }); expect(restored.clipEdit).toBeUndefined(); expect(preview.shots[0]).toEqual(left); expect(project.shots[1].clipEdit).toBeDefined();
});

it('allows a failed restoration to retry once without deleting the original source records', () => {
  const project = cut(), id = factory(), first = applyTranscriptEdit(editContent(project), project, 'shot', { kind: 'restore' }, assets, assets, id.id), retry = applyTranscriptEdit(first.content, project, 'shot', { kind: 'restore' }, assets, assets, id.id, first.submission);
  expect(retry.content).toBe(first.content); expect(id.count()).toBe(0); expect(retry.content.shots[0].captionTrack).toEqual(fixture().shots[0].captionTrack); expect(retry.content.clipEditSources).toEqual(project.clipEditSources);
});

it('rejects locked, missing, empty and too-short edits before creating any source or plan', () => {
  const project = fixture(), id = factory(); expect(() => applyTranscriptEdit(editContent({ ...project, shots: [{ ...project.shots[0], locked: true }] }), project, 'shot', action, assets, assets, id.id)).toThrow('解锁');
  expect(() => applyTranscriptEdit({ ...editContent(project), shots: [] }, project, 'shot', action, assets, assets, id.id)).toThrow('移除'); expect(() => applyTranscriptEdit(editContent(project), project, 'shot', { kind: 'delete', ranges: [] }, assets, assets, id.id)).toThrow('选择'); expect(() => applyTranscriptEdit(editContent(project), project, 'shot', { kind: 'delete', ranges: [{ startUs: 0, endUs: 7.8 * second }] }, assets, assets, id.id)).toThrow('0.5 秒'); expect(id.count()).toBe(0);
});
