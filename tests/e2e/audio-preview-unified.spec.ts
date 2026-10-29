import { writeFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { DEFAULT_AUDIO_MIX_SETTINGS, type AssetRecord, type ProjectDocument } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }), body = await response.json();
  expect(response.ok()).toBe(true); expect(body.error).toBeUndefined(); return body.result;
}
async function saved(request: APIRequestContext, projectId: string) { return (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId })).project; }
async function fixture(request: APIRequestContext, info: TestInfo, title: string) {
  let project = await rpc<ProjectDocument>(request, 'project.create', { title });
  const rate = 16000, samples = rate * 3, data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) data.writeInt16LE(Math.round(Math.sin(index * Math.PI * 880 / rate) * 6000), 44 + index * 2);
  const path = info.outputPath('complete-legacy-voice.wav'); await writeFile(path, data);
  const asset = await rpc<AssetRecord>(request, 'asset.import', { projectId: project.id, path, kind: 'audio' }); project = await saved(request, project.id);
  project = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { profile: { ...project.profile, width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 } }, audioMix: { ...DEFAULT_AUDIO_MIX_SETTINGS, loudness: { ...DEFAULT_AUDIO_MIX_SETTINGS.loudness, enabled: false } }, shots: [{ id: 'long-voice', title: '完整旧旁白', narration: '', visualPrompt: '', durationUs: 1000000, audioAssetId: asset.id, captionTrack: { timeBase: 'source', alignment: 'manual', cues: [{ id: 'tail', text: '录音末尾字幕', startUs: 2500000, endUs: 3000000 }] } }, { id: 'next', title: '后续镜头', narration: '', visualPrompt: '', durationUs: 1000000 }] } });
  return { project, asset };
}
async function open(page: Page, project: ProjectDocument) { await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/); await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click(); await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('完整旧旁白'); }
async function ready(page: Page) { const preview = page.locator('.preview-panel .prepared-mix-preview'); await expect(preview).toHaveAttribute('data-status', 'ready', { timeout: 20000 }); await expect(page.getByRole('button', { name: '播放预览', exact: true })).toBeEnabled(); return preview; }
async function seek(page: Page, frames: number) { const ruler = page.getByRole('slider', { name: '预览播放位置', exact: true }); await ruler.press('Home'); for (let index = 0; index < Math.floor(frames / 10); index++) await ruler.press('Shift+ArrowRight'); for (let index = 0; index < frames % 10; index++) await ruler.press('ArrowRight'); await expect(ruler).toHaveAttribute('aria-valuenow', String(Math.round(frames * 1000 / 30))); }

test('uses complete legacy voice timing for the main mix, following shots and a split beyond the old authored duration', async ({ page, request }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { project, asset } = await fixture(request, info, '完整旧旁白预览与分割验收'); await open(page, project); await ready(page);
  await expect(page.locator('.timecode')).toContainText('00:04.00');
  await expect(page.getByLabel('时长（秒）', { exact: true })).toHaveValue('3');
  expect((await saved(request, project.id)).shots[0].durationUs).toBe(1000000);
  const audio = page.locator('audio[data-audio-role="处理后混音"]'); await expect(audio).toHaveCount(1);
  expect(await audio.evaluate((element: HTMLAudioElement) => new URL(element.src).searchParams.get('path'))).not.toBe(asset.path);
  await page.getByRole('button', { name: '定位镜头 2：后续镜头', exact: true }).click();
  await expect(page.getByRole('slider', { name: '预览播放位置', exact: true })).toHaveAttribute('aria-valuenow', '3000');
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeCloseTo(3, 2);
  await page.getByRole('button', { name: '定位镜头 1：完整旧旁白', exact: true }).click(); await seek(page, 60);
  await page.getByRole('button', { name: '在播放头处分割镜头', exact: true }).click();
  await expect.poll(async () => (await saved(request, project.id)).shots.length).toBe(3);
  const split = await saved(request, project.id); expect(split.shots.map(shot => shot.durationUs)).toEqual([2000000, 1000000, 1000000]); expect(split.shots[1].sourceInUs).toBe(2000000); expect(split.shots[1].audioAssetId).toBe(asset.id);
  await ready(page); await seek(page, 80); await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeCloseTo(80 / 30, 2);
  await page.screenshot({ path: info.outputPath('unified-mix-legacy-tail.png') });
  await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect.poll(async () => (await saved(request, project.id)).shots).toEqual(project.shots); await ready(page); await expect(page.locator('.timecode')).toContainText('00:04.00');
  expect(errors).toEqual([]); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});

test('blocks playback on preparation failure and retries the unified mix before playing or muting', async ({ page, request }, info) => {
  const errors: string[] = [], consoleErrors: string[] = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  const { project } = await fixture(request, info, '主预览混音失败重试与静音验收'); let failed = 0, reject = true;
  await page.route('**/__desktop_rpc', async route => { if (reject && route.request().postDataJSON()?.method === 'audio.mix.prepare') { failed++; await route.fulfill({ status: 400, json: { error: '隔离的主预览混音准备失败' } }); } else await route.continue(); });
  await open(page, project); await expect(page.locator('.preview-panel').getByRole('alert')).toContainText('隔离的主预览混音准备失败');
  await expect(page.getByRole('button', { name: '播放预览', exact: true })).toBeDisabled(); await expect(page.locator('.preview-panel audio')).toHaveCount(0);
  await page.locator('.preview-toolbar').click(); await page.keyboard.press('Space'); await expect(page.getByRole('button', { name: '播放预览', exact: true })).toBeDisabled();
  reject = false; await page.getByRole('button', { name: '重新准备预览混音', exact: true }).click(); await ready(page);
  const audio = page.locator('audio[data-audio-role="处理后混音"]'); await expect(audio).toHaveCount(1); await page.getByRole('button', { name: '静音旁白', exact: true }).click(); expect(await audio.evaluate((element: HTMLAudioElement) => element.muted)).toBe(true);
  await page.getByRole('button', { name: '播放预览', exact: true }).click(); await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(.05); await page.getByRole('button', { name: '暂停预览', exact: true }).click(); await page.getByRole('button', { name: '开启旁白声音', exact: true }).click(); expect(await audio.evaluate((element: HTMLAudioElement) => element.muted)).toBe(false);
  expect(await saved(request, project.id)).toEqual(project); expect(errors).toEqual([]); expect(failed).toBeGreaterThan(0); expect(consoleErrors).toEqual(Array.from({ length: failed }, () => 'Failed to load resource: the server responded with a status of 400 (Bad Request)'));
});
