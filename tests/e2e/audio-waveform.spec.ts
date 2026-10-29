import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssetRecord, ProjectDocument } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  expect(response.ok()).toBe(true);
  const payload = await response.json(); expect(payload.error).toBeUndefined(); return payload.result;
}

function wav(): Buffer {
  const rate = 16_000, samples = rate * 2, bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(36 + samples * 2, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let sample = 0; sample < samples; sample++) bytes.writeInt16LE(Math.round((sample < rate ? .2 : .8) * 32767 * Math.sin(2 * Math.PI * 400 * sample / rate)), 44 + sample * 2);
  return bytes;
}

async function openProject(page: Page, title: string) {
  await page.goto('/');
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.locator('.project-card').filter({ hasText: title }).getByRole('button', { name: /继续创作/ }).click();
}

test('displays real source peaks for split ranges and looping music without changing project state', async ({ page, request }, info) => {
  const directory = await mkdtemp(join(tmpdir(), 'video-quickly-waveform-e2e-'));
  try {
    const project = await rpc<ProjectDocument>(request, 'project.create', { title: '真实波形与源区间验收' });
    const path = join(directory, 'levels.wav'); await writeFile(path, wav());
    const asset = await rpc<AssetRecord>(request, 'asset.import', { projectId: project.id, path, kind: 'audio' });
    const saved = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: {
      shots: [0, 1].map(index => ({ id: `voice-${index}`, title: `音量区间 ${index + 1}`, narration: '', visualPrompt: '', durationUs: 1_000_000, sourceInUs: index * 1_000_000, audioAssetId: asset.id })),
      musicClips: [{ id: 'music', assetId: asset.id, startUs: 0, sourceInUs: 1_000_000, durationUs: 2_000_000, loop: true }],
    } });
    let reads = 0;
    page.on('request', event => { if (event.url().includes('/__desktop_rpc') && event.postDataJSON()?.method === 'asset.waveform') reads++; });
    await openProject(page, project.title);
    const ready = page.locator('.audio-waveform[data-status=ready]');
    await expect(ready).toHaveCount(3);
    expect(reads).toBe(1);
    await expect(page.locator('.track--audio:not(.track--music) .audio-waveform').nth(1)).toHaveAttribute('data-source-in-us', '1000000');
    const heights = await page.locator('.track--audio:not(.track--music) .audio-waveform path').evaluateAll(paths => paths.map(path => Math.max(...[...path.getAttribute('d')!.matchAll(/V([\d.]+)/g)].map(match => Number(match[1])))));
    expect(heights[0]).toBeLessThan(20);
    expect(heights[1]).toBeGreaterThan(25);
    await expect(page.locator('.track--music')).toContainText('秒循环');
    const music = await page.locator('.track--music').boundingBox(), timeline = await page.locator('.timeline').boundingBox();
    expect(music && timeline && music.y + music.height <= timeline.y + timeline.height).toBe(true);
    expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project).toEqual(saved);
    await page.screenshot({ path: info.outputPath('real-source-waveforms-and-music.png') });
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('shows a decode failure without drawing a fabricated waveform', async ({ page, request }, info) => {
  const directory = await mkdtemp(join(tmpdir(), 'video-quickly-waveform-error-'));
  try {
    const project = await rpc<ProjectDocument>(request, 'project.create', { title: '波形解码失败验收' });
    const path = join(directory, 'broken.wav'); await writeFile(path, 'broken audio');
    const asset = await rpc<AssetRecord>(request, 'asset.import', { projectId: project.id, path, kind: 'audio' });
    await rpc(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: [{ id: 'broken', title: '音频损坏', narration: '', visualPrompt: '', durationUs: 1_000_000, audioAssetId: asset.id }] } });
    await openProject(page, project.title);
    const waveform = page.locator('.audio-waveform');
    await expect(waveform).toHaveAttribute('data-status', 'error');
    await expect(waveform).toContainText('波形读取失败');
    await expect(waveform.locator('svg')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('waveform-decode-error.png') });
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
