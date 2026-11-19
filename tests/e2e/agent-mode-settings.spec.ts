import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { ModelProfile, ProjectDocument, RunSummary } from '@video-quickly/contracts';
import { importSkillFixture } from '../fixtures/import-skill';
import { planningFixtureResponse, storyboardFixtureResponse } from '../fixtures/planning-response';
import { test } from './isolated-workspace';
import { openProduction, pickProductionModel, productionFixture, productionStep, saveProduction } from './production-settings';
import { rpc } from './native-video-fixture';
import { openProjectFromList } from './workspace-navigation';

const { strToU8, zipSync } = createRequire(new URL('../../src/packages/runtime/package.json', import.meta.url))('fflate') as typeof import('../../src/packages/runtime/node_modules/fflate');
const creationIds = ['screenplay', 'brief', 'style', 'script'];

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 1024, height: 720, theme: 'light' }, { width: 390, height: 844, theme: 'light' }]) test(`edits creation Skills without separate editing Agent controls at ${viewport.width}px`, async ({ page, request }, info) => {
  const source = await productionFixture(request), errors: string[] = [], methods: string[] = [];
  const model = await rpc<ModelProfile>(request, 'model.save', { model: { ...source.text, id: undefined, name: `工具模型 ${source.project.id}`, capabilities: ['text', 'tools'] } });
  const local = await rpc<ModelProfile>(request, 'model.save', { model: { ...source.text, id: undefined, name: `本地模型 ${source.project.id}`, provider: 'ollama' } });
  const prefix = `agent-capability-${source.project.id.slice(0, 8)}`;
  const skillNames = Array.from({ length: 13 }, (_, index) => `${prefix}-${String(index + 1).padStart(2, '0')}`);
  const skillPath = info.outputPath('agent-capabilities.zip');
  const longDescription = '从短剧分镜提取人物、场景与道具，记录关键动作、声音和镜头之间的连续性。'.repeat(5);
  await writeFile(skillPath, zipSync(Object.fromEntries(skillNames.map(name => [`${name}/SKILL.md`, strToU8(`---\nname: ${name}\ndescription: ${name === skillNames[0] ? longDescription : '当前任务可选择的制作方法'}\n---\n根据视频主题组织内容。`)]))));
  const { group, skills } = await importSkillFixture((method, params) => rpc(request, method, params), { path: skillPath });
  const siblingPath = info.outputPath('sound-skills.zip');
  await writeFile(siblingPath, zipSync({ 'sound/SKILL.md': strToU8(`---\nname: ${prefix}-sound\ndescription: 声音剪辑方法\n---\n保留镜头声音。`) }));
  const { group: sibling } = await importSkillFixture((method, params) => rpc(request, method, params), { path: siblingPath });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  page.on('request', request => { if (request.url().endsWith('/__desktop_rpc')) methods.push(request.postDataJSON()?.method); });
  await page.setViewportSize(viewport); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
  const dialog = await openProduction(page, source.project); await productionStep(dialog, '模型与素材');
  await expect(page).toHaveTitle('Video Quickly · 视频创作工作台');
  await expect(dialog.getByLabel('制作方式', { exact: true })).toHaveCount(0);
  await pickProductionModel(dialog, '文本模型', local);
  await pickProductionModel(dialog, '视频模型', source.video);
  const materials = dialog.getByRole('region', { name: '模型与素材', exact: true });
  await expect(materials.getByText('剪辑 Agent 设置', { exact: true })).toHaveCount(0);
  expect(methods).not.toContain('tool.list');
  await page.screenshot({ path: info.outputPath(`agent-models-${viewport.width}.png`) });

  await productionStep(dialog, '创作要求');
  await expect(dialog.getByText(/剪辑 Agent|工具自动选择/)).toHaveCount(0);
  await pickProductionModel(dialog, '文本模型', model);
  await productionStep(dialog, '创作要求');
  const skillPicker = dialog.getByRole('group', { name: '创作 Skill', exact: true });
  const skillTrigger = skillPicker.getByRole('button', { name: '创作 Skill', exact: true });
  const skillGroups = skillPicker.getByRole('list', { name: 'Skill 分组', exact: true });
  const skillGroup = skillGroups.getByRole('button', { name: new RegExp(`^${group.name}`) });
  const groupCheck = skillGroups.getByRole('checkbox', { name: `选用整组“${group.name}”`, exact: true });
  const siblingGroup = skillGroups.getByRole('button', { name: new RegExp(`^${sibling.name}`) });
  const skillMembers = skillGroups.getByRole('list', { name: `${group.name}中的 Skill`, exact: true });
  const skillSearch = skillPicker.getByRole('searchbox');
  await skillTrigger.press('Enter');
  await expect(skillTrigger).toHaveAttribute('aria-expanded', 'true');
  await expect(skillSearch).toBeFocused();
  await expect(skillSearch).toBeInViewport({ ratio: 1 });
  await expect(skillTrigger).toContainText('已选 0 个');
  await expect(skillPicker.getByText('Skill 脚本需单独启用。', { exact: false })).toHaveCount(0);
  await skillGroups.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath(`agent-skill-dropdown-${viewport.width}.png`) });
  await skillSearch.fill(prefix);
  await groupCheck.press('Space');
  await expect(groupCheck).toBeChecked();
  await expect(skillTrigger).toContainText(`已选 ${skillNames.length} 个`);
  await expect(skillGroup).toHaveAttribute('aria-expanded', 'false');
  await groupCheck.press('Space');
  await expect(groupCheck).not.toBeChecked();
  await expect(skillTrigger).toContainText('已选 0 个');
  await skillGroup.press('Enter');
  await expect(skillGroup).toHaveAttribute('aria-expanded', 'true');
  await expect(skillPicker).toBeInViewport({ ratio: 1 });
  await expect(siblingGroup).toBeVisible();
  for (const name of skillNames) await expect(skillMembers.getByRole('checkbox', { name: new RegExp(name) })).not.toBeChecked();
  const firstSkill = skillMembers.getByRole('checkbox', { name: new RegExp(skillNames[0]) });
  await firstSkill.check(); await skillMembers.getByRole('checkbox', { name: new RegExp(skillNames[1]) }).check();
  await expect(groupCheck).toHaveJSProperty('indeterminate', true);
  const description = skillMembers.getByText(longDescription, { exact: true });
  await expect(description).toHaveCSS('white-space', 'nowrap');
  await expect(description).toHaveCSS('text-overflow', 'ellipsis');
  expect(await description.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await description.hover();
  const tooltip = dialog.getByRole('tooltip');
  await expect(tooltip).toHaveText(longDescription);
  await expect(tooltip).toBeInViewport({ ratio: 1 });
  expect(await tooltip.evaluate(element => element.closest('.skill-picker__list') === null)).toBe(true);
  await page.screenshot({ path: info.outputPath(`agent-skill-description-${viewport.width}.png`) });
  await page.mouse.move(1, 1);
  await expect(tooltip).toHaveCount(0);
  await firstSkill.press('Tab');
  await expect(description).toBeFocused();
  await expect(tooltip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tooltip).toHaveCount(0);
  await expect(skillGroup).toHaveAttribute('aria-expanded', 'true');
  const lastSkill = skillMembers.getByRole('checkbox', { name: new RegExp(skillNames[skillNames.length - 1]) });
  await lastSkill.scrollIntoViewIfNeeded();
  await expect.poll(() => skillGroups.evaluate(list => list.scrollTop)).toBeGreaterThan(0);
  await expect(lastSkill).toBeInViewport({ ratio: 1 });
  await expect(skillGroup).toBeInViewport({ ratio: 1 });
  await expect(skillSearch).toBeInViewport({ ratio: 1 });
  await firstSkill.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath(`agent-skill-groups-${viewport.width}.png`) });
  await firstSkill.press('Escape');
  await expect(skillGroup).toBeFocused();
  await expect(skillMembers).toHaveCount(0);
  await skillGroup.press('Escape');
  await expect(skillTrigger).toBeFocused();
  await expect(skillTrigger).toHaveAttribute('aria-expanded', 'false');
  await expect(dialog.getByRole('group', { name: /工具连接/ })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath(`creation-skills-${viewport.width}.png`) });
  await productionStep(dialog, '确认保存');
  await expect(dialog.getByText('制作方式', { exact: true })).toHaveCount(0);
  const review = dialog.getByRole('region', { name: '确认保存', exact: true });
  await expect(review.getByText(/剪辑 Agent|工具自动选择/)).toHaveCount(0);
  await saveProduction(dialog); await expect(dialog).toHaveCount(0);
  const saved = await source.saved(); expect(saved.workflow.production).not.toHaveProperty('executionMode');
  const selected = skillNames.slice(0, 2).map(name => skills.find(skill => skill.name === name)!.id);
  expect(saved.workflow.nodes.filter(node => creationIds.includes(node.id)).map(node => node.skillIds)).toEqual(creationIds.map(() => selected));
  expect(saved.workflow.nodes.filter(node => !creationIds.includes(node.id)).map(node => ({ id: node.id, skillIds: node.skillIds }))).toEqual(source.project.workflow.nodes.filter(node => !creationIds.includes(node.id)).map(node => ({ id: node.id, skillIds: node.skillIds })));
  expect(saved.workflow.nodes.map(node => node.id)).toEqual(source.project.workflow.nodes.map(node => node.id));
  await page.reload(); await openProjectFromList(page, source.project.title); await page.getByRole('button', { name: '制作设置', exact: true }).click();
  await productionStep(dialog, '模型与素材');
  await pickProductionModel(dialog, '文本模型', local);
  await saveProduction(dialog); await expect(dialog).toHaveCount(0);
  const changedModel = await source.saved(); expect(changedModel.workflow.production.textModelId).toBe(local.id);
  expect(changedModel.workflow.nodes.map(node => node.skillIds)).toEqual(saved.workflow.nodes.map(node => node.skillIds));
  await page.getByRole('button', { name: '制作设置', exact: true }).click();
  await productionStep(dialog, '创作要求');
  await skillTrigger.click();
  await skillPicker.getByRole('searchbox').fill(prefix);
  await skillGroup.click();
  await expect(skillPicker.getByRole('checkbox', { name: new RegExp(skillNames[0]) })).toBeChecked();
  await expect(skillPicker.getByRole('checkbox', { name: new RegExp(skillNames[1]) })).toBeChecked();
  await expect(skillPicker.getByRole('checkbox', { name: new RegExp(skillNames[2]) })).not.toBeChecked();
  await skillTrigger.click();
  expect(methods).not.toContain('tool.list');
  expect(methods).not.toContain('run.start'); expect(errors).toEqual([]);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('preserves mixed task Skills until explicit additions, removals and clearing', async ({ page, request }, info) => {
  const source = await productionFixture(request), workflow = source.project.workflow;
  const archive = info.outputPath('creation-skills.zip');
  const names = ['shared-method', 'brief-method', 'style-method', 'new-method'];
  await writeFile(archive, zipSync(Object.fromEntries(names.map(name => [`${name}/SKILL.md`, strToU8(`---\nname: ${name}\ndescription: 分步骤创作方法\n---\n保持镜头叙事连续。`)]))));
  const { group, skills } = await importSkillFixture((method, params) => rpc(request, method, params), { path: archive });
  const ids = names.map(name => skills.find(skill => skill.name === name)!.id);
  const bindings: Record<string, string[]> = { screenplay: [ids[0]], brief: [ids[0], ids[1]], style: [ids[2], ids[0]], script: [ids[0]] };
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: source.project.id, revision: source.project.revision, patch: { workflow: {
    ...workflow,
    nodes: workflow.nodes.map(node => bindings[node.id] ? { ...node, skillIds: bindings[node.id] } : node),
  } } });
  const dialog = await openProduction(page, project);
  await pickProductionModel(dialog, '文本模型', source.text);
  await pickProductionModel(dialog, '视频模型', source.video);
  await productionStep(dialog, '创作要求');
  const picker = dialog.getByRole('group', { name: '创作 Skill', exact: true });
  const trigger = picker.getByRole('button', { name: '创作 Skill', exact: true });
  await expect(trigger).toContainText('分步骤设置 · 共 3 个');
  await trigger.click(); await expect(picker).toContainText('勾选会加入全部创作步骤');
  await picker.getByRole('button', { name: new RegExp(`^${group.name}`) }).click();
  await expect(picker.getByRole('checkbox', { name: /^shared-method/ })).toBeChecked();
  await expect(picker.getByRole('checkbox', { name: /^brief-method/ })).toBeChecked();
  await expect(picker.getByRole('checkbox', { name: /^style-method/ })).toBeChecked();
  await expect(picker.getByRole('checkbox', { name: /^new-method/ })).not.toBeChecked();
  expect((await source.saved()).workflow.nodes.map(node => node.skillIds)).toEqual(project.workflow.nodes.map(node => node.skillIds));
  await saveProduction(dialog); await expect(dialog).toHaveCount(0);
  expect((await source.saved()).workflow.nodes.map(node => node.skillIds)).toEqual(project.workflow.nodes.map(node => node.skillIds));

  await page.getByRole('button', { name: '制作设置', exact: true }).click();
  await productionStep(dialog, '创作要求');
  await trigger.click();
  await picker.getByRole('button', { name: new RegExp(`^${group.name}`) }).click();
  await picker.getByRole('checkbox', { name: /^new-method/ }).check();
  await picker.getByRole('checkbox', { name: /^shared-method/ }).uncheck();
  expect((await source.saved()).workflow.nodes.map(node => node.skillIds)).toEqual(project.workflow.nodes.map(node => node.skillIds));
  await saveProduction(dialog); await expect(dialog).toHaveCount(0);
  const changed = await source.saved();
  for (const node of changed.workflow.nodes.filter(node => creationIds.includes(node.id))) expect(node.skillIds).toEqual([...bindings[node.id].filter(id => id !== ids[0]), ids[3]]);

  await page.getByRole('button', { name: '制作设置', exact: true }).click();
  await productionStep(dialog, '创作要求'); await expect(trigger).toContainText('分步骤设置 · 共 3 个'); await trigger.click();
  await picker.getByRole('button', { name: '清空选择', exact: true }).click();
  await expect(trigger).toContainText('已选 0 个');
  await saveProduction(dialog); await expect(dialog).toHaveCount(0);
  expect((await source.saved()).workflow.nodes.filter(node => creationIds.includes(node.id)).map(node => node.skillIds)).toEqual(creationIds.map(() => []));

  await page.getByRole('button', { name: '制作设置', exact: true }).click();
  await productionStep(dialog, '创作要求'); await expect(trigger).toContainText('已选 0 个');
});

