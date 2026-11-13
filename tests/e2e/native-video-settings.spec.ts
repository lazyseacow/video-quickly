import { openProduction, openStoryboardProfile, productionFixture, productionStep, saveProduction, saveAndStartProduction } from './production-settings';
import { confirmAction } from './confirmation-actions';
import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { AssetRecord, CharacterProfile, ProjectDocument, RunStepPayload } from '@video-quickly/contracts';
import { rpc, fixture, saved, latest, open, pick } from './native-video-fixture';
import { openProjectFromList } from './workspace-navigation';

test('removes only the selected storyboard row after confirmation and can undo it', async ({ page, request }, info) => {
  const { project: created } = await productionFixture(request, { configureImage: false });
  const project = await rpc<ProjectDocument>(request, 'project.update', {
    projectId: created.id, revision: created.revision,
    patch: {
      shots: [
        { id: 'locked', title: '锁定的第一镜', narration: '保留的开场', visualPrompt: '清晨', durationUs: 2_000_000, sceneIndex: 0, locked: true },
        { id: 'target', title: '待移除的第二镜', narration: '移除的内容', visualPrompt: '湖面', durationUs: 3_000_000, sceneIndex: 1 },
        { id: 'keep', title: '保留的第三镜', narration: '保留的结尾', visualPrompt: '树梢', durationUs: 4_000_000, sceneIndex: 2 },
      ],
      workflow: { ...created.workflow, production: { ...created.workflow.production, manualPlanningSteps: ['script'] } },
    },
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const settings = await openProduction(page, project);
  await productionStep(settings, '创作要求');
  const storyboard = settings.getByRole('group', { name: '分镜内容', exact: true });
  const target = storyboard.getByRole('listitem').filter({ hasText: project.shots[1].title });
  const remove = target.getByRole('button', { name: `删除镜头：${project.shots[1].title}`, exact: true });
  await expect(storyboard.getByRole('button', { name: `删除镜头：${project.shots[0].title}`, exact: true })).toBeDisabled();
  await expect(remove).toBeEnabled();
  await target.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('storyboard-row-delete.png') });
  const confirmation = page.getByRole('alertdialog');

  await remove.click();
  await expect(confirmation).toHaveAccessibleName('删除镜头？');
  await expect(confirmation).toContainText(project.shots[1].title);
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(target).toBeVisible();
  expect((await saved(request, project.id)).shots).toEqual(project.shots);

  await remove.click();
  await confirmAction(page, '确认移除');
  await expect(target).toHaveCount(0);
  await expect(storyboard.getByRole('listitem')).toHaveCount(2);
  await expect.poll(async () => (await saved(request, project.id)).shots).toEqual([project.shots[0], project.shots[2]]);
  expect((await saved(request, project.id)).workflow.production.manualPlanningSteps).toEqual(['script']);

  await settings.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await expect(settings).toHaveCount(0);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await saved(request, project.id)).shots).toEqual(project.shots);
});

test('saves the tail-frame setting per project and can re-enable it after reload', async ({ page, request }, info) => {
  const source = await fixture(request, info);
  try {
    const dialog = await open(page, source.project);
    await pick(dialog, '文本模型', source.models[0]);
    await pick(dialog, '视频模型', source.video);
    const continuation = dialog.getByRole('switch', { name: '尾帧续镜', exact: true });
    await expect(continuation).toBeChecked();
    await continuation.press('Space');
    await expect(continuation).not.toBeChecked();
    await expect(continuation).toHaveAccessibleDescription('每个镜头使用自己的已有画面、角色参考图或文字独立生成。可并行处理。');
    await page.screenshot({ path: info.outputPath('tail-frame-continuation-disabled.png') });
    await productionStep(dialog, '确认保存');
    await expect(dialog.getByText('各镜头独立生成', { exact: true })).toBeVisible();
    await saveProduction(dialog);
    await expect(dialog).toHaveCount(0);
    expect((await saved(request, source.project.id)).workflow.production.continueFromLastFrame).toBe(false);

    await open(page, source.project);
    await productionStep(dialog, '模型与素材');
    await expect(continuation).not.toBeChecked();
    await continuation.press('Space');
    await expect(continuation).toBeChecked();
    await productionStep(dialog, '确认保存');
    await expect(dialog.getByText('沿用上一镜尾帧', { exact: true })).toBeVisible();
    await saveProduction(dialog);
    await expect(dialog).toHaveCount(0);
    expect((await saved(request, source.project.id)).workflow.production.continueFromLastFrame).toBe(true);
    expect(source.requests).toHaveLength(0);
  } finally { await source.close(); }
});

