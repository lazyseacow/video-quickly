import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { AssetRecord, CharacterProfile, ProjectDocument, RunSummary } from '@video-quickly/contracts';
import { openProduction, productionStep, saveProduction } from './production-settings';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json(); expect(response.ok(), JSON.stringify(payload.error)).toBe(true); return payload.result;
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
async function fixture(request: APIRequestContext, hold = false) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-creative-browser-'));
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const prompts: string[] = [];
  const server = createServer((incoming, response) => { void (async () => {
    let body = ''; for await (const part of incoming) body += String(part); prompts.push(body); entered(); if (hold) await gate;
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      entities: [{ key: 'gate', kind: 'prop', name: '铜锁', description: '旧铜色、圆形锁孔' }],
      shots: [{ title: '自动角色镜头', narration: '找到铜锁了。', visualPrompt: '人物走向花园木门', durationUs: 2_000_000, characterKeys: ['role-1'], entityKeys: ['gate'] }],
    }) } }] }));
  })().catch(error => response.destroy(error instanceof Error ? error : undefined)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const suffix = randomUUID().slice(0, 8), profiles: CharacterProfile[] = [];
    const path = join(directory, 'reference.png'); await writeFile(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
    const asset = await rpc<AssetRecord>(request, 'asset.import', { path, kind: 'image' });
    for (const name of ['小青', '小红']) profiles.push(await rpc<CharacterProfile>(request, 'character.save', { character: { name: `${name} ${suffix}`, description: `${name}的固定服装与外形`, referenceAssetIds: [asset.id] } }));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('本地文本服务未启动');
    const model = await rpc<{ id: string }>(request, 'model.save', { model: { name: `角色文本 ${suffix}`, provider: 'openai-compatible', connectionType: 'text', capabilities: ['text'], model: 'fixture-text', baseUrl: `http://127.0.0.1:${address.port}/v1` } });
    let project = await rpc<ProjectDocument>(request, 'project.create', { title: `角色一致性 ${suffix}`, brief: '花园中的相遇' });
    project = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { workflow: { ...project.workflow, production: { ...project.workflow.production, textModelId: model.id } } } });
    return { project, profiles, prompts, started, release, current: async () => (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project, cleanup: async () => { release(); await close(server); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) { release(); await close(server); await rm(directory, { recursive: true, force: true }); throw error; }
}

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }]) {
  test(`saves creative configuration, restores edits and displays generated role bindings at ${viewport.width}px`, async ({ page, request }, info) => {
    test.setTimeout(60_000);
    const source = await fixture(request), errors: string[] = [], consoleErrors: string[] = [];
    page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    try {
      await page.setViewportSize(viewport); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
      const dialog = await openProduction(page, source.project);
      await expect(page).toHaveTitle(/Video Quickly/); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      await dialog.locator('.creative-context-editor__roles > summary').click();
      const pool = dialog.getByRole('group', { name: '项目角色池', exact: true });
      const role = pool.getByRole('checkbox', { name: source.profiles[0].name, exact: true });
      await role.focus(); await page.keyboard.press('Space'); await expect(role).toBeChecked();
      await dialog.getByRole('textbox', { name: '连续性要求', exact: true }).fill('同一个傍晚，蓝色服装保持不变');
      await dialog.locator('.creative-context-editor__entities > summary').click();
      await dialog.getByRole('button', { name: '添加场景设定', exact: true }).click();
      const entity = dialog.getByRole('region', { name: '场景设定 1', exact: true });
      await entity.getByRole('textbox', { name: '设定名称', exact: true }).fill('花园');
      await entity.getByRole('textbox', { name: '固定特征', exact: true }).fill('左侧木门，右侧石喷泉');
      await productionStep(dialog, '模型与素材'); await productionStep(dialog, '创作要求');
      await expect(pool.getByRole('checkbox', { name: source.profiles[0].name, exact: true })).toBeChecked();
      await expect(dialog.getByRole('textbox', { name: '连续性要求', exact: true })).toHaveValue('同一个傍晚，蓝色服装保持不变');
      await dialog.getByRole('textbox', { name: '连续性要求', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`creative-settings-${viewport.theme}.png`) });
      await productionStep(dialog, '确认保存'); await expect(dialog.getByLabel('确认保存', { exact: true })).toContainText('已选择 1 个角色');
      await saveProduction(dialog); await expect(dialog).toHaveCount(0);
      await expect.poll(async () => (await source.current()).creativeContext?.characterIds).toEqual([source.profiles[0].id]);
      await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect.poll(async () => (await source.current()).creativeContext ?? null).toBeNull();
      await page.getByRole('button', { name: '重做', exact: true }).click(); await expect.poll(async () => (await source.current()).creativeContext?.continuity).toBe('同一个傍晚，蓝色服装保持不变');
      const saved = await source.current();
      const run = await rpc<RunSummary>(request, 'run.start', { projectId: saved.id, nodeId: 'script' });
      await expect.poll(async () => (await rpc<RunSummary>(request, 'run.get', { runId: run.id })).status, { timeout: 30_000 }).toBe('succeeded');
      await rpc(request, 'node.apply', { runId: run.id, nodeId: 'script', revision: saved.revision });
      await expect(page.getByRole('checkbox', { name: source.profiles[0].name, exact: true })).toBeChecked();
      await expect(page.getByRole('checkbox', { name: '道具：铜锁', exact: true })).toBeChecked();
      const restored = await openProduction(page, source.project);
      await expect(restored.getByRole('textbox', { name: '连续性要求', exact: true })).toHaveValue('同一个傍晚，蓝色服装保持不变');
      await expect(restored.getByRole('group', { name: '项目角色池', exact: true }).getByRole('checkbox', { name: source.profiles[0].name, exact: true })).toBeChecked();
      await restored.getByRole('button', { name: '取消', exact: true }).click();
      await expect(page.getByRole('button', { name: /分镜生成/, exact: false }).first()).toBeVisible();
      await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]); expect(consoleErrors).toEqual([]);
    } finally { await source.cleanup(); }
  });
}

