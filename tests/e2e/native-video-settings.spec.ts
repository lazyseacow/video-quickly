import { productionStep, saveProduction, saveAndStartProduction } from './production-settings';
import { expect, test } from '@playwright/test';
import type { ProjectDocument, RunStepPayload, RunSummary } from '@video-quickly/contracts';
import { rpc, fixture, saved, latest, open, pick } from './native-video-fixture';
import { openProjectFromList } from './workspace-navigation';

test('prefills AI planning fields, validates drafts and uses the edited values in production', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const source = await fixture(request, info, false, 1, { brief: 'AI 提出的主题', style: 'AI 提出的水彩画风', firstScriptResponse: '{}' });
  try {
    await page.setViewportSize({ width: 1024, height: 768 });
    const dialog = await open(page, source.project);
    await dialog.getByRole('button', { name: 'AI 填写简报', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('请先选择文本模型');
    expect(source.requests).toHaveLength(0);
    await pick(dialog, '文本模型', source.models[0]); await pick(dialog, '视频模型', source.video);
    await productionStep(dialog, '创作要求');
    await dialog.getByRole('button', { name: 'AI 填写简报', exact: true }).click();
    const topic = dialog.getByLabel('主题', { exact: true });
    await expect(topic).toHaveValue('AI 提出的主题');
    await expect(dialog.getByLabel('简报来源', { exact: true })).toHaveValue('manual');
    await expect(dialog.getByLabel('简报来源', { exact: true }).locator('option:checked')).toHaveText('使用已填写内容');
    await expect(topic.locator('..').locator('.field__required')).toHaveCSS('color', 'rgb(244, 154, 145)');
    await expect(topic.locator('..').getByText('必填', { exact: true })).toHaveCount(0);
    await topic.fill('人工修改后的主题');
    await dialog.getByLabel('核心信息', { exact: true }).fill('人工补充的核心信息');
    await dialog.getByRole('button', { name: 'AI 填写风格', exact: true }).click();
    await expect(dialog.getByLabel('画风', { exact: true })).toHaveValue('AI 提出的水彩画风');
    expect(JSON.stringify(source.requests[1])).toContain('人工修改后的主题');
    await dialog.getByLabel('色彩', { exact: true }).fill('人工选择的蓝白色');
    await dialog.locator('.production-settings__content').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: info.outputPath('ai-prefill-planning-fields.png') });

    const scriptButton = dialog.getByRole('button', { name: 'AI 填写分镜', exact: true });
    const editor = page.getByRole('dialog', { name: '编辑旁白与分镜', exact: true });
    await scriptButton.click();
    await expect(dialog.getByRole('alert')).toContainText('第 1/1 批分镜结果校验失败');
    await expect(editor).toHaveCount(0);
    await expect(topic).toHaveValue('人工修改后的主题');
    expect(await saved(request, source.project.id)).toEqual(source.project);

    await scriptButton.click();
    await expect(editor.getByLabel('镜头标题', { exact: true })).toHaveValue('生成的蓝色镜头');
    await expect(editor.getByLabel('镜头时长（秒）', { exact: true })).toHaveValue('1');
    expect((await saved(request, source.project.id)).shots).toEqual([]);
    await editor.getByLabel('旁白', { exact: true }).fill('这是人工修改的分镜旁白。');
    await editor.getByRole('button', { name: '保存到项目', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(dialog.getByLabel('分镜来源', { exact: true })).toHaveValue('manual');
    await expect(topic).toHaveValue('人工修改后的主题');
    await saveAndStartProduction(dialog);
    await expect.poll(async () => (await rpc<{ items: RunSummary[] }>(request, 'run.list', { projectId: source.project.id, purpose: 'production' })).items[0]?.status, { timeout: 30_000 }).toBe('succeeded');
    expect(source.requests).toHaveLength(6);
    expect(source.requests.filter(value => JSON.stringify(value).includes('分镜生成阶段：全片大纲。'))).toHaveLength(1);
    expect(JSON.stringify(source.requests[5])).toContain('这是人工修改的分镜旁白。');
    const completed = await saved(request, source.project.id);
    expect(completed.workflow.production.manualPlanningFields).toMatchObject({ brief: { topic: '人工修改后的主题', coreMessage: '人工补充的核心信息' }, style: { artStyle: 'AI 提出的水彩画风', palette: '人工选择的蓝白色' } });
    expect(completed.workflow.production.manualPlanningSteps).toEqual(['brief', 'style', 'script']);
  } finally { await source.close(); }
});

test('fills each planning field, adds a storyboard shot and starts with only a video model', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const source = await fixture(request, info);
  try {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.addInitScript(() => localStorage.setItem('vq-theme', 'light'));
    const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: source.project.id, revision: source.project.revision, patch: {
      creativeContext: { characterIds: [], entities: [{ key: 'sky', kind: 'scene', name: '晴朗天空', description: '晴朗的蓝天' }], continuity: '' },
    } });
    const dialog = await open(page, project);
    await dialog.getByLabel('简报来源', { exact: true }).selectOption('manual');
    await dialog.getByLabel('风格来源', { exact: true }).selectOption('manual');
    await dialog.getByLabel('分镜来源', { exact: true }).selectOption('manual');
    const topic = dialog.getByLabel('主题', { exact: true });
    await expect(topic).toHaveAttribute('maxlength', '160');
    await topic.fill('');
    await dialog.getByRole('button', { name: '下一步', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('请填写主题。');
    await expect(topic).toBeFocused();
    const values = {
      主题: '天空为何是蓝色', 目标受众: '刚接触这个主题的观众', 核心信息: '我写的天空创作简报', 叙事顺序: '先提问再解释', 预期成片时长: '1 秒', 表达要求: '简洁直白',
      画风: '我写的蓝色水彩风格', 色彩: '天蓝与白色', 构图: '天空占据主体', 光线: '柔和自然光', 角色外观: '戴蓝帽的旁白者', 场景连续性: '保持同一片天空',
    };
    for (const [label, value] of Object.entries(values)) await dialog.getByLabel(label, { exact: true }).fill(value);
    const next = dialog.getByRole('button', { name: '下一步', exact: true });
    const addStoryboard = dialog.getByRole('button', { name: '填写项目分镜', exact: true });
    await next.click();
    await expect(dialog.getByRole('alert')).toContainText('请至少添加一个镜头');
    await expect(addStoryboard).toBeFocused();
    await expect(dialog.locator('.production-settings__planning-note .field__required')).toHaveText('*');
    await dialog.locator('.production-settings__content').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: info.outputPath('manual-planning-fields.png') });
    await addStoryboard.click();
    const editor = page.getByRole('dialog', { name: '编辑旁白与分镜', exact: true });
    await editor.getByRole('button', { name: '添加镜头', exact: true }).click();
    await expect(editor.getByLabel('镜头标题', { exact: true })).toBeFocused();
    await editor.getByLabel('镜头标题', { exact: true }).fill('我写的天空镜头');
    await editor.getByLabel('旁白', { exact: true }).fill('这段旁白由我填写。');
    await editor.getByLabel('画面要求', { exact: true }).fill('天蓝色背景');
    await editor.getByLabel('声音要求', { exact: true }).fill('自然讲述');
    const duration = editor.getByLabel('镜头时长（秒）', { exact: true });
    await duration.fill('0.1');
    await editor.getByRole('button', { name: '保存到项目', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText('镜头时长须在 0.5 至 600 秒之间');
    await expect(duration).toBeFocused();
    expect((await saved(request, project.id)).shots).toHaveLength(0);
    await duration.fill('1');
    await editor.getByText('角色与创作设定', { exact: true }).click();
    await editor.getByRole('checkbox', { name: /晴朗天空/ }).check();
    await editor.locator('.planning-result-editor__body').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: info.outputPath('manual-storyboard-fields.png') });
    await editor.getByRole('button', { name: '保存到项目', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(dialog.getByLabel('核心信息', { exact: true })).toHaveValue(values.核心信息);
    await next.click();
    const text = dialog.getByRole('combobox', { name: '文本模型', exact: true });
    await expect(text).not.toHaveAttribute('aria-required', 'true');
    await expect(text.locator('xpath=ancestor::label[1]').locator('.field__required')).toHaveCount(0);
    await expect(dialog.getByText('文本模型可选，供剪辑 Agent 使用。', { exact: true })).toBeVisible();
    await next.click();
    await expect(dialog.getByRole('alert')).toContainText('请选择可用的视频模型');
    await pick(dialog, '视频模型', source.video);
    await next.click();
    await expect(dialog.getByLabel('声音要求', { exact: true })).toBeVisible();
    await saveAndStartProduction(dialog);
    await expect.poll(async () => (await latest(request, project.id))?.status, { timeout: 30_000 }).toBe('succeeded');
    expect(source.requests).toHaveLength(1);
    expect(JSON.stringify(source.requests[0])).toContain('这段旁白由我填写。');
    const runId = (await latest(request, project.id)).id;
    const brief = await rpc<RunStepPayload>(request, 'run.step.payload', { runId, nodeId: 'brief', kind: 'output' });
    expect(brief).toMatchObject({ value: { text: expect.stringContaining('核心信息\n我写的天空创作简报'), source: 'project' } });
    expect(brief.modelResponse).toBeUndefined();
    const script = await rpc<RunStepPayload>(request, 'run.step.payload', { runId, nodeId: 'script', kind: 'output' });
    expect(script).toMatchObject({ value: { shots: [{ title: '我写的天空镜头', durationUs: 1_000_000, visualPrompt: '天蓝色背景', soundPrompt: '自然讲述', creativeEntityKeys: ['sky'] }] } });
    const completed = await saved(request, project.id);
    expect(completed.workflow.production.manualPlanningSteps).toEqual(['brief', 'style', 'script']);
    expect(completed.workflow.production.textModelId).toBeUndefined();
    expect(completed.shots[0]).toMatchObject({ id: expect.any(String), title: '我写的天空镜头', narration: '这段旁白由我填写。', videoAssetId: expect.any(String) });
    await page.getByRole('button', { name: '打开阶段：策划与分镜', exact: true }).click();
    const records = page.getByRole('dialog', { name: '本次制作', exact: true });
    await records.getByRole('navigation', { name: '本次制作步骤', exact: true }).getByRole('button', { name: /创意简报/ }).click();
    await records.getByRole('button', { name: '编辑创意简报', exact: true }).click();
    const briefEditor = page.getByRole('dialog', { name: '编辑创意简报', exact: true });
    for (const label of ['主题', '目标受众', '核心信息', '叙事顺序', '预期成片时长', '表达要求'] as const) await expect(briefEditor.getByLabel(label, { exact: true })).toHaveValue(values[label]);
    await briefEditor.getByRole('button', { name: '取消', exact: true }).click();
    await records.getByRole('navigation', { name: '本次制作步骤', exact: true }).getByRole('button', { name: /风格与角色/ }).click();
    await records.getByRole('button', { name: '编辑风格与角色', exact: true }).click();
    const styleEditor = page.getByRole('dialog', { name: '编辑风格与角色', exact: true });
    for (const label of ['画风', '色彩', '构图', '光线', '角色外观', '场景连续性'] as const) await expect(styleEditor.getByLabel(label, { exact: true })).toHaveValue(values[label]);
  } finally { await source.close(); }
});

