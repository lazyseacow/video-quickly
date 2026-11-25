import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

interface RowMeasurement { reads: Record<string, number>; outlinePixels: string; calls: Array<{ type: string; tag: number; args: unknown[] }> }
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
import ProjectOutline from './renderer/components/ProjectOutline';

const reads = {}, calls = [];
let tag = 1;
function observed(shot) { const title = shot.title; return { ...shot, get title() { reads[shot.id] = (reads[shot.id] ?? 0) + 1; return title; } }; }
let project = projectSchema.parse({ id: 'row-project', title: '真实行组件', brief: '', revision: 1, profile: { width: 128, height: 72, previewScale: 1, fitMode: 'contain', frameRate: { numerator: 30, denominator: 1 } }, shots: Array.from({ length: 6 }, (_, index) => ({ id: 'shot-' + index, title: '镜头 ' + index, narration: '需要留白的字幕', visualPrompt: '', durationUs: 2_000_000 })), workflow: { id: 'workflow', version: 1, name: '流程', production: { mode: 'native-video', subtitleMode: 'script' }, nodes: [{ id: 'script', kind: 'script', label: '脚本' }], edges: [] }, claims: [{ id: 'claim', text: '资料', source: '人工', status: 'pending' }], captionStyle: { ...DEFAULT_CAPTION_STYLE }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archived: false });
project = { ...project, shots: project.shots.map(observed) };
const assets = [], selectedIds = ['shot-0'];
const root = createRoot(document.getElementById('fixture'));
const asyncNoop = async () => {};
function render() {
  const capturedTag = tag;
  const onSelect = (...args) => { calls.push({ type: 'select', tag: capturedTag, args }); };
  flushSync(() => root.render(createElement('div', { className: 'workspace-shell workbench', style: { height: '900px' } },
    createElement('aside', { className: 'story-panel', style: { width: '280px', height: '500px' } }, createElement(ProjectOutline, { project, assets, selectedShotId: 'shot-0', selectedIds, onSelectShot: onSelect, onAddShot: asyncNoop }))
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
  measure() { return { reads: { ...reads }, outlinePixels: pixels('.outline-shot:nth-child(2) canvas'), calls: [...calls] }; }
};
render();
`;

let bundle: string, styles: string[];
test.beforeAll(async () => {
  const result = await build({ absWorkingDir: resolve('src'), stdin: { contents: fixtureSource, resolveDir: resolve('src'), sourcefile: 'editor-row-fixture.ts' }, bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"MODE":"browser-test","DEV":false}' } });
  bundle = result.outputFiles[0].text;
  const html = await readFile(resolve('src/.generated/browser-preview/index.html'), 'utf8');
  styles = [...html.matchAll(/<link\b[^>]*\bhref="([^"]+\.css)"[^>]*>/g)].map(match => match[1].replace(/^\//, ''));
  expect(styles.length, 'The built browser entry must declare its production styles.').toBeGreaterThan(0);
});

async function openFixture(page: Page) {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/__editor_row_fixture.js', route => route.fulfill({ contentType: 'text/javascript', body: bundle }));
  await page.route('**/__editor_row_fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Editor row fixture</title>${styles.map(path => `<link rel="stylesheet" href="/${path}">`).join('')}<body class="theme-dark"><div id="fixture" style="width:1400px;height:930px"></div><script type="module" src="/__editor_row_fixture.js"></script></body>` }));
  await page.goto('/__editor_row_fixture');
  await expect(page).toHaveTitle('Editor row fixture'); expect(errors).toEqual([]); await expect(page.locator('.outline-shot')).toHaveCount(6);
  await expect(page.locator('.story-panel').getByRole('region', { name: '镜头列表', exact: true })).toBeVisible(); await expect(page.locator('.story-panel').getByRole('tab')).toHaveCount(0);
  await expect.poll(() => page.locator('.outline-shot').nth(1).locator('canvas').evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBe(128);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(errors).toEqual([]); return errors;
}
const measure = (page: Page) => page.evaluate(() => window.editorRowFixture.measure());
const change = (page: Page, action: string) => page.evaluate(action => window.editorRowFixture.change(action), action);
const reset = (page: Page) => page.evaluate(() => window.editorRowFixture.reset());

for (const references of [false, true]) test(`skips unchanged storyboard cards after another title changes (reference numbers: ${references})`, async ({ page }, info) => {
  const errors = await openFixture(page);
  if (references) await change(page, 'numbers');
  const before = await measure(page); await reset(page); await change(page, 'other-title'); const after = await measure(page);
  await info.attach('row-render-boundary', { body: JSON.stringify({ references, before, after }), contentType: 'application/json' });
  expect(after.reads['shot-1']).toBe(0);
  expect(after.outlinePixels).toBe(before.outlinePixels);
  await change(page, 'own-title');
  await expect(page.locator('.outline-shot').nth(1)).toContainText('当前行的新标题');
  expect((await measure(page)).reads['shot-1']).toBeGreaterThan(0); expect(errors).toEqual([]);
});

test('keeps legacy references inert while refreshing storyboard captions', async ({ page }) => {
  const errors = await openFixture(page); await change(page, 'numbers'); const empty = await measure(page);
  await change(page, 'last-reference'); const footer = await measure(page);
  expect(footer.outlinePixels).toBe(empty.outlinePixels);
  await change(page, 'no-last-reference'); const cleared = await measure(page);
  expect(cleared.outlinePixels).toBe(empty.outlinePixels);
  await change(page, 'caption-style'); const styled = await measure(page);
  expect(styled.outlinePixels).not.toBe(cleared.outlinePixels);
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
