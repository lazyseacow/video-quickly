import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { expect, it } from 'vitest';
import { DEFAULT_CAPTION_STYLE, DEFAULT_VIDEO_PROFILE, createSceneTemplate, effectiveCaptionStyle, shotSchema, timeAtFrame, type CaptionStyle } from '@video-quickly/contracts';
import { captionBox, captionFontFamily, captionPages, createSubtitleCues, drawSceneFrame, resolveCaptionLayout, safeCaptionStyle, selectCaptionFont } from '../src/index.js';
import { createCaptionAss, escapeAssText } from '../src/caption-ass.js';
import { splitShot } from '../src/editing.js';

const style: CaptionStyle = { ...DEFAULT_CAPTION_STYLE, fontSizeRatio: .05, textColor: '#00FF00', backgroundColor: '#112233' };
const rate = { numerator: 30_000, denominator: 1001 };
const shot = () => shotSchema.parse({ id: 'styled', title: 'Styled', narration: '', visualPrompt: '', durationUs: 4_000_000, captionTrack: { timeBase: 'scene', alignment: 'manual', cues: [{ id: 'original', startUs: 0, endUs: 4_000_000, text: '字幕风格 ABCDEFG' }] } });
function frame(value: CaptionStyle | undefined, options: { width?: number; height?: number; text?: string; template?: boolean; referenceFooter?: boolean } = {}) {
  const width = options.width ?? 640, height = options.height ?? 360, canvas = createCanvas(width, height), image = createCanvas(width, height);
  image.getContext('2d').fillStyle = '#ffffff'; image.getContext('2d').fillRect(0, 0, width, height);
  const original = { title: '', narration: '', durationUs: 4_000_000, captionTrack: { timeBase: 'scene' as const, alignment: 'manual' as const, cues: [{ id: 'original', startUs: 0, endUs: 4_000_000, text: options.text ?? '字幕风格 ABCDEFG' }] } };
  drawSceneFrame(canvas as unknown as HTMLCanvasElement, { ...original, captionStyle: value, sceneTemplate: options.template ? { ...createSceneTemplate('comparison'), motion: 'none' } : undefined, image: image as unknown as CanvasImageSource, referenceFooter: options.referenceFooter, shotIndex: 0, profile: { ...DEFAULT_VIDEO_PROFILE, width, height } }, 1_000_000);
  return canvas;
}

it('resolves inheritance without changing original caption tracks and previews unfinished style input safely', () => {
  expect(effectiveCaptionStyle({ captionStyle: style }, { captionStyle: null })).toEqual(style);
  expect(effectiveCaptionStyle({ captionStyle: style }, { captionStyle: { ...style, fontWeight: 700 } })?.fontWeight).toBe(700);
  expect(resolveCaptionLayout(1280, 720).legacy).toBe(true); expect(safeCaptionStyle(null)).toBeUndefined();
  const unfinished = { ...style, fontSizeRatio: NaN, textColor: '' };
  expect(safeCaptionStyle(unfinished)).toEqual(DEFAULT_CAPTION_STYLE); expect(() => frame(unfinished)).not.toThrow();
  const original = shot(), before = structuredClone(original);
  const [left, right] = splitShot({ ...original, captionStyle: style }, 2_000_000, { numerator: 30, denominator: 1 }, 'right');
  expect(left.captionTrack).toBe(original.captionTrack); expect(right.captionTrack).toBe(original.captionTrack); expect(original).toEqual(before);
});

it('uses controlled host font families and renders distinct serif, bold, colors and background opacity', () => {
  expect(captionFontFamily('serif')).toContain('Songti SC');
  expect(selectCaptionFont('sans', family => GlobalFonts.has(family))).not.toContain(',');
  expect(selectCaptionFont('serif', () => false)).toBe('serif');
  expect(frame(style).toBuffer('image/png').equals(frame({ ...style, fontId: 'serif' }).toBuffer('image/png'))).toBe(false);
  expect(frame(style).toBuffer('image/png').equals(frame({ ...style, fontWeight: 700 }).toBuffer('image/png'))).toBe(false);
  const layout = resolveCaptionLayout(640, 360, style), box = captionBox(layout, 1);
  const pixel = (opacity: number) => frame({ ...style, backgroundOpacity: opacity }).getContext('2d').getImageData(Math.ceil(box.x + 4), Math.floor(box.y + box.height / 2), 1, 1).data;
  expect([...pixel(0)].slice(0, 3)).toEqual([255, 255, 255]); expect([...pixel(1)].slice(0, 3)).toEqual([17, 34, 51]);
  expect(pixel(.5)[0]).toBeGreaterThan(120); expect(pixel(.5)[0]).toBeLessThan(150);
});

