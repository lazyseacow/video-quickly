import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test, type APIRequestContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createSceneTemplate, DEFAULT_AUDIO_MIX_SETTINGS, DEFAULT_AUDIO_PROCESSING, type AssetRecord, type ProjectDocument } from '@video-quickly/contracts';
import { deleteShotRanges } from '../../packages/video/src/clip-edits';

const execute = promisify(execFile), ffmpeg = process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json(); expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function saved(request: APIRequestContext, projectId: string) { return (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId })).project; }
async function videoFile(info: TestInfo, name: string, silent = false, color = 'blue') {
  const path = info.outputPath(name);
  await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=${color}:size=320x180:rate=30:duration=2`,
    ...(silent ? [] : ['-f', 'lavfi', '-i', "aevalsrc=exprs='0.2*sin(2*PI*if(lt(t,1),880,1320)*t)|0.1*sin(2*PI*if(lt(t,1),880,1320)*t)':s=48000:d=2"]),
    '-map', '0:v:0', ...(silent ? ['-an'] : ['-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k']), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path]);
  return path;
}
async function fixture(request: APIRequestContext, info: TestInfo, silent = false) {
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: `视频原声验收 ${randomUUID().slice(0, 8)}`, profile: { width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 }, fitMode: 'contain', previewScale: .5 } });
  const asset = await rpc<AssetRecord>(request, 'asset.import', { projectId: created.id, path: await videoFile(info, 'source.mp4', silent), kind: 'video' });
  const current = await saved(request, created.id);
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: current.revision, patch: {
    audioMix: { ...DEFAULT_AUDIO_MIX_SETTINGS, loudness: { ...DEFAULT_AUDIO_MIX_SETTINGS.loudness, enabled: false } },
    shots: [{ id: 'original-video', title: '原声镜头', narration: '', visualPrompt: '', durationUs: 1_500_000, videoInUs: 250_000, audioInUs: 0, videoAssetId: asset.id }],
  } });
  return { project, asset };
}
function observe(page: Page) {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); }); return errors;
}
async function healthy(page: Page, errors: string[], expected400 = 0) {
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  expect(errors).toEqual(Array.from({ length: expected400 }, () => 'Failed to load resource: the server responded with a status of 400 (Bad Request)'));
}
async function open(page: Page, project: ProjectDocument) {
  await page.goto('/'); await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
  await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('原声镜头');
}
async function dialog(page: Page) {
  await page.getByRole('button', { name: '镜头属性', exact: true }).click(); await page.getByRole('button', { name: '镜头声音处理', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '镜头声音处理', exact: true }); await expect(panel).toBeVisible(); return panel;
}
async function apply(panel: Locator) { await panel.getByRole('button', { name: '应用声音设置', exact: true }).click(); await expect(panel).toHaveCount(0); }
async function mixReady(container: Locator) { const mix = container.locator('.prepared-mix-preview'); await expect(mix).toHaveAttribute('data-status', 'ready', { timeout: 20_000 }); return mix; }
async function amplitudeOfPlayedMix(container: Locator, request: APIRequestContext, info: TestInfo, name: string, frequency = 880, start = .1) {
  const url = await container.locator('audio[data-audio-role="处理后混音"]').evaluate((element: HTMLAudioElement) => element.currentSrc);
  const response = await request.get(url); expect(response.ok()).toBe(true);
  const source = info.outputPath(`${name}.wav`), path = info.outputPath(`${name}.f32`); await writeFile(source, await response.body());
  await execute(ffmpeg, ['-v', 'error', '-y', '-i', source, '-ar', '48000', '-ac', '2', '-f', 'f32le', path]);
  const pcm = await readFile(path), count = 4800, first = Math.round(start * 48000); let real = 0, imaginary = 0;
  for (let index = 0; index < count; index++) { const value = pcm.readFloatLE((first + index) * 8), angle = 2 * Math.PI * frequency * index / 48000; real += value * Math.cos(angle); imaginary += value * Math.sin(angle); }
  return 2 * Math.hypot(real, imaginary) / count;
}
async function persisted(page: Page, projectId: string, undoCount: number) {
  await expect.poll(() => page.evaluate(async ({ projectId, undoCount }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open('video-quickly-drafts', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    return new Promise<boolean>(resolve => { const query = db.transaction('projects').objectStore('projects').getAll(); query.onsuccess = () => { resolve(query.result.some(value => value.projectId === projectId && value.undo.length === undoCount)); db.close(); }; });
  }, { projectId, undoCount })).toBe(true);
}

test('auditions video sound without committing, then preserves its actual mix, gain, mute and undo across reload', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const errors = observe(page), { project } = await fixture(request, info); await open(page, project);
  await expect(page.locator('.track--original')).toHaveCount(0); await expect(page.locator('.preview-panel .prepared-mix-preview')).toHaveCount(0);
  let panel = await dialog(page); await expect(panel.getByRole('checkbox', { name: '启用视频原声', exact: true })).not.toBeChecked();
  await expect.poll(() => panel.getByRole('checkbox', { name: '启用视频原声', exact: true }).evaluate(element => element.closest('label')?.getBoundingClientRect().height ?? 0)).toBeGreaterThanOrEqual(40);
  await panel.getByRole('checkbox', { name: '启用视频原声', exact: true }).check(); await panel.getByLabel('视频原声增益（dB）', { exact: true }).fill('-6');
  await panel.getByRole('button', { name: '试听处理', exact: true }).click(); await mixReady(panel);
  expect(await amplitudeOfPlayedMix(panel, request, info, 'audition')).toBeGreaterThan(.09); expect((await saved(request, project.id)).shots[0].audioProcessing).toBeUndefined();
  await panel.getByRole('button', { name: '取消', exact: true }).click(); await expect(panel).toHaveCount(0);
  await expect(page.locator('.preview-panel .prepared-mix-preview')).toHaveCount(0);
  panel = await dialog(page); await expect(panel.getByRole('checkbox', { name: '启用视频原声', exact: true })).not.toBeChecked();
  await panel.getByRole('checkbox', { name: '启用视频原声', exact: true }).check(); await panel.getByLabel('视频原声增益（dB）', { exact: true }).fill('-6'); await apply(panel);
  const main = page.locator('.preview-panel'); await mixReady(main);
  const amplitude = await amplitudeOfPlayedMix(main, request, info, 'main'); expect(amplitude).toBeGreaterThan(.09); expect(amplitude).toBeLessThan(.12);
  await expect(page.locator('.track--original .audio-waveform')).toHaveAttribute('data-status', 'ready'); await expect(page.locator('.track--original .audio-waveform')).toHaveAttribute('data-source-in-us', '250000');
  await page.getByRole('button', { name: '静音预览声音', exact: true }).click(); expect(await main.locator('audio').evaluate((element: HTMLAudioElement) => element.muted)).toBe(true);
  await page.getByRole('button', { name: '开启预览声音', exact: true }).click();
  await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect(page.locator('.track--original')).toHaveCount(0);
  await page.getByRole('button', { name: '重做', exact: true }).click(); await mixReady(main); await persisted(page, project.id, 1);
  await open(page, project); await mixReady(main); panel = await dialog(page);
  await expect(panel.getByRole('checkbox', { name: '启用视频原声', exact: true })).toBeChecked(); await expect(panel.getByLabel('视频原声增益（dB）', { exact: true })).toHaveValue('-6');
  await page.keyboard.press('Escape'); await expect(panel).toHaveCount(0); await healthy(page, errors);
});

test('retains explicit original-audio applications through save failure, retry, reload and both undo steps', async ({ page, request }, info) => {
  const errors = observe(page), { project } = await fixture(request, info); await open(page, project); const panel = await dialog(page);
  await panel.getByRole('checkbox', { name: '启用视频原声', exact: true }).check(); await panel.getByLabel('视频原声增益（dB）', { exact: true }).fill('-6');
  let failures = 0; await page.route('**/__desktop_rpc', async route => {
    if (!failures && route.request().postDataJSON()?.method === 'project.update') { failures++; await route.fulfill({ status: 400, json: { error: '隔离的原声保存失败' } }); return; } await route.continue();
  });
  await panel.getByRole('button', { name: '应用声音设置', exact: true }).click(); await expect(panel.getByRole('alert')).toContainText('当前输入已保留');
  expect((await saved(request, project.id)).shots[0].audioProcessing).toBeUndefined();
  await panel.getByLabel('视频原声增益（dB）', { exact: true }).fill('-3'); await apply(panel); await persisted(page, project.id, 2);
  await open(page, project); await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await saved(request, project.id)).shots[0].audioProcessing).toMatchObject({ version: 2, videoAudio: { enabled: true, gainDb: -6 } });
  await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect.poll(async () => (await saved(request, project.id)).shots[0].audioProcessing).toBeUndefined();
  await healthy(page, errors, 1);
});

test('protects the original-audio source when its video is replaced while the sound dialog is open', async ({ page, request }, info) => {
  const errors = observe(page), { project } = await fixture(request, info); await open(page, project); const panel = await dialog(page);
  await panel.getByRole('checkbox', { name: '启用视频原声', exact: true }).check(); await panel.getByLabel('视频原声增益（dB）', { exact: true }).fill('-4');
  const replacement = await rpc<AssetRecord>(request, 'asset.import', { projectId: project.id, path: await videoFile(info, 'replacement.mp4', false, 'red'), kind: 'video' });
  const current = await saved(request, project.id); await rpc(request, 'project.update', { projectId: project.id, revision: current.revision, patch: { shots: [{ ...current.shots[0], videoAssetId: replacement.id }] } });
  await expect.poll(() => page.locator('.preview-panel canvas').evaluate((canvas: HTMLCanvasElement) => { const pixel = canvas.getContext('2d')!.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data; return pixel[0] > 180 && pixel[1] < 50 && pixel[2] < 50; })).toBe(true);
  await panel.getByRole('button', { name: '应用声音设置', exact: true }).click(); await expect(panel.getByRole('alert')).toContainText('来源或剪辑范围已变化');
  await expect(panel.getByLabel('视频原声增益（dB）', { exact: true })).toHaveValue('-4'); const latest = await saved(request, project.id); expect(latest.shots[0].videoAssetId).toBe(replacement.id); expect(latest.shots[0].audioProcessing).toBeUndefined();
  await healthy(page, errors);
});

test('reports a video without audio, keeps playback available and lets the user mute the original track', async ({ page, request }, info) => {
  const errors = observe(page), { project } = await fixture(request, info, true); await open(page, project); let panel = await dialog(page);
  await panel.getByRole('checkbox', { name: '启用视频原声', exact: true }).check(); await apply(panel); await mixReady(page.locator('.preview-panel'));
  await expect(page.locator('.preview-panel .prepared-mix-preview__warnings')).toContainText('视频没有音轨'); await expect(page.getByRole('button', { name: '播放预览', exact: true })).toBeEnabled();
  const waveform = page.locator('.track--original .audio-waveform'); await expect(waveform).toHaveAttribute('data-status', 'error'); await expect(waveform.locator('svg')).toHaveCount(0);
  panel = await dialog(page); await panel.getByRole('checkbox', { name: '启用视频原声', exact: true }).uncheck(); await apply(panel);
  await expect(page.locator('.track--original')).toHaveCount(0); await expect(page.locator('.preview-panel .prepared-mix-preview')).toHaveCount(0); await healthy(page, errors, 1);
});

test('mixes original sound under a diagram and bounds bulk trims by its real video source until muted', async ({ page, request }, info) => {
  const errors = observe(page), fixtureData = await fixture(request, info);
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: fixtureData.project.id, revision: fixtureData.project.revision, patch: { shots: [{ ...fixtureData.project.shots[0], sceneTemplate: createSceneTemplate('process'), audioProcessing: { ...DEFAULT_AUDIO_PROCESSING, version: 2, videoAudio: { enabled: true, gainDb: 0 } } }] } });
  await open(page, project); await mixReady(page.locator('.preview-panel'));
  expect(await amplitudeOfPlayedMix(page.locator('.preview-panel'), request, info, 'diagram')).toBeGreaterThan(.17);
  await page.getByRole('region', { name: '项目时间轴', exact: true }).getByRole('button', { name: '批量编辑镜头', exact: true }).click();
  let bulk = page.getByRole('dialog', { name: '批量编辑镜头', exact: true });
  await bulk.getByRole('checkbox', { name: '批量修改时长', exact: true }).check();
  await bulk.getByLabel('批量镜头时长（秒）', { exact: true }).fill('2');
  await expect(bulk.getByRole('alert')).toContainText('超出真实时长');
  await expect(bulk.getByRole('button', { name: '应用批量修改', exact: true })).toBeDisabled();
  await bulk.getByLabel('批量镜头时长（秒）', { exact: true }).fill('1.7');
  await expect(bulk.getByRole('button', { name: '应用批量修改', exact: true })).toBeEnabled();
  await bulk.getByRole('button', { name: '应用批量修改', exact: true }).click(); await expect(bulk).toHaveCount(0);
  expect((await saved(request, project.id)).shots[0].durationUs).toBe(1_700_000);
  const panel = await dialog(page); await panel.getByRole('checkbox', { name: '启用视频原声', exact: true }).uncheck(); await apply(panel);
  await page.getByRole('region', { name: '项目时间轴', exact: true }).getByRole('button', { name: '批量编辑镜头', exact: true }).click();
  bulk = page.getByRole('dialog', { name: '批量编辑镜头', exact: true });
  await bulk.getByRole('checkbox', { name: '批量修改时长', exact: true }).check();
  await bulk.getByLabel('批量镜头时长（秒）', { exact: true }).fill('3');
  await expect(bulk.getByRole('button', { name: '应用批量修改', exact: true })).toBeEnabled();
  await bulk.getByRole('button', { name: '应用批量修改', exact: true }).click(); await expect(bulk).toHaveCount(0);
  expect((await saved(request, project.id)).shots[0]).toMatchObject({ durationUs: 3_000_000, videoAssetId: fixtureData.asset.id, audioProcessing: { version: 2, videoAudio: { enabled: false } } });
  await healthy(page, errors);
});

test('keeps original sound and its waveform source windows through a real split, EDL cut and full backup restore', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const errors = observe(page), { project, asset } = await fixture(request, info); await open(page, project); const panel = await dialog(page);
  await panel.getByRole('checkbox', { name: '启用视频原声', exact: true }).check(); await apply(panel);
  const ruler = page.getByRole('slider', { name: '预览播放位置', exact: true }); await ruler.press('Home'); await ruler.press('Shift+ArrowRight');
  for (let frame = 0; frame < 5; frame++) await ruler.press('ArrowRight');
  await page.getByRole('button', { name: '在播放头处分割镜头', exact: true }).click();
  await expect(page.locator('.outline-shot')).toHaveCount(2);
  const waves = page.locator('.track--original .audio-waveform'); await expect(waves).toHaveCount(2);
  await expect(waves.nth(0)).toHaveAttribute('data-source-in-us', '250000'); await expect(waves.nth(1)).toHaveAttribute('data-source-in-us', '750000');
  await mixReady(page.locator('.preview-panel'));
  expect(await amplitudeOfPlayedMix(page.locator('.preview-panel'), request, info, 'split-first')).toBeGreaterThan(.17);
  expect(await amplitudeOfPlayedMix(page.locator('.preview-panel'), request, info, 'split-last', 1320, .85)).toBeGreaterThan(.17);
  const split = await saved(request, project.id); expect(split.shots.every(shot => shot.audioProcessing?.version === 2 && shot.audioProcessing.videoAudio.enabled)).toBe(true);
  let sequence = 0;
  const edited = deleteShotRanges(split, split.shots[1].id, [{ startUs: 200_000, endUs: 300_000 }], split.profile.frameRate, [asset], kind => `original-cut-${kind}-${++sequence}`);
  await rpc(request, 'project.update', { projectId: project.id, revision: split.revision, patch: { shots: edited.shots, clipEditSources: edited.clipEditSources, clipEditPlans: edited.clipEditPlans } });
  await expect(waves.nth(1)).toHaveAttribute('data-span-count', '2'); await mixReady(page.locator('.preview-panel'));
  expect(await amplitudeOfPlayedMix(page.locator('.preview-panel'), request, info, 'edl-last', 1320, .85)).toBeGreaterThan(.17);
  const backup = await rpc<{ path: string }>(request, 'project.backup', { projectId: project.id });
  const restored = await rpc<ProjectDocument>(request, 'project.importBackup', { path: backup.path });
  expect(restored.shots.map(shot => shot.audioProcessing)).toEqual(split.shots.map(shot => shot.audioProcessing));
  expect(restored.shots[0].videoAssetId).not.toBe(split.shots[0].videoAssetId);
  expect(restored.clipEditPlans).toHaveLength(1);
  await open(page, restored); await mixReady(page.locator('.preview-panel'));
  expect(await amplitudeOfPlayedMix(page.locator('.preview-panel'), request, info, 'restored-last', 1320, .85)).toBeGreaterThan(.17);
  await healthy(page, errors);
});
