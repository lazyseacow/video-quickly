import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { AssetRecord, ModelProfile, ProjectDocument, RunSummary, ShotCandidate } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json(); expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function savedProject(request: APIRequestContext, projectId: string) {
  return (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId })).project;
}
async function createProject(request: APIRequestContext, title: string) {
  const project = await rpc<ProjectDocument>(request, 'project.create', { title });
  return rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: [1, 2].map(index => ({ id: `target-${index}`, title: `目标镜头 ${index}`, narration: `基线旁白 ${index}`, visualPrompt: `基线画面 ${index}`, durationUs: 2_000_000 })) } });
}
async function openProject(page: Page, title: string) {
  await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/);
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.locator('.project-card').filter({ hasText: title }).getByRole('button', { name: /继续创作/ }).click();
  await expect(page.getByLabel('镜头标题')).toBeVisible();
}
async function openCandidates(page: Page) {
  await page.getByRole('button', { name: 'AI 微调', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '镜头候选', exact: true }); await expect(dialog).toBeVisible(); return dialog;
}
function observeErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); }); return errors;
}
async function expectHealthy(page: Page, errors: string[]) {
  await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
}
async function showComparison(dialog: Locator) {
  await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '1');
  await dialog.locator('.shot-regeneration__comparison').scrollIntoViewIfNeeded();
  await expect(dialog.getByRole('button', { name: '应用所选候选', exact: true })).toBeInViewport({ ratio: 1 });
}
async function fixture(media?: { image: Buffer; audio: Buffer; video: Buffer }) {
  const requests: Array<{ path: string; body: string }> = [];
  let failure = false, calls = 0;
  let gate: Promise<void> | undefined, release: (() => void) | undefined;
  let origin = '';
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = []; incoming.on('data', chunk => chunks.push(chunk));
    incoming.on('end', () => { void (async () => {
      const path = incoming.url ?? ''; requests.push({ path, body: Buffer.concat(chunks).toString() });
      if (path === '/fixture.mp4' && media) { response.setHeader('Content-Type', 'video/mp4'); response.end(media.video); return; }
      if (path.endsWith('/chat/completions')) {
        const number = ++calls, waiting = gate;
        if (waiting) await waiting;
        if (failure) { response.statusCode = 500; response.end('isolated model failure'); return; }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ shots: [{ title: `候选标题 ${number}`, narration: `候选旁白 ${number}`, visualPrompt: `候选画面 ${number}`, durationUs: 3_000_000 }] }) } }] })); return;
      }
      if (path.endsWith('/images/generations') && media) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ b64_json: media.image.toString('base64') }] })); return; }
      if (path.endsWith('/audio/speech') && media) { response.setHeader('Content-Type', 'audio/mpeg'); response.end(media.audio); return; }
      if (path.endsWith('/generate-video') && media) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ url: `${origin}/fixture.mp4` })); return; }
      response.statusCode = 404; response.end('unknown fixture endpoint');
    })().catch(error => { response.statusCode = 500; response.end(String(error)); }); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('候选模型夹具未启动');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}/v1`, requests,
    fail(value: boolean) { failure = value; },
    hold() { gate = new Promise<void>(resolve => { release = resolve; }); },
    release() { release?.(); gate = undefined; release = undefined; },
    async close() { release?.(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
async function model(request: APIRequestContext, url: string, kind: ShotCandidate['kind']) {
  return rpc<ModelProfile>(request, 'model.save', { model: {
    name: `隔离候选服务 ${kind}`, provider: kind === 'video' ? 'custom-http' : 'openai-compatible', baseUrl: url, model: `candidate-${kind}`,
    capabilities: [kind === 'script' ? 'text' : kind === 'audio' ? 'tts' : kind],
    ...(kind === 'video' ? { parameters: { requestPath: 'generate-video', requestTemplate: { prompt: '{{prompt}}' }, resultUrlPath: 'url' } } : {}),
  } });
}

test('generates only the selected shot, compares chosen fields, and keeps the applied candidate undoable after reload', async ({ page, request }, info) => {
  const errors = observeErrors(page), service = await fixture();
  try {
    const project = await createProject(request, '镜头候选局部应用验收');
    const connection = await model(request, service.url, 'script');
    await openProject(page, project.title); await page.locator('.outline-shot').nth(1).click();
    let dialog = await openCandidates(page);
    await dialog.getByLabel('生成模型', { exact: true }).selectOption(connection.id);
    await dialog.getByLabel('本次调整要求', { exact: true }).fill('只重写当前镜头的旁白');
    await dialog.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect(dialog.locator('.shot-regeneration__comparison')).toContainText('候选旁白 1');
    await expect(dialog.locator('.shot-regeneration__comparison')).toContainText('基线旁白 2');
    await expect(dialog.getByRole('checkbox', { name: '应用候选时长', exact: true })).not.toBeChecked();
    expect(await savedProject(request, project.id)).toEqual(project);
    expect(service.requests[0].body).toContain('基线旁白 2'); expect(service.requests[0].body).not.toContain('基线旁白 1');
    await dialog.getByRole('checkbox', { name: '应用候选标题', exact: true }).uncheck();
    await dialog.getByRole('checkbox', { name: '应用候选画面要求', exact: true }).uncheck();
    await showComparison(dialog);
    await page.screenshot({ path: info.outputPath('shot-candidate-comparison-dark.png') });
    await dialog.getByRole('button', { name: '应用所选候选', exact: true }).click(); await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await savedProject(request, project.id)).shots[1].narration).toBe('候选旁白 1');
    const saved = await savedProject(request, project.id);
    expect(saved.shots[0]).toEqual(project.shots[0]);
    expect(saved.shots[1]).toEqual({ ...project.shots[1], narration: '候选旁白 1' });
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(async () => (await savedProject(request, project.id)).shots).toEqual(project.shots);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect.poll(async () => (await savedProject(request, project.id)).shots).toEqual(saved.shots);
    await page.reload(); await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
    await page.locator('.outline-shot').nth(1).click();
    await page.getByRole('button', { name: '浅色外观', exact: true }).click();
    await page.setViewportSize({ width: 600, height: 900 }); dialog = await openCandidates(page);
    await expect(dialog.locator('.shot-regeneration__history-item')).toHaveCount(1);
    await expect(dialog.locator('.shot-regeneration__comparison')).toContainText('候选旁白 1');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await showComparison(dialog);
    await page.screenshot({ path: info.outputPath('shot-candidate-history-light-600.png') });
    await expectHealthy(page, errors);
  } finally { await service.close(); }
});

test('recovers background generation, offers explicit resume, and retains the dialog on generation failure or stale output', async ({ page, request }) => {
  const errors = observeErrors(page), service = await fixture();
  try {
    const project = await createProject(request, '镜头候选恢复与冲突验收');
    const connection = await model(request, service.url, 'script'); service.hold();
    await openProject(page, project.title); let dialog = await openCandidates(page);
    await dialog.getByLabel('生成模型', { exact: true }).selectOption(connection.id);
    await dialog.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
    await expect.poll(() => service.requests.length).toBe(1);
    const pending = await rpc<{ activeRun: RunSummary }>(request, 'shot.candidates', { projectId: project.id, shotId: 'target-1' });
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    expect((await rpc<RunSummary>(request, 'run.get', { runId: pending.activeRun.id })).status).toBe('running');
    let interrupted = true, resumes = 0;
    // Runtime restart restoration is covered separately; expose its queued state over the real running fixture.
    await page.route('**/__desktop_rpc', async route => {
      const input = route.request().postDataJSON();
      if (input.method === 'run.resume') { interrupted = false; resumes++; }
      if (input.method === 'run.get' && interrupted && input.params.runId === pending.activeRun.id) {
        const response = await route.fetch(); const payload = await response.json();
        await route.fulfill({ json: { ...payload, result: { ...payload.result, status: 'queued', error: '上次执行已中断，可从检查点继续。' } } }); return;
      }
      await route.continue();
    });
    dialog = await openCandidates(page);
    await expect(dialog.getByRole('button', { name: '继续生成', exact: true })).toBeVisible();
    await expect(dialog.locator('.shot-regeneration__run')).toContainText('上次执行已中断');
    await expect(dialog.locator('.shot-regeneration__run')).not.toContainText('生成在后台继续');
    await dialog.getByRole('button', { name: '继续生成', exact: true }).click();
    expect(resumes).toBe(1); service.release();
    await expect(dialog.locator('.shot-regeneration__comparison')).toContainText('候选旁白 1');
    expect(service.requests).toHaveLength(1);
    service.fail(true); await dialog.getByLabel('生成模型', { exact: true }).selectOption(connection.id);
    await dialog.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('外部调用未完成，结果需要核对。');
    expect(service.requests).toHaveLength(2);
    expect((await rpc<{ total: number }>(request, 'shot.candidates', { projectId: project.id, shotId: 'target-1' })).total).toBe(1);
    const remote = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: project.shots.map((shot, index) => index ? shot : { ...shot, narration: '另一视图的人工旁白' }) } });
    await expect(page.locator('.project-heading-copy')).toHaveAttribute('data-revision', String(remote.revision));
    await dialog.getByRole('button', { name: '应用所选候选', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('已修改'); expect(await savedProject(request, project.id)).toEqual(remote);
    service.fail(false); service.hold();
    await dialog.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect.poll(() => service.requests.length).toBe(3);
    await dialog.getByRole('button', { name: '停止生成', exact: true }).click();
    await expect(dialog.locator('.shot-regeneration__run')).toContainText('已请求停止'); service.release();
    expect((await rpc<{ total: number }>(request, 'shot.candidates', { projectId: project.id, shotId: 'target-1' })).total).toBe(1);
    await expectHealthy(page, errors);
  } finally { await service.close(); }
});

function mediaBytes() {
  const ffmpeg = process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
  const run = (args: string[]) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], { maxBuffer: 2 * 1024 * 1024 });
  return {
    image: run(['-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=0.1', '-frames:v', '1', '-threads', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1']),
    audio: run(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=2', '-c:a', 'libmp3lame', '-f', 'mp3', 'pipe:1']),
    video: run(['-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=30:d=2', '-threads', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1']),
  };
}

test('previews real image, audio and video candidates within the clip window and preserves other media on apply', async ({ page, request }, info) => {
  const errors = observeErrors(page), media = mediaBytes(), service = await fixture(media);
  try {
    let project = await createProject(request, '镜头真实媒体候选验收');
    const audioPath = info.outputPath('original-voice.mp3'), videoPath = info.outputPath('original-video.mp4');
    await writeFile(audioPath, media.audio); await writeFile(videoPath, media.video);
    const oldAudio = await rpc<AssetRecord>(request, 'asset.import', { projectId: project.id, shotId: 'target-1', path: audioPath, kind: 'audio' });
    const oldVideo = await rpc<AssetRecord>(request, 'asset.import', { projectId: project.id, shotId: 'target-1', path: videoPath, kind: 'video' });
    project = await savedProject(request, project.id);
    project = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: project.shots.map((shot, index) => index ? shot : { ...shot, durationUs: 1_000_000, sourceInUs: 400_000, audioInUs: 500_000, videoInUs: 200_000, captionTrack: { timeBase: 'source', alignment: 'manual', cues: [{ id: 'keep', startUs: 400_000, endUs: 1_400_000, text: '保留已有字幕' }] } }) } });
    const connections = { image: await model(request, service.url, 'image'), audio: await model(request, service.url, 'audio'), video: await model(request, service.url, 'video') };
    await openProject(page, project.title);
    let dialog = await openCandidates(page);
    await dialog.getByLabel('生成内容', { exact: true }).selectOption('image'); await dialog.getByLabel('生成模型', { exact: true }).selectOption(connections.image.id);
    await dialog.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect(dialog.getByAltText('候选画面')).toBeVisible();
    expect(await dialog.getByAltText('候选画面').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(64);
    await expect.poll(() => dialog.getByLabel('当前视频', { exact: true }).evaluate(video => (video as HTMLVideoElement).currentTime)).toBeCloseTo(.2, 2);
    await dialog.getByRole('button', { name: '应用所选候选', exact: true }).click();
    await expect.poll(async () => (await savedProject(request, project.id)).shots[0].assetId).toBeTruthy();
    let saved = await savedProject(request, project.id);
    expect(saved.shots[0].videoAssetId).toBeUndefined(); expect(saved.shots[0].audioAssetId).toBe(oldAudio.id);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(async () => (await savedProject(request, project.id)).shots[0].videoAssetId).toBe(oldVideo.id);
    dialog = await openCandidates(page);
    await dialog.getByLabel('生成内容', { exact: true }).selectOption('audio'); await dialog.getByLabel('生成模型', { exact: true }).selectOption(connections.audio.id);
    await dialog.getByRole('button', { name: '生成候选', exact: true }).click();
    const audio = dialog.getByLabel('候选旁白', { exact: true });
    await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).readyState)).toBeGreaterThanOrEqual(1);
    await expect.poll(() => dialog.getByLabel('当前旁白', { exact: true }).evaluate(element => (element as HTMLAudioElement).currentTime)).toBeCloseTo(.5, 2);
    await audio.evaluate(element => { (element as HTMLAudioElement).currentTime = 1.8; });
    await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).currentTime)).toBeLessThanOrEqual(1);
    await expect(dialog).toContainText('现有字幕会保留');
    await dialog.getByRole('button', { name: '应用所选候选', exact: true }).click();
    await expect.poll(async () => (await savedProject(request, project.id)).shots[0].audioAssetId).not.toBe(oldAudio.id);
    saved = await savedProject(request, project.id);
    expect(saved.shots[0]).toMatchObject({ audioInUs: 0, videoAssetId: oldVideo.id, videoInUs: 200_000, captionTrack: project.shots[0].captionTrack });
    const newAudio = saved.shots[0].audioAssetId;
    dialog = await openCandidates(page);
    await dialog.getByLabel('生成内容', { exact: true }).selectOption('video'); await dialog.getByLabel('生成模型', { exact: true }).selectOption(connections.video.id);
    await dialog.getByRole('button', { name: '生成候选', exact: true }).click();
    const video = dialog.getByLabel('候选视频', { exact: true });
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).videoWidth)).toBe(64);
    await video.evaluate(element => { (element as HTMLVideoElement).currentTime = 1.8; });
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeLessThanOrEqual(1);
    expect(await dialog.locator('audio,video').count()).toBe(2);
    await showComparison(dialog);
    await page.screenshot({ path: info.outputPath('shot-real-media-comparison.png') });
    await dialog.getByRole('button', { name: '应用所选候选', exact: true }).click();
    await expect.poll(async () => (await savedProject(request, project.id)).shots[0].videoAssetId).not.toBe(oldVideo.id);
    saved = await savedProject(request, project.id);
    expect(saved.shots[0]).toMatchObject({ videoInUs: 0, audioAssetId: newAudio, audioInUs: 0, captionTrack: project.shots[0].captionTrack });
    expect(saved.shots[1]).toEqual(project.shots[1]);
    await expectHealthy(page, errors);
  } finally { await service.close(); }
});

test('paginates durable candidate history without mounting every historical media preview', async ({ page, request }) => {
  const errors = observeErrors(page), service = await fixture();
  try {
    const project = await createProject(request, '镜头候选分页历史验收'), connection = await model(request, service.url, 'script');
    for (let index = 0; index < 9; index++) {
      const run = await rpc<RunSummary>(request, 'shot.regenerate', { projectId: project.id, shotId: 'target-1', kind: 'script', modelId: connection.id, revision: project.revision });
      await expect.poll(async () => (await rpc<RunSummary>(request, 'run.get', { runId: run.id })).status).toBe('succeeded');
    }
    await openProject(page, project.title); const dialog = await openCandidates(page);
    await expect(dialog.locator('.shot-regeneration__history-item')).toHaveCount(8);
    await dialog.getByRole('button', { name: '加载更多候选', exact: true }).click();
    await expect(dialog.locator('.shot-regeneration__history-item')).toHaveCount(9);
    await expect(dialog.getByRole('button', { name: '加载更多候选', exact: true })).toHaveCount(0);
    await dialog.locator('.shot-regeneration__history-item').last().click();
    await expect(dialog.locator('.shot-regeneration__comparison')).toContainText('候选旁白 1');
    expect(await dialog.locator('audio,video,img').count()).toBe(0);
    expect(await savedProject(request, project.id)).toEqual(project);
    await expectHealthy(page, errors);
  } finally { await service.close(); }
});
