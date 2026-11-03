import { build } from 'esbuild';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

type PreviewMeasurement = { reads: number; paints: number; pixels: string; width: number; height: number; repairs: number[] };
declare global {
  interface Window {
    scenePreviewFixture: { change: (action: string) => Promise<void>; measure: () => PreviewMeasurement };
  }
}

// Compile the real component into an isolated browser fixture. No production
// entry point, component substitute or React implementation detail is involved.
const fixtureSource = `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { DEFAULT_CAPTION_STYLE, shotSchema } from '@video-quickly/contracts';
import { ScenePreview } from './src/components/ScenePreview';

let reads = 0, paints = 0;
const repairs = [0, 0];
const rate = { get numerator() { reads++; return 30; }, denominator: 1 };
const profile = { width: 640, height: 360, previewScale: 1, fitMode: 'contain', frameRate: rate };
const target = shotSchema.parse({ id: 'target', title: '当前镜头', narration: '当前镜头字幕', visualPrompt: '', durationUs: 2_000_000 });
const other = shotSchema.parse({ id: 'other', title: '另一个镜头', narration: '', visualPrompt: '', durationUs: 2_000_000 });
const source = { id: 'research', title: '资料', kind: 'text', content: 'alpha fact', sha256: 'a'.repeat(64), capturedAt: '2026-01-01T00:00:00.000Z' };
const claim = { id: 'claim', text: 'alpha', source: '资料', locator: '第一句', status: 'verified', evidence: [{ sourceId: source.id, sourceSha256: source.sha256, startOffset: 0, endOffset: 5, quote: 'alpha' }] };
let props = { project: { profile, workflow: { production: { mode: 'native-video', subtitleMode: 'script' } }, shots: [target, other], referenceDisplay: 'hidden', claims: [claim], researchSources: [source], captionStyle: { ...DEFAULT_CAPTION_STYLE } }, shot: target, shotIndex: 0, thumbnail: true, assets: [], onRepair: () => repairs[0]++ };
const root = createRoot(document.getElementById('fixture'));
const clearRect = CanvasRenderingContext2D.prototype.clearRect;
CanvasRenderingContext2D.prototype.clearRect = function (...args) { paints++; return clearRect.apply(this, args); };
function render() { flushSync(() => root.render(createElement(ScenePreview, props))); }
const settled = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
function replaceTarget(shot) { props = { ...props, shot, project: { ...props.project, shots: props.project.shots.map(value => value.id === shot.id ? shot : value) } }; }
window.scenePreviewFixture = {
  async change(action) {
    switch (action) {
      case 'other-title': props = { ...props, project: { ...props.project, shots: props.project.shots.map(shot => shot.id === 'other' ? { ...shot, title: '另一个标题' } : shot) } }; break;
      case 'own-title': replaceTarget({ ...props.shot, title: '已修改的当前标题' }); break;
      case 'numbers': props = { ...props, project: { ...props.project, referenceDisplay: 'numbers' } }; break;
      case 'other-reference': props = { ...props, project: { ...props.project, shots: props.project.shots.map(shot => shot.id === 'other' ? { ...shot, claimIds: ['claim'] } : shot) } }; break;
      case 'computed-footer': props = { ...props, project: { ...props.project, shots: undefined, referenceFooter: true } }; break;
      case 'computed-no-footer': props = { ...props, project: { ...props.project, shots: [props.shot, { ...other, claimIds: ['claim'] }], referenceFooter: false } }; break;
      case 'own-reference': replaceTarget({ ...props.shot, claimIds: ['claim'] }); break;
      case 'disputed': props = { ...props, project: { ...props.project, claims: props.project.claims.map(claim => ({ ...claim, status: 'disputed' })) } }; break;
      case 'source-replaced': props = { ...props, project: { ...props.project, researchSources: props.project.researchSources.map(source => ({ ...source, sha256: 'b'.repeat(64) })) } }; break;
      case 'caption-style': props = { ...props, project: { ...props.project, captionStyle: { ...props.project.captionStyle, textColor: '#ff0000', position: 'top' } } }; break;
      case 'small-profile': props = { ...props, project: { ...props.project, profile: { ...props.project.profile, width: 128, height: 72 } } }; break;
      case 'profile': props = { ...props, project: { ...props.project, profile: { ...props.project.profile, width: 360, height: 640 } } }; break;
      case 'clip': {
        const captionTrack = { timeBase: 'scene', alignment: 'manual', cues: [{ id: 'first', startUs: 0, endUs: 1_000_000, text: 'ALPHA' }, { id: 'second', startUs: 1_000_000, endUs: 4_000_000, text: 'BETA' }] };
        replaceTarget({ ...props.shot, narration: '', durationUs: 1_000_000, clipEdit: { planId: 'plan', inUs: 0, restoreInUs: 0, restoreDurationUs: 1_000_000 } });
        props = { ...props, thumbnail: false, project: { ...props.project, clipEditSources: [{ id: 'source', original: { durationUs: 4_000_000, captionTrack }, assetHashes: [] }], clipEditPlans: [{ id: 'plan', sourceId: 'source', spans: [{ id: 'span', durationUs: 2_000_000, originInUs: 0, sourceInUs: 0, audioInUs: 0, videoInUs: 0, sceneInUs: 0 }] }] } };
        break;
      }
      case 'clip-source': props = { ...props, project: { ...props.project, clipEditSources: props.project.clipEditSources.map(source => ({ ...source, original: { ...source.original, captionTrack: { ...source.original.captionTrack, cues: source.original.captionTrack.cues.map(cue => ({ ...cue, text: 'GAMMA ' + cue.text })) } } })) } }; break;
      case 'clip-plan': props = { ...props, project: { ...props.project, clipEditPlans: props.project.clipEditPlans.map(plan => ({ ...plan, spans: plan.spans.map(span => ({ ...span, originInUs: 1_000_000, sourceInUs: 1_000_000, audioInUs: 1_000_000, videoInUs: 1_000_000, sceneInUs: 1_000_000 })) })) } }; break;
      case 'missing-clip-source': props = { ...props, project: { ...props.project, clipEditSources: [] } }; break;
      case 'missing-image': replaceTarget({ ...props.shot, assetId: 'missing' }); props = { ...props, thumbnail: false }; break;
      case 'repair-handler': props = { ...props, onRepair: () => repairs[1]++ }; break;
      default: throw new Error('Unknown fixture action: ' + action);
    }
    render(); await settled();
  },
  measure() { const canvas = document.querySelector('canvas'); let hash = 2166136261; for (const value of canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data) hash = Math.imul(hash ^ value, 16777619); return { reads, paints, pixels: String(hash >>> 0), width: canvas.width, height: canvas.height, repairs: [...repairs] }; }
};
render();
`;

