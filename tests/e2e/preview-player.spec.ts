import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { expect, test, type APIRequestContext, type TestInfo } from '@playwright/test';
import { DEFAULT_AUDIO_MIX_SETTINGS, DEFAULT_AUDIO_PROCESSING, type AssetRecord, type ProjectDocument } from '@video-quickly/contracts';
import { rpc } from './native-video-fixture';
import { openProjectFromList } from './workspace-navigation';

async function fixture(request: APIRequestContext, info: TestInfo) {
  const path = info.outputPath('player-source.mp4');
  await promisify(execFile)(process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path], { windowsHide: true });
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: '播放器验收 ' + randomUUID().slice(0, 8), profile: { width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 }, fitMode: 'contain', previewScale: 1 } });
  const asset = await rpc<AssetRecord>(request, 'asset.import', { projectId: created.id, path, kind: 'video' });
  const { project } = await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: created.id });
  return rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: {
    audioMix: { ...DEFAULT_AUDIO_MIX_SETTINGS, loudness: { ...DEFAULT_AUDIO_MIX_SETTINGS.loudness, enabled: false } },
    shots: [0, 1].map(index => ({ id: `player-${index}`, title: `播放器镜头 ${index + 1}`, narration: '', visualPrompt: '', durationUs: 4_000_000, videoAssetId: asset.id, videoInUs: index * 4_000_000, audioProcessing: { ...DEFAULT_AUDIO_PROCESSING, version: 2, videoAudio: { enabled: true, gainDb: 0 } } })),
  } });
}

for (const viewport of [{ width: 1464, height: 895, theme: 'dark' }, { width: 1024, height: 720, theme: 'light' }, { width: 390, height: 844, theme: 'light' }]) test('plays, seeks and enters fullscreen without changing the project at ' + viewport.width + 'px', async ({ page, request }, info) => {
  const project = await fixture(request, info), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setViewportSize(viewport); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
  await page.goto('/'); await openProjectFromList(page, project.title);
  const player = page.getByRole('region', { name: '视频预览播放器', exact: true }), seek = player.getByRole('slider', { name: '播放器播放位置', exact: true });
  const audio = player.locator('audio[data-audio-role="处理后混音"]'), ruler = page.getByRole('slider', { name: '预览播放位置', exact: true });
  await expect(player.locator('.prepared-mix-preview')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(player.locator('.scene-preview')).toHaveAttribute('aria-busy', 'false');
  const bounds = await player.boundingBox(), picture = await player.locator('.preview-frame').boundingBox();
  expect(bounds).not.toBeNull(); expect(picture).not.toBeNull();
  expect(picture!.width).toBeCloseTo(Math.min(bounds!.width, bounds!.height * 16 / 9), 0);
  await seek.focus(); await seek.press('End'); await expect(ruler).toHaveAttribute('aria-valuenow', '7967');
  await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).currentTime)).toBeCloseTo(7.967, 1);
  await expect(player.locator('.preview-frame canvas')).toHaveAttribute('aria-label', '播放器镜头 2 · 镜头预览');
  await seek.press('Home'); await seek.press('ArrowRight'); await expect(ruler).toHaveAttribute('aria-valuenow', '33');
  if (viewport.width === 1464) {
    const volume = player.getByRole('slider', { name: '预览音量', exact: true });
    await volume.press('Home'); for (let index = 0; index < 7; index++) await volume.press('ArrowRight');
    await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).volume)).toBeCloseTo(.35, 2);
  }
  await player.getByRole('button', { name: '静音预览声音', exact: true }).click(); await expect(audio).toHaveJSProperty('muted', true);
  await player.getByRole('button', { name: '开启预览声音', exact: true }).click(); await expect(audio).toHaveJSProperty('muted', false);
  await player.focus(); await player.press('m'); await expect(audio).toHaveJSProperty('muted', true);
  await player.press('m'); await expect(audio).toHaveJSProperty('muted', false);
  await player.getByRole('button', { name: '播放预览', exact: true }).click();
  await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).currentTime)).toBeGreaterThan(.1);
  const slider = await seek.boundingBox(); expect(slider).not.toBeNull();
  await page.mouse.move(slider!.x + slider!.width * .25, slider!.y + slider!.height / 2); await page.mouse.down();
  await page.mouse.move(slider!.x + slider!.width * .6, slider!.y + slider!.height / 2, { steps: 5 }); await page.mouse.up();
  await expect(player.getByRole('button', { name: '暂停预览', exact: true })).toBeVisible();
  await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).currentTime)).toBeGreaterThan(4.5);
  await player.getByRole('button', { name: '暂停预览', exact: true }).click();
  await player.getByRole('button', { name: '全屏预览', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains('preview-player'))).toBe(true);
  await expect(player.getByRole('button', { name: '退出全屏预览', exact: true })).toBeVisible();
  const quality = player.getByRole('combobox', { name: '预览质量', exact: true });
  await quality.click();
  const option = await quality.getByRole('option', { name: '原画', exact: true }).boundingBox(), qualityBounds = await quality.boundingBox();
  expect(option).not.toBeNull(); expect(qualityBounds).not.toBeNull();
  expect(option!.y + option!.height).toBeLessThan(qualityBounds!.y);
  expect(option!.x + option!.width).toBeLessThanOrEqual(qualityBounds!.x + qualityBounds!.width);
  await quality.press('Escape');
  await page.screenshot({ path: info.outputPath('player-fullscreen-' + viewport.width + '.png') });
  await player.getByRole('button', { name: '退出全屏预览', exact: true }).click(); await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
  await player.focus(); await player.press('f');
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains('preview-player'))).toBe(true);
  await player.press('f'); await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
  if (viewport.width === 1464) {
    await player.getByRole('button', { name: '回到开头', exact: true }).click();
    await player.locator('.preview-frame').click(); await page.mouse.move(1, 1);
    await expect(player).toHaveAttribute('data-controls-visible', 'false', { timeout: 5000 });
    await expect(player.locator('.preview-controls')).toHaveCSS('visibility', 'hidden');
    await player.hover(); await expect(player.locator('.preview-controls')).toHaveCSS('visibility', 'visible');
    await player.getByRole('button', { name: '暂停预览', exact: true }).click();
  }
  await player.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('preview-player-' + viewport.width + '.png') });
  expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project).toEqual(project);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0); await expect(page).toHaveTitle(/Video Quickly/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]);
});
