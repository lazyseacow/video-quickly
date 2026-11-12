import { openStoryboardProfile, productionStep, saveProduction, saveAndStartProduction } from './production-settings';
import { confirmAction } from './confirmation-actions';
import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { AssetRecord, CharacterProfile, ProjectDocument, RunStepPayload } from '@video-quickly/contracts';
import { rpc, fixture, saved, latest, open, pick } from './native-video-fixture';
import { openProjectFromList } from './workspace-navigation';

test('fills planning content and starts image and video generation from a manual storyboard', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const source = await fixture(request, info);
  try {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.addInitScript(() => localStorage.setItem('vq-theme', 'light'));
    const referenceBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
    const references: AssetRecord[] = [];
    for (const name of ['主参考图.png', '备用参考图.png']) {
      const path = info.outputPath(name);
      await writeFile(path, referenceBytes);
      references.push(await rpc<AssetRecord>(request, 'asset.import', { path, kind: 'image' }));
    }
    const character = await rpc<CharacterProfile>(request, 'character.save', { character: { name: `蓝帽旁白者 ${source.project.id.slice(0, 8)}`, description: '蓝色圆帽，银框眼镜', referenceAssetIds: references.map(asset => asset.id) } });
    const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: source.project.id, revision: source.project.revision, patch: {
      creativeContext: { characterIds: [], entities: [{ key: 'sky', kind: 'scene', name: '晴朗天空', description: '晴朗的蓝天' }], continuity: '' },
    } });
    const dialog = await open(page, project);
    const briefText = '天空为何是蓝色？面向初学者，用 1 秒简明讲述。';
    const styleText = '天蓝与白色的水彩画，戴蓝帽的旁白者，同一片天空。';
    for (const label of ['简报内容', '风格内容']) await expect(dialog.getByRole('textbox', { name: label, exact: true })).toHaveAttribute('placeholder', '未填写时由 AI 生成');
    await dialog.getByLabel('简报内容', { exact: true }).fill(briefText);
    await dialog.getByLabel('风格内容', { exact: true }).fill(styleText);
    const next = dialog.getByRole('button', { name: '下一步', exact: true });
    const addStoryboard = dialog.getByRole('button', { name: '添加分镜', exact: true });
    await dialog.locator('.production-settings__content').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: info.outputPath('manual-planning-fields.png') });
    await addStoryboard.press('Enter');
    const editor = page.getByRole('dialog', { name: '编辑旁白与分镜', exact: true });
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
    await editor.getByRole('checkbox', { name: /晴朗天空/ }).check();
    await editor.getByRole('checkbox', { name: character.name, exact: true }).check();
    await editor.locator('.planning-result-editor__body').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: info.outputPath('manual-storyboard-fields.png') });
    await editor.getByRole('button', { name: '保存到项目', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(dialog.getByLabel('简报内容', { exact: true })).toHaveValue(briefText);
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
    await saveProduction(dialog);
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: '开始制作', exact: true }).click();
    const referenceReview = page.getByRole('alertdialog').getByRole('region', { name: '视频参考图', exact: true });
    await expect(referenceReview).toContainText('素材准备完成后确定各镜头的参考图');
    await expect(page.getByRole('alertdialog').locator('.dialog__surface')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: info.outputPath('video-reference-confirmation.png') });
    await confirmAction(page, '确认开始制作');
    await expect.poll(async () => (await latest(request, project.id))?.status, { timeout: 30_000 }).toBe('succeeded');
    expect(source.requests).toHaveLength(2);
    expect(source.requests[0].images).toEqual(expect.arrayContaining([{ image_url: `data:image/png;base64,${referenceBytes.toString('base64')}` }]));
    expect(JSON.stringify(source.requests[1])).toContain('这段旁白由我填写。');
    expect((source.requests[1].content as Array<{ type: string }>).filter(item => item.type === 'image_url')).toEqual([
      { type: 'image_url', role: 'first_frame', image_url: { url: `data:image/png;base64,${referenceBytes.toString('base64')}` } },
    ]);
    const runId = (await latest(request, project.id)).id;
    const brief = await rpc<RunStepPayload>(request, 'run.step.payload', { runId, nodeId: 'brief', kind: 'output' });
    expect(brief).toMatchObject({ value: { text: briefText, source: 'project' } });
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
    await expect(briefEditor.getByRole('textbox', { name: '创意简报', exact: true })).toHaveValue(briefText);
    await briefEditor.getByRole('button', { name: '取消', exact: true }).click();
    await records.getByRole('navigation', { name: '本次制作步骤', exact: true }).getByRole('button', { name: /风格与角色/ }).click();
    await records.getByRole('button', { name: '编辑风格与角色', exact: true }).click();
    const styleEditor = page.getByRole('dialog', { name: '编辑风格与角色', exact: true });
    await expect(styleEditor.getByRole('textbox', { name: '视觉风格', exact: true })).toHaveValue(styleText);
  } finally { await source.close(); }
});

