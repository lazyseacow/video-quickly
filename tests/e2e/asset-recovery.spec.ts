import { openProjectFromList } from './workspace-navigation';
import { setWorkspaceTheme } from './workspace-settings';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { test } from './isolated-workspace';
import { DEFAULT_AUDIO_MIX_SETTINGS, type AssetRecord, type ProjectDocument, type RunSummary } from '@video-quickly/contracts';
import { DocumentStore, openDatabase } from '../../packages/runtime/src/database';
import { createAssetRecovery, type AssetRecoveryOptions } from '../../packages/runtime/src/asset-recovery';

const execute = promisify(execFile);
async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }), payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function saved(request: APIRequestContext, projectId: string) { return (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId })).project; }
async function open(page: Page, project: ProjectDocument) {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/);
  await openProjectFromList(page, project.title);
}
async function recovery(page: Page) {
  await page.getByRole('button', { name: '素材库', exact: true }).click(); await page.getByRole('button', { name: '恢复缺失素材', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '恢复缺失素材', exact: true }); await expect(dialog).toBeVisible();
  await expect(dialog.getByText('检查完成', { exact: true })).toBeVisible(); return dialog;
}
async function restore(page: Page, source: string) {
  const dialog = await recovery(page); await dialog.getByLabel('查找目录', { exact: true }).fill(source);
  await dialog.getByRole('button', { name: '扫描目录', exact: true }).click(); await expect(dialog.getByText('扫描完成，请确认匹配项', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '选择全部匹配项', exact: true }).click(); await expect(dialog.getByRole('button', { name: '确认恢复所选素材', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '确认恢复所选素材', exact: true }).click(); await expect(dialog.getByText('所选素材已恢复', { exact: true })).toBeVisible();
  return dialog;
}
let failures: string[];
let missingAssets: Set<string>;
type RpcFailure = { method: string; error: string; phase: 'normal' | 'missing' | 'recovery'; projectId?: string; assetId?: string };
let rpcFailures: RpcFailure[], expectedRpcFailures: Array<Omit<RpcFailure, 'error' | 'phase'> & { error: RegExp; phase?: RpcFailure['phase'] }>;
let rpcFailureReads: Promise<void>[], rpcPhase: RpcFailure['phase'];
test.beforeEach(async ({ page, baseURL }) => {
  failures = []; missingAssets = new Set(); rpcFailures = []; expectedRpcFailures = []; rpcFailureReads = []; rpcPhase = 'normal'; page.on('pageerror', error => failures.push(error.message));
  page.on('console', entry => {
    if (entry.type() !== 'error') return;
    let expected = false;
    if (/^Failed to load resource: the server responded with a status of 404/.test(entry.text())) {
      try { const url = new URL(entry.location().url); expected = url.origin === baseURL && url.pathname === '/__desktop_asset' && url.searchParams.size === 1 && missingAssets.has(url.searchParams.get('path') ?? ''); } catch { /* A non-URL diagnostic is still an unexpected console error. */ }
    }
    if (!expected) failures.push(entry.location().url === `${baseURL}/__desktop_rpc` ? entry.text() : `${entry.text()} (${entry.location().url})`);
  });
  page.on('response', response => {
    if (response.status() !== 400 || response.url() !== `${baseURL}/__desktop_rpc`) return;
    const phase = rpcPhase;
    rpcFailureReads.push((async () => {
      try {
        const payload = await response.json(), input = response.request().postDataJSON();
        rpcFailures.push({ method: input.method, error: payload.error, phase, ...(input.method === 'audio.mix.prepare' ? { projectId: input.params.project.id } : input.method === 'asset.waveform' ? { assetId: input.params.assetId } : {}) });
      } catch (error) { failures.push(`无法读取 RPC 失败响应：${String(error)}`); }
    })());
  });
});
test.afterEach(async ({ page }) => {
  while (rpcFailureReads.length) await Promise.all(rpcFailureReads.splice(0));
  const byMethod = (left: { method: string }, right: { method: string }) => left.method.localeCompare(right.method);
  expect([...rpcFailures].sort(byMethod)).toEqual(expectedRpcFailures.map(value => ({ ...value, phase: value.phase ?? 'normal', error: expect.stringMatching(value.error) })).sort(byMethod));
  expect(failures).toEqual(expectedRpcFailures.map(() => 'Failed to load resource: the server responded with a status of 400 (Bad Request)'));
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});

test('restores a renamed real image through the complete dialog and automatically retries its failed preview', async ({ page, request }, info) => {
  const source = await mkdtemp(join(tmpdir(), 'vq-recovery-ui-'));
  try {
    const path = join(source, '原始.svg'), bytes = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#379269"/></svg>';
    await writeFile(path, bytes); const created = await rpc<ProjectDocument>(request, 'project.create', { title: `图片恢复 ${randomUUID().slice(0, 8)}` });
    const asset = await rpc<AssetRecord>(request, 'asset.import', { projectId: created.id, path, kind: 'image' });
    const baseline = await saved(request, created.id), project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: baseline.revision, patch: { shots: [{ id: 'picture', title: '待恢复画面', narration: '', visualPrompt: '', durationUs: 2_000_000, assetId: asset.id }] } });
    await rm(asset.path); missingAssets.add(asset.path); await rename(path, join(source, '改名后的画面.svg')); await writeFile(join(source, '第二个匹配.svg'), bytes); await writeFile(path, bytes.replace('#379269', '#111111'));
    await open(page, project); await expect(page.locator('.preview-panel .scene-preview__state')).toContainText('无法');
    const dialog = await recovery(page), card = page.locator('.asset-card').filter({ has: page.getByRole('heading', { name: asset.name, exact: true }) });
    await expect(card.getByRole('img', { name: `无法预览“${asset.name}”`, exact: true })).toBeAttached();
    await dialog.getByLabel('查找目录', { exact: true }).fill(source); await dialog.getByRole('button', { name: '扫描目录', exact: true }).click();
    await expect(dialog.getByText('扫描完成，请确认匹配项', { exact: true })).toBeVisible();
    const item = dialog.locator(`[data-asset-id="${asset.id}"]`), candidate = item.getByLabel(`匹配文件：${asset.name}`, { exact: true });
    await expect(candidate.locator('option')).toHaveCount(2);
    const chosen = await candidate.locator('option').filter({ hasText: '第二个匹配.svg' }).getAttribute('value'); expect(chosen).toBeTruthy();
    await candidate.selectOption(chosen!); await expect(item.getByRole('checkbox')).toBeChecked();
    let selected: Array<{ candidateId: string }> = [];
    page.on('request', request => { if (request.url().endsWith('/__desktop_rpc') && request.postDataJSON()?.method === 'asset.recovery.confirm') selected = request.postDataJSON().params.selections; });
    await dialog.getByRole('button', { name: '确认恢复所选素材', exact: true }).click();
    await expect(dialog.getByText('所选素材已恢复', { exact: true })).toBeVisible(); await page.screenshot({ path: info.outputPath('image-recovery-confirmed-dark.png') });
    await expect(dialog.locator('.asset-recovery__footer')).toContainText('0 个待恢复');
    await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await expect(card.locator('img')).toBeVisible();
    expect(await card.locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 160)).toBe(true);
    await openProjectFromList(page); await expect(page.locator('.preview-panel .scene-preview__state')).toHaveCount(0);
    expect(selected.map(value => value.candidateId)).toEqual([chosen]); expect(await readFile(asset.path, 'utf8')).toBe(bytes); expect(await saved(request, project.id)).toEqual(project);
  } finally { await rm(source, { recursive: true, force: true }); }
});

