import { expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type { CharacterProfile, CreativePlanningEntry, CreativePlanningResult, CreativeStyleCard, ModelProfile, ProjectDocument } from '@video-quickly/contracts';
import { confirmAction } from './confirmation-actions';
import { creationInput, openCreationSettings } from './drama-creation';
import { test } from './isolated-workspace';
import { rpc, saved } from './native-video-fixture';
import { chooseStudioEntry, openProjectFromList } from './workspace-navigation';

const goal = '雨夜，侦探穿过霓虹街道找到一封信。';
const styleCard = {
  fields: { artStyle: '雨夜电影感', palette: '墨蓝为主，琥珀为点缀', composition: '街道远景', lighting: '冷暖反射', characterAppearance: '', sceneContinuity: '维持同一条街道' },
  swatches: [{ hex: '#193248', label: '墨蓝' }, { hex: '#EA9B46', label: '琥珀' }, { hex: '#1F6C69', label: '街灯青' }],
};
const originalNarration = '信封就在这里。别惊动他们。';
const revisionInstruction = '把选中的一句话改成压低声音的口语。';
const revised = { lineText: '别出声。' };
const visualRevisionInstruction = '把这个镜头改成手持信封的特写。';
const revisedVisual = { visualPrompt: '深蓝夜色中，特写手里的信封。' };
const storyboardObjective = { route: 'storyboard', reason: '沿用雨夜风格，交付分镜。', totalSeconds: null, shotCount: null, shotSeconds: null, keyframeShots: null };
const storyboard = { shots: ['街角', '过街', '发现信封'].map((title, index) => ({
  title, visualPrompt: `沿用墨蓝环境光，表现${title}。`, narration: index === 2 ? originalNarration : '', soundPrompt: '雨打路面',
})) };
type ModelRequest = { messages: { content: unknown }[] };
function taskType({ messages }: ModelRequest) {
  const prompt = JSON.stringify(messages[0].content);
  if (prompt.includes('分析创作目标，选择一条可执行路线')) return '分析目标';
  if (prompt.includes('阅读已经生成的分镜，为静态预演推荐')) return '推荐镜头';
  if (prompt.includes('制作视觉风格卡')) return '风格卡';
  if (prompt.includes(revisionInstruction)) return '修改一句台词';
  if (prompt.includes(visualRevisionInstruction)) return '修改画面';
  return '三段分镜';
}
test.use({ reducedMotion: 'reduce' });

async function openPlanning(page: Page, command = '创作分镜') {
  const composer = page.getByRole('region', { name: '新建短剧', exact: true });
  const planning = page.getByRole('region', { name: '创作分镜', exact: true });
  await expect(composer.or(planning).first()).toBeVisible();
  if (!await planning.isVisible()) {
    await creationInput(composer).fill(command);
    await composer.getByRole('button', { name: '发送', exact: true }).click();
  }
  await expect(planning).toBeVisible();
  return planning;
}

async function modelServer(respond: (request: ModelRequest) => unknown, previewImage?: Buffer | ((ordinal: number) => Buffer)) {
  const calls: ModelRequest[] = [];
  const imageRequests: string[] = [];
  const server = createServer(async (incoming, response) => {
    let body = ''; for await (const chunk of incoming) body += chunk;
    const path = incoming.url ?? '';
    if (previewImage && /\/images\/(generations|edits)$/.test(path)) {
      imageRequests.push(path);
      response.setHeader('content-type', 'application/json');
      const bytes = typeof previewImage === 'function' ? previewImage(imageRequests.length) : previewImage;
      response.end(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] }));
      return;
    }
    const payload = JSON.parse(body) as ModelRequest;
    calls.push(payload);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(respond(payload)) } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('本地模型未启动。');
  return { calls, imageRequests, baseUrl: `http://127.0.0.1:${address.port}/v1`, async close() {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

test('keeps an oversized storyboard request as an editable message', async ({ page }) => {
  await page.goto('/');
  const composer = page.getByRole('region', { name: '新建短剧', exact: true });
  const input = creationInput(composer);
  const command = `帮我生成分镜：${'雨'.repeat(3000)}`;
  await input.fill(command);
  await composer.getByRole('button', { name: '发送', exact: true }).click();
  await expect(composer.getByRole('alert')).toContainText(/3,?000/);
  await expect(input).toHaveValue(command);
  await expect(page.getByRole('region', { name: '创作分镜', exact: true })).toHaveCount(0);
});

test('asks how to use an edited, imported document that starts with a command', async ({ page, request, isolatedWorkspace }) => {
  const text = '帮我生成分镜：这是角色在纸条上写下的话。';
  const path = join(isolatedWorkspace.directory, '未命名文稿.md');
  await writeFile(path, text);
  await page.goto('/');
  const composer = page.getByRole('region', { name: '新建短剧', exact: true });
  const add = composer.getByRole('button', { name: '添加文件', exact: true });
  await add.click();
  const importDialog = page.getByRole('dialog', { name: '导入文稿', exact: true });
  const filePath = importDialog.getByRole('textbox', { name: '文稿文件', exact: true });
  const read = importDialog.getByRole('button', { name: '读取文件', exact: true });
  await filePath.fill(path);
  await read.click();
  await expect(importDialog).toHaveCount(0);
  const input = creationInput(composer);
  await expect(input).toHaveValue(text);
  await expect(composer.getByText('未命名文稿.md', { exact: true })).toBeVisible();
  const replace = composer.getByRole('button', { name: '替换文件', exact: true });
  const remove = composer.getByRole('button', { name: '移除文件', exact: true });
  await replace.click();
  await expect(importDialog).toBeVisible();
  await importDialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(input).toHaveValue(text);
  await remove.click();
  await expect(input).toHaveValue('');
  await expect(composer.getByText('未命名文稿.md', { exact: true })).toHaveCount(0);
  await add.click();
  await filePath.fill(path);
  await read.click();
  await expect(importDialog).toHaveCount(0);
  await expect(input).toHaveValue(text);
  const edited = `${text}\n角色把纸条收进口袋。`;
  await input.fill(edited);
  await composer.getByRole('button', { name: '发送', exact: true }).click();
  const thread = composer.getByRole('log', { name: '创作对话', exact: true });
  await expect(thread).toContainText(edited);
  await expect(thread).toContainText('你想怎么使用这份文稿？');
  await expect(thread.getByRole('button', { name: '创作分镜', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '创作分镜', exact: true })).toHaveCount(0);
  await thread.getByRole('button', { name: '上传剧本', exact: true }).click();
  await expect(composer.getByRole('textbox', { name: '短剧名称', exact: true })).toBeFocused();
  await expect(thread).toContainText(edited);
  expect(await rpc(request, 'workspace.summary')).toMatchObject({ projects: [] });
});

test('turns an image and Skill into a reusable style and applies only the selected sentence of the third shot after preview', async ({ page, request, isolatedWorkspace }, info) => {
  const imagePath = join(isolatedWorkspace.directory, 'rain-on-the-bridge.jpg');
  const reference = await readFile(new URL('../../src/packages/runtime/src/builtin-drama-media/rain-on-the-bridge.jpg', import.meta.url));
  await writeFile(imagePath, reference);
  const server = await modelServer(payload => {
    const name = taskType(payload);
    if (name === '分析目标') return storyboardObjective;
    return name === '风格卡' ? styleCard : name === '修改一句台词' ? revised : storyboard;
  });
  const { calls } = server;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const model = await rpc<ModelProfile>(request, 'model.save', { model: { name: '分镜验收模型', provider: 'openai-compatible', connectionType: 'text', capabilities: ['text', 'vision', 'structured-output'], model: 'fixture-vision', baseUrl: server.baseUrl } });
    await page.setViewportSize({ width: 1024, height: 720 });
    await page.goto('/');
    const command = `帮我生成分镜：${goal}`;
    const planning = await openPlanning(page, command);
    await expect(planning.getByRole('textbox', { name: '创作目标', exact: true })).toHaveValue(command);
    await expect(planning.getByRole('log', { name: '分镜创作对话' })).toContainText(command);
    expect(calls).toHaveLength(0);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await planning.getByRole('textbox', { name: '参考图', exact: true }).fill(imagePath);
    await expect(planning.getByLabel('文本模型')).toHaveValue(model.id);
    await planning.getByRole('button', { name: '创作 Skill', exact: true }).click();
    await planning.getByRole('searchbox', { name: '搜索 Skill 或分组' }).fill('人物与视觉设定');
    await planning.getByRole('button', { name: /短剧创作技能/ }).click();
    await planning.getByRole('checkbox', { name: /人物与视觉设定/ }).check();
    await planning.getByRole('textbox', { name: '创作目标', exact: true }).focus();
    const analyze = planning.getByRole('button', { name: '分析创作目标', exact: true });
    await analyze.click();
    const billing = page.getByRole('alertdialog');
    await expect(billing).toBeVisible();
    expect(calls).toHaveLength(0);
    await billing.getByRole('button', { name: '取消', exact: true }).click();
    await expect(billing).toHaveCount(0);
    expect(calls).toHaveLength(0);
    await analyze.click();
    await confirmAction(page, '确认分析创作目标');
    await expect(planning.getByRole('heading', { name: '沿用风格出分镜' })).toBeFocused();
    await planning.getByRole('button', { name: '确认并开始制作', exact: true }).click();
    await confirmAction(page, '确认开始方案');
    await expect(planning.getByRole('heading', { name: '风格卡' })).toBeVisible();
    const referenceImage = planning.getByRole('img', { name: 'rain-on-the-bridge.jpg' });
    await expect(referenceImage).toBeVisible();
    await expect.poll(async () => referenceImage.evaluate(image => image instanceof HTMLImageElement ? image.naturalWidth : 0)).toBeGreaterThan(0);
    await expect(planning.getByRole('list', { name: '色板' })).toContainText('#193248');
    await expect(planning.getByRole('button', { name: '应用分镜并编辑' })).toBeEnabled();
    const styleDetails = planning.getByText('风格设定', { exact: true });
    const styleField = planning.getByText(styleCard.fields.artStyle, { exact: true });
    await expect(styleField).toBeHidden();
    await styleDetails.press('Enter');
    await expect(styleField).toBeVisible();
    await styleDetails.press('Enter');
    await expect(styleField).toBeHidden();
    await page.screenshot({ path: info.outputPath('creative-planning-result.png') });
    const cards = await rpc<{ items: CreativeStyleCard[] }>(request, 'creativePlanning.styleCards');
    expect(cards.items).toHaveLength(1);
    expect(cards.items[0].swatches).toEqual(styleCard.swatches);
    const draft = await rpc<CreativePlanningResult>(request, 'creativePlanning.get', { runId: cards.items[0].id });
    const original = (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: draft.projectId })).project;
    const content = calls[1].messages[0].content;
    expect(Array.isArray(content) && content.some(block => block.type === 'image_url' && block.image_url?.url === `data:image/jpeg;base64,${reference.toString('base64')}`), '视觉请求使用原参考图的实际内容').toBe(true);
    expect(JSON.stringify(calls[1].messages[0].content)).toContain('人物与视觉设定');
    expect(JSON.stringify(calls[2].messages[0].content)).toContain('#193248');
    await chooseStudioEntry(page, '对话');
    await page.evaluate(() => localStorage.setItem('vq-theme', 'light'));
    await page.reload();
    await page.setViewportSize({ width: 390, height: 844 });
    const composer = page.getByRole('region', { name: '新建短剧', exact: true });
    const settings = await openCreationSettings(page, composer);
    await settings.getByRole('button', { name: '分镜创作记录', exact: true }).click();
    await expect(settings).toHaveCount(0);
    await expect(planning).toBeVisible();
    expect(calls).toHaveLength(3);
    await planning.getByRole('button', { name: new RegExp(goal) }).click();
    await expect(planning.getByRole('heading', { name: '第 3 段 · 发现信封' })).toBeVisible();
    await planning.getByRole('button', { name: '修改镜头', exact: true }).click();
    const target = planning.getByRole('combobox', { name: '目标镜头' });
    await expect(target).toBeFocused();
    await target.selectOption(draft.shots![2].id);
    await planning.getByRole('checkbox', { name: '单句台词' }).check();
    const line = planning.getByRole('combobox', { name: '目标台词' });
    await line.selectOption(await line.getByRole('option', { name: /别惊动他们/ }).getAttribute('value') ?? '');
    await planning.getByRole('textbox', { name: '修改要求' }).fill(revisionInstruction);
    await planning.getByRole('button', { name: '生成修改预览', exact: true }).click();
    await confirmAction(page, '确认生成修改建议');
    const differences = planning.getByRole('region', { name: '修改差异' });
    await expect(differences).toBeVisible();
    await expect(differences).toContainText('修改前');
    await expect(differences).toContainText('别惊动他们。');
    await expect(differences).toContainText('修改后');
    await expect(differences).toContainText(revised.lineText);
    const history = await rpc<{ items: CreativePlanningEntry[] }>(request, 'creativePlanning.list');
    const preview = await rpc<CreativePlanningResult>(request, 'creativePlanning.get', { runId: history.items[0].id });
    const revisedShots = [...draft.shots!.slice(0, 2), { ...draft.shots![2], narration: `信封就在这里。${revised.lineText}` }];
    expect(preview.shots).toEqual(revisedShots);
    expect(preview.styleCard).toEqual(draft.styleCard);
    expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: draft.projectId })).project).toEqual(original);
    expect(calls.map(taskType)).toEqual(['分析目标', '风格卡', '三段分镜', '修改一句台词']);
    expect(JSON.stringify(calls[3].messages[0].content)).toContain('#193248');
    expect(await planning.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath('creative-planning-revised-narrow.png') });
    await planning.getByRole('button', { name: '确认应用', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '编辑旁白与分镜', exact: true });
    await expect(editor).toBeVisible();
    const third = editor.getByRole('group', { name: '镜头 3 内容' });
    await expect(third.getByLabel('镜头标题')).toHaveValue('发现信封');
    await third.getByLabel('镜头标题').fill('拾起信封');
    await editor.getByRole('button', { name: '保存到项目' }).click();
    await expect(editor).toHaveCount(0);
    const project = (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: draft.projectId })).project;
    expect(project.shots).toEqual([...revisedShots.slice(0, 2), { ...revisedShots[2], title: '拾起信封' }]);
    expect(project.style).toContain('#193248');
    await page.getByRole('button', { name: '短剧工作室', exact: true }).click();
    await openPlanning(page);
    await planning.getByRole('button', { name: '新建分镜', exact: true }).click();
    await planning.getByRole('textbox', { name: '创作目标', exact: true }).fill('同一条街道上的另一封信。');
    await planning.getByLabel('已有风格卡').selectOption(cards.items[0].id);
    await expect(planning.getByRole('textbox', { name: '参考图', exact: true })).toHaveCount(0);
    await planning.getByRole('button', { name: '分析创作目标', exact: true }).click();
    await confirmAction(page, '确认分析创作目标');
    await planning.getByRole('button', { name: '确认并开始制作', exact: true }).click();
    await confirmAction(page, '确认开始方案');
    await expect(planning.getByRole('button', { name: '应用分镜并编辑' })).toBeEnabled();
    expect(calls.map(taskType)).toEqual(['分析目标', '风格卡', '三段分镜', '修改一句台词', '分析目标', '三段分镜']);
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});

