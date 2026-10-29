import { createCanvas } from '@napi-rs/canvas';
import { expect, it } from 'vitest';
import { createSceneTemplate, DEFAULT_VIDEO_PROFILE, shotSchema } from '@video-quickly/contracts';
import { captionPages, createSubtitleCues, drawSceneFrame } from '../src/index.js';
import { SCENE_TEMPLATE_FONT_FAMILY } from '../src/scene-templates.js';

it.each([[640, 360], [360, 640]])('keeps a long explicit caption clear of template content at %i×%i without changing its cue timing', (width, height) => {
  const shot = shotSchema.parse({ id: 'shot', title: '字幕安全区', narration: '', visualPrompt: '', durationUs: 2_000_000, sceneTemplate: { ...createSceneTemplate('bar-chart'), motion: 'none' }, captionTrack: { timeBase: 'scene', alignment: 'manual', cues: [{ id: 'long', startUs: 0, endUs: 2_000_000, text: '这是一条需要完整保留时间的人工字幕。'.repeat(12) }] } });
  const profile = { ...DEFAULT_VIDEO_PROFILE, width, height };
  function render(captionTrack = shot.captionTrack, timeUs = 1_000_000) {
    const canvas = createCanvas(width, height);
    drawSceneFrame(canvas as unknown as HTMLCanvasElement, { ...shot, captionTrack, shotIndex: 0, profile }, timeUs);
    return canvas.getContext('2d').getImageData(0, 0, width, height).data;
  }
  const before = render({ timeBase: 'scene', alignment: 'manual', cues: [] }), after = render();
  let firstChangedRow = height, lastDiagramRow = -1;
  for (let offset = 0; offset < before.length; offset += 4) if (before[offset + 1] - before[offset] > 20 && before[offset + 1] - before[offset + 2] > 7 && before[offset + 1] < 210) lastDiagramRow = Math.floor(offset / 4 / width);
  for (let offset = 0; offset < before.length; offset++) if (before[offset] !== after[offset]) { firstChangedRow = Math.floor(offset / 4 / width); break; }
  expect(firstChangedRow).toBeLessThan(height);
  expect(firstChangedRow).toBeGreaterThan(lastDiagramRow);
  const ctx = createCanvas(width, height).getContext('2d');
  ctx.font = `500 ${Math.max(12, Math.min(width * .027, height * .047))}px ${SCENE_TEMPLATE_FONT_FAMILY}`;
  const maximumLines = height > width ? 3 : 2;
  const subtitles = createSubtitleCues([shot], text => captionPages(text, line => ctx.measureText(line).width, width * .78, maximumLines));
  expect(subtitles.length).toBeGreaterThan(1);
  expect(subtitles.every(cue => cue.lines.length <= maximumLines)).toBe(true);
  expect(subtitles.flatMap(cue => cue.lines).join('')).toBe(shot.captionTrack?.cues[0].text);
  expect(subtitles[0].startUs).toBe(0); expect(subtitles.at(-1)?.endUs).toBe(2_000_000);
  for (const cue of subtitles) {
    const timeUs = (cue.startUs + cue.endUs) / 2;
    const expected = render({ timeBase: 'scene', alignment: 'manual', cues: [{ id: 'visible-page', startUs: cue.startUs, endUs: cue.endUs, text: cue.lines.join('\n') }] }, timeUs);
    expect(Buffer.from(render(shot.captionTrack, timeUs)).equals(Buffer.from(expected))).toBe(true);
  }
});
