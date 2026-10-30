import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { AssetRecord, CaptionTrack, ProjectDocument } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  expect(response.ok()).toBe(true);
  const payload = await response.json(); expect(payload.error).toBeUndefined(); return payload.result;
}
async function createProject(request: APIRequestContext, title: string, captionTrack?: CaptionTrack) {
  const project = await rpc<ProjectDocument>(request, 'project.create', { title });
  return rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: [
    { id: 'caption-shot', title: '字幕编辑镜头', narration: '第一句旁白。第二句旁白。', visualPrompt: '', durationUs: 4_000_000, ...(captionTrack ? { captionTrack } : {}) },
    { id: 'caption-tail', title: '结尾镜头', narration: '', visualPrompt: '', durationUs: 2_000_000 },
  ] } });
}
async function savedProject(request: APIRequestContext, projectId: string) {
  return (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId })).project;
}
async function openProject(page: Page, title: string) {
  await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/);
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.locator('.project-card').filter({ hasText: title }).getByRole('button', { name: /继续创作/ }).click();
  await expect(page.getByLabel('镜头标题')).toHaveValue('字幕编辑镜头');
}
async function editor(page: Page) {
  await page.getByRole('button', { name: '编辑字幕', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑字幕', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '1');
  return dialog;
}
function observeErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  return errors;
}
async function expectHealthy(page: Page, errors: string[]) {
  await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
}
async function downloadSrt(page: Page) {
  await page.getByRole('button', { name: '导出', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '导出视频', exact: true });
  await dialog.getByRole('tab', { name: '其他导出', exact: true }).click();
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '导出字幕', exact: true }).click();
  const download = await pending; const path = await download.path();
  if (!path) throw new Error('字幕下载未产生文件');
  const text = await readFile(path, 'utf8');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click(); return text;
}

test('edits estimated captions through the production dialog as one undo command and restores them after reload', async ({ page, request }, info) => {
  const errors = observeErrors(page);
  const project = await createProject(request, '字幕编辑与恢复验收');
  await openProject(page, project.title);
  let dialog = await editor(page);
  await expect(dialog.getByText('当前字幕按旁白文字估时，尚未按语音对齐。')).toBeVisible();
  await expect(dialog.locator('.caption-editor__cue')).toHaveCount(2);
  await dialog.getByLabel('字幕 1 文字', { exact: true }).fill('取消的草稿');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect((await savedProject(request, project.id)).revision).toBe(project.revision);
  dialog = await editor(page);
  await expect(dialog.getByLabel('字幕 1 文字', { exact: true })).toHaveValue('第一句旁白。');
  await dialog.getByLabel('字幕 1 文字', { exact: true }).fill('校订后的第一句。');
  await dialog.getByLabel('字幕 1 出点（秒）', { exact: true }).fill('5');
  await expect(dialog.getByRole('button', { name: '应用字幕', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('alert')).toContainText('时间须在当前镜头范围内');
  await dialog.getByLabel('字幕 1 出点（秒）', { exact: true }).fill('1.4');
  await dialog.getByLabel('字幕 2 出点（秒）', { exact: true }).fill('3.5');
  await dialog.getByRole('button', { name: '定位字幕 2', exact: true }).click();
  await expect(page.locator('.timeline-ruler')).toHaveAttribute('aria-valuenow', '2000');
  await page.screenshot({ path: info.outputPath('caption-editor-dark-1536.png') });
  await dialog.getByRole('button', { name: '应用字幕', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await savedProject(request, project.id)).shots[0].captionTrack?.alignment).toBe('manual');
  const saved = await savedProject(request, project.id);
  expect(saved.revision).toBe(project.revision + 1);
  expect(saved.shots[0].captionTrack?.cues).toMatchObject([
    { startUs: 0, endUs: 1_400_000, text: '校订后的第一句。' },
    { startUs: 2_000_000, endUs: 3_500_000, text: '第二句旁白。' },
  ]);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots[0].captionTrack).toBeUndefined();
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots[0].captionTrack).toEqual(saved.shots[0].captionTrack);
  await page.reload();
  await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
  dialog = await editor(page);
  await expect(dialog.getByLabel('字幕 1 文字', { exact: true })).toHaveValue('校订后的第一句。');
  await expect(dialog.getByLabel('字幕 2 出点（秒）', { exact: true })).toHaveValue('3.5');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '浅色外观', exact: true }).click();
  await page.setViewportSize({ width: 600, height: 900 });
  await editor(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('caption-editor-light-600.png') });
  await expectHealthy(page, errors);
});