test('keeps a running role snapshot while saving and reopening a different pending pool', async ({ page, request }) => {
  test.setTimeout(60_000);
  const source = await fixture(request, true);
  try {
    let dialog = await openProduction(page, source.project);
    await dialog.locator('.creative-context-editor__roles > summary').click();
    await dialog.getByRole('group', { name: '项目角色池', exact: true }).getByRole('checkbox', { name: source.profiles[0].name, exact: true }).check();
    await saveProduction(dialog); await expect(dialog).toHaveCount(0);
    const before = await source.current(), run = await rpc<RunSummary>(request, 'run.start', { projectId: before.id, nodeId: 'script' }); await source.started;
    await page.getByRole('button', { name: '制作设置', exact: true }).click(); dialog = page.getByRole('dialog', { name: '制作设置', exact: true });
    await productionStep(dialog, '创作要求');
    const pool = dialog.getByRole('group', { name: '项目角色池', exact: true });
    await pool.getByRole('checkbox', { name: source.profiles[0].name, exact: true }).uncheck(); await pool.getByRole('checkbox', { name: source.profiles[1].name, exact: true }).check();
    await productionStep(dialog, '确认保存'); await dialog.getByRole('button', { name: '保存待用配置', exact: true }).click(); await expect(dialog).toHaveCount(0);
    expect((await source.current()).creativeContext?.characterIds).toEqual([source.profiles[0].id]); expect(source.prompts).toHaveLength(1); expect(source.prompts[0]).toContain(source.profiles[0].name); expect(source.prompts[0]).not.toContain(source.profiles[1].name);
    dialog = await openProduction(page, source.project);
    await expect(dialog.getByRole('group', { name: '项目角色池', exact: true }).getByRole('checkbox', { name: source.profiles[1].name, exact: true })).toBeChecked();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    source.release(); await expect.poll(async () => (await rpc<RunSummary>(request, 'run.get', { runId: run.id })).status, { timeout: 30_000 }).toBe('succeeded');
    expect((await source.current()).creativeContext?.characterIds).toEqual([source.profiles[0].id]);
  } finally { await source.cleanup(); }
});
