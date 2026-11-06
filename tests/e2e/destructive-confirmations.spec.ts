import { openAdvancedWorkflow } from './production-settings';
import { writeFile } from 'node:fs/promises';
import { expect, type Locator } from '@playwright/test';
import type { AssetRecord, CharacterProfile, MCPServer, ModelProfile, ProjectDocument, SeriesTemplate } from '@video-quickly/contracts';
import { test } from './isolated-workspace';
import { fixture as productionFixture, open as openProduction, pick, rpc } from './native-video-fixture';
import { productionStep, saveAndStartProduction, saveProduction } from './production-settings';
import { openProjectFromList } from './workspace-navigation';
import { confirmAction } from './confirmation-actions';

async function writeWave(path: string, sample = 0) {
  const wave = Buffer.alloc(44 + 3200);
  wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(16000, 24); wave.writeUInt32LE(32000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(3200, 40); wave.writeInt16LE(sample, 44);
  await writeFile(path, wave);
}

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 600, height: 900, theme: 'light' }]) test('requires explicit confirmation for library removals and preserves cancel and focus at ' + viewport.width + 'px', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const project = await rpc<ProjectDocument>(request, 'project.create', { title: '确认回收的项目' });
  const model = await rpc<ModelProfile>(request, 'model.save', { model: { name: '确认移除的模型', provider: 'openai-compatible', connectionType: 'text', capabilities: ['text'], model: 'fixture', baseUrl: 'http://127.0.0.1:1/v1' } });
  const character = await rpc<CharacterProfile>(request, 'character.save', { character: { name: '确认归档的角色', description: '', referenceAssetIds: [] } });
  const template = await rpc<SeriesTemplate>(request, 'seriesTemplate.save', { template: { name: '确认归档的系列', description: '', settings: { style: '', captionStyle: null, scenePreset: null } } });
  const server = await rpc<MCPServer>(request, 'tool.register', { server: { name: '确认移除的工具', transport: 'http', url: 'http://127.0.0.1:1/mcp', args: [], enabled: false } });
  const path = info.outputPath('confirmation-audio.wav'); await writeWave(path);
  const asset = await rpc<AssetRecord>(request, 'asset.import', { path, kind: 'audio' });
  const writes: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/__desktop_rpc')) { const method = request.postDataJSON()?.method; if (['project.archive', 'model.delete', 'asset.delete', 'character.archive', 'seriesTemplate.archive', 'tool.delete'].includes(method)) writes.push(method); } });
  await page.setViewportSize(viewport); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme); await page.goto('/');
  const cases: Array<{ pageName: string; trigger: string; title: string; confirm: string; method: string; subject: string; card: Locator }> = [
    { pageName: '我的项目', trigger: `将“${project.title}”移入回收站`, title: '将项目移入回收站？', confirm: '移入回收站', method: 'project.archive', subject: project.title, card: page.locator('.project-card').filter({ hasText: project.title }) },
    { pageName: '模型连接', trigger: `移除“${model.name}”`, title: '移除模型连接？', confirm: '确认移除', method: 'model.delete', subject: model.name, card: page.locator('.list-card').filter({ hasText: model.name }) },
    { pageName: '素材库', trigger: `移除素材“${asset.name}”`, title: '移除素材记录？', confirm: '确认移除', method: 'asset.delete', subject: asset.name, card: page.locator('.asset-card').filter({ hasText: asset.name }) },
    { pageName: '角色参考库', trigger: `归档角色：${character.name}`, title: '归档角色？', confirm: '确认归档', method: 'character.archive', subject: character.name, card: page.locator('.character-card').filter({ hasText: character.name }) },
    { pageName: '系列模板', trigger: `归档系列模板：${template.name}`, title: '归档系列模板？', confirm: '确认归档', method: 'seriesTemplate.archive', subject: template.name, card: page.locator('.series-template-card').filter({ hasText: template.name }) },
    { pageName: 'Skill 工作室', trigger: `移除工具连接“${server.name}”`, title: '移除工具连接？', confirm: '确认移除', method: 'tool.delete', subject: server.name, card: page.locator('.tool-connections .list-card').filter({ hasText: server.name }) },
  ];
  for (const item of cases) {
    await page.getByRole('button', { name: item.pageName, exact: true }).click();
    const trigger = page.getByRole('button', { name: item.trigger, exact: true }), dialog = page.getByRole('alertdialog', { name: item.title, exact: true });
    await trigger.click(); await expect(dialog).toBeVisible(); await expect(dialog).toContainText(item.subject);
    await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    expect(writes).not.toContain(item.method); await expect(item.card).toHaveCount(1);
    await page.keyboard.press('Enter'); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
    await trigger.click(); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
    await trigger.click(); await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click(); await expect(dialog).toHaveCount(0);
    expect(writes).not.toContain(item.method); await expect(item.card).toHaveCount(1);
    await trigger.click(); await expect(dialog).toBeVisible();
    expect(await dialog.getAttribute('aria-describedby')).toBeTruthy();
    if (item.method === 'model.delete') { await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '1'); await page.screenshot({ path: info.outputPath('confirmation-' + viewport.theme + '-' + viewport.width + '.png') }); }
    await dialog.getByRole('button', { name: item.confirm, exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect(dialog).toHaveCount(0); await expect(item.card).toHaveCount(0);
    expect(writes.filter(method => method === item.method)).toHaveLength(1);
  }
  expect(errors).toEqual([]); await expect(page.locator('vite-error-overlay')).toHaveCount(0); await expect(page).toHaveTitle(/Video Quickly/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('confirms tool activation and leaves a canceled connection disabled', async ({ page, request }) => {
  const server = await rpc<MCPServer>(request, 'tool.register', { server: { name: '需主动启用的工具', transport: 'stdio', command: 'confirmation-fixture', args: [], enabled: false } });
  const writes: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/__desktop_rpc') && request.postDataJSON()?.method === 'tool.toggle') writes.push(request.postData()!); });
  await page.goto('/'); await page.getByRole('button', { name: 'Skill 工作室', exact: true }).click();
  const toggle = page.getByRole('button', { name: `启用工具连接“${server.name}”`, exact: true });
  await toggle.click(); const dialog = page.getByRole('alertdialog', { name: '启用工具连接？', exact: true });
  await expect(dialog).toContainText('confirmation-fixture'); await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(writes).toHaveLength(0); await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click(); await confirmAction(page, '确认启用');
  await expect(page.getByRole('button', { name: `停用工具连接“${server.name}”`, exact: true })).toHaveAttribute('aria-pressed', 'true'); expect(writes).toHaveLength(1);
});

test('keeps pending production settings on cancel and discards them only after confirmation', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const source = await productionFixture(request, info, true);
  try {
    let settings = await openProduction(page, source.project);
    await pick(settings, '文本模型', source.models[0]); await pick(settings, '视频模型', source.video);
    await saveAndStartProduction(settings); await source.pending;
    await page.getByRole('button', { name: '制作设置', exact: true }).click(); settings = page.getByRole('dialog', { name: '制作设置', exact: true });
    await productionStep(settings, '创作要求'); const original = await settings.getByLabel('视觉风格', { exact: true }).inputValue();
    await settings.getByLabel('视觉风格', { exact: true }).fill('取消放弃时必须保留的下次制作风格'); await saveProduction(settings); await expect(settings).toHaveCount(0);
    await page.getByRole('button', { name: '制作设置', exact: true }).click(); await productionStep(settings, '创作要求');
    await expect(settings.getByLabel('视觉风格', { exact: true })).toHaveValue('取消放弃时必须保留的下次制作风格');
    await settings.getByRole('button', { name: '放弃待用配置', exact: true }).click();
    const dialog = page.getByRole('alertdialog', { name: '放弃待用配置？', exact: true });
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); await expect(settings).toBeVisible();
    await expect(settings.getByLabel('视觉风格', { exact: true })).toHaveValue('取消放弃时必须保留的下次制作风格');
    await settings.getByRole('button', { name: '放弃待用配置', exact: true }).click(); await confirmAction(page, '确认放弃'); await expect(settings).toHaveCount(0);
    await page.getByRole('button', { name: '制作设置', exact: true }).click(); await productionStep(settings, '创作要求');
    await expect(settings.getByLabel('视觉风格', { exact: true })).toHaveValue(original); await expect(settings.getByRole('button', { name: '放弃待用配置', exact: true })).toHaveCount(0);
    await settings.getByRole('button', { name: '取消', exact: true }).click();
  } finally { await source.close(); }
});