test('shows generated planning in production settings without switching to manual mode', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const briefText = '用两个镜头解释为什么天空看起来是蓝色的。';
  const styleText = '柔和蓝色水彩，使用明亮的自然光。';
  const releaseVideo = Promise.withResolvers<void>();
  const source = await fixture(request, info, false, 2, {
    brief: briefText, style: styleText,
    async beforeReply(_body, path) {
      if (!path.includes('contents/generations/tasks')) return;
      await releaseVideo.promise;
    },
  });
  try {
    const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: source.project.id, revision: source.project.revision, patch: {
      creativeContext: { characterIds: [], entities: [], continuity: '两镜保持一致的蓝色色调。' },
      workflow: { ...source.project.workflow, production: {
        ...source.project.workflow.production, textModelId: source.models[0].id, videoModelId: source.video.id,
      } },
    } });
    const run = await rpc<{ id: string }>(request, 'run.start', { projectId: project.id });
    await expect.poll(() => source.requests.some(value => value.generate_audio === true), { timeout: 15_000 }).toBe(true);
    expect((await saved(request, project.id)).shots).toHaveLength(0);
    for (const nodeId of ['brief', 'style', 'script']) {
      expect(await rpc<RunStepPayload>(request, 'run.step.payload', { runId: run.id, nodeId, kind: 'output' })).toMatchObject({
        value: { source: 'model' },
      });
    }
    const dialog = await open(page, project);
    const brief = dialog.getByRole('textbox', { name: '简报内容', exact: true });
    const style = dialog.getByRole('textbox', { name: '风格内容', exact: true });
    const storyboard = dialog.getByRole('group', { name: '分镜内容', exact: true });
    const expectGeneratedPlanning = async () => {
      await expect(dialog.getByText('AI 生成', { exact: true })).toHaveCount(2);
      await expect(dialog.getByRole('button', { name: /手动填写简报|手动填写风格/ })).toHaveCount(0);
      await expect(dialog.getByText('AI 生成要求', { exact: true })).toHaveCount(0);
      for (const [field, text] of [[brief, briefText], [style, styleText]] as const) {
        await expect(field).toHaveValue(new RegExp(text));
        await expect(field).toBeEditable();
        await expect(field).toHaveAccessibleDescription('AI 生成');
      }
      await expect(storyboard).toContainText('AI 生成 · 2 个镜头');
      for (const title of ['生成的蓝色镜头 1', '生成的蓝色镜头 2']) await expect(storyboard.getByText(title, { exact: true })).toBeVisible();
    };
    await productionStep(dialog, '创作要求');
    await expectGeneratedPlanning();
    await expect(storyboard.getByRole('button', { name: /^编辑镜头：/ }).and(page.locator(':enabled'))).toHaveCount(0);
    await expect(storyboard.getByRole('button', { name: /^删除镜头：/ }).and(page.locator(':enabled'))).toHaveCount(0);
    const firstShot = storyboard.getByRole('listitem').filter({ hasText: '生成的蓝色镜头 1' });
    const shotSummary = firstShot.locator('summary');
    await expect(shotSummary).toContainText(/1(?:\.0)? 秒/);
    await expect(firstShot.getByText('天空是蓝色的。', { exact: false })).toBeHidden();
    await shotSummary.press('Enter');
    await expect(firstShot.getByText('天空是蓝色的。', { exact: false })).toBeVisible();
    await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: info.outputPath('generated-planning-in-settings.png') });
    await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    releaseVideo.resolve();
    await expect.poll(async () => (await latest(request, project.id))?.status, { timeout: 30_000 }).toBe('succeeded');
    const completed = await saved(request, project.id);
    const requests = source.requests.length;
    expect(completed.shots.map(shot => shot.title)).toEqual(['生成的蓝色镜头 1', '生成的蓝色镜头 2']);
    await open(page, completed);
    await productionStep(dialog, '创作要求');
    await expectGeneratedPlanning();
    await productionStep(dialog, '确认保存');
    await expect(dialog.getByRole('region', { name: '确认保存', exact: true }).getByText('继续由 AI 生成', { exact: true })).toHaveCount(3);
    await saveProduction(dialog);
    await expect(dialog).toHaveCount(0);
    const persisted = await saved(request, project.id);
    expect(persisted.workflow.production.manualPlanningSteps ?? []).toEqual([]);
    expect(persisted.brief).toBe(completed.brief);
    expect(persisted.style).toBe(completed.style);
    expect(persisted.shots).toEqual(completed.shots);
    expect(source.requests).toHaveLength(requests);

    const videoOnly = await rpc<{ id: string }>(request, 'run.start', { projectId: project.id, nodeId: 'video' });
    await expect.poll(async () => await latest(request, project.id), { timeout: 30_000 }).toMatchObject({ id: videoOnly.id, status: 'succeeded' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem('vq-theme', 'light'));
    await open(page, persisted);
    await productionStep(dialog, '创作要求');
    await expectGeneratedPlanning();
    await expect(storyboard.getByRole('button', { name: '编辑项目分镜', exact: true })).toHaveCount(0);
    for (const title of ['生成的蓝色镜头 1', '生成的蓝色镜头 2']) {
      await expect(storyboard.getByRole('button', { name: `编辑镜头：${title}`, exact: true })).toBeEnabled();
    }
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await storyboard.scrollIntoViewIfNeeded();
    await expect(dialog.getByRole('button', { name: '下一步', exact: true })).toBeInViewport({ ratio: 1 });
    await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '1');
    const secondShot = storyboard.getByRole('listitem').filter({ hasText: '生成的蓝色镜头 2' });
    const secondSummary = secondShot.locator('summary');
    const editShot = secondShot.getByRole('button', { name: '编辑镜头：生成的蓝色镜头 2', exact: true });
    const headingBackground = () => secondSummary.evaluate(element => getComputedStyle(element, '::before').backgroundColor);
    const idleBackground = await headingBackground();
    await secondSummary.hover();
    const hoveredBackground = await headingBackground();
    expect(hoveredBackground).not.toBe(idleBackground);
    await editShot.hover();
    expect(await headingBackground()).toBe(hoveredBackground);
    const headingWidth = await secondSummary.evaluate(element => parseFloat(getComputedStyle(element, '::before').width));
    expect(headingWidth).toBeCloseTo((await secondShot.boundingBox())!.width);
    await page.screenshot({ path: info.outputPath('generated-storyboard-unified-hover.png') });
    await secondSummary.press('Enter');
    await expect(secondShot.locator('details')).toHaveAttribute('open', '');
    await expect(page.getByRole('dialog', { name: '编辑镜头', exact: true })).toHaveCount(0);
    await secondSummary.press('Enter');
    await expect(secondShot.locator('details')).not.toHaveAttribute('open');
    await page.screenshot({ path: info.outputPath('generated-storyboard-narrow-light.png') });
    const beforeEdit = await saved(request, project.id), callsBeforeEdit = source.requests.length;
    await editShot.press('Enter');
    const editor = page.getByRole('dialog', { name: '编辑镜头', exact: true });
    const title = editor.getByLabel('镜头标题', { exact: true }), narration = editor.getByLabel('旁白', { exact: true });
    await expect(title).toHaveCount(1);
    await expect(title).toHaveValue('生成的蓝色镜头 2');
    await expect(editor.getByRole('button', { name: '添加镜头', exact: true })).toHaveCount(0);
    await expect(editor.locator('.dialog__surface')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: info.outputPath('generated-storyboard-shot-editor.png') });
    await title.fill('蓝天的第二个镜头');
    await narration.fill('只修改第二镜的旁白。');
    await editor.getByRole('button', { name: '保存到项目', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(storyboard.getByRole('listitem').filter({ hasText: '蓝天的第二个镜头' }).locator('details')).not.toHaveAttribute('open');
    const afterEdit = await saved(request, project.id);
    expect(afterEdit.shots).toEqual([
      beforeEdit.shots[0],
      { ...beforeEdit.shots[1], title: '蓝天的第二个镜头', narration: '只修改第二镜的旁白。' },
    ]);
    expect(afterEdit.workflow.production.manualPlanningSteps ?? []).toEqual([]);
    expect(afterEdit.creativeContext).toEqual(beforeEdit.creativeContext);
    expect(source.requests).toHaveLength(callsBeforeEdit);
    await expect(storyboard.getByRole('button', { name: '编辑镜头：蓝天的第二个镜头', exact: true })).toBeVisible();
    await expect(storyboard.getByRole('button', { name: '编辑镜头：生成的蓝色镜头 1', exact: true })).toBeVisible();
    await saveProduction(dialog);
    await expect(dialog).toHaveCount(0);
    const savedSettings = await saved(request, project.id);
    expect(savedSettings.shots).toEqual(afterEdit.shots);
    expect(savedSettings.workflow.production.manualPlanningSteps ?? []).toEqual([]);

    await open(page, savedSettings);
    await productionStep(dialog, '创作要求');
    await expect(brief).toHaveValue(new RegExp(briefText));
    await expect(style).toHaveValue(new RegExp(styleText));
    await brief.press('ControlOrMeta+A');
    await brief.press('Backspace');
    await expect(brief).toHaveValue('');
    await expect(brief).not.toHaveAccessibleDescription('AI 生成');
    await brief.press('ControlOrMeta+Z');
    await expect(brief).toHaveValue(new RegExp(briefText));
    await expect(brief).toHaveAccessibleDescription('AI 生成');
    await brief.press('ControlOrMeta+A');
    await brief.press('Backspace');
    await expect(brief).toHaveValue('');
    await expect(style).toHaveValue(new RegExp(styleText));
    await style.press('ControlOrMeta+A');
    await style.press('Delete');
    await expect(style).toHaveValue('');
    await expect(style).not.toHaveAccessibleDescription('AI 生成');
    await saveProduction(dialog);
    await expect(dialog).toHaveCount(0);
    const cleared = await saved(request, project.id);
    expect(cleared.brief).toBe('');
    expect(cleared.style).toBe('');
    expect(cleared.shots).toEqual(afterEdit.shots);
    expect(cleared.workflow.production.manualPlanningSteps ?? []).toEqual([]);

    const generatedRead = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc')
      && response.request().postDataJSON()?.method === 'project.planning.outputs');
    await open(page, cleared);
    await productionStep(dialog, '创作要求');
    expect((await generatedRead).ok()).toBe(true);
    await expect(storyboard.getByText('蓝天的第二个镜头', { exact: true })).toBeVisible();
    await expect(brief).toHaveValue('');
    await expect(style).toHaveValue('');
    const replacementBrief = '改为从云层颜色讲解蓝天。';
    await brief.fill(replacementBrief);
    await saveProduction(dialog);
    await expect(dialog).toHaveCount(0);
    const replaced = await saved(request, project.id);
    expect(replaced.brief).toBe(replacementBrief);
    expect(replaced.style).toBe('');
    expect(replaced.workflow.production.manualPlanningSteps).toEqual(['brief']);
    expect(source.requests).toHaveLength(callsBeforeEdit);

    const styleRun = await rpc<{ id: string }>(request, 'run.start', { projectId: project.id, nodeId: 'style' });
    await expect.poll(async () => await latest(request, project.id)).toMatchObject({ id: styleRun.id, status: 'succeeded' });
    await open(page, replaced);
    await productionStep(dialog, '创作要求');
    await expect(brief).toHaveValue(replacementBrief);
    await expect(style).toHaveValue(new RegExp(styleText));
    await expect(style).toHaveAccessibleDescription('AI 生成');
    expect(source.requests).toHaveLength(callsBeforeEdit + 1);

    for (const title of ['生成的蓝色镜头 1', '蓝天的第二个镜头']) {
      await storyboard.getByRole('button', { name: `删除镜头：${title}`, exact: true }).click();
      await confirmAction(page, '确认移除');
      await expect(storyboard.getByText(title, { exact: true })).toHaveCount(0);
    }
    await expect.poll(async () => (await saved(request, project.id)).shots).toEqual([]);
    await open(page, replaced);
    await productionStep(dialog, '创作要求');
    await expect(style).toHaveValue(new RegExp(styleText));
    await expect(storyboard.getByRole('listitem')).toHaveCount(0);
    await expect(storyboard.getByRole('button', { name: '添加分镜', exact: true })).toBeEnabled();
    expect(source.requests).toHaveLength(callsBeforeEdit + 1);
  } finally { releaseVideo.resolve(); await source.close(); }
});

