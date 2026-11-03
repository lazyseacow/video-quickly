import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

interface RowMeasurement { reads: Record<string, number>; outlinePixels: string; timelinePixels: string; calls: Array<{ type: string; tag: number; args: unknown[] }> }
declare global {
  interface Window { editorRowFixture: { change(action: string): Promise<void>; reset(): void; measure(): RowMeasurement } }
}

// Real production components, with transparent authored-title getters observing
// work in unchanged rows. No comparator or React implementation is called here.
const fixtureSource = `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { projectSchema, DEFAULT_CAPTION_STYLE } from '@video-quickly/contracts';
import { buildTimeline } from '@video-quickly/video';
import ProjectOutline from './src/components/ProjectOutline';
import Timeline from './src/components/Timeline';
import { PlaybackClock } from './src/lib/playback';

const reads = {}, calls = [];
let tag = 1;
function observed(shot) { const title = shot.title; return { ...shot, get title() { reads[shot.id] = (reads[shot.id] ?? 0) + 1; return title; } }; }
let project = projectSchema.parse({ id: 'row-project', title: '真实行组件', brief: '', revision: 1, profile: { width: 128, height: 72, previewScale: 1, fitMode: 'contain', frameRate: { numerator: 30, denominator: 1 } }, shots: Array.from({ length: 6 }, (_, index) => ({ id: 'shot-' + index, title: '镜头 ' + index, narration: '需要留白的字幕', visualPrompt: '', durationUs: 2_000_000 })), workflow: { id: 'workflow', version: 1, name: '流程', production: { mode: 'native-video', subtitleMode: 'script' }, nodes: [{ id: 'script', kind: 'script', label: '脚本' }], edges: [] }, claims: [{ id: 'claim', text: '资料', source: '人工', status: 'pending' }], captionStyle: { ...DEFAULT_CAPTION_STYLE }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archived: false });
project = { ...project, shots: project.shots.map(observed) };
const clock = new PlaybackClock(12_000_000, project.profile.frameRate);
const assets = [], selectedIds = ['shot-0'];
const root = createRoot(document.getElementById('fixture'));
const asyncNoop = async () => {};
function render() {
  const capturedTag = tag;
  const onSelect = (...args) => { calls.push({ type: 'select', tag: capturedTag, args }); };
  flushSync(() => root.render(createElement('div', { className: 'workbench', style: { height: '900px' } },
    createElement('aside', { className: 'story-panel', style: { width: '280px', height: '500px' } }, createElement(ProjectOutline, { project, assets, selectedShotId: 'shot-0', selectedIds, onSelectShot: onSelect, onAddShot: asyncNoop })),
    createElement(Timeline, { project, assets, shots: project.shots, timeline: buildTimeline(project.shots), selectedId: 'shot-0', selectedIds, rate: project.profile.frameRate, clock, sourceDurationUs: 10_000_000, sourceStatus: 'ready', editingDisabled: false, onSelect, onMove: asyncNoop, onDuplicate: asyncNoop, onRemove: asyncNoop, onSplit: asyncNoop, onReorder: async (...args) => { calls.push({ type: 'reorder', tag: capturedTag, args }); }, onTrim: async (...args) => { calls.push({ type: 'trim', tag: capturedTag, args }); } })
  )));
}
const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
function replace(id, patch) { project = { ...project, shots: project.shots.map(shot => shot.id === id ? observed({ ...shot, ...patch }) : shot) }; }
function pixels(selector) { const canvas = document.querySelector(selector); let hash = 2166136261; for (const value of canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data) hash = Math.imul(hash ^ value, 16777619); return String(hash >>> 0); }
window.editorRowFixture = {
  async change(action) {
    switch (action) {
      case 'other-title': replace('shot-5', { title: '其他镜头的新标题' }); break;
      case 'own-title': replace('shot-1', { title: '当前行的新标题' }); break;
      case 'numbers': project = { ...project, referenceDisplay: 'numbers' }; break;
      case 'last-reference': replace('shot-5', { claimIds: ['claim'] }); break;
      case 'no-last-reference': replace('shot-5', { claimIds: [] }); break;
      case 'caption-style': project = { ...project, captionStyle: { ...project.captionStyle, textColor: '#ff0000', position: 'top' } }; break;
      case 'callbacks-and-revision': tag++; project = { ...project, revision: project.revision + 1 }; break;
      default: throw new Error('Unknown row action: ' + action);
    }
    render(); await settle();
  },
  reset() { for (const id of Object.keys(reads)) reads[id] = 0; calls.length = 0; },
  measure() { return { reads: { ...reads }, outlinePixels: pixels('.outline-shot:nth-child(2) canvas'), timelinePixels: pixels('.timeline-clip--video:nth-child(2) canvas'), calls: [...calls] }; }
};
render();
`;

