import { expect, it } from 'vitest';
import { assetSchema, createHistoryWorkflow, createSceneTemplate, DEFAULT_AUDIO_PROCESSING, DEFAULT_VIDEO_PROFILE, projectSchema, type AudioWaveform, type ShotCandidate } from '@video-quickly/contracts';
import { deleteShotRanges, resolveShotSpans } from '../packages/video/src/clip-edits';
import { trimShot } from '../packages/video/src/editing';
import { captionAtTime } from '../packages/video/src/captions';
import { candidatePreviewProject, shotWaveformSpans } from '../apps/desktop/src/lib/clip-preview';
import { waveformSpanColumns } from '../apps/desktop/src/lib/waveform-peaks';
import { captionTrackForEditor, commitCaptionEditorTrack, localCaptionTrack } from '../apps/desktop/src/lib/caption-editor-track';
import { applyBulkShotEdit } from '../apps/desktop/src/lib/bulk-shot-edits';
import { editContent } from '../apps/desktop/src/lib/project-edits';

function fixture() {
  const assets = [['voice', 'audio'], ['video', 'video'], ['new-voice', 'audio'], ['new-video', 'video']].map(([id, kind]) => assetSchema.parse({ id, kind, projectId: 'p', shotId: 'shot', name: id, path: `/fixture/${id}`, sha256: 'a'.repeat(64), version: 1, size: 1, mimeType: 'application/octet-stream', createdAt: '', provenance: '', active: true, retained: false }));
  const project = projectSchema.parse({ id: 'p', revision: 1, title: 'EDL消费', brief: '', profile: DEFAULT_VIDEO_PROFILE, workflow: createHistoryWorkflow(), createdAt: '', updatedAt: '', shots: [{ id: 'shot', title: '原镜头', narration: '', visualPrompt: '', durationUs: 8_000_000, sourceInUs: 0, audioAssetId: 'voice', videoAssetId: 'video', captionTrack: { timeBase: 'source', alignment: 'speech', granularity: 'word', sourceAssetId: 'voice', sourceSha256: assets[0].sha256, cues: Array.from({ length: 8 }, (_, index) => ({ id: `w${index}`, text: `词${index}`, startUs: index * 1_000_000, endUs: (index + 1) * 1_000_000 })) } }] });
  let counter = 0; const edited = deleteShotRanges(project, 'shot', [{ startUs: 2_000_000, endUs: 4_000_000 }], project.profile.frameRate, assets, kind => `${kind}-${++counter}`);
  return { project: edited, assets };
}

it('maps waveform columns only through retained source intervals, including a column crossing an edit', () => {
  const waveform: AudioWaveform = { version: 1, assetId: 'voice', sha256: 'hash', durationUs: 40_000, peaksPerSecond: 100, peaks: [.1, .9, .8, .2] };
  const spans = [{ outputStartUs: 0, durationUs: 10_000, sourceInUs: 0 }, { outputStartUs: 10_000, durationUs: 10_000, sourceInUs: 30_000 }];
  expect(waveformSpanColumns(waveform, spans, 20_000, 2)).toEqual([.1, .2]);
  expect(waveformSpanColumns(waveform, spans, 20_000, 1)).toEqual([.2]);
  expect(waveformSpanColumns(waveform, [...spans, { outputStartUs: 20_000, durationUs: 10_000, sourceInUs: 40_000 }], 30_000, 3)).toEqual([.1, .2, 0]);
});

it('projects waveform windows through trims and tail extension without filling deleted source gaps', () => {
  const { project } = fixture(), shot = project.shots[0];
  expect(shotWaveformSpans(shot, project)).toEqual([{ outputStartUs: 0, durationUs: 2_000_000, sourceInUs: 0 }, { outputStartUs: 2_000_000, durationUs: 4_000_000, sourceInUs: 4_000_000 }]);
  expect(shotWaveformSpans(shot, project, { inUs: 1_000_000, outUs: 7_000_000, rate: project.profile.frameRate, sourceDurationUs: 8_000_000 })).toEqual([
    { outputStartUs: 0, durationUs: 1_000_000, sourceInUs: 1_000_000 }, { outputStartUs: 1_000_000, durationUs: 4_000_000, sourceInUs: 4_000_000 }, { outputStartUs: 5_000_000, durationUs: 1_000_000, sourceInUs: 8_000_000 },
  ]);
  expect(project.clipEditPlans).toHaveLength(1);
});

it.each(['audio', 'video'] as const)('creates a private %s candidate plan while preserving the original and the other stream', kind => {
  const { project, assets } = fixture(), baseline = project.shots[0], asset = assets[kind === 'audio' ? 2 : 3];
  const candidate: ShotCandidate = { id: 'candidate', projectId: project.id, shotId: baseline.id, baseline, shot: { ...baseline, [kind === 'audio' ? 'audioAssetId' : 'videoAssetId']: asset.id }, kind, runId: 'run', nodeId: 'regenerate', createdAt: '', assetIds: [asset.id] };
  const snapshot = JSON.stringify(project), preview = candidatePreviewProject(project, candidate, assets), spans = resolveShotSpans(preview.shots[0], preview);
  expect(spans.map(span => kind === 'audio' ? [span.audioInUs, span.videoInUs] : [span.videoInUs, span.audioInUs])).toEqual([[0, 0], [2_000_000, 4_000_000]]);
  expect(preview.clipEditPlans).toHaveLength(2); expect(preview.clipEditSources).toBe(project.clipEditSources); expect(JSON.stringify(project)).toBe(snapshot);
  expect(() => candidatePreviewProject({ ...project, clipEditPlans: [] }, candidate, assets)).toThrow('计划缺失');
});

