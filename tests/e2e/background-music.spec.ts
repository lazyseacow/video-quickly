import { readFile, writeFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { DEFAULT_AUDIO_MIX_SETTINGS, type AssetRecord, type AudioLevelWindow, type AudioMixJob, type PreparedAudioMix, type ProjectDocument } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json(); expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function savedProject(request: APIRequestContext, projectId: string) {
  return (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId })).project;
}
async function createProject(request: APIRequestContext, title: string) {
  const project = await rpc<ProjectDocument>(request, 'project.create', { title });
  return rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { audioMix: { ...DEFAULT_AUDIO_MIX_SETTINGS, loudness: { ...DEFAULT_AUDIO_MIX_SETTINGS.loudness, enabled: false } }, shots: [0, 1].map(index => ({ id: `music-shot-${index}`, title: `音乐验收镜头 ${index + 1}`, narration: '', visualPrompt: '', durationUs: 3_000_000 })) } });
}
async function openProject(page: Page, title: string) {
  await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/);
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.locator('.project-card').filter({ hasText: title }).getByRole('button', { name: /继续创作/ }).click();
  await expect(page.getByLabel('镜头标题')).toHaveValue('音乐验收镜头 1');
}
async function musicEditor(page: Page) {
  await page.getByRole('button', { name: '背景音乐', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '背景音乐', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '1');
  return dialog;
}
function observeErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  return errors;
}
async function expectHealthy(page: Page, errors: string[]) {
  await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
}
function wav() {
  const rate = 8000, samples = rate * 2, bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) bytes.writeInt16LE(Math.round(Math.sin(index / rate * Math.PI * 800) * (index < rate ? 5000 : 20000)), 44 + index * 2);
  return bytes;
}
async function seek(page: Page, seconds: number) {
  const ruler = page.getByRole('slider', { name: '预览播放位置', exact: true });
  await ruler.press('Home');
  const frames = seconds * 30;
  for (let index = 0; index < Math.floor(frames / 10); index++) await ruler.press('Shift+ArrowRight');
  for (let index = 0; index < frames % 10; index++) await ruler.press('ArrowRight');
  await expect(ruler).toHaveAttribute('aria-valuenow', String(seconds * 1000));
}
async function expectAudioClock(page: Page, seconds: number) {
  await seek(page, seconds);
  const audio = page.locator('.preview-panel audio[data-audio-role="处理后混音"]');
  await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).currentTime)).toBeCloseTo(seconds, 2);
}
async function preparedMix(request: APIRequestContext, project: ProjectDocument): Promise<PreparedAudioMix> {
  let job = await rpc<AudioMixJob>(request, 'audio.mix.prepare', { project });
  await expect.poll(async () => { job = await rpc<AudioMixJob>(request, 'audio.mix.get', { jobId: job.id }); return job.status; }, { timeout: 30_000 }).toBe('succeeded');
  expect(job.result).toBeDefined(); return job.result!;
}
async function visibleMix(page: Page, request: APIRequestContext, projectId: string) {
  const project = await savedProject(request, projectId), mix = await preparedMix(request, project);
  const preview = page.locator('.preview-panel .prepared-mix-preview');
  await expect(preview).toHaveAttribute('data-mix-key', mix.key, { timeout: 30_000 });
  await expect(page.getByRole('button', { name: '播放预览', exact: true })).toBeEnabled({ timeout: 30_000 });
  const audio = preview.locator('audio[data-audio-role="处理后混音"]');
  await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).duration)).toBeCloseTo(6, 3);
  expect(mix.durationUs).toBe(6_000_000);
  await expect(page.locator('.preview-panel audio')).toHaveCount(1);
  await expect(page.locator('audio[data-audio-role="背景音乐"]')).toHaveCount(0);
  return { project, mix, audio };
}
function rmsAt(window: AudioLevelWindow, seconds: number, durationUs = 100_000) {
  const first = Math.round((seconds * 1e6 - window.startUs) / window.periodUs), count = durationUs / window.periodUs;
  const samples = window.samples.slice(first, first + count); expect(samples).toHaveLength(count);
  return Math.sqrt(samples.reduce((sum, sample) => sum + (sample.rmsLeft ** 2 + sample.rmsRight ** 2) / 2, 0) / samples.length);
}

