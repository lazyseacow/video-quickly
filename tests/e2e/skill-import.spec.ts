import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectDetailSchema, workspaceSnapshotSchema } from '@video-quickly/contracts';
import { importSkillFixture } from '../fixtures/import-skill';
import { rpc } from './native-video-fixture';
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
function skillGroup(page: Page, name: string) {
  return page.getByRole('region', { name: `Skill 分组“${name}”`, exact: true });
}
function groupDisclosure(group: Locator) {
  return group.getByRole('heading', { level: 2 }).getByRole('button');
}
test.afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

test('continues after closing the import dialog, groups every Skill and applies the group to new tasks', async ({ page, request }, info) => {
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
  const group = skillGroup(page, '短剧方法验收');
  await expect(groupDisclosure(group)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText(/^导入记录（/)).toHaveCount(0);
  await groupDisclosure(group).press('Enter');
  await expect(group.getByRole('heading', { name: 'ui-drama-write', exact: true })).toBeVisible();
  await expect(group.getByRole('heading', { name: 'ui-drama-storyboard', exact: true })).toBeVisible();
  const snapshot = workspaceSnapshotSchema.parse((await (await request.post('/__desktop_rpc', { data: { method: 'workspace.snapshot', params: {} } })).json()).result);
  const storedGroup = snapshot.skillGroups!.find(item => item.name === '短剧方法验收')!;
  expect(storedGroup.skillIds).toHaveLength(2);
  expect(snapshot.skillImports!.find(job => job.groupId === storedGroup.id)?.status).toBe('succeeded');

  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  const creation = page.getByRole('dialog', { name: '新建视频项目', exact: true });
  await creation.getByLabel('项目名称').fill('Skill 全流程验收');
  const creationPicker = creation.getByRole('group', { name: '创作 Skill（可选）', exact: true });
  const trigger = creationPicker.getByRole('button', { name: '创作 Skill（可选）', exact: true });
  const search = creationPicker.getByRole('searchbox');
  const groupEntry = creationPicker.getByRole('button', { name: /^短剧方法验收/ });
  const writeSkill = creationPicker.getByRole('checkbox', { name: /^ui-drama-write/ });
  const storyboardSkill = creationPicker.getByRole('checkbox', { name: /^ui-drama-storyboard/ });
  const selectGroup = creationPicker.getByRole('button', { name: '选用整组“短剧方法验收”', exact: true });
  await trigger.press('Enter');
  await expect(search).toBeFocused();
  await expect(groupEntry).toContainText('0 / 2');
  await expect(writeSkill).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('creation-skill-groups.png') });
  await search.fill('写作方法验收');
  await search.press('Enter');
  await groupEntry.press('Enter');
  await expect(creationPicker.getByRole('button', { name: '返回 Skill 分组', exact: true })).toBeFocused();
  await expect(storyboardSkill).toHaveCount(0);
  await writeSkill.press('Space');
  await expect(writeSkill).toBeChecked();
  await expect(trigger).toContainText('已选 1 个');
  await selectGroup.click();
  await search.fill('');
  await expect(storyboardSkill).toBeChecked();
  await creationPicker.getByRole('button', { name: '取消整组“短剧方法验收”', exact: true }).click();
  await expect(writeSkill).not.toBeChecked();
  await selectGroup.click();
  await creationPicker.getByRole('button', { name: '清空选择', exact: true }).click();
  await expect(trigger).toContainText('已选 0 个');
  await selectGroup.click();
  await expect(trigger).toContainText('已选 2 个');
  await page.screenshot({ path: info.outputPath('creation-skill-submenu.png') });
  await page.keyboard.press('Escape');
  await expect(groupEntry).toBeFocused();
  await expect(groupEntry).toContainText('2 / 2');
  await page.keyboard.press('Escape');
  await expect(search).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await creation.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(creation).toHaveCount(0);
  const after = workspaceSnapshotSchema.parse((await (await request.post('/__desktop_rpc', { data: { method: 'workspace.snapshot', params: {} } })).json()).result);
  const project = after.projects.find(item => item.title === 'Skill 全流程验收')!;
  for (const node of project.workflow.nodes.filter(node => ['brief', 'style', 'script'].includes(node.kind))) expect(node.skillIds).toEqual(storedGroup.skillIds);
  expect(project.workflow.production.agentSkillIds).toEqual(storedGroup.skillIds);

  await page.getByRole('button', { name: '制作设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '制作设置', exact: true });
  await settings.getByText('剪辑 Agent 设置', { exact: true }).click();
  await expect(settings.getByRole('button', { name: '剪辑 Agent 的 Skill', exact: true })).toContainText('已选 2 个');
  await saveProduction(settings);
  await expect(settings).toHaveCount(0);
  const saved = projectDetailSchema.parse((await (await request.post('/__desktop_rpc', { data: { method: 'project.get', params: { projectId: project.id } } })).json()).result).project!;
  for (const node of saved.workflow.nodes.filter(node => ['brief', 'style', 'script'].includes(node.kind))) expect(node.skillIds).toEqual(storedGroup.skillIds);
  expect(saved.workflow.production).toMatchObject({ agentSkillIds: storedGroup.skillIds, agentMcpServerIds: [] });

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
  const group = skillGroup(page, '导入重试验收');
  await groupDisclosure(group).click();
  await expect(group.getByRole('heading', { name: 'ui-skill-retry', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Skill 工作室', exact: true }).click();
  await groupDisclosure(group).click();
  await expect(group.getByRole('heading', { name: 'ui-skill-retry', exact: true })).toBeVisible();
});

test('expands groups independently and restores their layout when clearing search', async ({ page, request }) => {
  const directory = await sourceDirectory();
  for (const [name, names] of [['折叠验收甲', ['ui-disclosure-write']], ['折叠验收乙', ['ui-disclosure-color', 'ui-disclosure-style']]] as const) {
    const source = join(directory, name + '.zip');
    await writeFile(source, zipSync(Object.fromEntries(names.map(skill => [
      `methods/${skill}/SKILL.md`, strToU8(`---\nname: ${skill}\ndescription: 分组展开验收\n---\n保持项目设定。`),
    ]))));
    await importSkillFixture((method, params) => rpc(request, method, params), { path: source });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Skill 工作室', exact: true }).click();
  const first = skillGroup(page, '折叠验收甲'), second = skillGroup(page, '折叠验收乙');
  const firstDisclosure = groupDisclosure(first), secondDisclosure = groupDisclosure(second);
  const writing = first.getByRole('heading', { name: 'ui-disclosure-write', exact: true });
  const color = second.getByRole('heading', { name: 'ui-disclosure-color', exact: true });
  const style = second.getByRole('heading', { name: 'ui-disclosure-style', exact: true });
  await expect(firstDisclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(writing).toBeHidden();
  await expect(secondDisclosure).toHaveAttribute('aria-expanded', 'false');
  const borders = await page.locator('.skill-studio-groups').evaluate(list => {
    const groups = [...list.querySelectorAll('.skill-studio-group')];
    const tools = list.nextElementSibling!;
    const top = (element: Element) => parseFloat(getComputedStyle(element).borderTopWidth);
    const bottom = (element: Element) => parseFloat(getComputedStyle(element).borderBottomWidth);
    return [...groups.slice(1).map((group, index) => bottom(groups[index]) + top(group)), bottom(groups.at(-1)!) + top(tools)];
  });
  expect(borders).toEqual(borders.map(() => 1));
  await firstDisclosure.press('Enter');
  await secondDisclosure.press('Space');
  await expect(writing).toBeVisible();
  await expect(color).toBeVisible();
  const card = first.locator('.skill-card');
  const cardLayout = () => card.evaluate(element => {
    const content = element.querySelector('.list-card__body')!.getBoundingClientRect();
    const actions = element.querySelector('.list-card__actions')!.getBoundingClientRect();
    return { beside: actions.left >= content.right, below: actions.top >= content.bottom };
  });
  await expect.poll(cardLayout).toMatchObject({ below: true });
  await page.setViewportSize({ width: 1024, height: 720 });
  await expect.poll(cardLayout).toMatchObject({ beside: true, below: false });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.locator('.page-body').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await secondDisclosure.click();
  await expect(writing).toBeVisible();
  await expect(color).toBeHidden();

  const search = page.getByRole('searchbox', { name: '搜索 Skill 或分组', exact: true });
  await search.fill('ui-disclosure-color');
  await expect(first).toHaveCount(0);
  await expect(color).toBeVisible();
  await expect(style).toBeHidden();
  await secondDisclosure.press('Enter');
  await expect(color).toBeHidden();
  await search.fill('折叠验收乙');
  await expect(color).toBeVisible();
  await expect(style).toBeVisible();
  await search.clear();
  await expect(writing).toBeVisible();
  await expect(secondDisclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(color).toBeHidden();
});

test('shows persisted switch states, prevents repeated toggles and confirms individual and group uninstall', async ({ page, request }) => {
  const directory = await sourceDirectory(), source = join(directory, '状态与卸载验收.zip');
  await writeFile(source, zipSync({
    'methods/write/SKILL.md': strToU8('---\nname: ui-switch-write\ndescription: 写作方法状态验收\n---\n生成剧本。'),
    'methods/style/SKILL.md': strToU8('---\nname: ui-switch-style\ndescription: 风格方法状态验收\n---\n固定视觉风格。'),
  }));
  const imported = await importSkillFixture((method, params) => rpc(request, method, params), { path: source });
  const snapshot = async () => workspaceSnapshotSchema.parse((await (await request.post('/__desktop_rpc', { data: { method: 'workspace.snapshot', params: {} } })).json()).result);
  await page.goto('/');
  await page.getByRole('button', { name: 'Skill 工作室', exact: true }).click();
  const group = skillGroup(page, '状态与卸载验收');
  const disclosure = groupDisclosure(group);
  await disclosure.click();
  const card = group.locator('.skill-card').filter({ has: page.getByRole('heading', { name: 'ui-switch-write', exact: true }) });
  const toggle = card.getByRole('switch', { name: '“ui-switch-write”启用状态', exact: true });
  await expect(toggle).toHaveAttribute('aria-checked', 'true'); await expect(toggle).toHaveText('已启用');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false'); await expect(toggle).toHaveText('已停用');
  expect((await snapshot()).skills.find(skill => skill.name === 'ui-switch-write')?.enabled).toBe(false);
  await page.reload(); await page.getByRole('button', { name: 'Skill 工作室', exact: true }).click();
  await disclosure.click();
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
  await disclosure.click();
  await group.getByRole('button', { name: '停用分组“状态与卸载验收”', exact: true }).click();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(disclosure).toContainText('已启用 0 个');
  await disclosure.click();
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