test('pages every scoped record with causes and history, changes scope safely and stays usable in a narrow light dialog', async ({ page, request }, info) => {
  const project = await rpc<ProjectDocument>(request, 'project.create', { title: `完整恢复清单 ${randomUUID().slice(0, 8)}` });
  const { system } = await rpc<{ system: { dataDirectory: string } }>(request, 'workspace.summary'), database = openDatabase(system.dataDirectory), store = new DocumentStore(database);
  const base: AssetRecord = { id: '', projectId: project.id, path: '', name: '', sha256: createHash('sha256').update('missing').digest('hex'), size: 7, kind: 'image', mimeType: 'image/png', version: 1, createdAt: '', active: true, retained: false, provenance: '' };
  try {
    database.transaction(() => { for (let index = 0; index < 101; index++) { const id = `${project.id}-page-${index}`, path = join(system.dataDirectory, 'projects', project.id, 'assets', `${index}.png`); missingAssets.add(path); store.put('asset', id, { ...base, id, name: `缺失素材 ${index}`, path }); } })();
    store.put('run-snapshot', `${project.id}-history`, { project: { id: project.id }, assets: [{ ...base, id: 'historical-unsafe', name: '旧快照越界素材', path: join(tmpdir(), 'outside-workspace.png') }] });
  } finally { database.close(); }
  await open(page, project); const starts: unknown[] = []; page.on('request', request => { if (request.url().endsWith('/__desktop_rpc') && request.postDataJSON()?.method === 'asset.recovery.start') starts.push(request.postDataJSON().params); });
  const dialog = await recovery(page); await expect(dialog.locator('.asset-recovery__item')).toHaveCount(100);
  await dialog.getByRole('button', { name: '下一页素材清单', exact: true }).click(); await expect(dialog.locator('.asset-recovery__item')).toHaveCount(2);
  const unsafe = dialog.locator('[data-asset-id="historical-unsafe"]'); await expect(unsafe).toContainText('路径不可安全恢复'); await expect(unsafe).toContainText('当前工作区之外');
  await unsafe.locator('summary').click(); await expect(unsafe).toContainText('冻结制作快照'); await expect(unsafe.getByRole('checkbox')).toBeDisabled();
  const scope = dialog.getByLabel('恢复范围', { exact: true }); await scope.focus(); await expect(scope).toBeFocused(); await scope.selectOption('');
  await expect(dialog.getByText('检查完成', { exact: true })).toBeVisible(); expect(starts).toEqual([{ projectId: project.id }, {}]);
  await scope.selectOption(project.id); await expect(dialog.getByText('检查完成', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('complete-recovery-list-dark-1536.png') });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await setWorkspaceTheme(page, 'light'); await page.setViewportSize({ width: 600, height: 900 });
  await page.getByRole('button', { name: '恢复缺失素材', exact: true }).click(); const narrow = page.getByRole('dialog', { name: '恢复缺失素材', exact: true }); await expect(narrow).toBeVisible();
  await narrow.getByLabel('查找目录', { exact: true }).focus(); await expect(narrow.getByLabel('查找目录', { exact: true })).toBeFocused();
  expect(await narrow.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true); await page.screenshot({ path: info.outputPath('complete-recovery-list-light-600.png') });
  await page.keyboard.press('Escape'); await expect(narrow).toHaveCount(0); await expect(page.getByRole('button', { name: '恢复缺失素材', exact: true })).toBeFocused();
});