test('preserves existing shot media when a replacement is canceled', async ({ page, request }, info) => {
  const originalPath = info.outputPath('original-voice.wav'), replacementPath = info.outputPath('replacement-voice.wav');
  await writeWave(originalPath); await writeWave(replacementPath, 1);
  const original = await rpc<AssetRecord>(request, 'asset.import', { path: originalPath, kind: 'audio' });
  const replacement = await rpc<AssetRecord>(request, 'asset.import', { path: replacementPath, kind: 'audio' });
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: '替换镜头素材确认' });
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: { shots: [{ id: 'replace-voice', title: '已有配音的镜头', narration: '', visualPrompt: '', durationUs: 1_000_000, audioAssetId: original.id }] } });
  const writes: string[] = []; page.on('request', request => { if (request.url().endsWith('/__desktop_rpc') && request.postDataJSON()?.method === 'asset.select') writes.push(request.postData()!); });
  await page.goto('/'); await openProjectFromList(page, project.title); await page.getByRole('button', { name: '素材库', exact: true }).click();
  await page.getByRole('button', { name: `将“${replacement.name}”用于镜头`, exact: true }).click();
  const parent = page.getByRole('dialog', { name: '应用素材到镜头', exact: true });
  await expect(parent.getByLabel('目标镜头', { exact: true })).toHaveValue('replace-voice');
  await parent.getByRole('button', { name: '应用此版本', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '替换镜头素材？', exact: true }); await expect(dialog).toContainText(replacement.name);
  await dialog.getByRole('button', { name: '取消', exact: true }).click(); await expect(parent).toBeVisible();
  expect(writes).toHaveLength(0); expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project).toEqual(project);
  await parent.getByRole('button', { name: '应用此版本', exact: true }).click(); await confirmAction(page, '确认替换'); await expect(parent).toHaveCount(0);
  const updated = (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project;
  expect(updated.shots[0].audioAssetId).toBe(replacement.id); expect(writes).toHaveLength(1);
});

