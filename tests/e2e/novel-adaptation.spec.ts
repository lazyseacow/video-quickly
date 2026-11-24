import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { assetSchema, type ModelProfile, type ProjectDocument } from '@video-quickly/contracts';
import { fixtureCharacterImage } from '../fixtures/character-image';
import { approvedDialogue, approvedScreenplay, directorDraft, novelCharacter, novelFixtureResponse, novelShot, novelSource } from '../fixtures/novel-adaptation';
import { confirmAction } from './confirmation-actions';
import { test } from './isolated-workspace';
import { rpc, saved } from './native-video-fixture';
import { creationInput, creationMode, setCreationTitle } from './drama-creation';
import { revealStudioNavigation } from './workspace-navigation';

test.use({ viewport: { width: 1024, height: 720 }, reducedMotion: 'reduce' });

test('carries creative instructions and approvals through the adaptation conversation', async ({ page, request }, info) => {
  const requests: string[] = [], imagePrompts: string[] = [], errors: string[] = [];
  const screenplayInstruction = '让开场先听到雨点，再看到林夏手里的钥匙。';
  const screenplayRevisionInstruction = '在林夏开口前，让船工把灯举高。';
  const revisedDraft = directorDraft.replace('林夏：我得回去。', '船工举高了灯。\n林夏：我得回去。');
  const characterInstruction = '保留橙色雨衣，并注明袖口的反光条。';
  const storyboardInstruction = '把钥匙的特写保留在第一个镜头。';
  const portrait = await fixtureCharacterImage();
  page.on('pageerror', error => errors.push(error.message));
  const server = createServer(async (incoming, response) => {
    let body = '';
    for await (const chunk of incoming) body += chunk;
    response.setHeader('content-type', 'application/json');
    if (incoming.url === '/v1/images/generations') {
      imagePrompts.push((JSON.parse(body) as { prompt: string }).prompt);
      response.end(JSON.stringify({ data: [{ b64_json: portrait.toString('base64') }] }));
      return;
    }
    const data = JSON.parse(body) as { input?: string | { content: string }[]; text?: { format?: { name?: string } } };
    const prompt = typeof data.input === 'string' ? data.input : data.input?.[0]?.content ?? '';
    requests.push(prompt);
    try {
      const schema = data.text?.format?.name;
      const output = schema === 'drama_screenplay' && prompt.includes(screenplayRevisionInstruction)
        ? JSON.stringify({ text: revisedDraft }) : novelFixtureResponse(prompt, schema);
      response.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: output }] }] }));
    } catch (error) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('本地改编模型夹具未启动。');
    const model = await rpc<ModelProfile>(request, 'model.save', { model: {
      name: '改编验收模型', provider: 'openai-compatible', connectionType: 'text', textProtocol: 'responses',
      capabilities: ['text', 'structured-output'], model: 'adaptation-fixture', baseUrl: `http://127.0.0.1:${address.port}/v1`,
    } });
    const imageModel = await rpc<ModelProfile>(request, 'model.save', { model: {
      name: '角色定妆夹具', provider: 'openai-compatible', connectionType: 'image', capabilities: ['image'],
      model: 'gpt-image-fixture', baseUrl: `http://127.0.0.1:${address.port}/v1`,
    } });
    await page.goto('/');
    const composer = page.getByRole('region', { name: '新建短剧', exact: true });
    await expect(creationMode(composer, '自动判断')).toBeChecked();
    const input = creationInput(composer);
    await input.fill(novelSource);
    const composingEnter = await input.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
    expect(composingEnter).toBe(true);
    await expect(composer.getByRole('textbox', { name: '短剧名称', exact: true })).toHaveCount(0);
    await input.press('Shift+Enter');
    await expect(input).toHaveValue(`${novelSource}\n`);
    await input.press('Enter');
    const routeChoices = composer.getByRole('log', { name: '创作对话', exact: true });
    await expect(routeChoices).toContainText(novelSource);
    for (const name of ['改编小说', '上传剧本', '制作剧本', '创作分镜']) {
      await expect(routeChoices.getByRole('button', { name, exact: true })).toBeVisible();
    }
    expect(requests).toHaveLength(0);
    expect(await rpc(request, 'dramaWork.list')).toMatchObject({ items: [] });
    await routeChoices.getByRole('button', { name: '改编小说', exact: true }).click();
    await expect(composer.getByRole('textbox', { name: '短剧名称', exact: true })).toBeFocused();
    await setCreationTitle(composer, '创作分镜：钥匙与旧渡船');
    await expect(page.getByRole('region', { name: '创作分镜', exact: true })).toHaveCount(0);
    expect(await rpc(request, 'dramaWork.list')).toMatchObject({ items: [] });
    const creation = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.method === 'dramaStudio.create');
    await composer.getByRole('button', { name: '创建短剧', exact: true }).click();
    const { project } = (await (await creation).json()).result as { project: ProjectDocument };

    const workspace = page.getByRole('group', { name: '分集工作区', exact: true });
    const chat = workspace.getByRole('button', { name: '对话', exact: true });
    const storyboard = workspace.getByRole('button', { name: '分镜工作台', exact: true });
    const adaptation = page.getByRole('region', { name: '小说改编', exact: true });
    const conversation = adaptation.getByRole('log', { name: '创作对话', exact: true });
    const checkpoints = adaptation.getByRole('navigation', { name: '小说改编阶段' });
    const screenplayStep = conversation.getByRole('heading', { name: '导演剧本', exact: true });
    const rolesStep = conversation.getByRole('heading', { name: '角色资产', exact: true });
    const storyboardStep = conversation.getByRole('heading', { name: '分镜', exact: true });
    const instruction = adaptation.getByRole('textbox', { name: '创作要求', exact: true });
    await expect(adaptation).toBeVisible();
    await expect(page.getByRole('dialog', { name: '小说改编', exact: true })).toHaveCount(0);
    expect(requests).toHaveLength(0);
    await expect(conversation).toBeVisible();
    await expect(adaptation.getByText('已完成 1 / 4', { exact: true })).toBeVisible();
    await expect(checkpoints.getByRole('button', { name: '导演剧本，待生成' })).toHaveAttribute('aria-current', 'step');
    await expect(checkpoints.getByRole('button', { name: '角色资产，待剧本审核' })).toBeDisabled();
    await expect(checkpoints.getByRole('button', { name: '分镜，待角色确认' })).toBeDisabled();
    await expect(conversation.getByRole('button', { name: '修改原文', exact: true })).toBeVisible();
    await expect(conversation.getByText(novelSource, { exact: true })).toBeVisible();
    await expect(screenplayStep).toBeVisible();
    await expect(rolesStep).toHaveCount(0);
    await expect(storyboardStep).toHaveCount(0);
    await adaptation.getByLabel('文本模型', { exact: true }).selectOption(model.id);
    await instruction.press('Control+Enter');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await instruction.fill(screenplayInstruction);
    await storyboard.click();
    await expect(adaptation).toBeHidden();
    await expect(page.getByRole('button', { name: '开始制作', exact: true })).toBeVisible();
    await chat.click();
    await expect(instruction).toHaveValue(screenplayInstruction);
    expect(requests).toHaveLength(0);
    await instruction.press('Enter');
    await expect(page.getByRole('alertdialog')).toBeVisible();
    expect(requests).toHaveLength(0);
    await confirmAction(page, '确认生成');

    const screenplay = adaptation.getByRole('textbox', { name: '导演剧本文字', exact: true });
    await expect(screenplay).toHaveValue(directorDraft, { timeout: 12_000 });
    await expect(conversation.getByText(screenplayInstruction, { exact: true })).toBeVisible();
    await expect(rolesStep).toHaveCount(0);
    expect(requests[0]).toContain(screenplayInstruction);
    await instruction.fill(screenplayRevisionInstruction);
    await adaptation.getByRole('button', { name: '按要求重写', exact: true }).click();
    await confirmAction(page, '确认生成');
    await expect(screenplay).toHaveValue(revisedDraft, { timeout: 12_000 });
    await expect(conversation.getByText(screenplayRevisionInstruction, { exact: true })).toBeVisible();
    expect(requests[1]).toContain(screenplayRevisionInstruction);
    expect(requests[1]).toContain('林夏用袖口擦去铜钥匙上的水珠。');
    await screenplay.fill(approvedScreenplay);
    await page.screenshot({ path: info.outputPath('novel-director-review.png') });
    await adaptation.getByRole('button', { name: '审核通过', exact: true }).click();
    await expect(rolesStep).toBeVisible();
    await expect(storyboardStep).toHaveCount(0);
    await expect(adaptation.getByText('已完成 2 / 4', { exact: true })).toBeVisible();
    await expect(checkpoints.getByRole('button', { name: '角色资产，待生成' })).toHaveAttribute('aria-current', 'step');
    await checkpoints.getByRole('button', { name: '小说原文，已保存' }).click();
    const sourceField = conversation.getByRole('textbox', { name: '小说原文', exact: true });
    const importedSource = `${novelSource}\n这一段暂作备忘。`;
    const novelPath = info.outputPath('待校对原文.md');
    await writeFile(novelPath, importedSource, 'utf8');
    await expect(conversation.getByRole('button', { name: '读取小说', exact: true })).toBeDisabled();
    await conversation.getByRole('textbox', { name: '小说文件路径', exact: true }).fill(novelPath);
    await conversation.getByRole('button', { name: '读取小说', exact: true }).click();
    await expect(sourceField).toHaveValue(importedSource);
    await expect(conversation.getByText('已读取 待校对原文.md，可编辑后保存。')).toBeVisible();
    await checkpoints.getByRole('button', { name: '导演剧本，待上一步提交' }).click();
    await expect(screenplayStep).toBeFocused();
    await expect(screenplay).toBeDisabled();
    await adaptation.getByRole('button', { name: '返回小说原文' }).click();
    await expect(sourceField).toHaveValue(importedSource);
    await sourceField.fill(novelSource);
    await checkpoints.getByRole('button', { name: '角色资产，待生成' }).click();
    await expect(rolesStep).toBeFocused();
    await page.getByRole('button', { name: '返回短剧工作室', exact: true }).click();
    await expect(adaptation).toBeHidden();
    const navigation = await revealStudioNavigation(page);
    const recent = navigation.getByRole('region', { name: '最近分集', exact: true });
    await recent.getByRole('button').filter({ hasText: project.title }).click();
    await expect(rolesStep).toBeVisible();
    await expect(conversation.getByText(screenplayRevisionInstruction, { exact: true })).toBeVisible();
    await expect.poll(() => saved(request, project.id)).toMatchObject({ originalText: approvedScreenplay, shots: [] });
    expect(requests).toHaveLength(2);

    const skills = adaptation.getByRole('group', { name: '角色创作 Skill', exact: true });
    await skills.getByRole('button', { name: '角色创作 Skill', exact: true }).click();
    await skills.getByRole('searchbox').fill('人物与视觉设定');
    await skills.getByRole('button', { name: /短剧创作技能/ }).click();
    await skills.getByRole('checkbox', { name: /人物与视觉设定/ }).check();
    await adaptation.getByRole('heading', { name: '角色资产', exact: true }).focus();
    await instruction.fill(characterInstruction);
    await adaptation.getByRole('button', { name: '提取角色资产', exact: true }).click();
    await confirmAction(page, '确认生成');
    await expect(conversation.getByText(characterInstruction, { exact: true })).toBeVisible();
    await adaptation.locator('summary').filter({ hasText: /^林夏$/ }).click({ timeout: 12_000 });
    await expect(adaptation.getByRole('textbox', { name: '角色名称' })).toHaveValue('林夏', { timeout: 12_000 });
    const editedAppearance = '林夏，橙色雨衣，袖口有银色反光条。';
    await adaptation.getByRole('textbox', { name: '角色设定' }).fill(editedAppearance);
    await adaptation.getByLabel('参考图模型', { exact: true }).selectOption(imageModel.id);
    await expect(adaptation.getByRole('textbox', { name: '视觉提示词', exact: true })).toHaveValue(novelCharacter.visualPrompt);
    const portraitResponse = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.method === 'character.generateImage');
    await adaptation.getByRole('button', { name: '生成并添加参考图', exact: true }).click();
    expect(imagePrompts).toHaveLength(0);
    await confirmAction(page, '确认生成');
    const generatedAsset = assetSchema.parse((await (await portraitResponse).json()).result);
    const imageCaption = adaptation.getByText('已添加到角色参考图', { exact: true });
    await expect(imageCaption).toBeVisible();
    const preview = adaptation.getByRole('img', { name: generatedAsset.name, exact: true });
    await preview.scrollIntoViewIfNeeded();
    await expect.poll(() => preview.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(320);
    expect(imagePrompts).toHaveLength(1);
    expect(imagePrompts[0]).toContain(novelCharacter.visualPrompt);
    await imageCaption.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('novel-character-reference.png') });
    await adaptation.getByRole('button', { name: '确认角色资产', exact: true }).click();
    await expect(storyboardStep).toBeVisible();
    await instruction.fill(storyboardInstruction);
    await adaptation.getByRole('button', { name: '生成分镜', exact: true }).click();
    await confirmAction(page, '确认生成');
    await expect(adaptation.getByRole('list', { name: '生成的分镜' })).toContainText(novelShot.title, { timeout: 12_000 });
    await expect(conversation.getByText(storyboardInstruction, { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    const artifacts = adaptation.getByRole('complementary', { name: '本集产物', exact: true });
    await expect(artifacts).toBeVisible();
    await expect(artifacts.getByRole('button', { name: '定位导演剧本', exact: true })).toBeVisible();
    await artifacts.getByRole('button', { name: /林夏.*1 张参考图/ }).click();
    const roleSummary = conversation.locator('summary').filter({ hasText: /^林夏$/ });
    await expect(roleSummary).toBeFocused();
    await expect(adaptation.getByRole('textbox', { name: '角色名称' })).toHaveValue('林夏');
    await artifacts.getByRole('button').filter({ hasText: novelShot.title }).click();
    const shotSummary = conversation.getByRole('list', { name: '生成的分镜' }).locator('summary').filter({ hasText: novelShot.title });
    await expect(shotSummary).toBeFocused();
    await page.screenshot({ path: info.outputPath('novel-episode-artifact-rail.png') });
    await page.setViewportSize({ width: 600, height: 900 });
    await expect(artifacts).toBeHidden();
    const artifactDisclosure = adaptation.locator('.novel-adaptation__artifact-disclosure');
    await artifactDisclosure.locator('summary').click();
    await expect(artifactDisclosure.getByRole('button', { name: '定位导演剧本', exact: true })).toBeVisible();
    await artifactDisclosure.getByRole('button').filter({ hasText: novelShot.title }).click();
    await expect(artifactDisclosure).not.toHaveAttribute('open', '');
    await expect(shotSummary).toBeFocused();
    expect(await adaptation.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await conversation.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath('novel-storyboard-narrow.png') });
    expect((await saved(request, project.id)).shots).toHaveLength(0);
    await adaptation.getByRole('button', { name: '应用分镜', exact: true }).click();
    await expect.poll(() => saved(request, project.id)).toMatchObject({ originalText: approvedScreenplay,
      shots: [{ title: novelShot.title, creativeEntityKeys: [novelCharacter.key] }],
      creativeContext: { entities: [{ key: novelCharacter.key, referenceAssetIds: [generatedAsset.id] }] },
    });
    await expect(adaptation.getByText('已完成 4 / 4', { exact: true })).toBeVisible();
    await expect(checkpoints.getByRole('button', { name: '分镜，已应用' })).toHaveAttribute('aria-current', 'step');
    await adaptation.getByRole('button', { name: '打开分镜编辑器', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '编辑旁白与分镜', exact: true })).toBeVisible();
    await expect(adaptation).toBeHidden();
    expect(requests).toHaveLength(5);
    expect(requests[2]).toContain(approvedDialogue);
    expect(requests[2]).toContain('人物与视觉设定');
    expect(requests[2]).toContain(characterInstruction);
    expect(requests[3]).toContain(storyboardInstruction);
    expect(requests[4]).toContain(editedAppearance);
    expect(errors).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