test('fills planning content and generates video using the manual storyboard and role reference', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const source = await fixture(request, info);
  try {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.addInitScript(() => localStorage.setItem('vq-theme', 'light'));
    const referenceBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
    const referencePath = info.outputPath('角色参考图.png');
    await writeFile(referencePath, referenceBytes);
    const reference = await rpc<AssetRecord>(request, 'asset.import', { path: referencePath, kind: 'image' });
    const character = await rpc<CharacterProfile>(request, 'character.save', { character: { name: `蓝帽旁白者 ${source.project.id.slice(0, 8)}`, description: '蓝色圆帽，银框眼镜', referenceAssetIds: [reference.id] } });
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
    await expect(referenceReview).toContainText(reference.name);
    await expect(page.getByRole('alertdialog').locator('.dialog__surface')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: info.outputPath('video-reference-confirmation.png') });
    await confirmAction(page, '确认开始制作');
    await expect.poll(async () => (await latest(request, project.id))?.status, { timeout: 30_000 }).toBe('succeeded');
    expect(source.requests).toHaveLength(1);
    expect(JSON.stringify(source.requests[0])).toContain('这段旁白由我填写。');
    expect((source.requests[0].content as Array<{ type: string }>).filter(item => item.type === 'image_url')).toEqual([
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
    await page.locator('.project-heading-actions').getByRole('button', { name: '制作设置', exact: true }).click();
    await productionStep(dialog, '创作要求');
    await expect(dialog.getByText('AI 生成', { exact: true })).toHaveCount(0);
    await expect(dialog.getByLabel('简报内容', { exact: true })).toHaveValue(briefText);
    await expect(dialog.getByLabel('风格内容', { exact: true })).toHaveValue(styleText);
    await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await expect(dialog).toHaveCount(0);
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
    const storyboard = dialog.getByRole('group', { name: '分镜内容', exact: true });
    await expect(storyboard).toContainText('已填写 1 个镜头');
    await storyboard.getByRole('button', { name: '编辑镜头：树林晨景', exact: true }).click();
    const shotEditor = page.getByRole('dialog', { name: '编辑镜头', exact: true });
    await expect(shotEditor.getByLabel('分镜画面', { exact: true }).locator('option:checked')).toHaveText('手绘分镜.png');
    await shotEditor.getByLabel('声音要求', { exact: true }).fill('轻微的风吹树叶声');
    await shotEditor.getByRole('button', { name: '保存到项目', exact: true }).click();
    await expect(shotEditor).toHaveCount(0);
    expect((await saved(request, source.project.id)).shots[0]).toMatchObject({ assetId: authored.shots[0].assetId, soundPrompt: '轻微的风吹树叶声' });
    await expect(storyboard).toContainText('已填写 1 个镜头');
    await storyboard.getByRole('button', { name: '改用 AI 生成', exact: true }).click();
    await expect(storyboard).toContainText('项目分镜 · 1 个镜头');
    await storyboard.getByRole('button', { name: '使用项目分镜', exact: true }).click();
    await expect(storyboard).toContainText('已填写 1 个镜头');
    await storyboard.getByRole('button', { name: '添加分镜', exact: true }).click();
    await expect(editor.getByRole('group', { name: '镜头 2 内容', exact: true }).getByLabel('镜头标题', { exact: true })).toHaveValue('');
    await expect(editor.getByLabel('镜头标题', { exact: true })).toHaveCount(1);
    await editor.getByRole('button', { name: '取消', exact: true }).click();
    await expect(editor).toHaveCount(0);
    expect((await saved(request, source.project.id)).shots).toHaveLength(1);
    await pick(dialog, '视频模型', source.video);
    await expect(dialog.getByRole('combobox', { name: '图片模型', exact: true })).toHaveCount(0);
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
    await expect(dialog.getByText('AI 生成要求', { exact: true })).toHaveCount(0);
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