test('keeps the conflicting draft and parent dialog until discard is confirmed', async ({ page, request }) => {
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: '丢弃草稿二次确认' });
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: { shots: [{ id: 'confirmation-shot', title: '原始镜头', narration: '', visualPrompt: '', durationUs: 2_000_000 }] } });
  await page.goto('/'); await openProjectFromList(page, project.title); await page.getByLabel('镜头标题', { exact: true }).fill('必须保留的本地草稿');
  const remote = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: [{ ...project.shots[0], title: '另一视图保存的镜头' }] } });
  await page.getByRole('button', { name: '比较并处理', exact: true }).click();
  const parent = page.getByRole('dialog', { name: '比较草稿与已保存内容', exact: true });
  await parent.getByRole('button', { name: '放弃草稿并重新载入', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '放弃未保存的草稿？', exact: true });
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused(); await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(parent).toBeVisible(); await expect(parent).toContainText('必须保留的本地草稿'); await expect(parent.getByRole('button', { name: '放弃草稿并重新载入', exact: true })).toBeFocused();
  await parent.getByRole('button', { name: '放弃草稿并重新载入', exact: true }).click(); await confirmAction(page, '确认放弃');
  await expect(parent).toHaveCount(0); await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue(remote.shots[0].title);
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project).toEqual(remote);
});

test('leaves shots and workflow nodes intact on cancel, including keyboard deletion', async ({ page, request }) => {
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: '镜头与流程移除确认' });
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: { shots: [0, 1].map(index => ({ id: `confirmation-${index}`, title: `保留镜头 ${index + 1}`, narration: '', visualPrompt: '', durationUs: 2_000_000 })) } });
  await page.goto('/'); await openProjectFromList(page, project.title);
  await page.getByRole('button', { name: '移除所选镜头', exact: true }).click();
  const dialog = page.getByRole('alertdialog'); await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.outline-shot')).toHaveCount(2); expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project).toEqual(project);
  await openAdvancedWorkflow(page);
  const node = page.locator('.react-flow__node').first(); await expect(node).toBeVisible(); await node.click();
  const count = await page.locator('.react-flow__node').count();
  await node.focus(); await page.keyboard.press('Delete'); await expect(dialog).toBeVisible(); await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0); await expect(page.locator('.react-flow__node')).toHaveCount(count);
  await node.focus(); await page.keyboard.press('Delete'); await confirmAction(page, '确认移除'); await expect(page.locator('.react-flow__node')).toHaveCount(count - 1);
});