test('edits real music through the UI, restores history and follows project time with looping and fades', async ({ page, request }, info) => {
  test.setTimeout(90_000);
  const errors = observeErrors(page);
  const project = await createProject(request, '背景音乐编辑与播放验收');
  const path = info.outputPath('music-private.wav'); await writeFile(path, wav());
  const asset = await rpc<AssetRecord>(request, 'asset.import', { projectId: project.id, path, kind: 'audio' });
  await openProject(page, project.title);
  let dialog = await musicEditor(page);
  await dialog.getByLabel('从素材库添加音乐', { exact: true }).selectOption(asset.id);
  for (const [field, value] of [
    ['项目起点（秒）', '1'], ['素材入点（秒）', '0.5'], ['时长（秒）', '4'],
    ['音量（dB）', '-6'], ['淡入（秒）', '1'], ['淡出（秒）', '1'],
  ]) await dialog.getByLabel(`音乐 1 ${field}`, { exact: true }).fill(value);
  await dialog.getByRole('checkbox', { name: '从素材入点循环到结尾', exact: true }).check();
  await expect(dialog.getByRole('button', { name: '应用背景音乐', exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath('background-music-config.png') });
  expect((await savedProject(request, project.id)).revision).toBe(project.revision);
  await dialog.getByRole('button', { name: '应用背景音乐', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await savedProject(request, project.id)).musicClips?.length).toBe(1);
  const saved = await savedProject(request, project.id);
  expect(saved.revision).toBe(project.revision + 1);
  expect(saved.musicClips?.[0]).toMatchObject({ assetId: asset.id, startUs: 1_000_000, sourceInUs: 500_000, durationUs: 4_000_000, gainDb: -6, fadeInUs: 1_000_000, fadeOutUs: 1_000_000, loop: true });
  await expect(page.locator('.timeline-track-headers')).toContainText('A2');
  const waveform = page.locator('.track--music .audio-waveform');
  await expect(waveform).toHaveAttribute('data-status', 'ready');
  await expect(waveform).toHaveAttribute('data-source-in-us', '500000');
  await expect(waveform.getByRole('img')).toHaveAttribute('aria-label', /背景音乐真实音频波形/);
  await page.screenshot({ path: info.outputPath('background-music-track.png') });
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).musicClips?.length ?? 0).toBe(0);
  await expect(page.locator('.track--music')).toHaveCount(0);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).musicClips).toEqual(saved.musicClips);
  await page.reload(); await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
  dialog = await musicEditor(page);
  await expect(dialog.getByLabel('音乐 1 项目起点（秒）', { exact: true })).toHaveValue('1');
  await expect(dialog.getByLabel('音乐 1 音量（dB）', { exact: true })).toHaveValue('-6');
  await expect(dialog.getByRole('checkbox', { name: '从素材入点循环到结尾', exact: true })).toBeChecked();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  const { project: current, mix, audio } = await visibleMix(page, request, project.id);
  const measured = await rpc<AudioLevelWindow>(request, 'audio.mix.levels', { key: mix.key, startUs: 0, durationUs: mix.durationUs });
  expect(measured.key).toBe(mix.key); expect(measured.samples).toHaveLength(600);
  const high = rmsAt(measured, 2.1), low = rmsAt(measured, 2.6);
  expect(high).toBeGreaterThan(.01);
  // The actual source jumps from the louder second half back to source .5s every 1.5s.
  expect(low / high).toBeCloseTo(.25, 2);
  expect(rmsAt(measured, 3.1) / high).toBeCloseTo(1, 2);
  expect(rmsAt(measured, 3.6) / high).toBeCloseTo(1, 2);
  // Equal source amplitude isolates the fade envelope from the waveform's two amplitude regions.
  expect(rmsAt(measured, 1.6) / high).toBeGreaterThan(.62);
  expect(rmsAt(measured, 1.6) / high).toBeLessThan(.68);
  expect(rmsAt(measured, 4.6) / high).toBeGreaterThan(.32);
  expect(rmsAt(measured, 4.6) / high).toBeLessThan(.38);
  expect(rmsAt(measured, .5)).toBeLessThan(1e-7); expect(rmsAt(measured, 5.1)).toBeLessThan(1e-7);
  // Compare two genuinely prepared WAVs to verify the -6dB gain, independent of mono upmix rules.
  const unity = await preparedMix(request, { ...current, musicClips: current.musicClips!.map(clip => ({ ...clip, gainDb: 0 })) });
  expect(unity.key).not.toBe(mix.key);
  const unscaled = await rpc<AudioLevelWindow>(request, 'audio.mix.levels', { key: unity.key, startUs: 0, durationUs: unity.durationUs });
  expect(high / rmsAt(unscaled, 2.1)).toBeCloseTo(10 ** (-6 / 20), 2);
  for (const time of [.5, 1.5, 2.5, 4.5, 5]) await expectAudioClock(page, time);
  await page.getByRole('button', { name: '静音预览声音', exact: true }).click();
  await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).muted)).toBe(true);
  await page.getByRole('button', { name: '开启预览声音', exact: true }).click();
  await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).muted)).toBe(false);
  await seek(page, 2.5);
  await page.getByRole('button', { name: '播放预览', exact: true }).click();
  await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).paused)).toBe(false);
  await page.getByRole('button', { name: '暂停预览', exact: true }).click();
  await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).paused)).toBe(true);

  dialog = await musicEditor(page);
  await dialog.getByRole('checkbox', { name: '从素材入点循环到结尾', exact: true }).uncheck();
  await expect(dialog.getByRole('button', { name: '应用背景音乐', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('alert')).toContainText('片段超出素材尾部');
  await dialog.getByLabel('音乐 1 时长（秒）', { exact: true }).fill('1.5');
  await dialog.getByLabel('音乐 1 淡入（秒）', { exact: true }).fill('0');
  await dialog.getByLabel('音乐 1 淡出（秒）', { exact: true }).fill('0');
  await dialog.getByRole('button', { name: '应用背景音乐', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).musicClips?.[0].loop).toBe(false);
  const nonLooping = await savedProject(request, project.id);
  const next = await visibleMix(page, request, project.id);
  const ended = await rpc<AudioLevelWindow>(request, 'audio.mix.levels', { key: next.mix.key, startUs: 0, durationUs: next.mix.durationUs });
  expect(rmsAt(ended, 2.1) / high).toBeCloseTo(1, 2); expect(rmsAt(ended, 2.6)).toBeLessThan(1e-7);
  await expectAudioClock(page, 2); await expectAudioClock(page, 2.5);
  dialog = await musicEditor(page);
  await dialog.getByRole('button', { name: '移除音乐 1', exact: true }).click();
  await dialog.getByRole('button', { name: '应用背景音乐', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).musicClips).toEqual([]);
  await expect(audio).toHaveCount(0);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).musicClips).toEqual(nonLooping.musicClips);
  await expect(page.locator('.track--music .audio-waveform')).toHaveAttribute('data-status', 'ready');
  await page.getByRole('button', { name: '浅色外观', exact: true }).click();
  await page.setViewportSize({ width: 600, height: 900 });
  await musicEditor(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('background-music-light-600.png') });
  await expectHealthy(page, errors);
});

