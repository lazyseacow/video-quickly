import { execFile } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type TestInfo } from '@playwright/test';
import type { AssetRecord, CharacterProfile, ModelProfile, ProjectDocument } from '@video-quickly/contracts';
import { rpc, fixture, saved, latest, open, pick } from './native-video-fixture';

const media = async (args: string[]) => promisify(execFile)(process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
async function audioFile(info: TestInfo, name: string, frequency = 440) {
  const path = info.outputPath(name);
  await media(['-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=44100:duration=2`, path]);
  return { path, dataUrl: `data:audio/${name.endsWith('.mp3') ? 'mp3' : 'wav'};base64,${(await readFile(path)).toString('base64')}` };
}

for (const scenario of [
  { model: 'doubao-seedance-2-0-260128', image: true, width: 1536, height: 960, theme: 'dark', file: '音色参考.wav' },
  { model: 'doubao-seedance-2-5-260628', image: false, width: 600, height: 900, theme: 'light', file: '配乐参考.mp3' },
]) test(`saves and sends local reference audio through ${scenario.model} at ${scenario.width}px`, async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const source = await fixture(request, info), audio = await audioFile(info, scenario.file), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  try {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), scenario.theme);
    const video = await rpc<ModelProfile>(request, 'model.save', { model: { ...source.video, model: scenario.model } });
    let project = source.project;
    if (scenario.image) {
      const path = info.outputPath('场景参考.png'); await media(['-f', 'lavfi', '-i', 'color=c=blue:s=320x320', '-frames:v', '1', path]);
      const image = await rpc<AssetRecord>(request, 'asset.import', { projectId: project.id, path, kind: 'image' });
      const characterImage = await rpc<AssetRecord>(request, 'asset.import', { path, kind: 'image' });
      const character = await rpc<CharacterProfile>(request, 'character.save', { character: { name: '参考角色', description: '保持角色外观一致。', referenceAssetIds: [characterImage.id] } });
      project = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: [{ id: 'reference-shot', title: '场景', narration: '天空是蓝色的。', visualPrompt: '蓝色天空', durationUs: 2_000_000, assetId: image.id, characterIds: [character.id] }] } });
    }
    let dialog = await open(page, project);
    await pick(dialog, '文本模型', source.models[0]); await pick(dialog, '视频模型', video);
    await dialog.getByRole('tab', { name: '素材与配音', exact: true }).click();
    await dialog.getByLabel('参考素材', { exact: true }).selectOption(scenario.image ? 'existing' : 'none');
    const path = dialog.getByRole('textbox', { name: '参考音频文件路径', exact: true });
    await path.fill(info.outputPath('不支持.m4a')); await dialog.getByRole('button', { name: '添加参考音频', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('WAV 或 MP3');
    await path.fill(audio.path); await dialog.getByRole('button', { name: '添加参考音频', exact: true }).click();
    const list = dialog.getByRole('list', { name: '已选参考音频', exact: true }); await expect(list).toContainText(scenario.file);
    await dialog.getByRole('tab', { name: '策划与分镜', exact: true }).click(); await dialog.getByRole('tab', { name: '素材与配音', exact: true }).click();
    await expect(list).toContainText(scenario.file); await list.scrollIntoViewIfNeeded();
    await expect(dialog.getByRole('button', { name: '保存设置', exact: true })).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`reference-audio-${scenario.theme}-${scenario.width}.png`) });
    await dialog.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(dialog).toHaveCount(0);
    const configured = await saved(request, project.id), ids = configured.workflow.production.referenceAudioAssetIds;
    expect(ids).toHaveLength(1); await unlink(audio.path);
    dialog = await open(page, configured); await dialog.getByRole('tab', { name: '素材与配音', exact: true }).click();
    await expect(dialog.getByRole('list', { name: '已选参考音频', exact: true })).toContainText(scenario.file);
    await dialog.getByRole('button', { name: `移除参考音频：${scenario.file}`, exact: true }).click(); await expect(dialog.getByRole('list', { name: '已选参考音频', exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); await expect(dialog).toHaveCount(0);
    expect((await saved(request, project.id)).workflow.production.referenceAudioAssetIds).toEqual(ids);
    dialog = await open(page, configured);
    await dialog.getByRole('button', { name: '保存并开始制作', exact: true }).click(); await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await latest(request, project.id))?.status, { timeout: 30_000 }).toBe('succeeded');
    const videoRequest = source.requests.find(value => value.generate_audio === true);
    expect(videoRequest).toMatchObject({ model: scenario.model, content: expect.arrayContaining([{ type: 'audio_url', audio_url: { url: audio.dataUrl }, role: 'reference_audio' }]) });
    if (scenario.image) expect(videoRequest?.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image_url', role: 'reference_image' })]));
    else expect(videoRequest?.content).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image_url' })]));
    expect(source.requests.filter(value => value.generate_audio === true)).toHaveLength(1);
    dialog = await open(page, await saved(request, project.id)); await dialog.getByRole('tab', { name: '素材与配音', exact: true }).click();
    await dialog.getByRole('button', { name: `移除参考音频：${scenario.file}`, exact: true }).click(); await dialog.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(dialog).toHaveCount(0);
    expect((await saved(request, project.id)).workflow.production.referenceAudioAssetIds).toEqual([]);
    await expect(page).toHaveTitle(/Video Quickly/); await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width + 1);
  } finally { await source.close(); }
});