let bundle: string, styles: string[];
test.beforeAll(async () => {
  const result = await build({ absWorkingDir: resolve('apps/desktop'), stdin: { contents: fixtureSource, resolveDir: resolve('apps/desktop'), sourcefile: 'editor-row-fixture.ts' }, bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"MODE":"browser-test","DEV":false}' } });
  bundle = result.outputFiles[0].text;
  const manifest = JSON.parse(await readFile(resolve('apps/desktop/.generated/browser-preview/.vite/manifest.json'), 'utf8'));
  styles = manifest['index.html'].css;
});

async function openFixture(page: Page) {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/__editor_row_fixture.js', route => route.fulfill({ contentType: 'text/javascript', body: bundle }));
  await page.route('**/__editor_row_fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Editor row fixture</title>${styles.map(path => `<link rel="stylesheet" href="/${path}">`).join('')}<body class="theme-dark"><div id="fixture" style="width:1400px;height:930px"></div><script type="module" src="/__editor_row_fixture.js"></script></body>` }));
  await page.goto('/__editor_row_fixture');
  await expect(page).toHaveTitle('Editor row fixture'); expect(errors).toEqual([]); await expect(page.locator('.outline-shot')).toHaveCount(6);
  await expect(page.locator('.story-panel').getByRole('region', { name: '镜头列表', exact: true })).toBeVisible(); await expect(page.locator('.story-panel .outline-header')).toHaveCount(0); await expect(page.locator('.story-panel').getByRole('tab')).toHaveCount(0);
  await expect.poll(() => page.locator('.outline-shot').nth(1).locator('canvas').evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBe(128);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(errors).toEqual([]); return errors;
}
const measure = (page: Page) => page.evaluate(() => window.editorRowFixture.measure());
const change = (page: Page, action: string) => page.evaluate(action => window.editorRowFixture.change(action), action);
const reset = (page: Page) => page.evaluate(() => window.editorRowFixture.reset());

for (const references of [false, true]) test(`skips unchanged outline and timeline rows after another title changes (reference numbers: ${references})`, async ({ page }, info) => {
  const errors = await openFixture(page);
  if (references) await change(page, 'numbers');
  const before = await measure(page); await reset(page); await change(page, 'other-title'); const after = await measure(page);
  await info.attach('row-render-boundary', { body: JSON.stringify({ references, before, after }), contentType: 'application/json' });
  expect(after.reads['shot-1']).toBe(0);
  expect(after.outlinePixels).toBe(before.outlinePixels); expect(after.timelinePixels).toBe(before.timelinePixels);
  await change(page, 'own-title');
  await expect(page.locator('.outline-shot').nth(1)).toContainText('当前行的新标题');
  await expect(page.locator('.timeline-clip--video').nth(1)).toContainText('当前行的新标题');
  expect((await measure(page)).reads['shot-1']).toBeGreaterThan(0); expect(errors).toEqual([]);
});

test('keeps legacy references inert while refreshing changed caption styles in outline and timeline', async ({ page }) => {
  const errors = await openFixture(page); await change(page, 'numbers'); const empty = await measure(page);
  await change(page, 'last-reference'); const footer = await measure(page);
  expect(footer.outlinePixels).toBe(empty.outlinePixels); expect(footer.timelinePixels).toBe(empty.timelinePixels);
  await change(page, 'no-last-reference'); const cleared = await measure(page);
  expect(cleared.outlinePixels).toBe(empty.outlinePixels); expect(cleared.timelinePixels).toBe(empty.timelinePixels);
  await change(page, 'caption-style'); const styled = await measure(page);
  expect(styled.outlinePixels).not.toBe(cleared.outlinePixels); expect(styled.timelinePixels).not.toBe(cleared.timelinePixels);
  expect(errors).toEqual([]);
});

test('dispatches the latest selection callback without rerendering an unchanged row', async ({ page }) => {
  const errors = await openFixture(page); await reset(page); await change(page, 'callbacks-and-revision');
  expect((await measure(page)).reads['shot-1']).toBe(0);
  await page.locator('.outline-shot').nth(1).click({ modifiers: ['Shift'] });
  const calls = (await measure(page)).calls;
  expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ type: 'select', tag: 2, args: ['shot-1', { range: true }] });
  expect(errors).toEqual([]);
});

test('keeps pointer capture and uses the latest reorder and trim callbacks with the current revision', async ({ page }) => {
  const errors = await openFixture(page); await change(page, 'callbacks-and-revision');
  const button = page.locator('.timeline-clip--video').first().locator('.timeline-clip__select');
  const bounds = await button.boundingBox(); expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2); await page.mouse.down(); await page.mouse.move(bounds!.x + bounds!.width / 2 + 60, bounds!.y + bounds!.height / 2); await page.mouse.up();
  await expect.poll(async () => (await measure(page)).calls.some(call => call.type === 'reorder')).toBe(true);
  const reorder = (await measure(page)).calls.find(call => call.type === 'reorder');
  expect(reorder).toMatchObject({ tag: 2 }); expect(reorder!.args[2]).toBe(2);
  const out = page.getByRole('slider', { name: '镜头出点', exact: true }); await expect(out).toBeVisible(); await out.press('ArrowRight');
  await expect.poll(async () => (await measure(page)).calls.some(call => call.type === 'trim')).toBe(true);
  const trim = (await measure(page)).calls.find(call => call.type === 'trim');
  expect(trim).toMatchObject({ tag: 2 }); expect(trim!.args[3]).toBe(2);
  expect(errors).toEqual([]);
});
