import { expect, it } from 'vitest';
import { createNativeVideoWorkflow, DEFAULT_VIDEO_PROFILE, projectSchema } from '@video-quickly/contracts';
import { editContent, mergeEdits, ProjectEditSession, savedEditsSchema } from '../src/renderer/lib/project-edits';

function episode() {
  return projectSchema.parse({ id: 'episode', title: '第一集', brief: '', revision: 1, profile: DEFAULT_VIDEO_PROFILE, workflow: createNativeVideoWorkflow(), createdAt: '2026-11-17', updatedAt: '2026-11-17', shots: [{ id: 'shot', title: '镜头', narration: '', visualPrompt: '', durationUs: 4_000_000 }], drama: { workId: 'work', number: 1, visualStyle: 'animation', narrativeMode: 'mixed', scenes: [] } });
}

it('persists scene and dialogue commands through save, reload, undo and redo without flattening the content', () => {
  const original = episode(), session = new ProjectEditSession(original);
  const scenes = [{ id: 'scene', title: '书房', location: '宅院', timeOfDay: '夜', description: '桌上的旧信' }];
  const drama = { sceneId: 'scene', appearances: [{ characterId: 'hero', appearanceId: 'night' }], lines: [{ id: 'line', kind: 'dialogue' as const, speakerId: 'hero', voiceId: 'voice', text: '信是谁留下的？', emotion: '克制', pauseAfterUs: 400_000 }, { id: 'narrator', kind: 'narration' as const, text: '门外响起脚步。' }] };
  session.edit({ ...session.state.present, drama: { ...original.drama!, scenes }, shots: [{ ...original.shots[0], drama }] }, '编辑短剧内容');
  const saved = projectSchema.parse({ ...original, ...session.state.present, revision: 2 }); session.saved(saved);
  const restored = new ProjectEditSession(saved, savedEditsSchema.parse(JSON.parse(JSON.stringify(session.state))));
  expect(restored.state.present.drama?.scenes).toEqual(scenes);
  expect(restored.state.present.shots[0].drama).toEqual(drama);
  restored.undo(); expect(restored.state.present).toEqual(editContent(original));
  restored.redo(); expect(restored.state.present).toEqual(editContent(saved));
});

it('merges an unrelated project title while preserving local scene changes and exposes conflicting scene changes', () => {
  const original = episode(), base = editContent(original);
  const local = { ...base, drama: { ...base.drama!, scenes: [{ id: 'scene', title: '厨房', description: '', location: '', timeOfDay: '' }] } };
  const merged = mergeEdits(base, local, { ...base, title: '新的集名' });
  expect(merged.conflicts).toEqual([]); expect(merged.content.title).toBe('新的集名'); expect(merged.content.drama).toEqual(local.drama);
  const conflicting = mergeEdits(base, local, { ...base, drama: { ...base.drama!, scenes: [{ id: 'other', title: '客厅', description: '', location: '', timeOfDay: '' }] } });
  expect(conflicting.conflicts.some(conflict => conflict.path.startsWith('drama'))).toBe(true);
});
