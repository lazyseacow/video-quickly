import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { createHistoryWorkflow, createSceneTemplate, type ModelProfile, type ProjectDocument, type RunInspection, type RunSummary } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }), payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function saved(request: APIRequestContext, projectId: string) { return (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId })).project; }
async function reopen(page: Page, title: string) {
  await page.reload(); await page.getByRole('button', { name: '我的项目', exact: true }).click(); await page.getByLabel('搜索项目', { exact: true }).fill(title);
  await page.locator('.project-card').filter({ hasText: title }).getByRole('button', { name: '继续创作', exact: true }).click(); await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(title);
}
function observe(page: Page) {
  const writes: string[] = [], errors: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/__desktop_rpc')) { const method = request.postDataJSON()?.method; if (['project.create', 'project.update', 'workflow.save', 'run.start', 'run.review', 'model.save', 'render.export'].includes(method)) writes.push(method); } });
  page.on('pageerror', error => errors.push(error.message)); page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); }); return { writes, errors };
}
async function models(request: APIRequestContext) {
  const result: Record<string, ModelProfile> = {};
  for (const [name, capability] of [['brief', 'text'], ['style', 'text'], ['script', 'text'], ['assets', 'image'], ['voice', 'tts'], ['asr', 'asr'], ['animation', 'video']] as const) result[name] = await rpc<ModelProfile>(request, 'model.save', { model: { name: `阶段${name} ${randomUUID().slice(0, 8)}`, provider: 'openai-compatible', model: `stage-${name}`, baseUrl: 'http://127.0.0.1:1/v1', capabilities: [capability] } });
  return result;
}
async function leaf(dialog: Locator, label: string) {
  await dialog.getByRole('tab', { name: label, exact: true }).click(); const group = dialog.getByRole('group', { name: label, exact: true }); await expect(group).toBeVisible(); return group;
}
async function configure(dialog: Locator, label: string, model: ModelProfile, prompt: string) {
  const group = await leaf(dialog, label); await group.getByLabel(`${label}使用模型`, { exact: true }).selectOption(model.id); await group.getByLabel(`${label}提示词与补充要求`, { exact: true }).fill(prompt); return group;
}

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }] as const) {
  test.describe(`generic workflow stages at ${viewport.width}px in ${viewport.theme}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, reducedMotion: 'reduce', storageState: async ({ baseURL }, use) => {
      if (!baseURL) throw new Error('阶段测试需要本地工作区地址');
      await use({ cookies: [], origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: 'vq-theme', value: viewport.theme }, { name: 'vq-onboarding-v1', value: 'done' }] }] });
    } });
    test('creates four generic stages, saves independent task models once and retains every input after a failed grouped save', async ({ page, request }, info) => {
      const connections = await models(request), observed = observe(page), title = `通用四阶段 ${randomUUID().slice(0, 8)}`;
      await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      await page.getByRole('complementary', { name: '工作空间导航', exact: true }).getByRole('button', { name: '新建项目', exact: true }).click();
      const create = page.getByRole('dialog', { name: '新建视频项目', exact: true }); await create.getByLabel('项目名称', { exact: true }).fill(title); await create.getByLabel('创意简报', { exact: true }).fill('向第一次使用的观众演示如何整理桌面。');
      const created = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.method === 'project.create');
      await create.getByRole('button', { name: '创建项目', exact: true }).click(); const project: ProjectDocument = (await (await created).json()).result;
      await expect(create).toHaveCount(0); await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(title); await expect(page.locator('html')).toHaveAttribute('data-theme', viewport.theme);
      expect(project.templateId).toBe('generic'); expect(project.workflow.nodes).toHaveLength(8); expect(project.workflow.nodes.some(node => node.kind === 'research')).toBe(false); expect(project.workflow.stages).toHaveLength(4);
      const guide = page.getByRole('region', { name: '制作指引', exact: true });
      expect(await guide.locator('button[aria-label^="配置阶段："]').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))).toEqual(['配置阶段：策划与分镜', '配置阶段：素材与配音', '配置阶段：剪辑与动画', '配置阶段：审阅与导出']);
      await guide.getByRole('button', { name: '配置阶段：策划与分镜', exact: true }).click(); const planning = page.getByRole('dialog', { name: '策划与分镜', exact: true });
      for (const [id, label] of [['brief', '创意简报'], ['style', '风格与角色'], ['script', '旁白与分镜']] as const) {
        const group = await configure(planning, label, connections[id], `独立${id}输入，不替换其他子任务。`);
        for (const incompatible of ['assets', 'voice', 'asr', 'animation']) await expect(group.getByLabel(`${label}使用模型`, { exact: true }).locator(`option[value="${connections[incompatible].id}"]`)).toHaveCount(0);
      }
      const style = await leaf(planning, '风格与角色'); await expect(style.getByLabel('风格与角色使用模型', { exact: true })).toHaveValue(connections.style.id); await expect(style.getByLabel('风格与角色完成后等待人工审阅', { exact: true })).not.toBeChecked();
      const script = await leaf(planning, '旁白与分镜'); await expect(script.getByLabel('旁白与分镜使用模型', { exact: true })).toHaveValue(connections.script.id); await expect(script.getByLabel('旁白与分镜完成后等待人工审阅', { exact: true })).toBeChecked();
      const savePlanning = planning.getByRole('button', { name: '保存阶段配置', exact: true }); await expect(savePlanning).toBeInViewport({ ratio: 1 }); await expect(planning.locator('.dialog__surface')).toHaveCSS('opacity', '1'); await page.screenshot({ path: info.outputPath(`planning-${viewport.theme}-${viewport.width}.png`) });
      expect(observed.writes).toEqual(['project.create']); await savePlanning.click(); await expect(planning).toHaveCount(0);
      const planned = await saved(request, project.id); expect(planned.revision).toBe(project.revision + 1); expect(observed.writes).toEqual(['project.create', 'project.update']);
      for (const id of ['brief', 'style', 'script']) expect(planned.workflow.nodes.find(node => node.id === id)).toMatchObject({ modelId: connections[id].id, prompt: `独立${id}输入，不替换其他子任务。` });
      await guide.getByRole('button', { name: '配置阶段：素材与配音', exact: true }).click(); const materials = page.getByRole('dialog', { name: '素材与配音', exact: true });
      for (const [id, label] of [['assets', '画面素材'], ['voice', '配音与字幕']] as const) {
        const group = await configure(materials, label, connections[id], `保留${id}失败重试输入。`);
        for (const incompatible of ['brief', 'asr', 'animation', id === 'assets' ? 'voice' : 'assets']) await expect(group.getByLabel(`${label}使用模型`, { exact: true }).locator(`option[value="${connections[incompatible].id}"]`)).toHaveCount(0);
      }
      let failed = false;
      await page.route('**/__desktop_rpc', async route => { if (!failed && route.request().postDataJSON()?.method === 'project.update') { failed = true; await route.fulfill({ json: { error: '隔离的阶段保存失败' } }); return; } await route.continue(); });
      await materials.getByRole('button', { name: '保存阶段配置', exact: true }).click(); await expect(page.getByText('隔离的阶段保存失败', { exact: true })).toBeVisible(); await expect(materials).toBeVisible(); expect(await saved(request, project.id)).toEqual(planned);
      for (const [id, label] of [['assets', '画面素材'], ['voice', '配音与字幕']] as const) { const group = await leaf(materials, label); await expect(group.getByLabel(`${label}使用模型`, { exact: true })).toHaveValue(connections[id].id); await expect(group.getByLabel(`${label}提示词与补充要求`, { exact: true })).toHaveValue(`保留${id}失败重试输入。`); }
      await materials.getByRole('button', { name: '保存阶段配置', exact: true }).click(); await expect(materials).toHaveCount(0); const finished = await saved(request, project.id);
      expect(finished.revision).toBe(planned.revision + 1); expect(finished.workflow.stages).toEqual(project.workflow.stages);
      for (const id of ['assets', 'voice']) expect(finished.workflow.nodes.find(node => node.id === id)).toMatchObject({ modelId: connections[id].id, prompt: `保留${id}失败重试输入。` });
      expect(observed.writes).toEqual(['project.create', 'project.update', 'project.update', 'project.update']); expect((await rpc<{ items: unknown[] }>(request, 'run.list', { projectId: project.id })).items).toEqual([]);
      await reopen(page, title); await expect(page.getByRole('region', { name: '制作指引', exact: true }).locator('button[aria-label^="配置阶段："]')).toHaveCount(4);
      await guide.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`four-stages-${viewport.theme}-${viewport.width}.png`) });
      expect(await saved(request, project.id)).toEqual(finished); expect(observed.errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1);
    });
  });
}

test('preserves ungrouped legacy cards, optional research configuration and the stored workflow after reopening', async ({ page, request }) => {
  const project = await rpc<ProjectDocument>(request, 'project.create', { title: `旧九步流程 ${randomUUID().slice(0, 8)}`, templateId: 'history-handdrawn', brief: '保留既有资料核验与人工审阅。' }); expect(project.workflow).toEqual(createHistoryWorkflow());
  const observed = observe(page); await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/'); await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
  const guide = page.getByRole('region', { name: '制作指引', exact: true }); await expect(guide.locator('button[aria-label^="配置阶段："]')).toHaveCount(0); await expect(guide.locator('button[aria-label^="配置步骤："]')).toHaveCount(9);
  await guide.getByRole('button', { name: '配置步骤：资料与史实', exact: true }).click(); const research = page.getByRole('dialog', { name: '资料与史实', exact: true }); await expect(research).toBeVisible();
  await research.getByRole('button', { name: '取消', exact: true }).click(); await reopen(page, project.title);
  expect(await saved(request, project.id)).toEqual(project); expect(observed.writes).toEqual([]); expect(observed.errors).toEqual([]);
});

test('shows frozen stage progress for a real scoped local review after the current workflow changes', async ({ page, request }, info) => {
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: `冻结阶段进度 ${randomUUID().slice(0, 8)}`, brief: '只审阅已有本地分镜，不请求模型服务。' });
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: { shots: [{ id: 'local-stage-shot', title: '保留的本地分镜', narration: '', visualPrompt: '', durationUs: 1_000_000, sceneTemplate: createSceneTemplate('process') }] } });
  const phase = project.workflow.stages?.find(stage => stage.nodeIds.includes('script')), script = project.workflow.nodes.find(node => node.id === 'script');
  if (!phase || !script) throw new Error('通用流程必须包含分镜任务及其阶段');
  const observed = observe(page); await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/'); await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
  const run = await rpc<RunSummary>(request, 'run.start', { projectId: project.id, nodeId: 'script' });
  await expect.poll(async () => (await rpc<RunSummary>(request, 'run.get', { runId: run.id })).status).toBe('waiting_review');
  const frozen = await rpc<RunInspection>(request, 'run.inspect', { runId: run.id }); expect(frozen.steps.map(step => step.id)).toEqual(['script']); expect(frozen.stages?.find(stage => stage.id === phase.id)?.label).toBe(phase.label);
  const panel = page.getByRole('region', { name: '当前制作', exact: true }), progress = panel.getByRole('list', { name: '制作阶段进度', exact: true });
  const cards = progress.locator('.workbench-guide__step');
  await expect(cards).toHaveCount(1); await expect(panel.locator('.workbench-production__heading strong')).toHaveText(`${phase.label} · ${script.label}`);
  const edited = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { workflow: { ...project.workflow, stages: project.workflow.stages?.map(stage => stage.id === phase.id ? { ...stage, label: '当前项目的新策划阶段' } : stage), nodes: project.workflow.nodes.map(node => node.id === 'script' ? { ...node, label: '当前项目的新分镜名称' } : node) } } });
  await page.getByRole('button', { name: '流程', exact: true }).click(); await expect(page.locator('.react-flow')).toBeVisible(); const liveScript = page.locator('.react-flow__node[data-id="script"]'); await expect(liveScript).toContainText('当前项目的新分镜名称');
  await liveScript.click(); await page.getByRole('button', { name: '配置所属阶段', exact: true }).click(); const liveStage = page.getByRole('dialog', { name: '当前项目的新策划阶段', exact: true }); await expect(liveStage).toBeVisible(); await liveStage.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '分镜', exact: true }).click(); await expect(page.locator('#project-outline').getByRole('region', { name: '镜头列表', exact: true })).toBeVisible(); await expect(page.locator('#project-outline .outline-header')).toHaveCount(0); await expect(page.locator('#project-outline').getByRole('tab')).toHaveCount(0);
  await expect(panel.locator('.workbench-production__heading strong')).toHaveText(`${phase.label} · ${script.label}`); expect((await rpc<RunInspection>(request, 'run.inspect', { runId: run.id })).stages).toEqual(frozen.stages);
  const approve = panel.getByRole('button', { name: '通过审阅并继续', exact: true }); await expect(approve).toBeEnabled(); await approve.click();
  await expect.poll(async () => (await rpc<RunSummary>(request, 'run.get', { runId: run.id })).status).toBe('succeeded');
  await expect(panel.locator('.workbench-production__count')).toHaveText('1 / 1 阶段 · 1 / 1 任务'); await expect(cards).toHaveCount(1); await expect(cards).toHaveAttribute('data-state', 'succeeded'); await expect(progress).toContainText(phase.label);
  expect(await saved(request, project.id)).toEqual(edited); expect(await rpc(request, 'run.replay', { runId: run.id })).toMatchObject({ externalCalls: 0, matchesSnapshot: true });
  expect(observed.writes).toEqual(['run.review']); expect(observed.errors).toEqual([]); await panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('frozen-stage-progress-completed.png') });
});