test('starts the default workflow, retries only the failed storyboard and finishes the video with original sound', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const source = await fixture(request, info, false, 1, { firstScriptResponse: '{}' }), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto('/'); await openProjectFromList(page, source.project.title);
    await page.getByRole('button', { name: '开始制作', exact: true }).click();
    const blockers = page.getByRole('dialog', { name: '暂无法开始制作', exact: true });
    await blockers.getByRole('listitem').filter({ hasText: '创意简报' }).getByRole('button', { name: '调整步骤', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: '制作设置', exact: true });
    await expect(dialog.getByRole('navigation', { name: '制作设置步骤' }).getByRole('button', { name: '模型与素材', exact: true })).toHaveAttribute('aria-current', 'step');
    await expect(dialog.getByRole('combobox', { name: '文本模型', exact: true })).toBeFocused();
    expect(source.requests).toHaveLength(0);
    await pick(dialog, '文本模型', source.models[0]); await pick(dialog, '视频模型', source.video);
    await productionStep(dialog, '创作要求'); await dialog.getByLabel('创作要求', { exact: true }).fill('用一个镜头介绍蓝色天空，声音自然。');
    await productionStep(dialog, '模型与素材'); await expect(dialog.getByLabel('参考素材', { exact: true })).toHaveValue('none'); await productionStep(dialog, '声音与成片'); await dialog.getByLabel('声音要求', { exact: true }).fill('轻声讲述，环境音克制。');
    await productionStep(dialog, '声音与成片'); await expect(dialog.getByLabel('字幕', { exact: true })).toHaveValue('off');
    await dialog.getByLabel('画面比例', { exact: true }).selectOption('9:16');
    await dialog.getByLabel('分辨率', { exact: true }).selectOption('720');
    await dialog.getByLabel('素材适配', { exact: true }).selectOption('cover');
    await page.screenshot({ path: info.outputPath('native-settings-dark.png') });
    let writes = 0; page.on('request', value => { if (value.url().endsWith('/__desktop_rpc') && value.postDataJSON()?.method === 'project.update') writes++; });
    await saveProduction(dialog); await expect(dialog).toHaveCount(0); expect(writes).toBe(1);
    const configured = await saved(request, source.project.id); expect(configured.workflow.production).toMatchObject({ textModelId: source.models[0].id, videoModelId: source.video.id, soundPrompt: '轻声讲述，环境音克制。', subtitleMode: 'off' });
    expect(configured.workflow.nodes.filter(node => ['brief', 'style', 'script'].includes(node.id)).every(node => node.modelId === source.models[0].id)).toBe(true);
    await page.locator('.project-heading-actions').getByRole('button', { name: '制作设置', exact: true }).click();
    await saveAndStartProduction(dialog); await expect(dialog).toHaveCount(0);
    await expect(page.locator('.toast')).toContainText('请在“本次制作”查看详情。');
    await expect.poll(async () => (await latest(request, source.project.id))?.status).toBe('failed');
    const failed = await latest(request, source.project.id);
    expect(failed.selection).toBeUndefined();
    expect(failed).toMatchObject({ stepCount: 7, completedNodeIds: ['brief', 'style'] });
    expect(source.requests).toHaveLength(4);
    await page.getByRole('button', { name: '打开阶段：策划与分镜', exact: true }).click();
    const records = page.getByRole('dialog', { name: '本次制作', exact: true });
    const retry = records.getByRole('button', { name: '重试此批', exact: true });
    await expect(retry).toBeEnabled();
    await expect(records.getByRole('region', { name: '已保存分镜' })).toContainText('全片大纲');
    await page.screenshot({ path: info.outputPath('native-production-step-retry.png') });
    await retry.click();
    await expect(records).toContainText('后续步骤尚未执行');
    const retried = await latest(request, source.project.id);
    expect(retried).toMatchObject({ id: failed.id, stepRetry: { nodeId: 'script', status: 'completed' } });
    expect([...retried.completedNodeIds].sort()).toEqual(['brief', 'script', 'style']);
    expect(source.requests).toHaveLength(5);
    expect(JSON.stringify(source.requests[4])).toContain('自动视频制作步骤：旁白与分镜');
    expect(JSON.stringify(source.requests[4])).toContain('720 × 1280 像素（9:16）');
    expect(JSON.stringify(source.requests[4])).toContain('素材适配采用裁剪填满');
    await records.getByRole('button', { name: '继续原制作', exact: true }).click();
    await records.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await expect.poll(async () => (await latest(request, source.project.id))?.status, { timeout: 30_000 }).toBe('succeeded');
    expect((await latest(request, source.project.id)).id).toBe(failed.id);
    await expect(page.locator('.preview-panel .prepared-mix-preview')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
    expect((await saved(request, source.project.id)).shots[0].audioProcessing).toMatchObject({ version: 2, videoAudio: { enabled: true } });
    const videoRequests = source.requests.filter(value => value.generate_audio === true);
    expect(videoRequests).toHaveLength(1);
    expect(videoRequests[0]).toMatchObject({ ratio: '9:16', resolution: '720p' });
    expect(JSON.stringify(videoRequests[0])).toContain('720 × 1280 像素（9:16）');
    expect(JSON.stringify(videoRequests[0])).toContain('素材适配采用裁剪填满');
    expect(errors).toEqual([]); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('native-production-complete.png') });
    await page.getByRole('button', { name: '打开阶段：素材与配音', exact: true }).click(); await page.getByRole('dialog', { name: '本次制作', exact: true }).getByRole('navigation', { name: '本次制作步骤', exact: true }).getByRole('button', { name: /剪辑与运镜准备/ }).click();
    dialog = page.getByRole('dialog', { name: '本次制作', exact: true }); await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('navigation', { name: '本次制作步骤', exact: true }).getByRole('button', { name: /剪辑与运镜准备/ })).toHaveAttribute('aria-current', 'step');
    await expect(dialog.getByRole('navigation', { name: '本次制作步骤', exact: true })).toContainText('剪辑与运镜准备');
    await page.screenshot({ path: info.outputPath('automatic-editing-record.png') });
    await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await rpc(request, 'run.start', { projectId: source.project.id, nodeId: 'script' });
    await expect.poll(async () => (await latest(request, source.project.id))?.status, { timeout: 30_000 }).toBe('succeeded');
    await page.reload(); await openProjectFromList(page, source.project.title);
    await page.getByRole('button', { name: '打开阶段：策划与分镜', exact: true }).click(); await page.getByRole('dialog', { name: '本次制作', exact: true }).getByRole('navigation', { name: '本次制作步骤', exact: true }).getByRole('button', { name: /剪辑与运镜准备/ }).click();
    await expect(dialog).toContainText('这次制作未包含此步骤');
    await expect(dialog.getByRole('button', { name: '查看制作设置', exact: true })).toHaveCount(0);
  } finally { await source.close(); }
});

