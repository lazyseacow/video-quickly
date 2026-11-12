import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it, vi } from 'vitest';
import { createSceneTemplate, DEFAULT_VIDEO_PROFILE, sceneTemplateSchema, shotSchema, type SceneTemplate, type SceneTemplateKind } from '@video-quickly/contracts';
import { drawSceneFrame, type SceneFrame } from '../src/index.js';
import { splitShot, trimShot } from '../src/editing.js';

const kinds: SceneTemplateKind[] = ['process', 'comparison', 'bar-chart'];
const sizes = [[640, 360], [360, 640], [480, 480]];
function frame(template: SceneTemplate, timeUs: number, width = 640, height = 360, extra: Partial<SceneFrame> = {}) {
  const canvas = createCanvas(width, height);
  drawSceneFrame(canvas as unknown as HTMLCanvasElement, { title: '原镜头标题', narration: '', shotIndex: 0, profile: { ...DEFAULT_VIDEO_PROFILE, width, height }, durationUs: 4_000_000, sceneTemplate: template, ...extra }, timeUs);
  return canvas;
}
const green = (r: number, g: number, b: number) => g - r > 20 && g - b > 7 && g < 210;
function colored(canvas: ReturnType<typeof frame>) {
  const values = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let count = 0, lastY = -1;
  for (let offset = 0; offset < values.length; offset += 4) {
    if (green(values[offset], values[offset + 1], values[offset + 2])) { count++; lastY = Math.floor(offset / 4 / canvas.width); }
  }
  return { count, lastY };
}