test('recommends from the completed storyboard, confirms selected frames, and replaces only one', async ({ page, request, isolatedWorkspace }, info) => {
  const reference = await readFile(new URL('../../src/packages/runtime/src/builtin-drama-media/rain-on-the-bridge.jpg', import.meta.url));
  const imagePath = join(isolatedWorkspace.directory, 'keyframe-reference.jpg');
  await writeFile(imagePath, reference);
  const previewImage = await readFile(new URL('../../src/packages/runtime/src/builtin-drama-media/paris-alley.jpg', import.meta.url));
  let firstShotId = '';
  const server = await modelServer(payload => {
    const name = taskType(payload);
    if (name === '分析目标') return { route: 'keyframe-preview', reason: '预演指定的第二个镜头。', totalSeconds: 15, shotCount: 3, shotSeconds: [5, 8, 5], keyframeShots: [2] };
    if (name === '推荐镜头') return { recommendations: [{ shotId: firstShotId, reason: '街角交代了追踪的起点。' }] };
    if (name === '修改一句台词') return revised;
    if (name === '修改画面') return revisedVisual;
    return name === '风格卡' ? styleCard : storyboard;
  }, ordinal => ordinal === 3 ? reference : previewImage);
  try {
    await rpc<ModelProfile>(request, 'model.save', { model: { name: '预演文本模型', provider: 'openai-compatible', connectionType: 'text', capabilities: ['text', 'vision', 'structured-output'], model: 'fixture-vision', baseUrl: server.baseUrl } });
    const imageModel = await rpc<ModelProfile>(request, 'model.save', { model: { name: '预演图片模型', provider: 'openai-compatible', connectionType: 'image', capabilities: ['image'], model: 'fixture-image', baseUrl: server.baseUrl } });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const planning = await openPlanning(page);
    await planning.getByRole('textbox', { name: '创作目标', exact: true }).fill('预演第二镜。总时长不超过 15 秒，分成三个镜头，时长分别为 5/8/5 秒。');
    await planning.getByRole('textbox', { name: '参考图', exact: true }).fill(imagePath);
    await planning.getByRole('button', { name: '创作 Skill', exact: true }).click();
    await planning.getByRole('searchbox', { name: '搜索 Skill 或分组' }).fill('人物与视觉设定');
    await planning.getByRole('button', { name: /短剧创作技能/ }).click();
    await planning.getByRole('checkbox', { name: /人物与视觉设定/ }).check();
    const analyze = planning.getByRole('button', { name: '分析创作目标', exact: true });
    await analyze.focus();
    await analyze.press('Enter');
    await confirmAction(page, '确认分析创作目标');
    await expect(planning.getByRole('heading', { name: '预演关键镜头' })).toBeFocused();
    const options = planning.getByRole('group', { name: '选择时长方案' });
    const start = planning.getByRole('button', { name: '确认并开始制作', exact: true });
    await expect(options.getByRole('radio', { checked: true })).toHaveCount(0);
    await expect(start).toBeDisabled();
    expect(server.calls.map(taskType)).toEqual(['分析目标']);
    expect(server.imageRequests).toEqual([]);
    expect(await rpc(request, 'workspace.summary')).toMatchObject({ projects: [] });
    await expect(planning.getByLabel('图片模型')).toHaveCount(0);
    const keepTotal = options.getByRole('radio', { name: /总时长设为 15 秒/ });
    await keepTotal.focus();
    await keepTotal.press('Space');
    await expect(keepTotal).toBeChecked();
    await expect(start).toBeEnabled();
    expect(await planning.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await planning.screenshot({ path: info.outputPath('creative-objective-conflict.png') });
    await start.click();
    await confirmAction(page, '确认开始方案');
    await expect(planning.getByRole('heading', { name: '第 2 段 · 过街', exact: true })).toBeVisible();
    const history = await rpc<{ items: CreativePlanningEntry[] }>(request, 'creativePlanning.list');
    const parentId = history.items[0].id;
    const initial = await rpc<CreativePlanningResult>(request, 'creativePlanning.get', { runId: parentId });
    expect(initial.shots?.map(shot => shot.durationUs)).toEqual([5_000_000, 5_000_000, 5_000_000]);
    firstShotId = initial.shots![0].id;
    expect(server.calls.map(taskType)).toEqual(['分析目标', '风格卡', '三段分镜']);
    expect(server.imageRequests).toHaveLength(0);
    await expect(planning.getByRole('heading', { name: '关键镜头预演', exact: true })).toBeVisible();
    const gallery = planning.getByRole('region', { name: '关键镜头预演', exact: true });
    await expect(gallery.getByLabel('图片模型')).toHaveValue(imageModel.id);
    await gallery.getByRole('button', { name: '推荐关键镜头' }).click();
    await confirmAction(page, '确认推荐镜头');
    await expect(gallery.getByText('街角交代了追踪的起点。')).toBeVisible();
    expect(JSON.stringify(server.calls[3].messages[0].content)).toContain('发现信封');
    const choices = gallery.getByRole('group', { name: '选择预演镜头' });
    await choices.getByRole('checkbox', { name: /街角/ }).uncheck();
    await choices.getByRole('checkbox', { name: /过街/ }).check();
    await choices.getByRole('checkbox', { name: /发现信封/ }).check();
    await gallery.getByRole('button', { name: '生成预演图', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    expect(server.imageRequests).toHaveLength(0);
    await confirmAction(page, '确认生成预演');
    await expect(gallery.getByRole('img')).toHaveCount(2);
    await expect.poll(() => gallery.getByRole('img').first().evaluate(image => image instanceof HTMLImageElement ? image.naturalWidth : 0)).toBeGreaterThan(0);
    const second = gallery.getByRole('region', { name: /第 2 镜.*过街/ });
    const third = gallery.getByRole('region', { name: /第 3 镜.*发现信封/ });
    await second.getByRole('button', { name: '应用预演图', exact: true }).click();
    await third.getByRole('button', { name: '应用预演图', exact: true }).click();
    await expect(third.getByRole('img', { name: '当前画面' })).toBeVisible();
    const before = await rpc<CreativePlanningResult>(request, 'creativePlanning.get', { runId: parentId });
    expect(before.preview?.frames.filter(frame => frame.current).map(frame => frame.shotId)).toEqual(initial.shots!.slice(1).map(shot => shot.id));

    await planning.getByRole('button', { name: '修改镜头', exact: true }).click();
    await planning.getByRole('combobox', { name: '目标镜头' }).selectOption(initial.shots![2].id);
    await planning.getByRole('checkbox', { name: '单句台词' }).check();
    const line = planning.getByRole('combobox', { name: '目标台词' });
    await line.selectOption(await line.getByRole('option', { name: /别惊动他们/ }).getAttribute('value') ?? '');
    await planning.getByRole('textbox', { name: '修改要求' }).fill(revisionInstruction);
    await planning.getByRole('button', { name: '生成修改预览' }).click();
    await confirmAction(page, '确认生成修改建议');
    await planning.getByRole('button', { name: '确认应用', exact: true }).click();
    await expect(third.getByRole('img', { name: '当前画面' })).toBeVisible();
    await expect(gallery.getByText('需更新', { exact: true })).toHaveCount(0);
    const afterLine = await rpc<CreativePlanningResult>(request, 'creativePlanning.get', { runId: parentId });
    expect(afterLine.preview?.frames).toEqual(before.preview?.frames);
    expect(afterLine.shots?.[2].narration).toBe(`信封就在这里。${revised.lineText}`);

    await planning.getByRole('button', { name: '修改镜头', exact: true }).click();
    await planning.getByRole('combobox', { name: '目标镜头' }).selectOption(initial.shots![1].id);
    await planning.getByRole('checkbox', { name: '画面要求' }).check();
    await planning.getByRole('textbox', { name: '修改要求' }).fill(visualRevisionInstruction);
    await planning.getByRole('button', { name: '生成修改预览' }).click();
    await confirmAction(page, '确认生成修改建议');
    await planning.getByRole('button', { name: '确认应用', exact: true }).click();
    await expect(second.getByText('需更新', { exact: true })).toBeVisible();
    await expect(third.getByText('需更新', { exact: true })).toHaveCount(0);
    expect(server.imageRequests).toHaveLength(2);

    await second.getByRole('button', { name: '重做此镜', exact: true }).click();
    await confirmAction(page, '确认生成预演');
    await expect(second.getByRole('img')).toHaveCount(2);
    await expect(third.getByRole('img')).toHaveCount(1);
    expect(server.imageRequests).toHaveLength(3);
    await page.setViewportSize({ width: 1024, height: 768 });
    await second.screenshot({ path: info.outputPath('creative-keyframe-comparison.png') });
    await second.getByRole('button', { name: '替换预演图', exact: true }).click();
    await expect(second.getByRole('img')).toHaveCount(1);
    const after = await rpc<CreativePlanningResult>(request, 'creativePlanning.get', { runId: parentId });
    expect(after.preview?.frames[1].current?.id).not.toBe(before.preview?.frames[1].current?.id);
    expect(after.preview?.frames[1].stale).toBe(false);
    expect(after.preview?.frames[2].current?.id).toBe(before.preview?.frames[2].current?.id);
    expect(server.calls.map(taskType)).toEqual(['分析目标', '风格卡', '三段分镜', '推荐镜头', '修改一句台词', '修改画面']);
  } finally {
    await server.close();
  }
});

test('finishes a style-only objective with a reusable card and no empty episode', async ({ page, request, isolatedWorkspace }) => {
  const path = join(isolatedWorkspace.directory, 'only-style.jpg');
  await writeFile(path, await readFile(new URL('../../src/packages/runtime/src/builtin-drama-media/rain-on-the-bridge.jpg', import.meta.url)));
  const server = await modelServer(payload => taskType(payload) === '分析目标'
    ? { route: 'style-only', reason: '从参考图提取雨夜风格。', totalSeconds: null, shotCount: null, shotSeconds: null, keyframeShots: null }
    : styleCard);
  try {
    await rpc<ModelProfile>(request, 'model.save', { model: { name: '风格提取模型', provider: 'openai-compatible', connectionType: 'text', capabilities: ['text', 'vision', 'structured-output'], model: 'fixture-vision', baseUrl: server.baseUrl } });
    await page.goto('/');
    const planning = await openPlanning(page);
    await planning.getByRole('textbox', { name: '创作目标', exact: true }).fill('从参考图提取雨夜风格。');
    await planning.getByRole('textbox', { name: '参考图', exact: true }).fill(path);
    await planning.getByRole('button', { name: '分析创作目标', exact: true }).click();
    await confirmAction(page, '确认分析创作目标');
    await expect(planning.getByRole('heading', { name: '只提取风格' })).toBeFocused();
    await planning.getByRole('button', { name: '确认并开始制作', exact: true }).click();
    await confirmAction(page, '确认开始方案');
    await expect(planning.getByRole('list', { name: '色板' })).toContainText('#193248');
    await expect(planning.getByRole('button', { name: '应用分镜并编辑' })).toHaveCount(0);
    await planning.getByRole('button', { name: '完成', exact: true }).click();
    expect(server.calls.map(taskType)).toEqual(['分析目标', '风格卡']);
    expect(await rpc(request, 'workspace.summary')).toMatchObject({ projects: [] });
    await openPlanning(page);
    await planning.getByRole('button', { name: '新建分镜', exact: true }).click();
    await expect(planning.getByLabel('已有风格卡').getByRole('option', { name: '从参考图提取雨夜风格。' })).toHaveCount(1);
  } finally {
    await server.close();
  }
});

test('edits one structured dialogue line in the current workbench project and undoes it', async ({ page, request }) => {
  const replacement = '纸条在那边。';
  const server = await modelServer(() => ({ lineText: replacement }));
  try {
    await rpc<ModelProfile>(request, 'model.save', { model: { name: '改稿验收模型', provider: 'openai-compatible', connectionType: 'text', capabilities: ['text', 'structured-output'], model: 'fixture-text', baseUrl: server.baseUrl } });
    const character = await rpc<CharacterProfile>(request, 'character.save', { character: { name: '侦探', description: '墨蓝色外套', referenceAssetIds: [] } });
    const created = await rpc<ProjectDocument>(request, 'project.create', { title: '工作台精确改稿', originalText: goal });
    const dialogue = { id: 'letter', kind: 'dialogue' as const, speakerId: character.id, text: '纸条在椅子下面。', emotion: '轻声', pauseAfterUs: 500_000 };
    const original = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: {
      style: '墨蓝 #193248，街灯青 #1F6C69。',
      shots: [
        { ...storyboard.shots[0], id: 'street', durationUs: 2_500_000 },
        { ...storyboard.shots[1], id: 'porch', durationUs: 6_000_000, drama: { lines: [
          { id: 'door', kind: 'narration', text: '木门轻轻响了一声。' }, dialogue,
        ] } },
      ],
    } });
    await page.goto('/');
    await openProjectFromList(page, original.title);
    await page.getByRole('button', { name: '修改文案', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '修改镜头', exact: true });
    await dialog.getByRole('combobox', { name: '目标镜头' }).selectOption('porch');
    await dialog.getByRole('checkbox', { name: '单句台词' }).check();
    const lines = dialog.getByRole('combobox', { name: '目标台词' });
    await lines.selectOption(await lines.getByRole('option', { name: /纸条在椅子下面/ }).getAttribute('value') ?? '');
    await dialog.getByRole('textbox', { name: '修改要求' }).fill('只缩短这句台词。');
    await dialog.getByRole('button', { name: '生成修改预览', exact: true }).click();
    await confirmAction(page, '确认生成修改建议');
    const differences = dialog.getByRole('region', { name: '修改差异' });
    await expect(differences).toContainText(dialogue.text);
    await expect(differences).toContainText(replacement);
    expect(await saved(request, original.id)).toEqual(original);
    await dialog.getByRole('button', { name: '确认应用', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const after = await saved(request, original.id);
    const target = original.shots[1];
    const changedShots = [original.shots[0], { ...target, drama: {
      ...target.drama, lines: [target.drama!.lines[0], { ...dialogue, text: replacement }],
    } }];
    expect(after).toEqual({ ...original, revision: after.revision, updatedAt: after.updatedAt, shots: changedShots });
    expect(server.calls).toHaveLength(1);
    const undo = page.getByRole('button', { name: '撤销', exact: true });
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect.poll(async () => (await saved(request, original.id)).shots).toEqual(original.shots);
  } finally {
    await server.close();
  }
});
