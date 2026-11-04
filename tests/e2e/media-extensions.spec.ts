import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { AssetRecord, ModelProfile, ProjectDocument, ShotCandidate } from '@video-quickly/contracts';
import { openProjectFromList } from './workspace-navigation';

const ffmpeg = process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }), body = await response.json();
  expect(body.error, JSON.stringify(body)).toBeUndefined(); return body.result;
}
function png(color = 'red'): Buffer {
  return execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=162x92,format=rgba,crop=161:91`, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], { windowsHide: true });
}
async function fixture(request: APIRequestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-media-extensions-')), path = join(directory, `grid-${randomUUID().slice(0, 6)}.png`), bytes = png();
  await writeFile(path, bytes);
  const asset = await rpc<AssetRecord>(request, 'asset.import', { path });
  let project = await rpc<ProjectDocument>(request, 'project.create', { title: `媒体扩展 ${randomUUID().slice(0, 7)}`, profile: { width: 160, height: 90, frameRate: { numerator: 30, denominator: 1 } } });
  project = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: [{ id: 'first', title: '木盒画面', narration: '你好，木盒。', visualPrompt: '原始画面', durationUs: 1_000_000, assetId: asset.id, animation: { transition: 'cut' } }] } });
  return { asset, bytes, project, directory, current: async () => (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project, close: () => rm(directory, { recursive: true, force: true }) };
}
async function open(page: Page, title: string) { await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/); await openProjectFromList(page, title); }
const viewports = [{ width: 1536, height: 960, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }];

for (const viewport of viewports) test(`previews and saves deterministic grid crops without rebinding the shot at ${viewport.width}px`, async ({ page, request }, info) => {
  const source = await fixture(request), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewportSize(viewport); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
    await page.goto('/'); await page.getByRole('button', { name: '素材库', exact: true }).click();
    await page.getByRole('button', { name: `网格切图“${source.asset.name}”`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '网格切图', exact: true });
    await expect(dialog.getByRole('combobox', { name: '网格行数', exact: true })).toBeEnabled();
    await expect(dialog.getByAltText('网格切图原图')).toBeVisible();
    await dialog.getByRole('combobox', { name: '网格列数', exact: true }).selectOption('3');
    await dialog.getByRole('button', { name: '保存 6 张切图', exact: true }).click();
    await expect(dialog.getByText('已保存 6 张切图，来源和像素区域已记录。', { exact: true })).toBeVisible();
    await expect(dialog.getByAltText(/^切图 \d+$/)).toHaveCount(6);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`image-grid-${viewport.width}.png`) });
    const crops = await rpc<AssetRecord[]>(request, 'image.cutGrid', { assetId: source.asset.id, rows: 2, columns: 3 });
    expect(crops.map(asset => [asset.width, asset.height])).toEqual([[53, 45], [54, 45], [54, 45], [53, 46], [54, 46], [54, 46]]);
    expect(crops.every(asset => asset.derivation?.sourceAssetId === source.asset.id && asset.derivation.sourceSha256 === source.asset.sha256)).toBe(true);
    expect(await source.current()).toEqual(source.project);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: `网格切图“${source.asset.name}”`, exact: true }).click();
    await dialog.getByRole('combobox', { name: '网格列数', exact: true }).selectOption('3');
    await dialog.getByRole('button', { name: '保存 6 张切图', exact: true }).click();
    await expect(dialog.getByText('已保存 6 张切图，来源和像素区域已记录。', { exact: true })).toBeVisible();
    expect((await rpc<AssetRecord[]>(request, 'image.cutGrid', { assetId: source.asset.id, rows: 2, columns: 3 })).map(asset => asset.id)).toEqual(crops.map(asset => asset.id));
    expect(errors).toEqual([]); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  } finally { await source.close(); }
});

for (const viewport of viewports) test(`generates a masked image candidate and applies it explicitly with undo at ${viewport.width}px`, async ({ page, request }, info) => {
  const source = await fixture(request), resultBytes = png('green'), calls: Array<{ path: string; source: Buffer; mask: Buffer; prompt: string }> = [], errors: string[] = [];
  const server = createServer((incoming, response) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks), form = await new Request('http://fixture/images/edits', { method: 'POST', headers: { 'content-type': incoming.headers['content-type'] ?? '' }, body }).formData();
    const image = form.get('image[]'), mask = form.get('mask');
    if (!(image instanceof File) || !(mask instanceof File)) throw new Error('missing multipart source or mask');
    calls.push({ path: incoming.url ?? '', source: Buffer.from(await image.arrayBuffer()), mask: Buffer.from(await mask.arrayBuffer()), prompt: String(form.get('prompt')) });
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ b64_json: resultBytes.toString('base64') }], usage: { input_tokens: 11, output_tokens: 5 } }));
  })().catch(error => { response.statusCode = 500; response.end(String(error)); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('image fixture');
  page.on('pageerror', error => errors.push(error.message));
  try {
    const model = await rpc<ModelProfile>(request, 'model.save', { model: { name: `局部改图 ${randomUUID().slice(0, 6)}`, provider: 'openai-compatible', connectionType: 'image', capabilities: ['image'], baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'fixture-image-edit' } });
    await page.setViewportSize(viewport); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme); await open(page, source.project.title);
    await page.getByRole('button', { name: 'AI 微调', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '镜头候选', exact: true });
    await dialog.getByRole('combobox', { name: '生成内容', exact: true }).selectOption('image');
    await dialog.getByRole('combobox', { name: '生成模型', exact: true }).selectOption(model.id);
    const enabled = dialog.getByRole('checkbox', { name: '局部改图：保留原图并修改选中区域', exact: true }); await expect(enabled).toBeEnabled(); await enabled.check();
    for (const [label, value] of [['左侧像素', '10'], ['顶部像素', '12'], ['区域宽度', '40'], ['区域高度', '30']]) await dialog.getByRole('spinbutton', { name: label, exact: true }).fill(value);
    await dialog.getByRole('textbox', { name: '本次调整要求', exact: true }).fill('将选中区域的木盒改成绿色');
    expect(await source.current()).toEqual(source.project); expect(calls).toHaveLength(0);
    await page.screenshot({ path: info.outputPath(`image-edit-region-${viewport.width}.png`) });
    await dialog.getByRole('button', { name: '生成候选', exact: true }).click(); await expect(dialog.getByAltText('候选画面')).toBeVisible();
    expect(calls).toHaveLength(1); expect(calls[0].path).toBe('/v1/images/edits'); expect(calls[0].source).toEqual(source.bytes); expect(calls[0].prompt).toContain('木盒改成绿色');
    const maskPath = join(source.directory, 'submitted-mask.png'); await writeFile(maskPath, calls[0].mask);
    const rgba = execFileSync(ffmpeg, ['-v', 'error', '-i', maskPath, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { windowsHide: true });
    expect(rgba[(12 * 161 + 10) * 4 + 3]).toBe(0); expect(rgba[(11 * 161 + 10) * 4 + 3]).toBe(255); expect(rgba[(42 * 161 + 50) * 4 + 3]).toBe(255);
    expect(await source.current()).toEqual(source.project);
    const candidates = await rpc<{ items: ShotCandidate[] }>(request, 'shot.candidates', { projectId: source.project.id, shotId: 'first' }); expect(candidates.items).toHaveLength(1);
    const frozen = await rpc<{ value: { node: { config: { imageEdit: { sourceAssetId: string; maskAssetId: string } } } } }>(request, 'run.step.payload', { runId: candidates.items[0].runId, nodeId: candidates.items[0].nodeId, kind: 'input' });
    expect(frozen.value.node.config.imageEdit.sourceAssetId).toBe(source.asset.id); expect(frozen.value.node.config.imageEdit.maskAssetId).toBeTruthy();
    await dialog.locator('.shot-regeneration__comparison').scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`image-edit-candidate-${viewport.width}.png`) });
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await dialog.getByRole('button', { name: '应用所选候选', exact: true }).click(); await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await source.current()).shots[0].assetId).toBe(candidates.items[0].shot.assetId);
    await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect.poll(async () => (await source.current()).shots[0].assetId).toBe(source.asset.id);
    expect(calls).toHaveLength(1); expect(errors).toEqual([]); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await source.close(); }
});

for (const viewport of viewports) test(`exports a local handoff and distinguishes a template-based experimental draft at ${viewport.width}px`, async ({ page, request }, info) => {
  const source = await fixture(request), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewportSize(viewport); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme); await open(page, source.project.title);
    await page.getByRole('button', { name: '导出', exact: true }).click();
    const parent = page.locator('.export-dialog');
    await parent.getByRole('tab', { name: '其他导出', exact: true }).click(); await parent.getByRole('button', { name: '剪映／CapCut 工程', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '剪映／CapCut 工程导出', exact: true });
    await dialog.getByRole('combobox', { name: '剪辑软件', exact: true }).selectOption('capcut');
    await dialog.getByRole('textbox', { name: '工程输出目录', exact: true }).fill(source.directory);
    await dialog.getByRole('button', { name: '导出剪辑交接包', exact: true }).click();
    await expect(dialog.getByText('剪辑交接包已导出 · 源修订 ' + source.project.revision, { exact: true })).toBeVisible();
    const output = await dialog.locator('.editor-project-export__path code').textContent(), manifest = JSON.parse(await readFile(join(output!, 'manifest.json'), 'utf8'));
    expect(manifest.output).toBe('handoff-only'); expect(manifest.compatibility.desktopImportVerified).toBe(false); expect(manifest.files.some((file: { path: string }) => file.path === 'draft_info.json')).toBe(false);
    expect(await source.current()).toEqual(source.project); expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await dialog.locator('.notice').first().evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`editor-handoff-${viewport.width}.png`) });
    const templatePath = join(source.directory, 'empty-draft.json');
    await writeFile(templatePath, JSON.stringify({ platform: { app_source: 'cc', app_version: '9.3.0', os: 'windows' }, tracks: [], materials: {} }));
    await dialog.getByRole('textbox', { name: '空草稿模板（可选）', exact: true }).fill(templatePath);
    await dialog.getByRole('button', { name: '导出实验性草稿', exact: true }).click();
    await expect(dialog.getByText('实验性草稿已导出 · 源修订 ' + source.project.revision, { exact: true })).toBeVisible();
    const draftDirectory = await dialog.locator('.editor-project-export__path code').textContent(), draft = JSON.parse(await readFile(join(draftDirectory!, 'draft_info.json'), 'utf8'));
    expect(draft.platform.app_version).toBe('9.3.0'); expect(draft.tracks.map((track: { type: string }) => track.type)).toEqual(['video', 'audio']);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await expect(dialog).toHaveCount(0); await expect(parent).toBeVisible();
    expect(errors).toEqual([]); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  } finally { await source.close(); }
});