test('keeps runtime settings frozen while saving the next production configuration', async ({ page, request }, info) => {
  const source = await fixture(request, info, true);
  try {
    let dialog = await open(page, source.project); await pick(dialog, '文本模型', source.models[0]); await pick(dialog, '视频模型', source.video);
    await saveAndStartProduction(dialog); await source.pending;
    await page.locator('.project-heading-actions').getByRole('button', { name: '制作设置', exact: true }).click(); dialog = page.getByRole('dialog', { name: '制作设置', exact: true });
    await pick(dialog, '文本模型', source.models[1]); await saveProduction(dialog); await expect(dialog).toHaveCount(0);
    expect((await saved(request, source.project.id)).workflow.production?.textModelId).toBe(source.models[0].id);
    source.release(); await expect.poll(async () => (await latest(request, source.project.id))?.status, { timeout: 30_000 }).toBe('succeeded');
    expect(source.requests.filter(value => value.messages).every(value => value.model === source.models[0].model)).toBe(true);
    await page.reload(); await openProjectFromList(page, source.project.title); await page.locator('.project-heading-actions').getByRole('button', { name: '制作设置', exact: true }).click();
    await expect(dialog).toContainText('已保存待用配置'); await productionStep(dialog, '模型与素材'); await expect(dialog.getByRole('combobox', { name: '文本模型', exact: true })).toHaveValue(source.models[1].name);
  } finally { await source.close(); }
});