test('freezes reference audio while saving and restoring the next production configuration', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const source = await fixture(request, info, true), original = await audioFile(info, '原音色.wav'), next = await audioFile(info, '待用音色.wav', 880);
  try {
    let dialog = await open(page, source.project); await pick(dialog, '文本模型', source.models[0]); await pick(dialog, '视频模型', source.video);
    await dialog.getByRole('tab', { name: '素材与配音', exact: true }).click();
    await dialog.getByRole('textbox', { name: '参考音频文件路径', exact: true }).fill(original.path); await dialog.getByRole('button', { name: '添加参考音频', exact: true }).click();
    await expect(dialog.getByRole('list', { name: '已选参考音频', exact: true })).toContainText(basename(original.path));
    await dialog.getByRole('button', { name: '保存并开始制作', exact: true }).click(); await expect(dialog).toHaveCount(0); await source.pending;
    const frozenIds = (await saved(request, source.project.id)).workflow.production.referenceAudioAssetIds;
    await page.locator('.project-heading-actions').getByRole('button', { name: '制作设置', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '制作设置', exact: true }); await dialog.getByRole('tab', { name: '素材与配音', exact: true }).click();
    await dialog.getByRole('textbox', { name: '参考音频文件路径', exact: true }).fill(next.path); await dialog.getByRole('button', { name: '添加参考音频', exact: true }).click();
    await expect(dialog.getByRole('list', { name: '已选参考音频', exact: true })).toContainText(basename(next.path));
    await dialog.getByRole('button', { name: `移除参考音频：${basename(original.path)}`, exact: true }).click();
    await dialog.getByRole('button', { name: '保存待用配置', exact: true }).click(); await expect(dialog).toHaveCount(0);
    expect((await saved(request, source.project.id)).workflow.production.referenceAudioAssetIds).toEqual(frozenIds);
    source.release(); await expect.poll(async () => (await latest(request, source.project.id))?.status, { timeout: 30_000 }).toBe('succeeded');
    const videoRequest = source.requests.find(value => value.generate_audio === true);
    expect(videoRequest?.content).toEqual(expect.arrayContaining([{ type: 'audio_url', audio_url: { url: original.dataUrl }, role: 'reference_audio' }]));
    expect(JSON.stringify(videoRequest)).not.toContain(next.dataUrl);
    dialog = await open(page, await saved(request, source.project.id)); await expect(dialog).toContainText('已保存待用配置');
    await dialog.getByRole('tab', { name: '素材与配音', exact: true }).click();
    const list = dialog.getByRole('list', { name: '已选参考音频', exact: true }); await expect(list).toContainText(basename(next.path)); await expect(list).not.toContainText(basename(original.path));
  } finally { await source.close(); }
});