it('does not alias an existing imported plan when allocating candidate preview identities', () => {
  const { project, assets } = fixture(), baseline = project.shots[0];
  const collision = { ...project.clipEditPlans![0], id: 'candidate-preview-candidate-plan-1' };
  const document = { ...project, clipEditPlans: [...project.clipEditPlans!, collision] };
  const candidate: ShotCandidate = { id: 'candidate', projectId: project.id, shotId: baseline.id, baseline, shot: { ...baseline, audioAssetId: assets[2].id }, kind: 'audio', runId: 'run', nodeId: 'regenerate', createdAt: '', assetIds: [assets[2].id] };
  const preview = candidatePreviewProject(document, candidate, assets);
  expect(preview.shots[0].clipEdit?.planId).not.toBe(collision.id);
  expect(resolveShotSpans(preview.shots[0], preview).map(span => span.audioInUs)).toEqual([0, 2_000_000]);
});

it('extends only the selected private bulk plan and retains the sibling and both source-duration checks', () => {
  const { project } = fixture(), original = project.shots[0], baseline = editContent({ ...project, shots: [original, { ...original, id: 'sibling' }] });
  let counter = 0;
  const result = applyBulkShotEdit(baseline, baseline, ['shot'], { durationUs: 7_000_000 }, { voice: 10_000_000, video: 8_000_000 }, kind => `bulk-${kind}-${++counter}`);
  expect(resolveShotSpans(result.shots[0], result).map(span => [span.originInUs, span.durationUs])).toEqual([[0, 2_000_000], [4_000_000, 4_000_000], [8_000_000, 1_000_000]]);
  expect(result.shots[1]).toBe(baseline.shots[1]); expect(result.shots[0].clipEdit?.planId).not.toBe(original.clipEdit?.planId); expect(result.clipEditPlans).toHaveLength(2);
  expect(() => applyBulkShotEdit(baseline, baseline, ['shot'], { durationUs: 7_000_000 }, { voice: 10_000_000 })).toThrow('视频素材时长');
  expect(() => applyBulkShotEdit(baseline, baseline, ['shot'], { durationUs: 8_000_001 }, { voice: 10_000_000, video: 8_000_000 })).toThrow('真实时长');
  const changed = { ...baseline, clipEditPlans: baseline.clipEditPlans.map(plan => ({ ...plan, spans: plan.spans.map((span, index) => index ? span : { ...span, audioInUs: 1 }) })) };
  expect(() => applyBulkShotEdit(changed, baseline, ['shot'], { durationUs: 7_000_000 }, { voice: 10_000_000, video: 8_000_000 })).toThrow('计划已变化');
});

it('uses an enabled template video original track to bound a private EDL tail extension', () => {
  const { project } = fixture();
  const baseline = editContent({ ...project, shots: [{ ...project.shots[0], sceneTemplate: createSceneTemplate('process'), audioProcessing: { ...DEFAULT_AUDIO_PROCESSING, version: 2, videoAudio: { enabled: true, gainDb: 0 } } }] });
  let sequence = 0;
  const result = applyBulkShotEdit(baseline, baseline, ['shot'], { durationUs: 7_000_000 }, { voice: 2_000_000, video: 10_000_000 }, kind => `original-tail-${kind}-${++sequence}`);
  expect(result.shots[0].durationUs).toBe(7_000_000);
  expect(resolveShotSpans(result.shots[0], result).at(-1)).toMatchObject({ videoInUs: 8_000_000, durationUs: 1_000_000 });
  expect(() => applyBulkShotEdit(baseline, baseline, ['shot'], { durationUs: 9_000_000 }, { voice: 2_000_000, video: 10_000_000 })).toThrow('真实时长');
});

it('keeps genuine ASR untouched and stores manual caption edits on plan time while preserving hidden captions', () => {
  const { project } = fixture(), shot = trimShot(project.shots[0], { inUs: 1_000_000, outUs: 5_000_000 }, project.profile.frameRate, undefined, project);
  const full = captionTrackForEditor(shot, project), local = localCaptionTrack(shot, full, project);
  expect(local.cues.map(cue => cue.text)).toEqual(['词1', '词4', '词5', '词6']); expect(local.alignment).toBe('speech');
  expect(commitCaptionEditorTrack(shot, full, local, project)).toBe(full);
  const manual = commitCaptionEditorTrack(shot, full, { ...local, alignment: 'manual', cues: local.cues.map((cue, index) => index ? cue : { ...cue, text: '人工纠正' }) }, project);
  expect(manual.timeBase).toBe('clip'); expect(manual.alignment).toBe('manual');
  expect(manual.cues).toEqual(expect.arrayContaining([expect.objectContaining({ text: '词0' }), expect.objectContaining({ text: '词7' })]));
  expect(captionAtTime({ ...shot, captionTrack: manual }, 0, undefined, project)?.text).toBe('人工纠正');
  expect(commitCaptionEditorTrack(shot, full, local, project, true)).toMatchObject({ timeBase: 'clip', alignment: 'manual', cues: [] });
});