test('retains failed saves and keeps the unified form usable in a narrow light window', async ({ page, request }, info) => {
  const source = await fixture(request, info); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.addInitScript(() => localStorage.setItem('vq-theme', 'light')); await page.setViewportSize({ width: 760, height: 800 });
    let dialog = await open(page, source.project); await pick(dialog, '文本模型', source.models[0]); await pick(dialog, '视频模型', source.video);
    await productionStep(dialog, '创作要求'); await dialog.getByLabel('创作要求', { exact: true }).fill('保存失败后仍保留的创作要求');
    let fail = true;
    await page.route('**/__desktop_rpc', async route => { if (route.request().postDataJSON()?.method === 'project.update' && fail) { fail = false; await route.fulfill({ status: 400, json: { error: '隔离的保存失败' } }); } else await route.continue(); });
    await saveProduction(dialog); await expect(dialog).toContainText('操作尚未完成'); await expect(dialog.getByLabel('创作要求', { exact: true })).toHaveValue('保存失败后仍保留的创作要求');
    await productionStep(dialog, '声音与成片'); await expect(dialog.getByLabel('字幕', { exact: true })).toHaveValue('off');
    const bounds = await dialog.locator('.dialog__surface').boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.width).toBeLessThanOrEqual(760);
    await productionStep(dialog, '确认保存'); await expect(dialog.getByRole('button', { name: '保存设置', exact: true })).toBeInViewport(); await page.screenshot({ path: info.outputPath('native-settings-light-narrow.png') });
    await saveProduction(dialog); await expect(dialog).toHaveCount(0); expect((await saved(request, source.project.id)).brief).toBe('保存失败后仍保留的创作要求'); expect(errors).toEqual([]);
  } finally { await source.close(); }
});
