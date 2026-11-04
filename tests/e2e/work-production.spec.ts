import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ProjectDocument, StoryWork } from '@video-quickly/contracts';
import { confirmAction } from './confirmation-actions';
import { fixtureNativeVideo } from '../fixtures/native-video';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }), payload = await response.json();
  expect(response.ok(), JSON.stringify(payload.error)).toBe(true); return payload.result;
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
async function fixture(request: APIRequestContext) {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: { path: string; prompt?: string }[] = [];
  let baseUrl = '';
  const video = fixtureNativeVideo();
  const server = createServer((incoming, response) => { void (async () => {
    response.setHeader('content-type', 'application/json');
    if (incoming.method !== 'POST') {
      if (incoming.url === '/video.mp4') { response.setHeader('content-type', 'video/mp4'); response.end(video); }
      else response.end(JSON.stringify({ status: 'succeeded', content: { video_url: `${baseUrl}/video.mp4` } }));
      return;
    }
    let raw = ''; for await (const bytes of incoming) raw += String(bytes);
    const body = JSON.parse(raw), prompt = body.messages?.[0]?.content as string | undefined;
    calls.push({ path: incoming.url ?? '', prompt }); if (calls.length === 1) await gate;
    if (prompt) {
      const content = prompt.includes('自动视频制作步骤：旁白与分镜') ? JSON.stringify({ shots: [{ title: '花园镜头', narration: '木盒找到了。', visualPrompt: '花园中的蓝色木盒', durationUs: 1000000, characterKeys: [], entityKeys: [] }], entities: [] }) : '统一的水彩花园与蓝色木盒。';
      response.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 23, completion_tokens: 11 } }));
    } else response.end(JSON.stringify({ id: `episode-video-${calls.length}` }));
  })().catch(error => response.destroy(error instanceof Error ? error : undefined)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture'); baseUrl = `http://127.0.0.1:${address.port}`;
  const text = await rpc<{ id: string }>(request, 'model.save', { model: { name: `分集文本 ${randomUUID().slice(0, 6)}`, provider: 'openai-compatible', connectionType: 'text', capabilities: ['text'], model: 'fixture-text', baseUrl } });
  const videoModel = await rpc<{ id: string }>(request, 'model.save', { model: { name: `分集视频 ${randomUUID().slice(0, 6)}`, provider: 'seedance', connectionType: 'video', capabilities: ['video'], model: 'seedance-2-0-fixture', baseUrl } });
  let project = await rpc<ProjectDocument>(request, 'project.create', { title: `作品样例 ${randomUUID().slice(0, 6)}`, profile: { width: 160, height: 90, frameRate: { numerator: 30, denominator: 1 } } });
  project = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { style: '样例水彩', workflow: { ...project.workflow, production: { ...project.workflow.production, textModelId: text.id, videoModelId: videoModel.id, referenceMode: 'none' } } } });
  return { project, calls, release, async close() { release(); await close(server); } };
}
async function createWork(page: Page, project: ProjectDocument) {
  await page.goto('/'); await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.getByRole('button', { name: '作品与分集', exact: true }).click();
  await page.getByRole('button', { name: '新建作品', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建作品', exact: true }), title = `花园作品 ${randomUUID().slice(0, 6)}`;
  await dialog.getByRole('textbox', { name: '作品名称', exact: true }).fill(title);
  await dialog.getByRole('combobox', { name: '沿用项目的默认设置', exact: true }).selectOption(project.id);
  await expect(dialog.getByRole('textbox', { name: '作品默认风格', exact: true })).toHaveValue('样例水彩');
  await dialog.getByRole('textbox', { name: '作品默认风格', exact: true }).fill('作品中的统一水彩花园');
  await dialog.getByRole('button', { name: '保存作品', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  return title;
}
async function createEpisodes(page: Page) {
  await page.getByRole('button', { name: '批量新建分集', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '批量新建分集', exact: true });
  await dialog.getByRole('spinbutton', { name: '创建数量', exact: true }).fill('2');
  await dialog.getByRole('textbox', { name: '第 1 集标题', exact: true }).fill('发现木盒');
  await dialog.getByRole('textbox', { name: '第 1 集原始文案', exact: true }).fill('第一集原文：花园里发现蓝色木盒。');
  await dialog.getByRole('textbox', { name: '第 2 集标题', exact: true }).fill('打开木盒');
  await dialog.getByRole('textbox', { name: '第 2 集原始文案', exact: true }).fill('第二集原文：大家一起打开木盒。');
  await dialog.getByRole('button', { name: '创建 2 个分集', exact: true }).click();
  return dialog;
}
async function begin(page: Page) { await page.getByRole('button', { name: '开始队列', exact: true }).click(); await confirmAction(page, '开始队列'); }

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }]) test(`creates a work, runs native episodes sequentially, pauses and refreshes stale input at ${viewport.width}px`, async ({ page, request }, info) => {
  test.slow(); const source = await fixture(request), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewportSize(viewport); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
    const title = await createWork(page, source.project), dialog = await createEpisodes(page); await expect(dialog).toHaveCount(0);
    await expect(page.locator('.episode-row')).toHaveCount(2); await page.screenshot({ path: info.outputPath(`work-episodes-${viewport.theme}.png`) });
    await page.getByRole('button', { name: '所选分集入队（2）', exact: true }).click();
    await expect(page.locator('.queue-item')).toHaveCount(2); expect(source.calls).toHaveLength(0);
    await begin(page); await expect.poll(() => source.calls.length).toBe(1);
    await page.getByRole('button', { name: '暂停后续派发', exact: true }).click(); await expect(page.locator('.queue-summary')).toContainText('已暂停派发');
    source.release(); await expect(page.locator('.queue-item').first().locator('.queue-item__status')).toHaveText('已完成', { timeout: 45000 });
    await expect(page.locator('.queue-item').nth(1).locator('.queue-item__status')).toHaveText('待制作'); expect(source.calls).toHaveLength(4);
    const works = await rpc<{ items: StoryWork[] }>(request, 'work.list', {}), work = works.items.find(work => work.title === title)!;
    const summary = await rpc<{ projects: { id: string; episode?: { workId: string; number: number } }[] }>(request, 'workspace.summary');
    const episodes = summary.projects.filter(project => project.episode?.workId === work.id).sort((a, b) => a.episode!.number - b.episode!.number);
    const second = (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: episodes[1].id })).project;
    await rpc(request, 'project.update', { projectId: second.id, revision: second.revision, patch: { title: '人工更新的打开木盒' } });
    await begin(page); await expect(page.locator('.queue-item').nth(1)).toContainText('排队后项目已修改'); expect(source.calls).toHaveLength(4);
    await page.screenshot({ path: info.outputPath(`production-queue-${viewport.theme}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.getByRole('button', { name: '核对并刷新输入', exact: true }).click(); await confirmAction(page, '刷新输入');
    await begin(page); await expect(page.locator('.queue-summary')).toContainText('已完成', { timeout: 45000 });
    expect(source.calls).toHaveLength(8);
    for (const episode of episodes) {
      const project = (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: episode.id })).project;
      expect(project.shots).toHaveLength(1); expect(project.shots[0].videoAssetId).toBeTruthy(); expect(project.episode?.originalText).toContain('集原文');
    }
    expect(errors).toEqual([]);
  } finally { await source.close(); }
});

test('retries a committed batch response without duplicate projects and explicitly synchronizes defaults', async ({ page, request }) => {
  const source = await fixture(request);
  try {
    const title = await createWork(page, source.project); let lost = false;
    await page.route('**/__desktop_rpc', async route => {
      if (route.request().postDataJSON().method !== 'work.episodes.create' || lost) return route.continue();
      lost = true; await route.fetch(); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ error: '夹具响应丢失，保留草稿后重试。' }) });
    });
    const dialog = await createEpisodes(page); await expect(dialog.getByRole('alert')).toContainText('夹具响应丢失');
    await dialog.getByRole('button', { name: '创建 2 个分集', exact: true }).click(); await expect(dialog).toHaveCount(0); await expect(page.locator('.episode-row')).toHaveCount(2);
    const works = await rpc<{ items: StoryWork[] }>(request, 'work.list'), work = works.items.find(work => work.title === title)!;
    await page.getByRole('button', { name: '编辑作品默认设置', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '作品默认设置', exact: true }); await editor.getByRole('textbox', { name: '作品默认风格', exact: true }).fill('显式同步的新风格'); await editor.getByRole('button', { name: '保存作品', exact: true }).click();
    await expect(page.getByRole('navigation', { name: '作品内容', exact: true })).toHaveCount(1); await expect(page.locator('.episode-row')).toHaveCount(2);
    const before = await rpc<{ projects: ProjectDocument[] }>(request, 'workspace.snapshot'); expect(before.projects.filter(project => project.episode?.workId === work.id).map(project => project.style)).toEqual(['作品中的统一水彩花园', '作品中的统一水彩花园']);
    await page.getByRole('button', { name: '同步作品默认设置', exact: true }).click(); await page.getByRole('dialog', { name: '同步作品默认设置', exact: true }).getByRole('button', { name: '同步到所选分集', exact: true }).click();
    await expect.poll(async () => (await rpc<{ projects: ProjectDocument[] }>(request, 'workspace.snapshot')).projects.filter(project => project.episode?.workId === work.id).map(project => project.style)).toEqual(['显式同步的新风格', '显式同步的新风格']);
    await expect(page.locator('.episode-row').first()).toContainText('项目修订 2'); await expect(page.locator('.episode-row').nth(1)).toContainText('项目修订 2');
    expect(source.calls).toHaveLength(0);
    await page.getByRole('button', { name: '所选分集入队（2）', exact: true }).click(); await begin(page); await expect.poll(() => source.calls.length).toBe(1);
    await page.getByRole('button', { name: '取消后续排队项', exact: true }).click(); await confirmAction(page, '取消后续排队项');
    await expect(page.locator('.queue-item').nth(1).locator('.queue-item__status')).toHaveText('已取消');
    await page.getByRole('button', { name: '停止当前制作', exact: true }).click(); await confirmAction(page, '停止当前制作'); source.release();
    await expect(page.locator('.queue-item').first().locator('.queue-item__status')).toHaveText('已取消');
    await page.getByRole('navigation', { name: '作品内容', exact: true }).getByRole('button', { name: '分集', exact: true }).click();
    await page.getByRole('button', { name: '所选分集入队（2）', exact: true }).click(); await expect(page.locator('.queue-item')).toHaveCount(2); await expect(page.locator('.queue-item__status')).toHaveText(['待制作', '待制作']);
  } finally { await source.close(); }
});

test('joins existing projects, protects conflicting episode numbers and preserves original text on keyboard cancellation', async ({ page, request }) => {
  const source = await fixture(request);
  try {
    const title = await createWork(page, source.project);
    await page.getByRole('button', { name: '加入已有项目', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: '加入已有项目', exact: true });
    await dialog.getByRole('combobox', { name: '已有项目', exact: true }).selectOption(source.project.id);
    await expect(dialog.getByRole('button', { name: '保存分集关联', exact: true })).toBeEnabled();
    await dialog.getByRole('textbox', { name: '分集原始文案', exact: true }).fill('已有项目的独立原始文案');
    await dialog.getByRole('button', { name: '保存分集关联', exact: true }).click(); await expect(page.locator('.episode-row')).toHaveCount(1);
    const current = async (id: string) => (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: id })).project;
    expect((await current(source.project.id)).style).toBe('样例水彩');
    await page.locator('.episode-row').getByRole('button', { name: '编辑分集', exact: true }).click();
    const edit = page.getByRole('dialog', { name: '编辑分集', exact: true });
    await expect(edit.getByRole('textbox', { name: '分集原始文案', exact: true })).toHaveValue('已有项目的独立原始文案');
    await edit.getByRole('textbox', { name: '分集原始文案', exact: true }).fill('未保存的修改'); await page.keyboard.press('Escape'); await expect(edit).toHaveCount(0);
    expect((await current(source.project.id)).episode?.originalText).toBe('已有项目的独立原始文案');
    await expect(page.locator('.episode-row').getByRole('button', { name: '编辑分集', exact: true })).toBeFocused();
    const other = await rpc<ProjectDocument>(request, 'project.create', { title: `另一个独立项目 ${randomUUID().slice(0, 6)}` });
    await page.getByRole('button', { name: '加入已有项目', exact: true }).click(); dialog = page.getByRole('dialog', { name: '加入已有项目', exact: true });
    await dialog.getByRole('combobox', { name: '已有项目', exact: true }).selectOption(other.id); await expect(dialog.getByRole('button', { name: '保存分集关联', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: '保存分集关联', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('第 1 集已存在');
    await dialog.getByRole('spinbutton', { name: '分集编号', exact: true }).fill('2'); await dialog.getByRole('button', { name: '保存分集关联', exact: true }).click(); await expect(page.locator('.episode-row')).toHaveCount(2);
    const first = page.locator('.episode-row').filter({ has: page.getByRole('heading', { name: source.project.title, exact: true }) });
    await first.getByRole('button', { name: '移出作品', exact: true }).click(); await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click();
    expect((await current(source.project.id)).episode?.number).toBe(1);
    await first.getByRole('button', { name: '移出作品', exact: true }).click(); await confirmAction(page, '移出作品'); await expect(page.locator('.episode-row')).toHaveCount(1);
    const detached = await current(source.project.id); expect(detached.episode).toBeUndefined(); expect(detached.episodeSource?.workTitle).toBe(title); expect(source.calls).toHaveLength(0);
  } finally { await source.close(); }
});