it.each([[640, 360], [360, 640], [480, 480], [64, 64]])('keeps top and bottom reading pages, diagram content and reference footer apart at %i×%i', (width, height) => {
  for (const position of ['top', 'bottom'] as const) {
    const value = { ...style, position, fontSizeRatio: .09, maxLines: 3 } as const, layout = resolveCaptionLayout(width, height, value, { template: true, referenceFooter: true });
    const box = captionBox(layout, layout.maxLines);
    if (position === 'top') expect(box.y + box.height).toBeLessThan(layout.diagramTop);
    else expect(layout.diagramBottom).toBeLessThan(box.y);
    expect(layout.diagramBottom).toBeGreaterThan(layout.diagramTop);
    const text = '每条原始字幕保留真实时间，页面仅按阅读量切换。'.repeat(10);
    const ctx = createCanvas(width, height).getContext('2d'); ctx.font = layout.font;
    const pages = captionPages(text, line => ctx.measureText(line).width, layout.textWidth, layout.maxLines);
    expect(pages.length).toBeGreaterThan(1); expect(pages.every(page => page.length <= value.maxLines)).toBe(true); expect(pages.flat().join('')).toBe(text);
    expect(() => frame(value, { width, height, text, template: true, referenceFooter: true })).not.toThrow();
  }
});

it('merges adjacent split pages only when their effective styles are equal by value', () => {
  const original = { ...shot(), captionStyle: style }, [left, right] = splitShot(original, 2_000_000, { numerator: 30, denominator: 1 }, 'right');
  const pages = (text: string) => [[text]];
  expect(createSubtitleCues([left, right], pages)).toHaveLength(1);
  const reordered = Object.fromEntries(Object.entries(style).reverse()) as CaptionStyle;
  expect(createSubtitleCues([left, { ...right, captionStyle: reordered }], pages)).toHaveLength(1);
  expect(createSubtitleCues([{ ...left, captionStyle: undefined }, { ...right, captionStyle: null }], pages)).toHaveLength(1);
  const different = createSubtitleCues([left, { ...right, captionStyle: { ...style, textColor: '#FF0000' } }], pages);
  expect(different).toHaveLength(2); expect(different.map(cue => [cue.startUs, cue.endUs])).toEqual([[0, 2_000_000], [2_000_000, 4_000_000]]);
});

it('treats Windows and standalone carriage returns as line breaks before enforcing the styled page line limit', () => {
  expect(captionPages('A\r\nB\rC', text => text.length, 100, 2)).toEqual([['A', 'B'], ['C']]);
});

it('keeps literal ASS syntax inert and emits controlled per-event styles with frame-accurate visibility', () => {
  const raw = '{\\pos(0,0)\\fs999} \\N \\h';
  expect(escapeAssText(raw)).toBe('\\{\\\u2060pos(0,0)\\\u2060fs999\\} \\\u2060N \\\u2060h');
  const layout = resolveCaptionLayout(640, 360, style);
  const output = createCaptionAss([{ startUs: 1_301_301, endUs: 1_600_000, lines: [raw], layout, fontName: 'Controlled Sans' }, { startUs: 2_000_000, endUs: 3_000_000, lines: ['Different'], layout: resolveCaptionLayout(640, 360, { ...style, fontId: 'serif', fontWeight: 700, position: 'top' }), fontName: 'Controlled Serif' }], 640, 360, rate);
  expect(output).toContain('PlayResX: 640'); expect(output).toContain('Controlled Serif'); expect(output).toContain('Controlled Sans'); expect(output).not.toContain('{\\pos(0,0)');
  expect(output).toContain('\\fade(255,0,255,4,4,271,271)'); expect(output).toContain('0:00:01.33,0:00:01.61');
  expect(output.match(/^Dialogue: /gm)).toHaveLength(4);
});

it('uses the same persisted fractional-frame boundary as Canvas captions', () => {
  const startUs = timeAtFrame(1, rate), endUs = timeAtFrame(3, rate);
  const output = createCaptionAss([{ startUs, endUs, lines: ['BOUNDARY'], layout: resolveCaptionLayout(640, 360), fontName: 'Arial' }], 640, 360, rate);
  expect(output).toContain('0:00:00.03,0:00:00.10');
  expect(output).toContain('\\fade(255,0,255,3,3,70,70)');
  expect(output).not.toContain('\\fade(255,0,255,6,6,40,40)');
});