test('adds, sorts, splits and deletes caption cues locally before applying one edit', async ({ page, request }) => {
  const errors = observeErrors(page);
  const original: CaptionTrack = { timeBase: 'scene', alignment: 'manual', cues: [] };
  const project = await createProject(request, '字幕句段操作验收', original);
  await openProject(page, project.title);
  const dialog = await editor(page);
  await expect(dialog.locator('.caption-editor__cue')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '识别并对齐', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '添加字幕', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '应用字幕', exact: true })).toBeDisabled();
  await dialog.getByLabel('字幕 1 文字', { exact: true }).fill('新增字幕');
  await dialog.getByLabel('字幕 1 出点（秒）', { exact: true }).fill('2');
  await dialog.getByRole('button', { name: '添加字幕', exact: true }).click();
  await dialog.getByLabel('字幕 2 文字', { exact: true }).fill('后句字幕');
  await dialog.getByLabel('字幕 1 入点（秒）', { exact: true }).fill('2.5');
  await dialog.getByLabel('字幕 1 出点（秒）', { exact: true }).fill('3');
  await dialog.getByLabel('字幕 2 入点（秒）', { exact: true }).fill('0');
  await dialog.getByLabel('字幕 2 出点（秒）', { exact: true }).fill('1');
  await expect(dialog.getByRole('button', { name: '应用字幕', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '按时间排序', exact: true }).click();
  await expect(dialog.getByLabel('字幕 1 文字', { exact: true })).toHaveValue('后句字幕');
  await dialog.getByRole('button', { name: '拆分字幕 2', exact: true }).click();
  await expect(dialog.locator('.caption-editor__cue')).toHaveCount(3);
  await dialog.getByRole('button', { name: '删除字幕 3', exact: true }).click();
  await expect(dialog.locator('.caption-editor__cue')).toHaveCount(2);
  expect((await savedProject(request, project.id)).revision).toBe(project.revision);
  await dialog.getByRole('button', { name: '应用字幕', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots[0].captionTrack?.cues.length).toBe(2);
  expect((await savedProject(request, project.id)).revision).toBe(project.revision + 1);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots[0].captionTrack).toEqual(original);
  await expectHealthy(page, errors);
});

