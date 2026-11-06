import { expect, test, type Page } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectDetailSchema, skillImportResultSchema, workspaceSnapshotSchema } from '@video-quickly/contracts';
import { saveProduction } from './production-settings';

const { strToU8, zipSync } = createRequire(new URL('../../packages/runtime/package.json', import.meta.url))('fflate') as typeof import('../../packages/runtime/node_modules/fflate');
const directories: string[] = [];
async function sourceDirectory() {
  const path = await mkdtemp(join(tmpdir(), 'video-quickly-skill-ui-'));
  directories.push(path); return path;
}
async function openImport(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Skill 工作室', exact: true }).click();
  await page.getByRole('button', { name: '导入 Skill', exact: true }).first().click();
  return page.getByRole('dialog', { name: '导入 Skill', exact: true });
}
test.afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

test('continues after closing the import dialog, groups every Skill and applies the group to new tasks', async ({ page, request }) => {
  const directory = await sourceDirectory(), source = join(directory, 'repository.zip');
  await writeFile(source, zipSync({
    ...Object.fromEntries(Array.from({ length: 510 }, (_, index) => ['drama-main/examples/' + index + '.md', strToU8('example')])),
    'drama-main/skills/write/SKILL.md': strToU8('---\nname: ui-drama-write\ndescription: 写作方法验收\n---\n读取 references/guide.md。'),
    'drama-main/skills/write/references/guide.md': strToU8('叙事资源验收：场景有明确目标。'),
    'drama-main/skills/storyboard/SKILL.md': strToU8('---\nname: ui-drama-storyboard\ndescription: 分镜方法验收\n---\n生成分镜。'),
  }));
  let submitted!: () => void, release!: () => void, delivered!: () => void;
  const started = new Promise<void>(resolve => { submitted = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const completed = new Promise<void>(resolve => { delivered = resolve; });
  await page.route('**/__desktop_rpc', async route => {
    if (route.request().postDataJSON()?.method !== 'skill.import.start') { await route.continue(); return; }
    const response = await route.fetch(); submitted(); await gate;
    await route.fulfill({ response }); delivered();
  });
  const dialog = await openImport(page);
  await dialog.getByRole('textbox', { name: '目录路径或 GitHub 链接' }).fill(source);
  await dialog.getByLabel('分组名称（可选）').fill('短剧方法验收');
  await dialog.getByRole('button', { name: '导入', exact: true }).click();
  await started;
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  release(); await completed;
  await page.reload();
  await page.getByRole('button', { name: 'Skill 工作室', exact: true }).click();
  const group = page.getByRole('region', { name: 'Skill 分组“短剧方法验收”', exact: true });
  await expect(group.getByRole('heading', { name: 'ui-drama-write', exact: true })).toBeVisible();
  await expect(group.getByRole('heading', { name: 'ui-drama-storyboard', exact: true })).toBeVisible();
  const snapshot = workspaceSnapshotSchema.parse((await (await request.post('/__desktop_rpc', { data: { method: 'workspace.snapshot', params: {} } })).json()).result);
  const storedGroup = snapshot.skillGroups!.find(item => item.name === '短剧方法验收')!;
  expect(storedGroup.skillIds).toHaveLength(2);
  expect(snapshot.skillImports!.find(job => job.groupId === storedGroup.id)?.status).toBe('succeeded');

  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  const creation = page.getByRole('dialog', { name: '新建视频项目', exact: true });
  await creation.getByLabel('项目名称').fill('Skill 全流程验收');
  await creation.getByText('创作 Skill（可选）', { exact: true }).click();
  await creation.getByRole('button', { name: '选用整组“短剧方法验收”', exact: true }).click();
  await expect(creation.getByText('已选 2 个', { exact: true })).toBeVisible();
  await creation.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(creation).toHaveCount(0);
  const after = workspaceSnapshotSchema.parse((await (await request.post('/__desktop_rpc', { data: { method: 'workspace.snapshot', params: {} } })).json()).result);
  const project = after.projects.find(item => item.title === 'Skill 全流程验收')!;
  for (const node of project.workflow.nodes.filter(node => ['brief', 'style', 'script'].includes(node.kind))) expect(node.skillIds).toEqual(storedGroup.skillIds);

  await page.getByRole('button', { name: '制作设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '制作设置', exact: true });
  await settings.locator('summary').filter({ hasText: /^高级设置$/ }).first().click();
  const brief = project.workflow.nodes.find(node => node.kind === 'brief')!;
  await settings.getByText(`${brief.label} Skill · 已选 2 个`, { exact: true }).click();
  const picker = settings.getByRole('group', { name: brief.label + ' Skill', exact: true });
  await picker.getByRole('searchbox').fill('ui-drama-write');
  await picker.getByRole('checkbox', { name: /^ui-drama-write/ }).uncheck();
  await saveProduction(settings);
  await expect(settings).toHaveCount(0);
  const saved = projectDetailSchema.parse((await (await request.post('/__desktop_rpc', { data: { method: 'project.get', params: { projectId: project.id } } })).json()).result).project!;
  expect(saved.workflow.nodes.find(node => node.kind === 'brief')!.skillIds).toHaveLength(1);
  expect(saved.workflow.nodes.find(node => node.kind === 'script')!.skillIds).toEqual(storedGroup.skillIds);

  await page.getByRole('button', { name: 'Skill 工作室', exact: true }).click();
  await group.getByRole('button', { name: '查看“ui-drama-write”', exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'ui-drama-write', exact: true });
  await detail.getByLabel('查看引用资源').selectOption('references/guide.md');
  await expect(detail.getByLabel('references/guide.md')).toContainText('叙事资源验收');
  await detail.getByRole('button', { name: '关闭', exact: true }).click();
});

test('retains a failed background import and retries into its group', async ({ page }) => {
  const directory = await sourceDirectory(), source = join(directory, 'retry.zip');
  await writeFile(source, zipSync({ 'README.md': strToU8('no Skill') }));
  const dialog = await openImport(page);
  await dialog.getByRole('textbox', { name: '目录路径或 GitHub 链接' }).fill(source);
  await dialog.getByLabel('分组名称（可选）').fill('导入重试验收');
  await dialog.getByRole('button', { name: '导入', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const status = page.locator('.skill-import-status');
  await expect(status.getByRole('alert')).toContainText('没有找到 SKILL.md');
  await writeFile(source, zipSync({ 'method/SKILL.md': strToU8('---\nname: ui-skill-retry\ndescription: 后台重试验收\n---\n生成剧本。') }));
  await status.getByRole('button', { name: '重试导入', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ui-skill-retry', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Skill 分组“导入重试验收”', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Skill 工作室', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ui-skill-retry', exact: true })).toBeVisible();
});

test('shows persisted switch states, prevents repeated toggles and confirms individual and group uninstall', async ({ page, request }) => {
  const directory = await sourceDirectory(), source = join(directory, '状态与卸载验收.zip');
  await writeFile(source, zipSync({
    'methods/write/SKILL.md': strToU8('---\nname: ui-switch-write\ndescription: 写作方法状态验收\n---\n生成剧本。'),
    'methods/style/SKILL.md': strToU8('---\nname: ui-switch-style\ndescription: 风格方法状态验收\n---\n固定视觉风格。'),
  }));
  const imported = skillImportResultSchema.parse((await (await request.post('/__desktop_rpc', { data: { method: 'skill.import', params: { path: source } } })).json()).result);
  if (!('skills' in imported)) throw new Error('Expected a Skill group');
  const snapshot = async () => workspaceSnapshotSchema.parse((await (await request.post('/__desktop_rpc', { data: { method: 'workspace.snapshot', params: {} } })).json()).result);
  await page.goto('/');
  await page.getByRole('button', { name: 'Skill 工作室', exact: true }).click();
  const group = page.getByRole('region', { name: 'Skill 分组“状态与卸载验收”', exact: true });
  const card = group.locator('.skill-card').filter({ has: page.getByRole('heading', { name: 'ui-switch-write', exact: true }) });
  const toggle = card.getByRole('switch', { name: '“ui-switch-write”启用状态', exact: true });
  await expect(toggle).toHaveAttribute('aria-checked', 'true'); await expect(toggle).toHaveText('已启用');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false'); await expect(toggle).toHaveText('已停用');
  expect((await snapshot()).skills.find(skill => skill.name === 'ui-switch-write')?.enabled).toBe(false);
  await page.reload(); await page.getByRole('button', { name: 'Skill 工作室', exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  let entered!: () => void, release!: () => void, requests = 0;
  const observed = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/__desktop_rpc', async route => {
    if (route.request().postDataJSON()?.method !== 'skill.toggle') { await route.continue(); return; }
    requests++; const response = await route.fetch(); entered(); await gate; await route.fulfill({ response });
  });
  await toggle.click(); await observed;
  await expect(toggle).toBeDisabled(); await expect(toggle).toHaveAttribute('aria-busy', 'true');
  release();
  await expect(toggle).toHaveAttribute('aria-checked', 'true'); await expect(toggle).toBeEnabled(); expect(requests).toBe(1);
  await page.unroute('**/__desktop_rpc');
  await group.getByRole('button', { name: '停用分组“状态与卸载验收”', exact: true }).click();
  await expect(group.getByRole('switch').first()).toHaveAttribute('aria-checked', 'false');
  await expect(group.getByRole('switch').last()).toHaveAttribute('aria-checked', 'false');
  await group.getByRole('button', { name: '启用分组“状态与卸载验收”', exact: true }).click();
  await expect(group.getByRole('switch').first()).toHaveAttribute('aria-checked', 'true');
  await expect(group.getByRole('switch').last()).toHaveAttribute('aria-checked', 'true');

  await card.getByRole('button', { name: '卸载“ui-switch-write”', exact: true }).click();
  let confirmation = page.getByRole('alertdialog');
  await expect(confirmation.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  expect((await snapshot()).skills.some(skill => skill.name === 'ui-switch-write')).toBe(true);
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(confirmation).toHaveCount(0); await expect(card).toBeVisible();
  await card.getByRole('button', { name: '卸载“ui-switch-write”', exact: true }).click();
  confirmation = page.getByRole('alertdialog');
  await confirmation.getByRole('button', { name: '卸载 Skill', exact: true }).click();
  await expect(card).toHaveCount(0); await expect(group.locator('.skill-card')).toHaveCount(1);
  await group.getByRole('button', { name: '卸载分组“状态与卸载验收”', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '卸载分组', exact: true }).click();
  await expect(group).toHaveCount(0);
  const removed = await snapshot();
  expect(removed.skills.some(skill => imported.skills.some(item => item.id === skill.id))).toBe(false);
  expect(removed.skillGroups?.some(item => item.id === imported.group.id)).toBe(false);
  await page.reload(); await page.getByRole('button', { name: 'Skill 工作室', exact: true }).click();
  await expect(group).toHaveCount(0);
});
