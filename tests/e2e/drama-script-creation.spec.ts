import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { DramaWork, ModelProfile, ProjectDocument } from '@video-quickly/contracts';
import { confirmAction } from './confirmation-actions';
import { openWorks } from './workspace-navigation';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const value = await response.json(); expect(response.ok(), JSON.stringify(value.error)).toBe(true); return value.result;
}

async function openEpisode(page: Page, work: DramaWork, project: ProjectDocument) {
  await page.goto('/');
  await openWorks(page);
  await page.locator('.drama-work-card').filter({ has: page.getByRole('heading', { name: work.title, exact: true }) }).getByRole('button', { name: '查看分集', exact: true }).click();
  await page.locator('.drama-episode-row').filter({ has: page.getByRole('heading', { name: project.title, exact: true }) }).getByRole('button', { name: '打开分集', exact: true }).click();
}

for (const scenario of [{ width: 1536, height: 960, theme: 'dark' }, { width: 1024, height: 720, theme: 'light' }] as const) {
  test(`creates, recovers, applies and edits a real screenplay draft at ${scenario.width}px`, async ({ page, request }, info) => {
    test.setTimeout(120_000);
    const screenplay = '第一场 · 雨夜车站\n林夏把错寄的信递给站长。\n林夏：这封信，为什么写着我的名字？\n站长藏起钥匙，身后的列车突然熄灯。';
    const calls: Record<string, unknown>[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const server = createServer({ keepAliveTimeout: 0 }, async (incoming, response) => {
      let body = ''; for await (const chunk of incoming) body += chunk;
      calls.push(JSON.parse(body)); await gate;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: screenplay }) } }] }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture server address');
    const suffix = randomUUID().slice(0, 8), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', value => { if (value.type() === 'error') errors.push(value.text()); });
    try {
      const model = await rpc<ModelProfile>(request, 'model.save', { model: { name: `剧本模型 ${suffix}`, model: 'screenplay-local-fixture', provider: 'openai-compatible', connectionType: 'text', capabilities: ['text'], baseUrl: `http://127.0.0.1:${address.port}` } });
      const { work, project } = await rpc<{ work: DramaWork; project: ProjectDocument }>(request, 'dramaStudio.create', { work: { title: `剧本创作 ${suffix}`, description: '错寄的信引出一个车站秘密，突出人物动机。', visualStyle: 'live-action', narrativeMode: 'mixed', stylePresetId: 'natural-live-action', skillIds: [] }, mode: 'write' });
      const saved = async () => (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project;
      await page.setViewportSize(scenario); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), scenario.theme);
      await openEpisode(page, work, project);
      let dialog = page.getByRole('dialog', { name: '分集剧本 · 第 1 集', exact: true });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('combobox', { name: '剧本文本模型', exact: true }).selectOption(model.id);
      await dialog.getByRole('textbox', { name: '本次创作要求', exact: true }).fill('增加一枚钥匙作为悬念道具，按场次写行动和可表演对白。');
      await dialog.getByRole('button', { name: '生成剧本草稿', exact: true }).click();
      await confirmAction(page, '确认填写');
      await expect.poll(() => calls.length).toBe(1);
      expect(JSON.stringify(calls[0])).toContain('错寄的信');
      expect(JSON.stringify(calls[0])).toContain('钥匙');
      expect((await saved()).originalText ?? '').toBe('');
      // The durable draft keeps running across a full browser reload.
      await openEpisode(page, work, project);
      dialog = page.getByRole('dialog', { name: '分集剧本 · 第 1 集', exact: true });
      await expect(dialog).toBeVisible(); release();
      await expect(dialog.getByRole('textbox', { name: '生成的剧本草稿', exact: true })).toHaveValue(screenplay, { timeout: 30_000 });
      expect((await saved()).originalText ?? '').toBe('');
      await dialog.getByRole('textbox', { name: '剧本正文', exact: true }).fill('尚未保存的手改正文');
      await dialog.getByRole('button', { name: '应用到本集剧本', exact: true }).click();
      await expect(dialog).toContainText('正文有未保存的修改');
      await expect(dialog.getByRole('textbox', { name: '剧本正文', exact: true })).toHaveValue('尚未保存的手改正文');
      await dialog.getByRole('textbox', { name: '剧本正文', exact: true }).fill('');
      await dialog.getByRole('button', { name: '应用到本集剧本', exact: true }).click();
      await expect(dialog.getByRole('textbox', { name: '剧本正文', exact: true })).toHaveValue(screenplay);
      await expect.poll(async () => (await saved()).originalText).toBe(screenplay);
      expect((await saved()).brief).toContain('错寄的信');
      await dialog.getByRole('textbox', { name: '剧本正文', exact: true }).fill(`${screenplay}\n林夏没有转身。`);
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      await page.getByRole('button', { name: '分集剧本', exact: true }).click();
      dialog = page.getByRole('dialog', { name: '分集剧本 · 第 1 集', exact: true });
      await expect(dialog.getByRole('textbox', { name: '剧本正文', exact: true })).toHaveValue(`${screenplay}\n林夏没有转身。`);
      await dialog.getByRole('button', { name: '保存剧本', exact: true }).click();
      await expect.poll(async () => (await saved()).originalText).toBe(`${screenplay}\n林夏没有转身。`);
      await page.screenshot({ path: info.outputPath(`screenplay-${scenario.theme}.png`) });
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      await page.getByRole('button', { name: '撤销', exact: true }).click();
      await expect.poll(async () => (await saved()).originalText).toBe(screenplay);
      await page.getByRole('button', { name: '重做', exact: true }).click();
      await expect.poll(async () => (await saved()).originalText).toBe(`${screenplay}\n林夏没有转身。`);
      await openEpisode(page, work, project);
      await page.getByRole('button', { name: '分集剧本', exact: true }).click();
      await expect(page.getByRole('dialog', { name: '分集剧本 · 第 1 集', exact: true }).getByRole('textbox', { name: '剧本正文', exact: true })).toHaveValue(`${screenplay}\n林夏没有转身。`);
      dialog = page.getByRole('dialog', { name: '分集剧本 · 第 1 集', exact: true });
      const latest = await saved();
      const external = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: latest.revision, patch: { originalText: '另一视图保存的新剧本，必须保留。' } });
      await expect(page.locator('.project-heading-copy')).toHaveAttribute('data-revision', String(external.revision));
      await dialog.locator('summary', { hasText: 'AI 剧本创作' }).click();
      await dialog.getByRole('combobox', { name: '剧本文本模型', exact: true }).selectOption(model.id);
      await dialog.getByRole('button', { name: '生成剧本草稿', exact: true }).click();
      await expect(dialog).toContainText('剧本正文已在其他视图修改');
      expect((await saved()).originalText).toBe(external.originalText);
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      expect(errors).toEqual([]); expect(calls).toHaveLength(1);
    } finally {
      release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}