test('imports an authored storyboard frame and uses it without an image model', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const source = await fixture(request, info);
  try {
    const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
    const path = info.outputPath('手绘分镜.png');
    await writeFile(path, Buffer.from(image, 'base64'));
    const dialog = await open(page, source.project);
    await dialog.getByLabel('简报内容', { exact: true }).fill('用一个镜头讲述树林晨景。');
    await dialog.getByLabel('风格内容', { exact: true }).fill('水彩，淡绿色。');
    await dialog.getByRole('button', { name: '添加分镜', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '编辑旁白与分镜', exact: true });
    await editor.getByRole('textbox', { name: '镜头标题', exact: true }).fill('树林晨景');
    await editor.getByRole('textbox', { name: '画面要求', exact: true }).fill('薄雾从绿色树冠间升起');
    await editor.getByLabel('镜头时长（秒）', { exact: true }).fill('1');
    await editor.getByRole('button', { name: '导入画面', exact: true }).click();
    await editor.getByRole('textbox', { name: '图片文件路径', exact: true }).fill(path);
    await editor.getByRole('button', { name: '导入图片', exact: true }).click();
    await expect(editor.getByLabel('分镜画面', { exact: true }).locator('option:checked')).toHaveText('手绘分镜.png');
    await expect(editor.locator('.planning-result-editor__image-preview img')).toBeVisible();
    await editor.getByRole('button', { name: '保存到项目', exact: true }).click();
    await expect(editor).toHaveCount(0);
    const authored = await saved(request, source.project.id);
    expect(authored.shots[0]).toMatchObject({ assetId: expect.any(String), visualPrompt: '薄雾从绿色树冠间升起' });
    expect(authored.workflow.production.manualPlanningSteps).toBeUndefined();
    await dialog.getByRole('button', { name: '改用 AI 生成', exact: true }).click();
    const storyboard = dialog.getByRole('button', { name: '编辑项目分镜', exact: true });
    await expect(storyboard).toContainText('未填写时由 AI 生成');
    await storyboard.click();
    await editor.getByRole('button', { name: '保存到项目', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(storyboard).toContainText('已填写 1 个镜头');
    await pick(dialog, '视频模型', source.video);
    const imageModel = dialog.getByRole('combobox', { name: '图片模型', exact: true });
    await expect(imageModel).toHaveValue(source.image.name);
    await imageModel.click();
    await dialog.getByRole('option', { name: '不生成首帧', exact: true }).click();
    await expect(imageModel).toHaveValue('不生成首帧');
    await saveAndStartProduction(dialog);
    await expect.poll(async () => (await latest(request, source.project.id))?.status, { timeout: 30_000 }).toBe('succeeded');
    expect(source.requests).toHaveLength(1);
    expect(source.requests[0].content).toEqual(expect.arrayContaining([
      { type: 'image_url', role: 'first_frame', image_url: { url: `data:image/png;base64,${image}` } },
    ]));
    expect(JSON.stringify(source.requests[0])).toContain('薄雾从绿色树冠间升起');
    expect((await saved(request, source.project.id)).workflow.production.imageModelId).toBeUndefined();
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
    await productionStep(dialog, '创作要求');
    const originalText = '河风渐起，旅人将信藏进了木盒。';
    await dialog.getByRole('textbox', { name: '项目原文', exact: true }).fill(originalText);
    await dialog.getByText('AI 生成要求', { exact: true }).click();
    await dialog.getByLabel('创作要求', { exact: true }).fill('用一个镜头介绍蓝色天空，声音自然。');
    await openStoryboardProfile(dialog);
    await dialog.getByLabel('画面比例', { exact: true }).selectOption('9:16');
    await dialog.getByLabel('分辨率', { exact: true }).selectOption('720');
    await dialog.getByLabel('视频帧率', { exact: true }).selectOption('60');
    await dialog.getByLabel('素材适配', { exact: true }).selectOption('cover');
    await productionStep(dialog, '模型与素材'); await expect(dialog.getByLabel('参考素材', { exact: true })).toHaveCount(0);
    await productionStep(dialog, '声音与成片'); await dialog.getByLabel('声音要求', { exact: true }).fill('轻声讲述，环境音克制。');
    await expect(dialog.getByLabel('字幕', { exact: true })).toHaveValue('off');
    await page.screenshot({ path: info.outputPath('native-settings-dark.png') });
    let writes = 0; page.on('request', value => { if (value.url().endsWith('/__desktop_rpc') && value.postDataJSON()?.method === 'project.update') writes++; });
    await saveProduction(dialog); await expect(dialog).toHaveCount(0); expect(writes).toBe(1);
    const configured = await saved(request, source.project.id); expect(configured.workflow.production).toMatchObject({ textModelId: source.models[0].id, videoModelId: source.video.id, soundPrompt: '轻声讲述，环境音克制。', subtitleMode: 'off' });
    expect(configured.originalText).toBe(originalText);
    expect(configured.workflow.nodes.filter(node => ['brief', 'style', 'script'].includes(node.id)).every(node => node.modelId === source.models[0].id)).toBe(true);
    await page.locator('.project-heading-actions').getByRole('button', { name: '制作设置', exact: true }).click();
    await saveAndStartProduction(dialog); await expect(dialog).toHaveCount(0);
    await expect(page.locator('.toast')).toContainText('请在“本次制作”查看详情。');
    await expect.poll(async () => (await latest(request, source.project.id))?.status).toBe('failed');
    const failed = await latest(request, source.project.id);
    expect(failed.selection).toBeUndefined();
    expect(failed).toMatchObject({ stepCount: 7, completedNodeIds: ['brief', 'style'] });
    expect(source.requests).toHaveLength(4);
    expect(JSON.stringify(source.requests[0])).toContain(originalText);
    for (const request of source.requests.slice(2, 4)) expect(JSON.stringify(request)).toContain(originalText);
    await page.getByRole('button', { name: '打开阶段：策划与分镜', exact: true }).click();
    const records = page.getByRole('dialog', { name: '本次制作', exact: true });
    const retry = records.getByRole('button', { name: '重试此批', exact: true });
    await expect(retry).toBeEnabled();
    await expect(records.getByRole('region', { name: '已保存分镜' })).toContainText('全片大纲');
    await page.screenshot({ path: info.outputPath('native-production-step-retry.png') });
    await retry.click();
    await confirmAction(page, '确认重试');
    await expect(records).toContainText('后续步骤尚未执行');
    const retried = await latest(request, source.project.id);
    expect(retried).toMatchObject({ id: failed.id, stepRetry: { nodeId: 'script', status: 'completed' } });
    expect([...retried.completedNodeIds].sort()).toEqual(['brief', 'script', 'style']);
    expect(source.requests).toHaveLength(5);
    expect(JSON.stringify(source.requests[4])).toContain('自动视频制作步骤：旁白与分镜');
    expect(JSON.stringify(source.requests[4])).toContain('分辨率、画幅比例、帧率和素材适配方式由制作设置管理，不写入镜头画面');
    expect(JSON.stringify(source.requests[4])).toContain('durationUs 填写不小于 4000000');
    expect(JSON.stringify(source.requests[4])).toContain('initialFrame、characterPositions、actionTimeline');
    const storyboard = records.getByRole('region', { name: '分镜预览' });
    for (const heading of ['初始画面', '人物站位', '动作时间轴']) await expect(storyboard).toContainText(heading);
    for (const request of source.requests) expect(JSON.stringify(request)).not.toMatch(/成片规格：|720\s*×\s*1280|9:16|60\s*fps|裁剪填满/);
    await records.getByRole('button', { name: '继续原制作', exact: true }).click();
    await confirmAction(page, '确认继续制作');
    await records.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await expect.poll(async () => (await latest(request, source.project.id))?.status, { timeout: 30_000 }).toBe('succeeded');
    expect((await latest(request, source.project.id)).id).toBe(failed.id);
    await expect(page.locator('.preview-panel .prepared-mix-preview')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
    expect((await saved(request, source.project.id)).shots[0].audioProcessing).toMatchObject({ version: 2, videoAudio: { enabled: true } });
    const videoRequests = source.requests.filter(value => value.generate_audio === true);
    expect(videoRequests).toHaveLength(1);
    expect(videoRequests[0]).toMatchObject({ ratio: '9:16', resolution: '720p' });
    const [{ text }] = videoRequests[0].content as { text: string }[];
    for (const value of ['初始画面\n蓝色天空', '人物站位', '动作时间轴\n0–1 秒']) expect(text).toContain(value);
    expect(text).not.toMatch(/720\s*×\s*1280|9:16|60\s*fps|裁剪填满/);
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
    await productionStep(dialog, '创作要求'); await dialog.getByLabel('简报内容', { exact: true }).fill('保存失败后仍保留的创作要求');
    let fail = true;
    await page.route('**/__desktop_rpc', async route => { if (route.request().postDataJSON()?.method === 'project.update' && fail) { fail = false; await route.fulfill({ status: 400, json: { error: '隔离的保存失败' } }); } else await route.continue(); });
    await saveProduction(dialog); await expect(dialog).toContainText('操作尚未完成'); await expect(dialog.getByLabel('简报内容', { exact: true })).toHaveValue('保存失败后仍保留的创作要求');
    await productionStep(dialog, '声音与成片'); await expect(dialog.getByLabel('字幕', { exact: true })).toHaveValue('off');
    const bounds = await dialog.locator('.dialog__surface').boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.width).toBeLessThanOrEqual(760);
    await productionStep(dialog, '确认保存'); await expect(dialog.getByRole('button', { name: '保存设置', exact: true })).toBeInViewport(); await page.screenshot({ path: info.outputPath('native-settings-light-narrow.png') });
    await saveProduction(dialog); await expect(dialog).toHaveCount(0); expect((await saved(request, source.project.id)).brief).toBe('保存失败后仍保留的创作要求'); expect(errors).toEqual([]);
  } finally { await source.close(); }
});