describe('editable explanatory scenes', () => {
  it('keeps old shots unchanged, validates editable limits and preserves input whitespace', () => {
    expect(shotSchema.parse({ id: 'legacy', title: '旧项目', narration: '', visualPrompt: '', durationUs: 1_000_000 }).sceneTemplate).toBeUndefined();
    for (const kind of kinds) {
      const sample = createSceneTemplate(kind);
      expect(sceneTemplateSchema.safeParse(sample).success).toBe(true); expect(sample.heading).toContain('示例');
      const spaced = { ...sample, heading: '  保留输入空格  ' };
      expect(sceneTemplateSchema.parse(spaced).heading).toBe(spaced.heading);
      expect(sceneTemplateSchema.safeParse({ ...sample, heading: ' \n ' }).success).toBe(false);
    }
    const process = createSceneTemplate('process');
    if (process.kind !== 'process') throw new Error('wrong sample');
    expect(sceneTemplateSchema.safeParse({ ...process, steps: [process.steps[0]] }).success).toBe(false);
    process.steps[0].title = '人工修改'; expect(createSceneTemplate('process')).not.toEqual(process);
    const chart = createSceneTemplate('bar-chart');
    if (chart.kind !== 'bar-chart') throw new Error('wrong sample');
    expect(sceneTemplateSchema.safeParse({ ...chart, bars: [{ label: 'A', value: -1 }, { label: 'B', value: 2 }] }).success).toBe(false);
  });

  it.each(kinds)('animates actual %s diagram pixels in landscape, portrait and square frames', kind => {
    const template = createSceneTemplate(kind);
    for (const [width, height] of sizes) {
      const initial = frame(template, 0, width, height), final = frame(template, 4_000_000, width, height);
      const before = initial.getContext('2d').getImageData(0, 0, width, height).data, after = final.getContext('2d').getImageData(0, 0, width, height).data;
      let changed = 0;
      for (let offset = 0; offset < before.length; offset += 4) if (Math.abs(before[offset] - after[offset]) + Math.abs(before[offset + 1] - after[offset + 1]) + Math.abs(before[offset + 2] - after[offset + 2]) > 35) changed++;
      expect(changed).toBeGreaterThan(300);
      expect(initial.toBuffer('image/png').equals(final.toBuffer('image/png'))).toBe(false);
      const still = { ...template, motion: 'none' as const };
      expect(frame(still, 0, width, height).toBuffer('image/png').equals(frame(still, 3_000_000, width, height).toBuffer('image/png'))).toBe(true);
    }
  });

  it('renders bar widths proportional to the supplied values rather than equal decorative columns', () => {
    const template: SceneTemplate = { kind: 'bar-chart', heading: 'Measured values', palette: 'sage', motion: 'none', unit: 'units', bars: [{ label: 'A', value: 10 }, { label: 'B', value: 20 }, { label: 'Zero', value: 0 }] };
    const canvas = frame(template, 0, 960, 540), values = canvas.getContext('2d').getImageData(0, 0, 960, 540).data;
    const groups: number[] = []; let current = 0;
    for (let y = Math.floor(540 * .26); y < 540 * .8; y++) {
      let longest = 0, run = 0;
      for (let x = Math.floor(960 * .3); x < 960 * .8; x++) {
        const offset = (y * 960 + x) * 4;
        run = green(values[offset], values[offset + 1], values[offset + 2]) ? run + 1 : 0; longest = Math.max(longest, run);
      }
      if (longest > 960 * .06) current = Math.max(current, longest);
      else if (current) { groups.push(current); current = 0; }
    }
    if (current) groups.push(current);
    expect(groups).toHaveLength(2); expect(groups[0] / groups[1]).toBeCloseTo(.5, 1);
  });

  it.each(kinds)('preserves the authored %s frame through splits and trims while keeping captions in a separate safe area', kind => {
    const template = createSceneTemplate(kind), original = shotSchema.parse({ id: 'original', title: '图解', narration: '', visualPrompt: '', sourceInUs: 0, durationUs: 4_000_000, sceneTemplate: template });
    const [, right] = splitShot(original, 2_000_000, { numerator: 30, denominator: 1 }, 'right');
    const trimmed = trimShot(original, { inUs: 1_000_000, outUs: 3_000_000 }, { numerator: 30, denominator: 1 });
    for (const [width, height] of sizes) {
      expect(frame(template, 700_000, width, height, { ...right, shotIndex: 2 }).toBuffer('image/png').equals(frame(template, 2_700_000, width, height).toBuffer('image/png'))).toBe(true);
      expect(frame(template, 700_000, width, height, trimmed).toBuffer('image/png').equals(frame(template, 1_700_000, width, height).toBuffer('image/png'))).toBe(true);
      const empty = frame(template, 4_000_000, width, height), captioned = frame(template, 4_000_000, width, height, { narration: '字幕仍然生效。' });
      const before = empty.getContext('2d').getImageData(0, 0, width, height).data, after = captioned.getContext('2d').getImageData(0, 0, width, height).data;
      let firstChanged = height;
      for (let offset = 0; offset < before.length; offset++) if (before[offset] !== after[offset]) { firstChanged = Math.floor(offset / 4 / width); break; }
      expect(firstChanged).toBeLessThan(height); expect(firstChanged).toBeGreaterThan(colored(empty).lastY);
    }
  });

  it('fits long editable headings and body content inside their actual Canvas clipping rectangles', () => {
    const heading = '需要在横屏竖屏和方形中完整显示的长标题'.repeat(8).slice(0, 160);
    for (const kind of kinds) {
      const template = createSceneTemplate(kind); template.heading = heading;
      if (template.kind === 'process') template.steps = Array.from({ length: 6 }, () => ({ title: '较长的流程步骤标题'.repeat(8).slice(0, 80), detail: '需要保留的详细解释文字。'.repeat(25).slice(0, 300) }));
      if (template.kind === 'comparison') for (const side of [template.left, template.right]) { side.title = '较长的比较标题'.repeat(10).slice(0, 80); side.points = Array.from({ length: 5 }, () => '可编辑的比较内容。'.repeat(20).slice(0, 180)); }
      if (template.kind === 'bar-chart') template.bars = Array.from({ length: 6 }, (_, index) => ({ label: '较长的数据标签'.repeat(12).slice(0, 80), value: index * 11 }));
      for (const [width, height] of [[1280, 720], [720, 1280], [960, 960]]) {
        const canvas = createCanvas(width, height), ctx = canvas.getContext('2d');
        let rectangle: { x: number; y: number; width: number; height: number } | undefined; const drawn: string[] = [];
        const nativeRect = ctx.rect.bind(ctx), nativeText = ctx.fillText.bind(ctx);
        const rectSpy = vi.spyOn(ctx, 'rect').mockImplementation((x, y, w, h) => { rectangle = { x, y, width: w, height: h }; nativeRect(x, y, w, h); });
        const textSpy = vi.spyOn(ctx, 'fillText').mockImplementation((value, x, y, maxWidth) => {
          if (ctx.textBaseline === 'top' && rectangle) {
            const size = Number(ctx.font.match(/\s([\d.]+)px/)?.[1]);
            expect(y + size * 1.3).toBeLessThanOrEqual(rectangle.y + rectangle.height + .1);
            expect(ctx.measureText(value).width).toBeLessThanOrEqual(rectangle.width + .1); drawn.push(value);
          }
          nativeText(value, x, y, maxWidth);
        });
        try { drawSceneFrame(canvas as unknown as HTMLCanvasElement, { title: '', narration: '', shotIndex: 0, profile: { ...DEFAULT_VIDEO_PROFILE, width, height }, durationUs: 4_000_000, sceneTemplate: { ...template, motion: 'none' } }, 0); }
        finally { rectSpy.mockRestore(); textSpy.mockRestore(); }
        expect(drawn.join('')).toContain(heading);
      }
    }
  });

  it('prioritizes the template over an associated image and tolerates unfinished editor values', () => {
    const template = createSceneTemplate('bar-chart');
    const image = createCanvas(640, 360); image.getContext('2d').fillStyle = '#ff0000'; image.getContext('2d').fillRect(0, 0, 640, 360);
    expect(frame(template, 1_000_000, 640, 360, { image: image as unknown as CanvasImageSource }).toBuffer('image/png').equals(frame(template, 1_000_000).toBuffer('image/png'))).toBe(true);
    if (template.kind !== 'bar-chart') throw new Error('wrong sample');
    expect(() => frame({ ...template, heading: '', bars: [{ label: '', value: -1 }, { label: '', value: NaN }] }, 1_000_000)).not.toThrow();
  });
});