let bundle: string;
test.beforeAll(async () => {
  const result = await build({
    absWorkingDir: resolve('apps/desktop'), stdin: { contents: fixtureSource, resolveDir: resolve('apps/desktop'), sourcefile: 'scene-preview-fixture.ts' },
    bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"MODE":"browser-test","DEV":false}' },
  });
  bundle = result.outputFiles[0].text;
});

async function openFixture(page: Page) {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/__scene_preview_fixture.js', route => route.fulfill({ contentType: 'text/javascript', body: bundle }));
  await page.route('**/__scene_preview_fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>ScenePreview fixture</title><style>.scene-preview{display:block;width:420px;height:236px}.scene-preview canvas{display:block;width:100%;height:100%}</style><div id="fixture" style="display:block;width:640px;height:640px"></div><script type="module" src="/__scene_preview_fixture.js"></script>' }));
  await page.goto('/__scene_preview_fixture');
  await expect(page).toHaveTitle('ScenePreview fixture');
  await expect(page.locator('canvas')).toHaveAttribute('aria-label', '当前镜头 · 镜头预览');
  await expect.poll(() => page.evaluate(() => window.scenePreviewFixture.measure().paints)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
  return errors;
}
const measure = (page: Page) => page.evaluate(() => window.scenePreviewFixture.measure());
const change = (page: Page, action: string) => page.evaluate(action => window.scenePreviewFixture.change(action), action);

