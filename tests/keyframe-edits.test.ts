import { expect, it } from 'vitest';
import { createHistoryWorkflow, DEFAULT_VIDEO_PROFILE, projectSchema } from '@video-quickly/contracts';
import { applyKeyframeEdit, assertKeyframeAssets, assertKeyframePreviewWindow, keyframeAssetIds, keyframePreviewWindow } from '../apps/desktop/src/lib/keyframe-edits';
import type { AssetRecord } from '@video-quickly/contracts';
import { editContent, ProjectEditSession, savedEditsSchema } from '../apps/desktop/src/lib/project-edits';
import { applyBulkShotEdit } from '../apps/desktop/src/lib/bulk-shot-edits';

const fixture = () => projectSchema.parse({ id: 'p', title: 'p', brief: '', revision: 1, profile: DEFAULT_VIDEO_PROFILE, workflow: createHistoryWorkflow(), shots: [{ id: 's', title: 's', narration: '', visualPrompt: '', durationUs: 3_000_000 }], createdAt: '', updatedAt: '' });
const animated = (project = fixture()) => ({ ...project.shots[0].animation, keyframes: [{ id: 'kf', timeUs: 0, panX: .1, panY: 0, zoom: 2, easing: 'linear' as const }] });

it('freezes actual consumed visual asset identity while allowing an unrelated retain flag change', () => {
  const shot = { ...fixture().shots[0], videoAssetId: 'v' };
  const asset: AssetRecord = { id: 'v', projectId: 'p', name: 'video', path: '/video.mp4', kind: 'video', mimeType: 'video/mp4', size: 1, sha256: 'a'.repeat(64), version: 1, active: true, retained: false, provenance: '', createdAt: '' };
  expect(() => assertKeyframeAssets(shot, [asset], [{ ...asset, retained: true }])).not.toThrow();
  expect(() => assertKeyframeAssets(shot, [asset], [{ ...asset, version: 2, sha256: 'b'.repeat(64) }])).toThrow('素材版本');
  expect(() => assertKeyframeAssets(shot, [asset], [])).toThrow('素材版本');
});

it('freezes narration metadata only when its complete recording determines the legacy presentation window', () => {
  const p = fixture(), baseline = { ...p.shots[0], audioAssetId: 'voice' };
  const voice: AssetRecord = { id: 'voice', projectId: 'p', name: 'voice', path: '/voice.wav', kind: 'audio', mimeType: 'audio/wav', size: 1, sha256: 'a'.repeat(64), version: 1, active: true, retained: false, provenance: '', createdAt: '' };
  expect(keyframeAssetIds(baseline)).toEqual(['voice']);
  for (const patch of [{ path: '/new.wav' }, { sha256: 'b'.repeat(64) }, { version: 2 }]) expect(() => assertKeyframeAssets(baseline, [voice], [{ ...voice, ...patch }])).toThrow('旁白素材版本');
  expect(() => assertKeyframeAssets(baseline, [voice], [{ ...voice, retained: true }])).not.toThrow();
  expect(() => assertKeyframeAssets({ ...baseline, audioInUs: 0 }, [voice], [{ ...voice, version: 2 }])).not.toThrow();
  expect(() => assertKeyframePreviewWindow({ ...baseline, durationUs: 3_000_000 }, { ...baseline, durationUs: 4_000_000 })).toThrow('实际预览时长');
  expect(() => applyKeyframeEdit({ ...editContent(p), shots: [{ ...baseline, audioAssetId: 'another-voice' }] }, baseline, p, animated())).toThrow('已更新');
});

it('aligns the candidate to global fractional-rate frames and excludes the next shot boundary', () => {
  const p = fixture(); p.profile.frameRate = { numerator: 30000, denominator: 1001 }; p.shots = [{ ...p.shots[0], durationUs: 500_000 }, { ...p.shots[0], id: 'second', durationUs: 1_000_000 }];
  const window = keyframePreviewWindow(p, 'second');
  expect(window.minimumUs).toBe(500); expect(window.align(500_000)).toBe(501_000);
  expect(window.maximumUs).toBe(968_133); expect(window.align(1_000_000)).toBe(window.maximumUs);
});

it('applies a complete motion edit as one recoverable command and preserves unrelated titles', () => {
  const project = fixture(), session = new ProjectEditSession(project), context = editContent(project);
  const current = { ...context, title: '后来的项目名', shots: context.shots.map(shot => ({ ...shot, title: '后来的镜头名' })) };
  session.edit(current, '改标题'); session.endGroup();
  session.edit(applyKeyframeEdit(session.state.present, project.shots[0], project, animated()), '关键帧'); session.endGroup();
  expect(session.state.undo).toHaveLength(2); expect(session.state.present.title).toBe(current.title); expect(session.state.present.shots[0].title).toBe(current.shots[0].title);
  const restored = new ProjectEditSession(project, savedEditsSchema.parse(JSON.parse(JSON.stringify(session.state))));
  restored.undo(); expect(restored.state.present.shots[0].animation).toEqual(project.shots[0].animation);
  restored.redo(); expect(restored.state.present.shots[0].animation).toEqual(animated());
});

it.each(['locked', 'duration', 'motion', 'media'] as const)('rejects a related %s change without overwriting it', change => {
  const project = fixture(), baseline = project.shots[0];
  const shot = { ...baseline, ...(change === 'locked' ? { locked: true } : change === 'duration' ? { durationUs: 2_000_000 } : change === 'motion' ? { animation: { ...baseline.animation, zoom: 1.4 } } : { videoAssetId: 'new-video' }) };
  const content = { ...editContent(project), shots: [shot] };
  expect(() => applyKeyframeEdit(content, baseline, project, animated())).toThrow(); expect(content.shots[0]).toEqual(shot);
});

it('rejects invalid curves and duplicate keyframe times at the actual application boundary', () => {
  const project = fixture(), animation = animated();
  expect(() => applyKeyframeEdit(editContent(project), project.shots[0], project, { ...animation, keyframes: [...animation.keyframes, { ...animation.keyframes[0], id: 'duplicate-time' }] })).toThrow();
});

it('copies the complete authored track and permits an explicit legacy bulk motion replacement', () => {
  const project = fixture(); project.shots[0].animation = animated(); project.shots.push({ ...project.shots[0], id: 'other', title: '保留的内容', narration: '原旁白', animation: { panX: 0, panY: 0, zoom: 1, transition: 'cut' } });
  const content = editContent(project), copied = applyBulkShotEdit(content, content, ['other'], { copyStyleFromId: 's' }, {});
  expect(copied.shots[1].animation).toEqual(animated()); expect(copied.shots[1].narration).toBe('原旁白');
  const replaced = applyBulkShotEdit(copied, copied, ['other'], { animation: { panX: .2, panY: 0, zoom: 1.3, transition: 'cut' } }, {});
  expect(replaced.shots[1].animation.keyframes).toBeUndefined(); expect(replaced.shots[0].animation.keyframes).toEqual(animated().keyframes);
});