test('projects split captions, preserves hidden source cues during local edits, and exports explicit caption choices', async ({ page, request }) => {
  const errors = observeErrors(page);
  const original: CaptionTrack = { timeBase: 'source', alignment: 'manual', cues: [
    { id: 'crossing', startUs: 0, endUs: 1_500_000, text: '跨界字幕' },
    { id: 'later', startUs: 1_500_000, endUs: 4_000_000, text: '后半句' },
  ] };
  const project = await createProject(request, '分割字幕与源区间验收', original);
  await openProject(page, project.title);
  const ruler = page.getByRole('slider', { name: '预览播放位置', exact: true });
  await ruler.press('Home'); for (let index = 0; index < 3; index++) await ruler.press('Shift+ArrowRight');
  await page.getByRole('button', { name: '在播放头处分割镜头', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots.length).toBe(3);
  let dialog = await editor(page);
  await expect(dialog.getByLabel('字幕 1 入点（秒）', { exact: true })).toHaveValue('0');
  await expect(dialog.getByLabel('字幕 1 出点（秒）', { exact: true })).toHaveValue('0.5');
  await expect(dialog.getByLabel('字幕 2 入点（秒）', { exact: true })).toHaveValue('0.5');
  await dialog.getByLabel('字幕 1 文字', { exact: true }).fill('右侧修订');
  await dialog.getByRole('button', { name: '应用字幕', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots[1].captionTrack?.cues.length).toBe(3);
  const edited = await savedProject(request, project.id);
  expect(edited.shots[0].captionTrack).toEqual(original);
  expect(edited.shots[1].captionTrack?.cues).toMatchObject([
    { startUs: 0, endUs: 1_000_000, text: '跨界字幕' },
    { startUs: 1_000_000, endUs: 1_500_000, text: '右侧修订' },
    { startUs: 1_500_000, endUs: 4_000_000, text: '后半句' },
  ]);
  const srt = await downloadSrt(page);
  expect(srt).toContain('00:00:00,000 --> 00:00:01,000\n跨界字幕');
  expect(srt).toContain('00:00:01,000 --> 00:00:01,500\n右侧修订');
  expect(srt).toContain('00:00:01,500 --> 00:00:04,000\n后半句');
  await page.getByLabel('素材入点（秒）', { exact: true }).fill('0');
  await page.getByLabel('素材出点（秒）', { exact: true }).fill('4');
  await page.getByRole('button', { name: '应用入出点', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots[1].sourceInUs).toBe(0);
  dialog = await editor(page);
  await expect(dialog.locator('.caption-editor__cue')).toHaveCount(3);
  await expect(dialog.getByLabel('字幕 1 文字', { exact: true })).toHaveValue('跨界字幕');
  await expect(dialog.getByLabel('字幕 2 文字', { exact: true })).toHaveValue('右侧修订');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots[1].sourceInUs).toBe(1_000_000);
  dialog = await editor(page);
  await dialog.getByRole('button', { name: '关闭字幕', exact: true }).click();
  await dialog.getByRole('button', { name: '应用字幕', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots[1].captionTrack?.cues).toEqual([]);
  expect(await downloadSrt(page)).not.toContain('后半句');
  await expectHealthy(page, errors);
});

function fixtureWav() {
  const samples = 8000 * 4, bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) bytes.writeInt16LE(Math.round(Math.sin(index / 8000 * Math.PI * 880) * 6000), 44 + index * 2);
  return bytes;
}

test('uses actual timestamped ASR candidates without auto-applying them and rejects text-only results', async ({ page, request }, info) => {
  const errors = observeErrors(page);
  let textOnly = false; const requests: Array<{ path?: string; body: string }> = [];
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = []; incoming.on('data', chunk => chunks.push(chunk));
    incoming.on('end', () => {
      requests.push({ path: incoming.url, body: Buffer.concat(chunks).toString() });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(textOnly ? { text: '没有任何时间戳的纯文字' } : { segments: [
        { start: .2, end: .8, text: '识别的第一句。' }, { start: 1.2, end: 2, text: '识别的第二句。' },
      ] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('识别夹具服务未启动');
  try {
    const project = await createProject(request, '语音识别候选验收');
    const path = info.outputPath('fixture-voice.wav'); await writeFile(path, fixtureWav());
    const audio = await rpc<AssetRecord>(request, 'asset.import', { projectId: project.id, shotId: 'caption-shot', path, kind: 'audio' });
    const model = await rpc<{ id: string }>(request, 'model.save', { model: { name: '隔离的语音识别服务', provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'timestamp-fixture', capabilities: ['asr'] } });
    await openProject(page, project.title);
    let dialog = await editor(page);
    await dialog.getByLabel('语音识别模型', { exact: true }).selectOption(model.id);
    await dialog.getByRole('button', { name: '识别并对齐', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '使用候选', exact: true })).toBeVisible();
    expect((await savedProject(request, project.id)).shots[0].captionTrack).toBeUndefined();
    await dialog.getByRole('button', { name: '使用候选', exact: true }).click();
    await expect(dialog.getByLabel('字幕 1 入点（秒）', { exact: true })).toHaveValue('0.2');
    await expect(dialog.getByLabel('字幕 2 文字', { exact: true })).toHaveValue('识别的第二句。');
    await dialog.getByRole('button', { name: '应用字幕', exact: true }).click();
    await expect.poll(async () => (await savedProject(request, project.id)).shots[0].captionTrack?.alignment).toBe('speech');
    const saved = await savedProject(request, project.id);
    expect(saved.shots[0].captionTrack).toMatchObject({ timeBase: 'source', sourceAssetId: audio.id, sourceSha256: audio.sha256, modelId: model.id, cues: [{ startUs: 200_000, endUs: 800_000 }, { startUs: 1_200_000, endUs: 2_000_000 }] });
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(async () => (await savedProject(request, project.id)).shots[0].captionTrack).toBeUndefined();
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect.poll(async () => (await savedProject(request, project.id)).shots[0].captionTrack).toEqual(saved.shots[0].captionTrack);
    textOnly = true; dialog = await editor(page);
    await dialog.getByRole('button', { name: '识别并对齐', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('没有返回语音时间戳');
    await expect(dialog.getByRole('button', { name: '使用候选', exact: true })).toHaveCount(0);
    expect((await savedProject(request, project.id)).shots[0].captionTrack).toEqual(saved.shots[0].captionTrack);
    expect(requests).toHaveLength(2);
    expect(requests[0].path).toBe('/v1/audio/transcriptions');
    expect(requests[0].body).toContain('timestamp-fixture'); expect(requests[0].body).toContain('verbose_json');
    await expectHealthy(page, errors);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