test('automatically retries failed real video, source duration, waveform and local mix after recovery without changing the editor selection', async ({ page, request }, info) => {
  test.setTimeout(60_000); const source = await mkdtemp(join(tmpdir(), 'vq-recovery-media-'));
  try {
    const video = join(source, 'video.mp4'), audio = join(source, 'voice.wav');
    await execute(process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=blue:size=320x180:rate=30:duration=2', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', video]);
    await execute(process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=2', audio]);
    const created = await rpc<ProjectDocument>(request, 'project.create', { title: `真实媒体恢复 ${randomUUID().slice(0, 8)}` });
    const picture = await rpc<AssetRecord>(request, 'asset.import', { projectId: created.id, path: video, kind: 'video' }), voice = await rpc<AssetRecord>(request, 'asset.import', { projectId: created.id, path: audio, kind: 'audio' });
    const missingVoiceError = new RegExp(`^ENOENT: no such file or directory, open '${voice.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'$`);
    expectedRpcFailures = [{ method: 'asset.waveform', error: missingVoiceError, assetId: voice.id, phase: 'missing' }, { method: 'audio.mix.prepare', error: missingVoiceError, projectId: created.id, phase: 'missing' }];
    const before = await saved(request, created.id), project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: before.revision, patch: {
      audioMix: { ...DEFAULT_AUDIO_MIX_SETTINGS, loudness: { ...DEFAULT_AUDIO_MIX_SETTINGS.loudness, enabled: false } },
      shots: [{ id: 'media', title: '保留所选镜头', narration: '', visualPrompt: '', durationUs: 1_000_000, videoAssetId: picture.id, audioAssetId: voice.id, sourceInUs: 0 }],
    } });
    const failedMix = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.status() === 400 && response.request().postDataJSON()?.method === 'audio.mix.prepare' && response.request().postDataJSON().params.project.id === project.id);
    rpcPhase = 'missing';
    await rm(picture.path); await rm(voice.path); missingAssets.add(picture.path); missingAssets.add(voice.path); await open(page, project);
    await expect(page.locator('.preview-panel .scene-preview__state')).toContainText('无法');
    await expect(page.locator('.audio-waveform')).toHaveAttribute('data-status', 'error');
    await expect(page.locator('.preview-panel .preview-audio').getByRole('alert')).toContainText('ENOENT');
    await expect(page.getByRole('button', { name: '重新准备预览混音', exact: true })).toBeVisible();
    expect((await (await failedMix).json()).error).toContain(voice.path);
    await expect(page.locator('.clip-timing').getByRole('alert')).toContainText('无法读取');
    await expect.poll(() => rpcFailures.length).toBe(2); rpcPhase = 'recovery';
    const dialog = await restore(page, source); await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await openProjectFromList(page); await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('保留所选镜头');
    await expect(page.locator('.preview-panel .scene-preview__state')).toHaveCount(0); await expect(page.locator('.audio-waveform')).toHaveAttribute('data-status', 'ready');
    await expect(page.locator('.clip-timing')).toContainText('可用素材出点上限 2.000 秒');
    await expect(page.locator('.preview-panel .prepared-mix-preview')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
    const mix = page.locator('audio[data-audio-role="处理后混音"]'); expect(await mix.evaluate((element: HTMLAudioElement) => element.readyState >= 2)).toBe(true);
    await page.getByRole('button', { name: '静音旁白', exact: true }).click(); await expect.poll(() => mix.evaluate((element: HTMLAudioElement) => element.muted)).toBe(true);
    await page.screenshot({ path: info.outputPath('real-media-recovered-without-reimport.png') }); expect(await saved(request, project.id)).toEqual(project);
  } finally { await rm(source, { recursive: true, force: true }); }
});