test('protects referenced public music and restores it as an independent asset through the backup UI', async ({ page, request }, info) => {
  const errors = observeErrors(page);
  const project = await createProject(request, '公共音乐备份与保护验收');
  const path = info.outputPath('music-public.wav'), bytes = wav(); await writeFile(path, bytes);
  const asset = await rpc<AssetRecord>(request, 'asset.import', { path, kind: 'audio' });
  expect(asset.projectId).toBeUndefined();
  await openProject(page, project.title);
  let dialog = await musicEditor(page);
  await dialog.getByLabel('从素材库添加音乐', { exact: true }).selectOption(asset.id);
  await dialog.getByRole('button', { name: '应用背景音乐', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).musicClips?.length).toBe(1);
  const saved = await savedProject(request, project.id);
  await page.getByRole('button', { name: '素材库', exact: true }).click();
  const card = page.locator('.asset-card').filter({ hasText: asset.name });
  await expect(card).toContainText('使用中');
  await expect(card.getByRole('button', { name: `移除素材“${asset.name}”`, exact: true })).toBeDisabled();
  const rejected = await request.post('/__desktop_rpc', { data: { method: 'asset.delete', params: { assetId: asset.id } } });
  expect((await rejected.json()).error).toContain('正在使用或已保留');
  await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
  await page.getByRole('button', { name: '项目设置', exact: true }).click();
  const pendingBackup = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.method === 'project.backup');
  await page.getByRole('button', { name: '备份项目与素材', exact: true }).click();
  const backup = (await (await pendingBackup).json()).result as { path: string; assets: number };
  expect(backup.assets).toBe(1);
  const portable = JSON.parse(await readFile(`${backup.path}/project.json`, 'utf8'));
  expect(portable.project.musicClips).toEqual(saved.musicClips);
  expect(portable.assets[0].sha256).toBe(asset.sha256);
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.getByRole('button', { name: '导入项目', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '导入项目备份', exact: true });
  await dialog.getByLabel('项目备份路径', { exact: true }).fill(backup.path);
  const pendingImport = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.method === 'project.importBackup');
  await dialog.getByRole('button', { name: '导入备份', exact: true }).click();
  const restored = (await (await pendingImport).json()).result as ProjectDocument;
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(restored.title);
  expect(restored.id).not.toBe(project.id);
  const music = restored.musicClips?.[0];
  if (!music) throw new Error('恢复项目未保留背景音乐设置');
  expect(music.assetId).not.toBe(asset.id);
  const detail = await rpc<{ project: ProjectDocument; assets: AssetRecord[] }>(request, 'project.get', { projectId: restored.id });
  const restoredAsset = detail.assets.find(value => value.id === music.assetId);
  expect(restoredAsset).toMatchObject({ projectId: restored.id, sha256: asset.sha256 });
  if (!restoredAsset) throw new Error('恢复项目未包含公共音乐');
  expect(await readFile(restoredAsset.path)).toEqual(bytes);
  await expect(page.locator('.track--music .audio-waveform')).toHaveAttribute('data-status', 'ready');
  await expectHealthy(page, errors);
});
