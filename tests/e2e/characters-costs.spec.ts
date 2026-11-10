import { confirmAction } from './confirmation-actions';
import { openProjectFromList } from './workspace-navigation';
import { openCosts, setWorkspaceTheme } from './workspace-settings';
import { settingField } from './settings';
import { fixtureCharacterViews } from '../fixtures/character-views';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { AssetRecord, CharacterProfile, ModelProfile, ProjectDocument, RunSummary, UsageRecord } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json(); expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function savedProject(request: APIRequestContext, projectId: string) { return (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId })).project; }
async function createProject(request: APIRequestContext, title: string) {
  const project = await rpc<ProjectDocument>(request, 'project.create', { title });
  return rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: [{ id: 'role-shot', title: '角色镜头', narration: '原旁白', visualPrompt: '人物站在门口', durationUs: 1_000_000 }] } });
}
async function openProject(page: Page, title: string) {
  await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/);
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.locator('.project-card').filter({ hasText: title }).getByRole('button', { name: /继续创作/ }).click();
  await expect(page.getByLabel('镜头标题')).toHaveValue('角色镜头');
}
function observeErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  return errors;
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5mQAAAAASUVORK5CYII=', 'base64');

for (const viewport of [{ width: 1536, height: 960, theme: 'dark', useReference: true, rejectFirst: true }, { width: 390, height: 844, theme: 'light', useReference: false, rejectFirst: false }]) {
  test(`generates, previews and saves four views in one form at ${viewport.width}px`, async ({ page, request }, info) => {
    const board = await fixtureCharacterViews();
    const calls: { path?: string; body: Record<string, unknown> }[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const server = createServer((incoming, response) => { void (async () => {
      let raw = '';
      for await (const chunk of incoming) raw += String(chunk);
      calls.push({ path: incoming.url, body: JSON.parse(raw) });
      const reject = viewport.rejectFirst && calls.length === 1;
      await gate;
      response.setHeader('content-type', 'application/json');
      if (reject) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: { message: 'status_code=400, The request failed because the output image may contain sensitive information. Request id: fixture-private-detail' } }));
        return;
      }
      response.end(JSON.stringify({ data: [{ b64_json: board.toString('base64') }] }));
    })().catch(error => response.destroy(error)); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('图片夹具未启动。');
      const model = await rpc<ModelProfile>(request, 'model.save', { model: { name: `定妆夹具 ${viewport.width}`, provider: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'gpt-image-fixture', connectionType: 'image', capabilities: ['image'],
        ...(viewport.useReference ? { pricing: { currency: 'CNY', perImage: 0.25 } } : {}) } });
      const name = `青衣旅人 ${viewport.width}`;
      await page.setViewportSize(viewport);
      await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
      await page.goto('/');
      await page.getByRole('button', { name: '角色参考库', exact: true }).click();
      await page.getByRole('button', { name: '新建角色', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '新建角色', exact: true });
      const nameField = dialog.getByLabel('角色名称', { exact: true });
      const descriptionField = dialog.getByLabel('角色设定', { exact: true });
      const modelField = dialog.getByLabel('图片模型', { exact: true });
      const description = '蓝绿色长外套、橙色围巾、黑色短发。';
      await nameField.fill(name);
      await descriptionField.fill(description);
      await page.mouse.click(2, 2);
      await expect(nameField).toHaveValue(name);
      const optionalReference = dialog.locator('.character-reference-disclosure');
      const summary = optionalReference.locator('summary');
      await expect(optionalReference).toHaveJSProperty('open', false);
      if (viewport.useReference) {
        const path = info.outputPath('role-anchor.png');
        await writeFile(path, png);
        await (await settingField(dialog, '角色参考图路径')).fill(path);
        await dialog.getByRole('button', { name: '导入参考图片', exact: true }).click();
        await expect(summary).toContainText('已选 1 张');
        await summary.click();
      }
      await modelField.selectOption(model.id);
      const generate = dialog.getByRole('button', { name: '生成四视角', exact: true });
      const billing = page.getByRole('alertdialog', { name: '生成角色四视角？', exact: true });
      const estimate = billing.getByRole('region', { name: '生成与费用预估' });
      if (viewport.rejectFirst) {
        await generate.click();
        await expect(billing).toContainText('可能产生费用');
        await expect(estimate).toContainText('¥0.25');
        await expect(billing.getByRole('button', { name: '取消', exact: true })).toBeFocused();
        await expect(page.locator('.character-editor').getByText('等待确认…', { exact: true })).toBeVisible();
        expect(calls).toHaveLength(0);
        await expect(billing.locator('.dialog__surface')).toHaveCSS('opacity', '1');
        await page.screenshot({ path: info.outputPath('character-charge-estimate.png') });
        await page.keyboard.press('Enter');
        await expect(billing).toHaveCount(0);
        await expect(generate).toBeEnabled();
        await expect(nameField).toHaveValue(name);
        await expect(modelField).toHaveValue(model.id);
        expect(calls).toHaveLength(0);
      }
      await generate.click();
      await expect(estimate).toContainText(model.name);
      await expect(estimate).toContainText(model.model);
      await expect(estimate).toContainText('1 张四宫格原图，裁出 4 张参考图');
      await expect(estimate).toContainText(viewport.useReference ? '¥0.25' : '暂无法估算');
      await expect(estimate).toContainText('以服务商实际计费为准');
      await confirmAction(page, '确认生成');
      await expect(generate).toBeDisabled();
      await expect(dialog.getByText('正在为同一个角色绘制四个视角。')).toBeVisible();
      await expect(dialog.getByRole('button', { name: '关闭对话框', exact: true })).toBeDisabled();
      await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
      await page.mouse.click(2, 2);
      await page.keyboard.press('Escape');
      await expect(nameField).toHaveValue(name);
      release();
      if (viewport.rejectFirst) {
        await expect(dialog.getByRole('alert')).toHaveText('模型服务的内容审核拦截了生成的图片（HTTP 400）。请调整生成描述或参考图后重试。');
        await page.mouse.click(2, 2);
        await expect(nameField).toHaveValue(name);
        await expect(descriptionField).toHaveValue(description);
        await expect(modelField).toHaveValue(model.id);
        await expect(summary).toContainText('已选 1 张');
        expect(calls).toHaveLength(1);
        await page.screenshot({ path: info.outputPath('character-views-review-rejection.png') });
        await descriptionField.fill(`${description}风格为手绘动画。`);
        await generate.click();
        await confirmAction(page, '确认生成');
        await expect(dialog.getByRole('alert')).toHaveCount(0);
      }
      const views = dialog.getByRole('group', { name: '生成的四视角参考图' });
      await expect(views.locator('img')).toHaveCount(4);
      await page.mouse.click(2, 2);
      await expect.poll(() => views.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
      await views.scrollIntoViewIfNeeded();
      await expect.poll(() => dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 2)).toBe(true);
      const evidence = info.outputPath(`character-views-${viewport.width}.png`);
      await page.screenshot({ path: evidence });
      await info.attach('character-views', { path: evidence, contentType: 'image/png' });

      await dialog.getByRole('button', { name: '选用这组参考图', exact: true }).click();
      await expect(summary).toContainText('已选 4 张');
      await expect(views.locator('img')).toHaveCount(4);
      await summary.click();
      const references = dialog.getByRole('group', { name: '参考图片（最多 4 张）' });
      await expect(references.locator('input:checked')).toHaveCount(4);
      await dialog.getByRole('button', { name: '保存角色', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      const library = await rpc<{ items: CharacterProfile[] }>(request, 'character.list');
      const character = library.items.find(item => item.name === name)!;
      expect(character.referenceAssetIds).toHaveLength(4);
      expect((await rpc<AssetRecord[]>(request, 'character.references', { characterId: character.id })).every(asset => asset.projectId === undefined)).toBe(true);
      expect(calls).toHaveLength(viewport.rejectFirst ? 2 : 1);
      expect(calls[0].body.prompt).toContain('蓝绿色长外套、橙色围巾、黑色短发');
      if (viewport.rejectFirst) expect(calls[1].body.prompt).toContain('风格为手绘动画');
      expect(calls[0].path).toBe(viewport.useReference ? '/v1/images/edits' : '/v1/images/generations');
      if (viewport.useReference) expect(calls[0].body.images).toEqual([{ image_url: `data:image/png;base64,${png.toString('base64')}` }]);
    } finally {
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
}

test('can remove an archived character from an unsaved draft without losing other shot edits', async ({ page, request }) => {
  const project = await createProject(request, '草稿归档角色恢复验收');
  const character = await rpc<CharacterProfile>(request, 'character.save', { character: { name: '临时草稿角色', description: '', referenceAssetIds: [] } });
  await openProject(page, project.title);
  await page.getByLabel('旁白', { exact: true }).fill('应保留的人工旁白');
  await page.getByRole('checkbox', { name: '临时草稿角色', exact: true }).check();
  await rpc(request, 'character.archive', { characterId: character.id, revision: character.revision });
  const archived = page.getByRole('checkbox', { name: '临时草稿角色（已归档）', exact: true });
  await expect(archived).toBeChecked(); await expect(archived).toBeEnabled(); await archived.click();
  await expect(archived).toHaveCount(0);
  await page.getByRole('button', { name: '保存镜头', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots[0].narration).toBe('应保留的人工旁白');
  expect((await savedProject(request, project.id)).shots[0].characterIds ?? []).toEqual([]);
});

test('creates a visual character library, binds a shot with durable undo, and protects references through backup', async ({ page, request }, info) => {
  const errors = observeErrors(page);
  const project = await createProject(request, '角色参考库与编辑恢复验收');
  const fileName = 'public-character.png';
  const path = info.outputPath(fileName); await writeFile(path, png);
  await openProject(page, project.title);
  await page.getByRole('button', { name: '角色参考库', exact: true }).click();
  await page.getByRole('button', { name: '新建角色', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建角色', exact: true });
  await (await settingField(dialog, '角色名称')).fill('稳定角色小青');
  await (await settingField(dialog, '角色设定')).fill('青色长衫，圆眼镜，保持人物服饰与面部特征。');
  await (await settingField(dialog, '角色参考图路径')).fill(path);
  await dialog.getByRole('button', { name: '导入参考图片', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: fileName })).toBeChecked();
  await dialog.getByRole('button', { name: '保存角色', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const library = await rpc<{ items: CharacterProfile[] }>(request, 'character.list', { archived: false });
  const character = library.items.find(value => value.name === '稳定角色小青'); expect(character).toBeTruthy();
  await expect(page.getByAltText('稳定角色小青参考图')).toBeVisible();
  await page.screenshot({ path: info.outputPath('character-library-dark.png') });
  await page.getByRole('button', { name: '素材库', exact: true }).click();
  const referencedImage = page.locator('.asset-card').filter({ hasText: fileName });
  await expect(referencedImage).toContainText('使用中');
  await expect(referencedImage.getByRole('button', { name: `移除素材“${fileName}”`, exact: true })).toBeDisabled();
  await openProjectFromList(page);
  await page.getByRole('checkbox', { name: '稳定角色小青', exact: true }).check();
  await page.getByRole('button', { name: '保存镜头', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots[0].characterIds).toEqual([character!.id]);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots[0].characterIds ?? []).toEqual([]);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots[0].characterIds).toEqual([character!.id]);
  await page.reload(); await openProjectFromList(page, project.title);
  await expect(page.getByRole('checkbox', { name: '稳定角色小青', exact: true })).toBeChecked();
  await page.getByRole('button', { name: '角色参考库', exact: true }).click();
  const blockedArchive = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.method === 'character.archive');
  await page.getByRole('button', { name: '归档角色：稳定角色小青', exact: true }).click(); await confirmAction(page, '确认归档');
  await expect(page.getByRole('alert')).toContainText('仍有项目镜头使用此角色');
  expect((await blockedArchive).status()).toBe(400);
  const deletion = await request.post('/__desktop_rpc', { data: { method: 'asset.delete', params: { assetId: character!.referenceAssetIds[0] } } });
  expect((await deletion.json()).error).toBeTruthy();
  const backup = await rpc<{ path: string }>(request, 'project.backup', { projectId: project.id, destination: info.outputPath('character-backup') });
  const imported = await rpc<ProjectDocument>(request, 'project.importBackup', { path: backup.path });
  expect(imported.shots[0].characterIds).toHaveLength(1); expect(imported.shots[0].characterIds![0]).not.toBe(character!.id);
  const restored = await rpc<CharacterProfile>(request, 'character.get', { characterId: imported.shots[0].characterIds![0] });
  expect(restored.name).toBe(character!.name); expect(restored.referenceAssetIds[0]).not.toBe(character!.referenceAssetIds[0]);
  const images = await rpc<AssetRecord[]>(request, 'character.references', { characterId: restored.id });
  expect(images).toHaveLength(1); expect(images[0].sha256).toBe((await rpc<AssetRecord[]>(request, 'character.references', { characterId: character!.id }))[0].sha256);
  expect(errors).toEqual(['Failed to load resource: the server responded with a status of 400 (Bad Request)']); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});

test('sends frozen character settings into generation and records provider token counters across reload', async ({ page, request }, info) => {
  const errors = observeErrors(page), calls: string[] = [];
  const server = createServer({ keepAliveTimeout: 0 }, (request, response) => { void (async () => {
    let body = ''; for await (const chunk of request) body += chunk.toString(); calls.push(body);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ shots: [{ title: '人物候选', narration: '候选旁白', visualPrompt: '人物轻轻推门', durationUs: 1_000_000 }] }) } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }));
  })().catch(error => response.destroy(error instanceof Error ? error : undefined)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('无效测试地址');
    let project = await createProject(request, '角色快照与费用验收');
    const character = await rpc<CharacterProfile>(request, 'character.save', { character: { name: '配角阿宁', description: '灰色斗篷，语气平静', referenceAssetIds: [] } });
    project = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: project.shots.map(shot => ({ ...shot, characterIds: [character.id] })) } });
    const model = await rpc<ModelProfile>(request, 'model.save', { model: { name: '费用计量服务', provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'usage-fixture', connectionType: 'text', capabilities: ['text'], pricing: { currency: 'USD', inputPerMillionTokens: 2, outputPerMillionTokens: 4 } } });
    await openProject(page, project.title);
    await page.getByRole('button', { name: 'AI 微调', exact: true }).click();
    const candidate = page.getByRole('dialog', { name: '镜头候选', exact: true });
    await candidate.getByLabel('生成模型', { exact: true }).selectOption(model.id);
    const started = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.method === 'shot.regenerate');
    await candidate.getByRole('button', { name: '生成候选', exact: true }).click();
    await confirmAction(page, '确认生成');
    const generated = await (await started).json(); expect(generated.error).toBeUndefined();
    await expect.poll(async () => (await rpc<RunSummary>(request, 'run.get', { runId: generated.result.id })).status, { timeout: 30_000 }).toBe('succeeded');
    await expect(candidate.locator('.shot-regeneration__comparison')).toContainText('候选旁白');
    expect(calls).toHaveLength(1); expect(calls[0]).toContain('配角阿宁'); expect(calls[0]).toContain('灰色斗篷');
    const ledger = await rpc<{ items: UsageRecord[] }>(request, 'cost.list', { projectId: project.id });
    expect(ledger.items).toHaveLength(1); expect(ledger.items[0].providerUsage).toMatchObject({ inputTokens: 100, outputTokens: 50 }); expect(ledger.items[0].estimatedAmount).toBeUndefined();
    await rpc(request, 'character.save', { character: { ...character, description: '改成红色斗篷' } });
    const blockedCandidate = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.method === 'shot.candidate.apply');
    await candidate.getByRole('button', { name: '应用所选候选', exact: true }).click();
    await expect(candidate.getByRole('alert')).toBeVisible(); expect(await savedProject(request, project.id)).toEqual(project);
    expect((await blockedCandidate).status()).toBe(400);
    await candidate.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '关闭提示', exact: true }).click();
    await expect(page.locator('.toast')).toHaveCount(0);
    await rpc(request, 'model.save', { model: { ...model, pricing: { currency: 'USD', inputPerMillionTokens: 99, outputPerMillionTokens: 99 } } });
    await openCosts(page);
    await page.getByLabel('用量项目').selectOption(project.id);
    await page.getByRole('button', { name: `查看任务用量详情：${ledger.items[0].runId}`, exact: true }).click();
    const row = page.locator('.cost-record').filter({ hasText: '费用计量服务' });
    await expect(row.locator('[data-metric="inputTokens"] .token-amount')).toHaveText('100');
    await expect(row.locator('[data-metric="outputTokens"] .token-amount')).toHaveText('50');
    await expect(row.locator('[data-metric="cachedOutputTokens"] .token-amount')).toHaveText('—');
    const saved = (await rpc<{ items: UsageRecord[] }>(request, 'cost.list', { projectId: project.id })).items[0];
    expect(saved.pricing).toBeUndefined(); expect(saved.actualAmount).toBeUndefined();
    await setWorkspaceTheme(page, 'light'); await page.setViewportSize({ width: 600, height: 900 });
    const records = page.getByRole('table', { name: '调用明细', exact: true });
    await expect(records.getByRole('columnheader', { name: '输入 Token', exact: true })).toHaveCount(1);
    await expect(row.getByText('输入 Token', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('cost-records-light-600.png') });
    expect(await page.locator('.page-body').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.reload(); await openCosts(page); await page.getByLabel('用量项目').selectOption(project.id);
    await page.getByRole('button', { name: `查看任务用量详情：${ledger.items[0].runId}`, exact: true }).click();
    await expect(row.locator('[data-metric="inputTokens"] .token-amount')).toHaveText('100');
    expect(errors).toEqual(['Failed to load resource: the server responded with a status of 400 (Bad Request)']); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