test('reloads the first page of a new generation after another view rescans the same recovery task', async ({ page, request }) => {
  const source = await mkdtemp(join(tmpdir(), 'vq-recovery-generation-'));
  try {
    const project = await rpc<ProjectDocument>(request, 'project.create', { title: `恢复清单世代 ${randomUUID().slice(0, 8)}` });
    const { system } = await rpc<{ system: { dataDirectory: string } }>(request, 'workspace.summary'), database = openDatabase(system.dataDirectory), store = new DocumentStore(database);
    try {
      database.transaction(() => { for (let index = 0; index < 101; index++) { const id = `${project.id}-${index}`, path = join(system.dataDirectory, 'projects', project.id, 'assets', `${index}.png`); missingAssets.add(path); store.put('asset', id, { id, projectId: project.id, name: `待检查 ${index}`, path, kind: 'image', mimeType: 'image/png', size: 7, sha256: createHash('sha256').update('missing').digest('hex'), version: 1, createdAt: '', active: true, retained: false, provenance: '' }); } })();
    } finally { database.close(); }
    await open(page, project); let jobId = '';
    page.on('request', request => { if (request.url().endsWith('/__desktop_rpc') && request.postDataJSON()?.method === 'asset.recovery.get') jobId = request.postDataJSON().params.jobId; });
    const dialog = await recovery(page); await expect(dialog.locator('.asset-recovery__item')).toHaveCount(100); expect(jobId).toBeTruthy();
    await rpc(request, 'asset.recovery.scan', { jobId, directory: source });
    await expect.poll(async () => (await rpc<{ job: { phase: string } }>(request, 'asset.recovery.get', { jobId })).job.phase).toBe('awaiting_confirmation');
    expectedRpcFailures = [{ method: 'asset.recovery.get', error: /清单已重新扫描/ }];
    await dialog.getByRole('button', { name: '下一页素材清单', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('清单已重新扫描');
    await dialog.getByRole('button', { name: '重新读取状态', exact: true }).click(); await expect(dialog.getByText('扫描完成，请确认匹配项', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('alert')).toHaveCount(0); await expect(dialog.locator('.asset-recovery__item')).toHaveCount(100);
    await dialog.getByRole('button', { name: '下一页素材清单', exact: true }).click(); await expect(dialog.locator('.asset-recovery__item')).toHaveCount(1);
  } finally { await rm(source, { recursive: true, force: true }); }
});

test('cancels a real controlled scan and continues after an unreadable source directory', async ({ page, request }, info) => {
  const source = await mkdtemp(join(tmpdir(), 'vq-recovery-cancel-ui-')), path = join(source, 'source.svg');
  await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  const project = await rpc<ProjectDocument>(request, 'project.create', { title: `素材扫描取消 ${randomUUID().slice(0, 8)}` });
  const asset = await rpc<AssetRecord>(request, 'asset.import', { projectId: project.id, path, kind: 'image' }); await rm(asset.path); missingAssets.add(asset.path);
  const { system } = await rpc<{ system: { dataDirectory: string } }>(request, 'workspace.summary'), database = openDatabase(system.dataDirectory);
  const options: AssetRecoveryOptions = { directory: system.dataDirectory, store: new DocumentStore(database) }, manager = createAssetRecovery(options);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  // Route this flow to the real manager with a file-boundary gate, avoiding large files or fabricated progress.
  await page.route('**/__desktop_rpc', async route => {
    const input = route.request().postDataJSON();
    if (!input.method.startsWith('asset.recovery.')) { await route.continue(); return; }
    try { await route.fulfill({ json: { result: await manager.dispatch(input.method, input.params) } }); }
    catch (error) { await route.fulfill({ status: 400, json: { error: error instanceof Error ? error.message : String(error) } }); }
  });
  try {
    await open(page, project); const dialog = await recovery(page);
    await dialog.getByLabel('查找目录', { exact: true }).fill(join(source, 'does-not-exist')); await dialog.getByRole('button', { name: '扫描目录', exact: true }).click();
    await expect(dialog.getByText('恢复操作未完成', { exact: true })).toBeVisible(); await expect(dialog.getByRole('alert')).toContainText('ENOENT');
    options.failpoint = async point => { if (point === 'scan:file') { entered(); await gate; } };
    await dialog.getByLabel('查找目录', { exact: true }).fill(source); await dialog.getByRole('button', { name: '扫描目录', exact: true }).click(); await ready;
    await expect(dialog.getByText('正在扫描目录', { exact: true })).toBeVisible(); await expect(dialog.getByRole('progressbar', { name: '素材恢复进度' })).toBeVisible();
    await page.screenshot({ path: info.outputPath('real-scan-progress-with-cancel.png') });
    await dialog.getByRole('button', { name: '取消素材恢复', exact: true }).click(); release(); await expect(dialog.getByText('操作已取消', { exact: true })).toBeVisible();
    options.failpoint = undefined; await dialog.getByRole('button', { name: '扫描目录', exact: true }).click(); await expect(dialog.getByText('扫描完成，请确认匹配项', { exact: true })).toBeVisible();
    await expect(dialog.locator(`[data-asset-id="${asset.id}"]`).getByLabel(`匹配文件：${asset.name}`, { exact: true }).locator('option')).toHaveCount(1);
    await expect(readFile(asset.path)).rejects.toMatchObject({ code: 'ENOENT' }); expect(await saved(request, project.id)).toEqual(project);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); await manager.close(); database.close(); await rm(source, { recursive: true, force: true }); }
});

test('automatically recovers the selected media in both current and historical real step results', async ({ page, request }, info) => {
  const source = await mkdtemp(join(tmpdir(), 'vq-result-media-recovery-'));
  try {
    const created = await rpc<ProjectDocument>(request, 'project.create', { title: `结果媒体恢复 ${randomUUID().slice(0, 8)}` });
    await rpc(request, 'project.update', { projectId: created.id, revision: created.revision, patch: {
      shots: ['first', 'selected'].map(id => ({ id, title: id === 'first' ? '第一张' : '保留所选画面', narration: '', visualPrompt: '', durationUs: 1_000_000 })),
      workflow: { ...created.workflow, nodes: [{ id: 'assets', kind: 'assets', label: '沿用本地画面' }], edges: [] },
    } });
    const assets: AssetRecord[] = [];
    for (const [shotId, color] of [['first', '#379269'], ['selected', '#3266cc']]) {
      const path = join(source, `${shotId}.svg`); await writeFile(path, `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="${color}"/></svg>`);
      assets.push(await rpc<AssetRecord>(request, 'asset.import', { projectId: created.id, shotId, path, kind: 'image' }));
    }
    const project = await saved(request, created.id), runs: RunSummary[] = [];
    for (let index = 0; index < 2; index++) {
      const started = await rpc<{ id: string }>(request, 'run.start', { projectId: project.id }); let completed: RunSummary | undefined;
      await expect.poll(async () => { completed = await rpc<RunSummary>(request, 'run.get', { runId: started.id }); return completed.status; }).toBe('succeeded');
      runs.push(completed!);
    }
    const { system } = await rpc<{ system: { dataDirectory: string } }>(request, 'workspace.summary');
    function frozen() {
      const database = openDatabase(system.dataDirectory), store = new DocumentStore(database);
      try { return runs.map(run => ({ snapshot: store.get('run-snapshot', run.id), result: store.get('node-result', `${run.id}:assets`) })); }
      finally { database.close(); }
    }
    const baseline = frozen(), asset = assets[1]; await rm(asset.path); missingAssets.add(asset.path);
    await open(page, project); await page.getByRole('button', { name: '制作记录', exact: true }).click();
    await page.locator(`.run-card[data-run-id="${runs[1].id}"]`).getByRole('button', { name: '查看步骤', exact: true }).click();
    const detail = page.getByRole('dialog', { name: '制作步骤详情', exact: true }), current = detail.getByRole('region', { name: '本次产物', exact: true });
    await current.getByRole('combobox', { name: '预览媒体', exact: true }).selectOption(asset.id); await expect(current.getByRole('alert')).toContainText('媒体暂时无法预览');
    await detail.getByRole('button', { name: '历史产物', exact: true }).click();
    await detail.getByLabel('历史产物版本', { exact: true }).locator(`[data-run-id="${runs[0].id}"]`).click();
    const history = detail.getByRole('region', { name: '历史产物', exact: true });
    await history.getByRole('combobox', { name: '预览媒体', exact: true }).selectOption(asset.id); await expect(history.getByRole('alert')).toContainText('媒体暂时无法预览');
    const job = await rpc<{ id: string }>(request, 'asset.recovery.start', { projectId: project.id });
    await expect.poll(async () => (await rpc<{ job: { phase: string } }>(request, 'asset.recovery.get', { jobId: job.id })).job.phase).toBe('awaiting_directory');
    await rpc(request, 'asset.recovery.scan', { jobId: job.id, directory: source });
    await expect.poll(async () => (await rpc<{ job: { phase: string } }>(request, 'asset.recovery.get', { jobId: job.id })).job.phase).toBe('awaiting_confirmation');
    const pageResult = await rpc<{ items: Array<{ id: string; assetId: string; candidates: Array<{ id: string }> }> }>(request, 'asset.recovery.get', { jobId: job.id });
    const item = pageResult.items.find(item => item.assetId === asset.id); expect(item?.candidates).toHaveLength(1);
    await rpc(request, 'asset.recovery.confirm', { jobId: job.id, selections: [{ itemId: item!.id, candidateId: item!.candidates[0].id }] });
    await expect.poll(async () => (await rpc<{ job: { phase: string } }>(request, 'asset.recovery.get', { jobId: job.id })).job.phase).toBe('succeeded');
    for (const result of [current, history]) {
      await expect(result.getByRole('alert')).toHaveCount(0);
      const image = result.getByRole('img', { name: asset.name, exact: true }); await expect(image).toBeVisible();
      expect(await image.evaluate((element: HTMLImageElement) => ({ ready: element.complete && element.naturalWidth === 160, path: new URL(element.src).searchParams.get('path'), retried: Number(new URL(element.src).searchParams.get('availability')) > 0 }))).toEqual({ ready: true, path: asset.path, retried: true });
      await expect(result.getByRole('combobox', { name: '预览媒体', exact: true })).toHaveValue(asset.id);
    }
    expect(await saved(request, project.id)).toEqual(project); expect(frozen()).toEqual(baseline);
    for (const run of runs) expect(await rpc(request, 'run.get', { runId: run.id })).toEqual(run);
    await page.screenshot({ path: info.outputPath('recovered-current-and-historical-result-media.png') });
  } finally { await rm(source, { recursive: true, force: true }); }
});
