import { expect, it } from 'vitest';
import { createNativeVideoWorkflow, DEFAULT_VIDEO_PROFILE, projectSchema, shotSchema, validateDramaProject } from '@video-quickly/contracts';
import { splitShotInContext } from '../src/packages/video/src/editing';
import { captureClipEditSource } from '../src/packages/video/src/clip-edits';
import { bulkDuplicateShots } from '../src/renderer/lib/bulk-shot-edits';
import { editContent } from '../src/renderer/lib/project-edits';

function project() {
  return projectSchema.parse({ id: 'episode', title: '第一集', brief: '', revision: 1, profile: DEFAULT_VIDEO_PROFILE, workflow: createNativeVideoWorkflow(),
    drama: { workId: 'work', number: 1, visualStyle: 'animation', narrativeMode: 'mixed', scenes: [{ id: 'scene', title: '雨夜' }] },
    shots: [{ id: 'shot', title: '相遇', narration: '', visualPrompt: '路灯下', durationUs: 6_000_000,
      drama: { sceneId: 'scene', appearances: [{ characterId: 'actor', appearanceId: 'coat' }], lines: [
        { id: 'dialogue', kind: 'dialogue', speakerId: 'actor', voiceId: 'voice', text: '你终于来了。', emotion: '惊讶', pauseAfterUs: 300_000 },
        { id: 'narration', kind: 'narration', text: '那一夜，雨一直没有停。' },
      ] },
    }], createdAt: '', updatedAt: '',
  });
}
function assertIndependent(left: ReturnType<typeof shotSchema.parse>, right: ReturnType<typeof shotSchema.parse>) {
  expect(right.drama?.sceneId).toBe(left.drama?.sceneId); expect(right.drama?.appearances).toEqual(left.drama?.appearances);
  expect(right.drama?.lines.map(({ id: _id, ...line }) => line)).toEqual(left.drama?.lines.map(({ id: _id, ...line }) => line));
  expect(new Set([...left.drama!.lines, ...right.drama!.lines].map(line => line.id)).size).toBe(4);
  expect(right.drama).not.toBe(left.drama); expect(right.drama?.lines[0]).not.toBe(left.drama?.lines[0]);
  right.drama!.lines[0].text = '修改副本'; expect(left.drama!.lines[0].text).toBe('你终于来了。');
}

it('copies dialogue with new identities and preserves shared scene, appearance and voice bindings', () => {
  const current = project(), original = JSON.stringify(current);
  const copied = bulkDuplicateShots(editContent(current), ['shot'], { shot: 'copy' });
  expect(() => validateDramaProject(copied)).not.toThrow(); expect(copied.shots.map(shot => shot.id)).toEqual(['shot', 'copy']);
  assertIndependent(copied.shots[0], copied.shots[1]); expect(JSON.stringify(current)).toBe(original);
});

it.each([false, true])('splits a drama shot into separately editable dialogue identities with clip editing %s', clipEdited => {
  const current = project();
  if (clipEdited) {
    current.clipEditSources = [captureClipEditSource(current.shots[0], [], 'source')];
    current.clipEditPlans = [{ id: 'plan', sourceId: 'source', spans: [{ id: 'span', durationUs: 6_000_000, originInUs: 0, sourceInUs: 0, audioInUs: 0, videoInUs: 0, sceneInUs: 0 }] }];
    current.shots[0].clipEdit = { planId: 'plan', inUs: 0, restoreInUs: 0, restoreDurationUs: 6_000_000 };
  }
  const original = JSON.stringify(current);
  const split = splitShotInContext(current, 'shot', 3_000_000, current.profile.frameRate, 'right');
  expect(() => validateDramaProject(split)).not.toThrow(); expect(split.shots.map(shot => shot.durationUs)).toEqual([3_000_000, 3_000_000]);
  assertIndependent(split.shots[0], split.shots[1]); expect(JSON.stringify(current)).toBe(original);
});

it('keeps legacy copy and split results free from new drama fields', () => {
  const current = project(); delete current.drama; delete current.shots[0].drama;
  const copied = bulkDuplicateShots(editContent(current), ['shot'], { shot: 'copy' });
  const split = splitShotInContext(current, 'shot', 3_000_000, current.profile.frameRate, 'right');
  for (const shot of [...copied.shots, ...split.shots]) expect(shot).not.toHaveProperty('drama');
});
