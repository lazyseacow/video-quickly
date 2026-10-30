import { describe, expect, it } from 'vitest';
import { DEFAULT_VIDEO_PROFILE, motionKeyframesSchema, projectSchema, shotSchema } from '@video-quickly/contracts';
import { createCanvas } from '@napi-rs/canvas';
import { drawSceneFrame } from '../src/index.js';
import { sampleMotion, motionSceneTimeUs, motionLocalTimeUs } from '../src/keyframes.js';
import { splitShot, trimShot } from '../src/editing.js';
import { deleteShotRanges } from '../src/clip-edits.js';

const animation = { panX: .2, panY: -.1, zoom: 1.5, transition: 'cut' as const,
  keyframes: [{ id: 'a', timeUs: 0, panX: 0, panY: 0, zoom: 1, easing: 'linear' as const }, { id: 'b', timeUs: 4_000_000, panX: .4, panY: -.2, zoom: 2, easing: 'linear' as const }] };
const shot = () => shotSchema.parse({ id: 'shot', title: '镜头', narration: '', visualPrompt: '', durationUs: 4_000_000, animation });

describe('authored motion keyframes', () => {
  it('interpolates original scene microseconds and holds both endpoints', () => {
    expect(sampleMotion(animation, -1, 4_000_000)).toEqual({ panX: 0, panY: 0, zoom: 1 });
    expect(sampleMotion(animation, 2_000_000, 4_000_000)).toEqual({ panX: .2, panY: -.1, zoom: 1.5 });
    expect(sampleMotion(animation, 9_000_000, 4_000_000)).toEqual({ panX: .4, panY: -.2, zoom: 2 });
  });
  it('supports hold, polynomial and time-correct custom Bezier easing', () => {
    const at = (easing: 'hold' | 'ease-in' | 'ease-out' | 'smoothstep' | 'cubic-bezier', curve?: [number, number, number, number]) => sampleMotion({ ...animation, keyframes: [{ ...animation.keyframes[0], easing, curve }, animation.keyframes[1]] }, 1_000_000, 4_000_000).zoom;
    expect(at('hold')).toBe(1); expect(at('ease-in')).toBeCloseTo(1.0625); expect(at('ease-out')).toBeCloseTo(1.4375); expect(at('smoothstep')).toBeCloseTo(1.15625);
    expect(at('cubic-bezier', [0, 0, 1, 1])).toBeCloseTo(1.25, 6);
    expect(at('cubic-bezier', [.42, 0, 1, 1])).toBeLessThan(1.25);
  });
  it('retains legacy smoothstep motion without adding stored defaults', () => {
    const { keyframes: _, ...legacy } = animation;
    expect(sampleMotion(legacy, 2_000_000, 4_000_000)).toEqual({ panX: .1, panY: -.05, zoom: 1.25 });
    expect(shotSchema.parse({ ...shot(), animation: legacy }).animation).not.toHaveProperty('keyframes');
  });
  it('rejects unsorted, duplicate, non-finite and incomplete custom curves', () => {
    expect(motionKeyframesSchema.safeParse([...animation.keyframes].reverse()).success).toBe(false);
    expect(motionKeyframesSchema.safeParse([animation.keyframes[0], { ...animation.keyframes[1], timeUs: 0 }]).success).toBe(false);
    expect(motionKeyframesSchema.safeParse([{ ...animation.keyframes[0], zoom: NaN }]).success).toBe(false);
    expect(motionKeyframesSchema.safeParse([{ ...animation.keyframes[0], easing: 'cubic-bezier' }]).success).toBe(false);
  });
  it('preserves animation phase through split, trim and noncontinuous deletion', () => {
    const original = shot(); const rate = DEFAULT_VIDEO_PROFILE.frameRate;
    const [left, right] = splitShot(original, 2_000_000, rate, 'right');
    expect(motionSceneTimeUs(right, {}, 500_000)).toBe(2_500_000);
    expect(sampleMotion(right.animation, motionSceneTimeUs(right, {}, 500_000), right.sceneDurationUs!)).toEqual(sampleMotion(animation, 2_500_000, 4_000_000));
    const trimmed = trimShot(right, { inUs: 2_500_000, outUs: 4_000_000 }, rate);
    expect(motionSceneTimeUs(trimmed, {}, 0)).toBe(2_500_000);
    const project = projectSchema.parse({ id: 'p', title: 'project', brief: '', revision: 1, profile: DEFAULT_VIDEO_PROFILE, workflow: { id: 'w', name: 'w', version: 1, nodes: [{ id: 'n', kind: 'review', label: 'n' }], edges: [] }, shots: [original], createdAt: '', updatedAt: '' });
    let id = 0; const cut = deleteShotRanges(project, original.id, [{ startUs: 1_000_000, endUs: 2_000_000 }], rate, [], () => `id-${++id}`);
    expect(motionSceneTimeUs(cut.shots[0], cut, 1_500_000)).toBe(2_500_000);
    expect(motionLocalTimeUs(cut.shots[0], cut, 2_500_000)).toBe(1_500_000);
    expect(motionLocalTimeUs(cut.shots[0], cut, 1_500_000)).toBeUndefined();
    expect(left.animation.keyframes).toEqual(right.animation.keyframes);
  });
  it('draws transformed media with the same sampled pose instead of resetting after split', () => {
    const image = createCanvas(120, 80), ctx = image.getContext('2d'); ctx.fillStyle = 'red'; ctx.fillRect(0, 0, 60, 80); ctx.fillStyle = 'blue'; ctx.fillRect(60, 0, 60, 80);
    const profile = { ...DEFAULT_VIDEO_PROFILE, width: 120, height: 80, fitMode: 'cover' as const };
    const [_, right] = splitShot(shot(), 2_000_000, profile.frameRate, 'right');
    const paint = (value: ReturnType<typeof shot>, timeUs: number) => { const target = createCanvas(120, 80); drawSceneFrame(target as unknown as HTMLCanvasElement, { ...value, title: '', shotIndex: 0, profile, image: image as unknown as CanvasImageSource }, timeUs); return target.getContext('2d').getImageData(0, 0, 120, 80).data; };
    expect(paint(right, 500_000)).toEqual(paint(shot(), 2_500_000));
  });
});