test('keeps an unchanged thumbnail out of renders when another shot title changes', async ({ page }, info) => {
  const errors = await openFixture(page), before = await measure(page);
  await change(page, 'other-title');
  const unrelated = await measure(page);
  await info.attach('unrelated-shot-render-boundary', { body: JSON.stringify({ before, unrelated }), contentType: 'application/json' });
  // Transparent frame-rate reads observe the actual component render. Canvas
  // paint counts alone would miss wasted renders whose effects already bail out.
  expect(unrelated.reads).toBe(before.reads);
  expect(unrelated.paints).toBe(before.paints);
  expect(unrelated.pixels).toBe(before.pixels);
  await change(page, 'own-title');
  await expect(page.locator('canvas')).toHaveAttribute('aria-label', '已修改的当前标题 · 镜头预览');
  const own = await measure(page);
  expect(own.reads).toBeGreaterThan(unrelated.reads);
  expect(own.paints).toBeGreaterThan(unrelated.paints);
  expect(own.pixels).not.toBe(unrelated.pixels);
  expect(errors).toEqual([]);
});

test('ignores retired citation data while invalidating caption style and profile in the real canvas', async ({ page }) => {
  const errors = await openFixture(page);
  await change(page, 'numbers'); await change(page, 'small-profile'); const noReferences = await measure(page);
  await change(page, 'other-reference'); const footer = await measure(page);
  expect(footer.pixels).toBe(noReferences.pixels);
  await change(page, 'own-reference'); const verified = await measure(page);
  expect(verified.pixels).toBe(footer.pixels);
  await change(page, 'disputed'); const disputed = await measure(page);
  expect(disputed.pixels).toBe(verified.pixels);
  await change(page, 'source-replaced'); const replaced = await measure(page);
  expect(replaced.pixels).toBe(disputed.pixels);
  await change(page, 'caption-style'); const styled = await measure(page);
  expect(styled.pixels).not.toBe(replaced.pixels);
  await change(page, 'profile'); const portrait = await measure(page);
  expect(portrait.height).toBeGreaterThan(portrait.width);
  expect(errors).toEqual([]);
});

test('invalidates shared clip sources and plans and exposes a removed source', async ({ page }) => {
  const errors = await openFixture(page);
  await change(page, 'clip'); const original = await measure(page);
  await change(page, 'clip-source'); const changedSource = await measure(page);
  expect(changedSource.pixels).not.toBe(original.pixels);
  await change(page, 'clip-plan'); const changedPlan = await measure(page);
  expect(changedPlan.pixels).not.toBe(changedSource.pixels);
  await change(page, 'missing-clip-source');
  await expect(page.getByRole('alert')).toContainText('镜头剪辑来源缺失');
  expect(errors).toEqual([]);
});

test('ignores both legacy global reference-footer projections and shot metadata', async ({ page }) => {
  const errors = await openFixture(page);
  await change(page, 'numbers'); await change(page, 'small-profile'); const empty = await measure(page);
  await change(page, 'computed-footer'); const footer = await measure(page);
  expect(footer.pixels).toBe(empty.pixels);
  expect(footer.reads).toBe(empty.reads);
  await change(page, 'computed-no-footer');
  expect((await measure(page)).pixels).toBe(empty.pixels);
  expect(errors).toEqual([]);
});

test('uses the latest repair callback while the same media error is visible', async ({ page }) => {
  const errors = await openFixture(page);
  await change(page, 'missing-image');
  await expect(page.getByRole('alert')).toContainText('未找到镜头图片素材');
  await page.getByRole('button', { name: '重新导入', exact: true }).click();
  expect((await measure(page)).repairs).toEqual([1, 0]);
  await change(page, 'repair-handler');
  await page.getByRole('button', { name: '重新导入', exact: true }).click();
  expect((await measure(page)).repairs).toEqual([1, 1]);
  expect(errors).toEqual([]);
});