test('uses the saved creation Skill in real screenplay, brief, style and storyboard draft requests', async ({ page, request }, info) => {
  const source = await productionFixture(request), calls: string[] = [], errors: string[] = [];
  const marker = '创作Skill验收：每场用可见行动体现人物动机。';
  const server = createServer({ keepAliveTimeout: 0 }, async (incoming, response) => {
    let encoded = ''; for await (const part of incoming) encoded += part.toString();
    calls.push(encoded);
    const payload = JSON.parse(encoded) as { messages: Array<{ content: string }> };
    const prompt = payload.messages[0].content;
    const content = prompt.includes('自动视频制作步骤：旁白与分镜')
      ? storyboardFixtureResponse(prompt, JSON.stringify({ shots: [{ title: '信封', narration: '她展开信纸。', visualPrompt: '书桌上的信封', durationUs: 4_000_000 }] }))
      : planningFixtureResponse(prompt, '第一场 · 清晨书房\n林夏展开一封未寄出的信。');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('本地创作模型未启动');
  page.on('pageerror', error => errors.push(error.message));
  try {
    const model = await rpc<ModelProfile>(request, 'model.save', { model: { ...source.text, id: undefined, name: `本地创作验收 ${source.project.id}`, baseUrl: `http://127.0.0.1:${address.port}/v1` } });
    const archive = info.outputPath('creation-request-skill.zip');
    await writeFile(archive, zipSync({ 'evidence/SKILL.md': strToU8(`---\nname: request-evidence\ndescription: 检查本集创作Skill\n---\n${marker}`) }));
    const { group, skills } = await importSkillFixture((method, params) => rpc(request, method, params), { path: archive });
    const dialog = await openProduction(page, source.project);
    await pickProductionModel(dialog, '文本模型', model); await pickProductionModel(dialog, '视频模型', source.video);
    await productionStep(dialog, '创作要求');
    const picker = dialog.getByRole('group', { name: '创作 Skill', exact: true });
    await picker.getByRole('button', { name: '创作 Skill', exact: true }).click();
    await picker.getByRole('checkbox', { name: `选用整组“${group.name}”`, exact: true }).check();
    await saveProduction(dialog); await expect(dialog).toHaveCount(0);
    const project = await source.saved();
    for (const id of creationIds) {
      const node = project.workflow.nodes.find(node => node.id === id)!;
      expect(node.skillIds).toEqual([skills[0].id]);
      const before = calls.length;
      const run = await rpc<RunSummary>(request, 'planning.prefill.start', { requestId: randomUUID(), projectId: project.id, projectRevision: project.revision,
        node: { ...node, modelId: model.id }, context: { originalText: project.originalText } });
      await expect.poll(async () => (await rpc<RunSummary>(request, 'run.get', { runId: run.id })).status).toBe('succeeded');
      expect(calls.length, `${id} must call the local model`).toBeGreaterThan(before);
      for (const body of calls.slice(before)) expect(body, `${id} must include the selected Skill`).toContain(marker);
    }
    expect((await source.saved()).workflow.nodes.map(node => node.skillIds)).toEqual(project.workflow.nodes.map(node => node.skillIds));
    expect((await source.saved()).originalText).toBe(project.originalText);
    expect(errors).toEqual([]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('keeps custom Agent Skill configuration without MCP management or bindings', async ({ page, request }, info) => {
  const source = await productionFixture(request), methods: string[] = [];
  const archive = info.outputPath('custom-agent-skill.zip');
  await writeFile(archive, zipSync({
    'agent/SKILL.md': strToU8('---\nname: agent-method\ndescription: 自定义任务方法\n---\n按用户要求核对生成结果。'),
    'agent/scripts/check.mjs': strToU8('process.stdout.write("local-skill")'),
    'agent/scripts/check.py': strToU8('print("unsupported-fixture")'),
  }));
  const { group, skills } = await importSkillFixture((method, params) => rpc(request, method, params), { path: archive });
  const model = await rpc<ModelProfile>(request, 'model.save', { model: { ...source.text, id: undefined, name: '自定义工具模型', capabilities: ['text', 'tools'] } });
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: source.project.id, revision: source.project.revision, patch: { workflow: { ...source.project.workflow, id: `agent-task-${source.project.id}`, stages: undefined, production: { ...source.project.workflow.production, textModelId: model.id }, nodes: [{ id: 'agent-task', kind: 'agent', label: '独立 Agent 任务', modelId: model.id, prompt: '保留自定义任务要求。' }], edges: [] } } });
  page.on('request', request => { if (request.url().endsWith('/__desktop_rpc')) methods.push(request.postDataJSON()?.method); });
  const dialog = await openProduction(page, project);
  await expect(dialog.getByRole('group', { name: '创作 Skill', exact: true })).toHaveCount(0);
  await dialog.locator('[data-production-step="planning"] > .production-settings__advanced > summary').click();
  await expect(dialog.getByRole('group', { name: /工具连接/ })).toHaveCount(0);
  await dialog.getByRole('button', { name: '更多操作', exact: true }).click();
  const picker = dialog.getByRole('group', { name: '独立 Agent 任务 Skill', exact: true });
  await picker.getByRole('button', { name: '独立 Agent 任务 Skill', exact: true }).click();
  await picker.getByRole('searchbox').fill('agent-method');
  await picker.getByRole('button', { name: new RegExp(`^${group.name}`) }).click();
  await picker.getByRole('checkbox', { name: /^agent-method/ }).check();
  expect((await source.saved()).workflow.nodes[0].skillIds).toEqual([]);
  await saveProduction(dialog); await expect(dialog).toHaveCount(0);
  expect((await source.saved()).workflow.nodes[0]).toMatchObject({ kind: 'agent', prompt: '保留自定义任务要求。', skillIds: [skills[0].id] });
  expect((await source.saved()).workflow.nodes[0].config).not.toHaveProperty('mcpServerIds');
  await page.getByRole('button', { name: 'Skill 工作室', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Skill 工作室', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '工具连接', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '添加工具连接', exact: true })).toHaveCount(0);
  await page.getByRole('searchbox', { name: '搜索 Skill 或分组', exact: true }).fill('agent-method');
  await page.getByRole('button', { name: '查看“agent-method”', exact: true }).click();
  const details = page.getByRole('dialog', { name: 'agent-method', exact: true });
  const unsupported = details.locator('.skill-tools .field-inline').filter({ has: page.getByText('scripts/check.py', { exact: true }) });
  await expect(unsupported).toBeVisible();
  await expect(unsupported.getByText('暂不支持', { exact: true })).toBeVisible();
  await expect(details.getByRole('checkbox', { name: /scripts\/check\.py/ })).toHaveCount(0);
  const permission = details.getByRole('checkbox', { name: /scripts\/check\.mjs/ });
  await expect(permission).not.toBeChecked();
  const toggle = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.method === 'skill.tool.toggle');
  await permission.click();
  expect((await (await toggle).json()).result.tools).toEqual(expect.arrayContaining([{ id: 'scripts/check.mjs', label: 'scripts/check.mjs', enabled: true, permissions: ['execute', 'project-files'] }]));
  await expect(permission).toBeChecked();
  expect(methods.filter(method => method.startsWith('tool.'))).toEqual([]);
});
