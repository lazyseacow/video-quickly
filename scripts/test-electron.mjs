import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { _electron, expect } from '@playwright/test';
import { findElectronRuntime } from './electron-runtime-process.mjs';
import { verifyNativeMediaExtensions } from './native-media-extensions.mjs';
import { verifyNativeTransitions } from './native-transitions.mjs';
import { verifyNativeTransitionLoading } from './native-transition-loading.mjs';
import { verifyNativeTransitionCache } from './native-transition-cache.mjs';
import { verifyNativeCompactDialogs } from './native-compact-dialogs.mjs';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'src');
const fromDesktop = createRequire(join(desktop, 'package.json'));
const packaged = process.argv.includes('--packaged');
const compact = process.argv.includes('--compact');
const artifacts = process.env.VIDEO_QUICKLY_ELECTRON_ARTIFACT_DIR ?? join(root, '.generated/electron-artifacts');
const reportPath = process.env.VIDEO_QUICKLY_ELECTRON_REPORT ?? join(root, '.generated/electron-results.json');
const fixture = await mkdtemp(join(tmpdir(), 'vq-electron-native-'));
const workspace = join(fixture, '中文 workspace');
const profile = join(fixture, '中文 Chromium profile');
const checks = {};
const errors = [];
const windows = [];
let nativeTextInputTypes;
let gettingStartedHelpBounds;
let previewFullscreenTiming;
let application;
let page;
let runtimePid;
let actualElectronVersion;
let distributionScope = packaged ? 'unverified-package' : 'source-desktop';
let fixtureFfmpeg = process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
let credentialModel;
const testSecret = `isolated-electron-fixture-${randomUUID()}`;
let expectedSecret = testSecret;
const credentialReferences = new Set();
let credentialRequests = 0;
let credentialContacts = 0;
const credentialServer = createServer({ keepAliveTimeout: 0 }, (request, response) => {
  credentialContacts++;
  if (request.headers.authorization !== `Bearer ${expectedSecret}`) { response.writeHead(401); response.end(); return; }
  credentialRequests++;
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ data: [{ id: 'isolated-native-fixture' }] }));
});
credentialServer.listen(0, '127.0.0.1');
await once(credentialServer, 'listening');
const environment = { ...process.env, VIDEO_QUICKLY_DATA_DIR: workspace, VIDEO_QUICKLY_ELECTRON_USER_DATA: profile };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.VIDEO_QUICKLY_DEV_URL;
if (packaged) {
  for (const key of ['VIDEO_QUICKLY_FFMPEG', 'VIDEO_QUICKLY_FFPROBE', 'VIDEO_QUICKLY_MEDIA_DIR']) delete environment[key];
  if (process.platform === 'darwin') environment.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
}
await mkdir(artifacts, { recursive: true });
await mkdir(workspace, { recursive: true });
function executablePath() {
  if (process.env.VIDEO_QUICKLY_ELECTRON_EXECUTABLE) {
    assert.equal(packaged, true, 'An executable override is only valid for packaged acceptance');
    assert.ok(isAbsolute(process.env.VIDEO_QUICKLY_ELECTRON_EXECUTABLE), 'The packaged test executable must use an absolute path');
    return process.env.VIDEO_QUICKLY_ELECTRON_EXECUTABLE;
  }
  if (!packaged) return fromDesktop('electron');
  const directory = join(root, '.generated/electron-release');
  if (process.platform === 'win32') return join(directory, 'win-unpacked/video-quickly.exe');
  if (process.platform === 'darwin') return join(directory, `mac${process.arch === 'arm64' ? '-arm64' : ''}/Video Quickly.app/Contents/MacOS/Video Quickly`);
  return join(directory, 'linux-unpacked/video-quickly');
}
async function launch() {
  const executable = executablePath();
  assert.ok(existsSync(executable), 'Electron application must be built or installed before native testing');
  application = await _electron.launch({ executablePath: executable, args: packaged ? [] : [desktop], env: environment, timeout: 30_000 });
  actualElectronVersion = await application.evaluate(() => process.versions.electron);
  assert.equal(actualElectronVersion, fromDesktop('electron/package.json').version);
  if (packaged) {
    const resources = await application.evaluate(() => process.resourcesPath);
    const sidecar = join(resources, 'sidecar'), suffix = process.platform === 'win32' ? '.exe' : '';
    const node = join(sidecar, `node${suffix}`), media = join(sidecar, 'media');
    for (const tool of [node, join(media, `ffmpeg${suffix}`), join(media, `ffprobe${suffix}`)]) {
      const metadata = await lstat(tool);
      assert.ok(metadata.isFile() && !metadata.isSymbolicLink(), 'Packaged Node, FFmpeg and FFprobe must be ordinary bundled files');
    }
    const info = JSON.parse(await readFile(join(sidecar, 'runtime-info.json'), 'utf8'));
    const provenance = JSON.parse(await readFile(join(media, 'provenance.json'), 'utf8'));
    assert.equal(info.portability, 'bundled'); assert.equal(info.platform, process.platform); assert.equal(info.architecture, process.arch);
    assert.equal(provenance.verified, true);
    assert.equal((await execute(node, ['--version'], { env: environment })).stdout.trim(), info.nodeVersion);
    if (process.platform === 'darwin') {
      assert.equal(info.nodeProvenance?.verified, true);
      assert.equal(provenance.platform, 'darwin'); assert.equal(provenance.architecture, process.arch);
    }
    distributionScope = 'bundled-runtime-and-media';
    fixtureFfmpeg = join(media, `ffmpeg${suffix}`);
    checks.bundledTools = true;
  }
  observePage(await application.firstWindow());
  await expect(page).toHaveTitle(/Video Quickly/);
  await expect(page.locator('.workspace-shell')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => rpc('runtime.status'), { timeout: 20_000 }).toMatchObject({ state: 'ready' });
  const records = (await readFile(join(workspace, 'logs', 'desktop.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const startup = records.slice(records.findLastIndex(record => record.event === 'desktop.starting'));
  assert.equal(startup.some(record => record.event === 'rpc.rejected' && record.reason === 'not_connected'), false, 'Startup requests must wait for runtime readiness');
  checks.startupReadiness = true;
  assert.equal(new URL(page.url()).protocol, 'video-quickly:');
  assert.equal(new URL(page.url()).hostname, 'app');
  await inspectWindow();
  if (!checks.gettingStarted) {
    const project = await verifyGettingStarted();
    await verifyGenericWorkflow(project);
    await verifyStoryboardTimeline(project);
    if (compact) await verifyNativeCompactDialogs({ page, rpc, openProject, fixture, artifacts, ffmpegPath: fixtureFfmpeg, environment: packaged ? environment : process.env, checks });
    await verifyNativeMediaExtensions({ page, rpc, openProject, fixture, artifacts, ffmpegPath: fixtureFfmpeg, environment: packaged ? environment : process.env, checks });
    await verifyNativeTransitions({ page, rpc, openProject, fixture, artifacts, ffmpegPath: fixtureFfmpeg, environment: packaged ? environment : process.env, checks });
    await verifyNativeTransitionLoading({ page, rpc, openProject, fixture, artifacts, ffmpegPath: fixtureFfmpeg, environment: packaged ? environment : process.env, checks });
    await verifyNativeTransitionCache({ page, rpc, openProject, fixture, artifacts, ffmpegPath: fixtureFfmpeg, environment: packaged ? environment : process.env, checks });
  } else {
    assert.equal(await page.evaluate(() => localStorage.getItem('vq-onboarding-v1')), 'done');
    await expect(page.getByRole('dialog', { name: '使用指南', exact: true })).toHaveCount(0);
  }
  return page;
}
async function verifyGenericWorkflow(project) {
  const character = await rpc('character.save', { character: { name: '原生制作角色', description: '固定外形与服装', referenceAssetIds: [] } });
  const snapshot = await rpc('workspace.snapshot');
  assert.equal(project.workflow.id, 'native-video');
  assert.equal(project.workflow.production.subtitleMode, 'off');
  assert.equal(project.workflow.nodes.some(node => ['research', 'review'].includes(node.kind) || node.requiresReview), false);
  assert.equal(project.workflow.nodes.length, 7);
  assert.equal(project.workflow.stages.length, 4);
  const guidance = page.getByRole('region', { name: '制作指引', exact: true });
  const stageLabels = ['策划与分镜', '素材与配音', '剪辑与动画', '审阅与导出'];
  const progress = guidance.getByRole('list', { name: '制作阶段进度', exact: true });
  await expect(progress.getByRole('button', { name: /^打开阶段：/ })).toHaveCount(4);
  await expect(progress.locator('.workbench-guide__step-copy > strong')).toHaveText(stageLabels);
  for (const label of stageLabels) {
    const trigger = progress.getByRole('button', { name: `打开阶段：${label}`, exact: true });
    await expect(trigger).toHaveAttribute('data-state', 'pending');
    await expect(trigger).toContainText('尚未制作');
    await trigger.focus(); await trigger.press('Enter');
    const records = page.getByRole('dialog', { name: '本次制作', exact: true });
    await expect(records).toBeVisible();
    await expect(records).toContainText('尚未开始制作');
    await expect(records.getByRole('button', { name: '制作设置', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(records).toHaveCount(0); await expect(trigger).toBeFocused();
  }
  const settingsButton = page.getByRole('button', { name: '制作设置', exact: true });
  await expect(settingsButton).toHaveCount(1); await settingsButton.click();
  const dialog = page.getByRole('dialog', { name: '制作设置', exact: true });
  const steps = dialog.getByRole('navigation', { name: '制作设置步骤', exact: true });
  await expect(steps.getByRole('button')).toHaveText(['1创作要求', '2模型与素材', '3声音与成片', '4确认保存']);
  await expect(dialog.getByRole('region', { name: '步骤指引', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('checkbox', { name: /人工审阅|人工审核/ })).toHaveCount(0);
  await dialog.getByLabel('简报内容', { exact: true }).fill('未提交的项目配置');
  await expect(dialog.getByLabel('项目原文', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('画面比例', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '应用系列模板', exact: true })).toHaveCount(0);
  const roles = dialog.getByRole('button', { name: /^角色与连续性/ });
  const entities = dialog.getByRole('button', { name: /^人物、场景与道具/ });
  const entityPosition = () => entities.evaluate(element => {
    const { x, y, width, height } = element.getBoundingClientRect();
    const scrollTop = element.closest('.production-settings__content')?.scrollTop ?? 0;
    return { x, y: y + scrollTop, width, height };
  });
  await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '1');
  const initialPosition = await entityPosition();
  await roles.press('Enter');
  await expect(dialog.getByRole('group', { name: '项目角色池', exact: true })).toBeVisible();
  await expect(dialog.getByRole('group', { name: '项目角色池', exact: true }).getByRole('checkbox', { name: character.name, exact: true })).not.toBeChecked();
  await dialog.getByRole('textbox', { name: '连续性要求', exact: true }).fill('同一场景与固定服装');
  assert.deepEqual(await entityPosition(), initialPosition);
  await page.keyboard.press('Escape');
  await expect(roles).toBeFocused();
  await expect(dialog.getByText('高级设置', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText('剪辑 Agent 设置', { exact: true })).toBeVisible();
  await dialog.getByLabel('风格内容', { exact: true }).fill('未提交的项目风格');
  await steps.getByRole('button', { name: '模型与素材', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: '文本模型', exact: true })).toHaveValue('');
  await expect(dialog.getByRole('combobox', { name: '视频模型', exact: true })).toHaveValue('');
  await expect(dialog.getByRole('combobox', { name: '图片模型', exact: true })).toHaveCount(0);
  const continuation = dialog.getByRole('switch', { name: '尾帧续镜', exact: true });
  await expect(continuation).toBeChecked();
  await continuation.press('Space');
  await expect(continuation).not.toBeChecked();
  await expect(dialog.getByText('高级设置', { exact: true })).toHaveCount(0);
  await steps.getByRole('button', { name: '创作要求', exact: true }).click();
  await expect(dialog.getByLabel('简报内容', { exact: true })).toHaveValue('未提交的项目配置');
  await expect(dialog.getByLabel('风格内容', { exact: true })).toHaveValue('未提交的项目风格');
  await page.screenshot({ path: join(artifacts, 'desktop-workflow-stage.png') });
  await steps.getByRole('button', { name: '确认保存', exact: true }).click();
  await expect(dialog.getByText('各镜头独立生成', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '保存设置', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '保存并开始制作', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.deepEqual((await rpc('workspace.snapshot')).projects, snapshot.projects, 'Canceling the configuration wizard must preserve the project');
  await expect(page.getByRole('button', { name: '添加模型连接', exact: true })).toHaveCount(0);
  await expect(settingsButton).toHaveCount(1); await settingsButton.click();
  const settings = page.getByRole('dialog', { name: '制作设置', exact: true });
  await expect(settings.getByRole('navigation', { name: '制作设置步骤', exact: true }).getByRole('button', { name: '确认保存', exact: true })).toHaveAttribute('aria-current', 'step');
  await expect(settings.getByLabel('画面引用编号', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: join(artifacts, 'desktop-project-settings.png') });
  await settings.getByRole('button', { name: '关闭对话框', exact: true }).click(); await expect(settings).toHaveCount(0);
  await expect(page.locator('.inspector').getByRole('heading', { name: '镜头属性', exact: true })).toBeVisible();
  await expect(page.locator('.inspector')).not.toContainText(/待核验|已核验|引用已失效/);
  assert.deepEqual((await rpc('workspace.snapshot')).projects, snapshot.projects, 'Inspecting global settings must preserve the project');
  const contactsBeforePreview = credentialContacts;
  await page.getByRole('button', { name: 'Skill 工作室', exact: true }).click();
  await page.getByRole('button', { name: '提示词实验与模板', exact: true }).click();
  const launcher = page.getByRole('dialog', { name: '选择提示词实验任务', exact: true });
  await launcher.getByLabel('实验项目', { exact: true }).selectOption(project.id);
  await launcher.getByLabel('实验任务', { exact: true }).selectOption('brief');
  await launcher.getByRole('button', { name: '打开提示词实验', exact: true }).click();
  const experiment = page.getByRole('dialog', { name: '提示词实验', exact: true });
  await experiment.getByRole('textbox', { name: '实验提示词', exact: true }).fill('桌面包中的独立实验提示词');
  await experiment.getByRole('button', { name: '离线预览', exact: true }).click();
  await expect(experiment.getByLabel('最终提示词', { exact: true })).toContainText('桌面包中的独立实验提示词');
  await experiment.getByRole('button', { name: '保存实验草稿', exact: true }).click();
  await expect(experiment.getByText('实验草稿已保存。', { exact: true })).toBeVisible();
  const sessions = await rpc('promptSession.list', { projectId: project.id });
  assert.equal(sessions.items.length, 1); assert.equal(sessions.items[0].draft.projectRevision, project.revision);
  const template = await rpc('promptLibrary.save', { name: '原生提示词模板', kind: 'template', prompt: '原生固定版本', nodeKinds: ['brief'] });
  await rpc('promptLibrary.save', { id: template.id, revision: template.revision, name: template.name, kind: 'template', prompt: '新版本', nodeKinds: template.nodeKinds });
  assert.equal((await rpc('promptLibrary.get', { id: template.id, version: 1 })).prompt, '原生固定版本');
  await experiment.locator('.prompt-workbench__body').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: join(artifacts, 'desktop-prompt-experiment.png') });
  await experiment.getByRole('button', { name: '关闭', exact: true }).click(); await expect(experiment).toHaveCount(0);
  await launcher.getByRole('button', { name: '取消', exact: true }).click(); await expect(launcher).toHaveCount(0);
  assert.equal((await projectDocument(project.id)).revision, project.revision); assert.equal(credentialContacts, contactsBeforePreview);
  await openProject(project.title);
  await expect(page.getByRole('textbox', { name: '项目名称', exact: true })).toHaveValue(project.title);
  checks.promptOfflinePreview = true; checks.promptSessionPersistence = true; checks.promptTemplateVersions = true; checks.promptConfigurationIsolation = true;
  checks.projectSettings = true;
  checks.genericWorkflow = true;
}
async function verifyStoryboardTimeline(originalProject) {
  const title = '原生分镜与时间轴验收';
  const project = await rpc('project.create', { title, profile: { width: 320, height: 180, frameRate: { numerator: 30, denominator: 1 } } });
  const shots = Array.from({ length: 54 }, (_, index) => ({
    id: `native-timeline-${index}`, title: `待生成镜头 ${index + 1}`, narration: '', visualPrompt: '',
    durationUs: index % 3 === 0 ? 30_000_000 : 500_000,
    animation: { transition: 'cut', panX: index % 2 ? .2 : 0 },
  }));
  await rpc('project.update', { projectId: project.id, revision: project.revision, patch: { shots } });
  await openProject(title);
  const timeline = page.getByRole('region', { name: '项目时间轴', exact: true });
  const clips = timeline.locator('.timeline-clip--video');
  const preview = page.locator('.preview-frame canvas');
  await expect(clips).toHaveCount(shots.length);
  await expect.poll(() => clips.evaluateAll(elements => elements.every((element, index) => {
    const bounds = element.getBoundingClientRect();
    const previous = elements[index - 1]?.getBoundingClientRect();
    return bounds.width >= 71.99 && (!previous || bounds.left - previous.right >= 3.98);
  }))).toBe(true);
  await expect(preview).toHaveAttribute('data-rendered-time-us', '0');
  await expect(page.getByRole('region', { name: '视频预览播放器', exact: true })).toContainText('默认画面');
  const firstPicture = await preview.evaluate(canvas => canvas.toDataURL());
  await page.screenshot({ path: join(artifacts, 'desktop-storyboard-timeline.png') });

  await page.locator('.outline-shot').last().click();
  const lastStartUs = shots.slice(0, -1).reduce((total, shot) => total + shot.durationUs, 0);
  await expect(timeline.getByRole('slider', { name: '预览播放位置', exact: true })).toHaveAttribute('aria-valuenow', String(lastStartUs / 1_000));
  await expect(preview).toHaveAttribute('data-rendered-time-us', String(lastStartUs));
  assert.equal(await preview.evaluate(canvas => canvas.toDataURL()), firstPicture);
  await expect.poll(() => timeline.locator('.timeline-scroll').evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  await expect(clips.last()).toBeInViewport({ ratio: .9 });
  await page.screenshot({ path: join(artifacts, 'desktop-storyboard-timeline-end.png') });
  checks.storyboardTimeline = true;
  await openProject(originalProject.title);
}
async function verifyGettingStarted() {
  const guide = page.getByRole('dialog', { name: '使用指南', exact: true });
  const heading = guide.getByRole('heading');
  const highlighted = page.locator('.driver-active-element');
  async function activeTarget() {
    await expect(guide).toBeVisible();
    await expect(guide).toBeInViewport({ ratio: 1 });
    await expect(highlighted).toHaveCount(1);
    await expect(highlighted).toBeVisible();
    await expect(highlighted).toBeInViewport();
    await expect(highlighted).not.toHaveAttribute('id', 'driver-dummy-element');
    await expect(highlighted).toHaveAttribute('data-guide', /\S+/);
    return highlighted.getAttribute('data-guide');
  }
  async function nextStep() {
    const previousTitle = await heading.innerText();
    await guide.getByRole('button', { name: '下一步', exact: true }).click();
    await expect(heading).not.toHaveText(previousTitle);
  }
  await expect(heading).toHaveText('新建创作项目');
  assert.equal(await activeTarget(), 'create-project');
  assert.equal(await page.evaluate(() => localStorage.getItem('vq-onboarding-v1')), null);
  const empty = await rpc('workspace.snapshot');
  assert.deepEqual(empty.projects, []);
  const library = await rpc('seriesTemplate.list');
  assert.equal(library.items.length, 3);
  assert.ok(library.items.every(template => template.creationDefaults?.skillIds.length === 1
    && empty.skills.some(skill => skill.enabled && skill.id === template.creationDefaults.skillIds[0])));
  assert.equal(empty.assets.length, 3);
  for (const asset of empty.assets) {
    assert.ok(!asset.projectId && asset.kind === 'image' && asset.provenance.includes('CC0'));
    const response = await page.evaluate(async path => {
      const result = await fetch(await window.videoQuickly.assetUrl(path));
      return { status: result.status, bytes: (await result.arrayBuffer()).byteLength };
    }, asset.path);
    assert.deepEqual(response, { status: 200, bytes: asset.size });
  }
  checks.builtInDramaTemplates = true;
  await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
  await expect(page.getByLabel('搜索项目', { exact: true })).toBeVisible();
  checks.emptyWorkspaceStartup = true;
  await page.screenshot({ path: join(artifacts, 'desktop-getting-started.png') });

  await highlighted.click();
  const create = page.getByRole('dialog', { name: '新建视频项目', exact: true });
  await expect(create).toBeVisible();
  await expect(guide).toHaveCount(0);
  await expect(page.locator('.driver-overlay')).toHaveCount(0);
  await create.getByLabel('项目名称', { exact: true }).fill('取消原生导览中的项目');
  await create.getByLabel('创意简报', { exact: true }).fill('确认高亮操作打开的表单可以正常输入。');
  await page.keyboard.press('Escape');
  await expect(create).toHaveCount(0);
  await expect(heading).toHaveText('新建创作项目');
  assert.equal(await activeTarget(), 'create-project');
  assert.equal(await page.evaluate(() => localStorage.getItem('vq-onboarding-v1')), null);
  assert.deepEqual((await rpc('workspace.summary')).projects, []);

  const projectTitle = '原生流程验收项目';
  await highlighted.click();
  await create.getByLabel('项目名称', { exact: true }).fill(projectTitle);
  await create.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(create).toHaveCount(0);
  await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(projectTitle);
  const created = (await rpc('workspace.snapshot')).projects[0];
  assert.equal(created.title, projectTitle);
  const project = await rpc('project.update', { projectId: created.id, revision: created.revision, patch: {
    shots: [{ id: 'guide-shot', title: '导览首镜头', narration: '原生导览播放验收。', visualPrompt: '固定画面', durationUs: 5_000_000 }],
  } });
  await expect(page.locator('.workbench .outline-shot')).toHaveCount(1);
  const before = await rpc('workspace.snapshot');

  let reachedEnd = false, contextCaptured = false;
  for (let step = 0; step < 20; step++) {
    const target = await activeTarget();
    assert.equal(await page.evaluate(() => localStorage.getItem('vq-onboarding-v1')), null);
    if (!contextCaptured && ['preview', 'timeline'].includes(target)) {
      await page.screenshot({ path: join(artifacts, 'desktop-getting-started-context.png') });
      contextCaptured = true;
    }
    if (!await guide.getByRole('button', { name: '下一步', exact: true }).count()) { reachedEnd = true; break; }
    await nextStep();
  }
  assert.equal(reachedEnd, true, 'The getting started tour must finish within twenty steps');
  assert.equal(contextCaptured, true, 'The native tour must highlight a real preview or timeline');
  assert.equal(await activeTarget(), 'help');
  await guide.getByRole('button', { name: '完成引导', exact: true }).click();
  await expect(guide).toHaveCount(0);
  assert.equal(await page.evaluate(() => localStorage.getItem('vq-onboarding-v1')), 'done');

  await page.reload();
  await expect(page.locator('.workspace-shell')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => rpc('runtime.status'), { timeout: 20_000 }).toMatchObject({ state: 'ready' });
  await expect(guide).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
  await openProject(projectTitle);
  const help = page.getByRole('button', { name: '设置', exact: true });
  async function reopenGuide() {
    await help.click();
    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: '使用指南', exact: true }).click();
    await expect(settings).toHaveCount(0);
  }
  await expect(help).toBeVisible();
  await expect(help).toBeInViewport({ ratio: 1 });
  gettingStartedHelpBounds = await help.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
  });
  assert.ok(gettingStartedHelpBounds.left >= 0 && gettingStartedHelpBounds.top >= 0 && gettingStartedHelpBounds.right <= gettingStartedHelpBounds.viewportWidth && gettingStartedHelpBounds.bottom <= gettingStartedHelpBounds.viewportHeight, 'The getting started entry must fit inside the native viewport');
  await reopenGuide();
  await expect(heading).toHaveText('新建创作项目');
  assert.equal(await activeTarget(), 'create-project');
  let reachedPreview = false;
  for (let step = 0; step < 20; step++) {
    if (await activeTarget() === 'preview') { reachedPreview = true; break; }
    await nextStep();
  }
  assert.equal(reachedPreview, true, 'The manual tour must reach playback within twenty steps');
  const play = highlighted.getByRole('button', { name: '播放预览', exact: true });
  await expect(play).toBeEnabled({ timeout: 30_000 });
  await play.click();
  await expect(heading).toHaveText('安排镜头节奏');
  assert.equal(await activeTarget(), 'timeline');
  await expect(page.getByRole('button', { name: '暂停预览', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const ruler = highlighted.getByRole('slider', { name: '预览播放位置', exact: true });
  await ruler.scrollIntoViewIfNeeded();
  const beforeSeek = Number(await ruler.getAttribute('aria-valuenow'));
  const maximum = Number(await ruler.getAttribute('aria-valuemax'));
  const rulerBounds = await ruler.boundingBox();
  assert.ok(maximum > 0 && rulerBounds?.width && rulerBounds.height, 'Interactive native acceptance requires a real seekable timeline');
  await ruler.click({ position: { x: rulerBounds.width * (beforeSeek > maximum / 2 ? .2 : .8), y: rulerBounds.height / 2 } });
  await expect.poll(async () => Number(await page.getByRole('slider', { name: '预览播放位置', exact: true }).getAttribute('aria-valuenow'))).not.toBe(beforeSeek);
  await expect(heading).toHaveText(/^(展开属性面板|编辑属性)$/);
  assert.ok(['inspector-toggle', 'inspector'].includes(await activeTarget()), 'A completed user seek must advance to the next available property step');
  await page.keyboard.press('Escape');
  await expect(guide).toHaveCount(0);
  await expect(help).toBeFocused();
  const after = await rpc('workspace.snapshot');
  for (const field of ['projects', 'models', 'skills', 'runs', 'assets']) assert.deepEqual(after[field], before[field], `Getting started must not change workspace ${field}`);
  checks.gettingStartedInteractive = true;
  checks.gettingStarted = true;
  return project;
}
function observePage(next) {
  page = next;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
}
async function inspectWindow() {
  const native = await application.evaluate(({ BrowserWindow, screen }, compact) => {
    const window = BrowserWindow.getAllWindows()[0];
    const minimumSize = window.getMinimumSize();
    if (compact) window.setSize(...minimumSize);
    return { visible: window.isVisible(), bounds: window.getBounds(), contentBounds: window.getContentBounds(), workArea: screen.getDisplayMatching(window.getBounds()).workArea, minimumSize };
  }, compact);
  assert.equal(native.visible, true, 'Native acceptance requires a shown Electron window');
  if (compact) {
    assert.deepEqual([native.bounds.width, native.bounds.height], native.minimumSize);
    await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: native.contentBounds.width, height: native.contentBounds.height });
    assert.equal((await page.getByRole('complementary', { name: '工作空间导航', exact: true }).boundingBox()).width, 52);
  }
  windows.push({ ...native, viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })) });
}
async function openProject(title) {
  const navigation = page.getByRole('complementary', { name: '工作空间导航', exact: true });
  await navigation.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.getByLabel('搜索项目', { exact: true }).fill('');
  await page.getByRole('button', { name: '全部项目', exact: true }).click();
  const project = page.locator('.project-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await expect(project).toBeVisible();
  await project.getByRole('button', { name: '继续创作', exact: true }).click();
}
function rpc(method, params = {}) { return page.evaluate(({ method, params }) => window.videoQuickly.rpc(method, params), { method, params }); }
async function findRuntime() {
  return findElectronRuntime(application, workspace, { onDiagnostics: diagnostics => writeFile(join(artifacts, 'runtime-process-diagnostics.json'), JSON.stringify(diagnostics, null, 2)) });
}
function processAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function close(expectedConfirmations) {
  if (!application) return;
  // Substitute only the native dialog's user decision. The production window
  // listener and quit ordering must remain responsible for approving departure.
  const confirmationLog = join(fixture, `quit-${randomUUID()}.jsonl`);
  await application.evaluate(({ dialog }, path) => {
    dialog.showMessageBoxSync = (_owner, options) => { process.getBuiltinModule('fs').appendFileSync(path, JSON.stringify({ buttons: options.buttons }) + '\n'); return 1; };
  }, confirmationLog);
  await application.close(); application = undefined;
  if (runtimePid) await expect.poll(() => processAlive(runtimePid), { timeout: 10_000 }).toBe(false);
  if (expectedConfirmations !== undefined) {
    const decisions = await readFile(confirmationLog, 'utf8').then(value => value.trim().split('\n').filter(Boolean), error => { if (error.code === 'ENOENT') return []; throw error; });
    assert.equal(decisions.length, expectedConfirmations, 'One departure must not ask for the same unsaved edits twice');
  }
}
async function projectDocument(id) { return (await rpc('project.get', { projectId: id })).project; }
async function cleanupCredentialReferences() {
  if (!credentialReferences.size || !application) return;
  const absent = await application.evaluate(async ({ app }, references) => {
    const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
    const { AsyncEntry } = load('@napi-rs/keyring');
    for (const reference of references) {
      const entry = new AsyncEntry('video-quickly-electron', reference);
      await entry.deleteCredential();
      if (await entry.getPassword() !== null) return false;
    }
    return true;
  }, [...credentialReferences]);
  assert.equal(absent, true, 'Every credential created by this isolated fixture must be removed');
  credentialReferences.clear();
}
try {
  await launch();
  runtimePid = await findRuntime();
  const summary = await rpc('workspace.summary');
  assert.equal(summary.system.dataDirectory, workspace);
  assert.equal(summary.system.mode, 'desktop');
  assert.equal(await page.evaluate(() => window.videoQuickly.platform), process.platform);
  const sandbox = await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process, bridge: typeof window.videoQuickly.rpc }));
  assert.deepEqual(sandbox, { require: 'undefined', process: 'undefined', bridge: 'function' });
  await assert.rejects(rpc('host.secret.get', { key: 'not-a-real-key' }), /桌面请求无效/);
  checks.nativeBridge = true;
  checks.sandbox = true;
  const confirmationModel = await rpc('model.save', { model: { name: '原生确认弹窗验收', provider: 'openai-compatible', connectionType: 'text', capabilities: ['text'], model: 'confirmation-fixture', baseUrl: 'http://127.0.0.1:1/v1' } });
  await page.getByRole('button', { name: '模型连接', exact: true }).click();
  const removeConnection = page.getByRole('button', { name: `移除“${confirmationModel.name}”`, exact: true });
  await removeConnection.click();
  const confirmation = page.getByRole('alertdialog', { name: '移除模型连接？', exact: true });
  await expect(confirmation.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(confirmation).toHaveCount(0);
  assert.equal((await rpc('workspace.summary')).models.some(model => model.id === confirmationModel.id), true);
  await removeConnection.click(); await confirmation.getByRole('button', { name: '确认移除', exact: true }).click();
  await expect(removeConnection).toHaveCount(0);
  assert.equal((await rpc('workspace.summary')).models.some(model => model.id === confirmationModel.id), false);
  checks.destructiveConfirmation = true;
  const trayState = await application.evaluate(({ app, BrowserWindow, nativeImage }) => {
    const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
    const { tray, trayMenu } = load('./electron/main.mjs');
    const window = BrowserWindow.getAllWindows()[0];
    const iconName = process.platform === 'darwin' ? 'trayTemplate.png' : process.platform === 'win32' ? 'icon.ico' : '32x32.png';
    const icon = nativeImage.createFromPath(app.getAppPath() + '/build/icons/' + iconName);
    window.hide();
    trayMenu.getMenuItemById('show-main').click();
    return { alive: !tray.isDestroyed(), iconLoaded: !icon.isEmpty(), visible: window.isVisible(), labels: trayMenu.items.map(item => item.label) };
  });
  assert.deepEqual(trayState, { alive: true, iconLoaded: true, visible: true, labels: ['显示主窗口', '退出 Video Quickly'] });
  checks.tray = true;
  const senderDenied = await application.evaluate(async ({ BrowserWindow, app }) => {
    const other = new BrowserWindow({ show: false, webPreferences: { preload: app.getAppPath() + '/electron/preload.cjs', contextIsolation: true, sandbox: true, nodeIntegration: false } });
    try {
      await other.loadURL('video-quickly://app/');
      if (process.platform === 'darwin') {
        const denied = await other.webContents.executeJavaScript("window.videoQuickly.waitForNativeFullscreenEntry().then(() => false, error => error.message.includes('不允许此页面调用桌面功能'))");
        if (!denied) return false;
      }
      return await other.webContents.executeJavaScript("window.videoQuickly.rpc('workspace.summary',{}).then(()=>false,()=>true)");
    } finally { other.destroy(); }
  });
  assert.equal(senderDenied, true); checks.senderBoundary = true;
  credentialModel = await rpc('model.save', { model: { name: '隔离系统凭据验收', provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${credentialServer.address().port}/v1`, model: 'isolated-native-fixture', connectionType: 'text', capabilities: ['text'], enabled: false }, secret: testSecret });
  assert.equal(credentialModel.hasSecret, true);
  credentialReferences.add(credentialModel.credentialRef);
  assert.equal((await rpc('model.test', { modelId: credentialModel.id })).connected, true);
  assert.equal(credentialRequests, 1);
  checks.nativeCredentialWriteRead = true;

  let project = await rpc('project.create', { title: 'Electron 原生功能验收', profile: { width: 320, height: 180, frameRate: { numerator: 30, denominator: 1 }, fitMode: 'contain', previewScale: .5 } });
  project = await rpc('project.update', { projectId: project.id, revision: project.revision, patch: { shots: [{ id: 'native-shot', title: '原生镜头', narration: '', visualPrompt: '', durationUs: 1_000_000 }] } });
  await openProject(project.title);
  const title = page.getByLabel('镜头标题', { exact: true });
  await expect(title).toHaveValue('原生镜头');
  await title.focus();
  await title.press('ControlOrMeta+a');
  await page.keyboard.insertText('Electron 原生编辑');
  await expect(title).toHaveValue('Electron 原生编辑');
  await page.getByRole('button', { name: '保存镜头', exact: true }).click();
  await expect.poll(async () => (await projectDocument(project.id)).shots[0].title).toBe('Electron 原生编辑');
  const undo = page.getByRole('button', { name: '撤销', exact: true }), redo = page.getByRole('button', { name: '重做', exact: true });
  // A committed RPC may still be awaiting its reply in the renderer. History
  // shortcuts must wait until the UI leaves that saving state and owns focus.
  await expect(undo).toBeEnabled(); await undo.focus(); await expect(undo).toBeFocused();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(title).toHaveValue('原生镜头');
  await expect.poll(async () => (await projectDocument(project.id)).shots[0].title).toBe('原生镜头');
  await expect(redo).toBeEnabled(); await redo.focus(); await expect(redo).toBeFocused();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(title).toHaveValue('Electron 原生编辑');
  await expect.poll(async () => (await projectDocument(project.id)).shots[0].title).toBe('Electron 原生编辑');
  checks.editHistory = true;

  await expect(page.getByRole('button', { name: '撤销', exact: true })).toHaveAttribute('title', new RegExp(`${process.platform === 'darwin' ? '⌘' : 'Ctrl'} Z`));
  checks.platformShortcutHints = true;
  await page.getByRole('button', { name: '导入画面', exact: true }).click();
  const importDialog = page.getByRole('dialog'), pathInput = importDialog.getByRole('textbox', { name: '图片文件路径', exact: true });
  await pathInput.fill('native-input');
  await pathInput.press('End'); await expect(pathInput).toBeFocused();
  const inputEvents = await pathInput.evaluateHandle(input => {
    const types = [];
    input.addEventListener('input', event => { if (event instanceof InputEvent) types.push(event.inputType); });
    return types;
  });
  // Sequential key events need not share one native undo group. Insert one
  // editing transaction before checking the operating system's shortcuts.
  await page.keyboard.insertText('-edited');
  await expect(pathInput).toHaveValue('native-input-edited');
  await pathInput.press('ControlOrMeta+z'); await expect(pathInput).toHaveValue('native-input');
  await pathInput.press(process.platform === 'win32' ? 'Control+y' : 'ControlOrMeta+Shift+z'); await expect(pathInput).toHaveValue('native-input-edited');
  await expect(pathInput).toBeFocused();
  nativeTextInputTypes = await inputEvents.jsonValue(); await inputEvents.dispose();
  assert.deepEqual(nativeTextInputTypes, ['insertText', 'historyUndo', 'historyRedo']);
  await pathInput.press('ControlOrMeta+a');
  assert.deepEqual(await pathInput.evaluate(element => [element.selectionStart, element.selectionEnd]), [0, 'native-input-edited'.length]);
  await importDialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await projectDocument(project.id)).shots[0].title, 'Electron 原生编辑');
  checks.nativeTextEditing = true;

  const video = join(fixture, '中文 原生媒体.mp4');
  await execute(fixtureFfmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=1', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', video], { env: packaged ? environment : process.env });
  // Native dialogs themselves are OS UI; this substitutes only the user's
  // selection, while exercising real preload -> IPC -> dialog argument handling.
  await application.evaluate(({ dialog }, path) => {
    globalThis.__vqFileDialogs = [];
    dialog.showOpenDialog = async (_owner, options) => { globalThis.__vqFileDialogs.push(options); return { canceled: false, filePaths: [path] }; };
  }, video);
  assert.equal(await page.evaluate(path => window.videoQuickly.pickPath({ mode: 'file', title: '隔离文件选择验收', defaultPath: path, extensions: ['mp4'] }), video), video);
  const fileOptions = await application.evaluate(() => globalThis.__vqFileDialogs[0]);
  assert.deepEqual(fileOptions, { title: '隔离文件选择验收', defaultPath: video, filters: [{ name: '素材文件', extensions: ['mp4'] }], properties: ['openFile'] });
  await application.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  assert.equal(await page.evaluate(() => window.videoQuickly.pickPath({ mode: 'file', title: '取消选择验收' })), null);
  await application.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async (_owner, options) => { globalThis.__vqFileDialogs.push(options); return { canceled: false, filePaths: [directory] }; };
  }, fixture);
  assert.equal(await page.evaluate(path => window.videoQuickly.pickPath({ mode: 'directory', title: '选择目录验收', defaultPath: path }), fixture), fixture);
  const directoryOptions = await application.evaluate(() => globalThis.__vqFileDialogs.at(-1));
  assert.deepEqual(directoryOptions, { title: '选择目录验收', defaultPath: fixture, properties: ['openDirectory', 'createDirectory'] });
  await application.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  assert.equal(await page.evaluate(() => window.videoQuickly.pickPath({ mode: 'directory', title: '取消目录验收' })), null);
  const destination = join(fixture, '中文 导出成片.mp4');
  await application.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async (_owner, options) => { globalThis.__vqFileDialogs.push(options); return { canceled: false, filePath: path }; };
  }, destination);
  assert.equal(await page.evaluate(path => window.videoQuickly.pickPath({ mode: 'save', title: '保存文件验收', defaultPath: path, extensions: ['mp4'] }), destination), destination);
  assert.deepEqual(await application.evaluate(() => globalThis.__vqFileDialogs.at(-1)), { title: '保存文件验收', defaultPath: destination, filters: [{ name: '导出文件', extensions: ['mp4'] }] });
  await application.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }); });
  assert.equal(await page.evaluate(() => window.videoQuickly.pickPath({ mode: 'save', title: '取消保存验收' })), null);
  await application.evaluate(({ shell }) => { globalThis.__vqRevealed = []; shell.showItemInFolder = path => { globalThis.__vqRevealed.push(path); }; });
  await page.evaluate(async ({ file, directory }) => { await window.videoQuickly.revealFile(file); await window.videoQuickly.revealFile(directory); }, { file: video, directory: fixture });
  assert.deepEqual(await application.evaluate(() => globalThis.__vqRevealed), [video, fixture]);
  await assert.rejects(page.evaluate(path => window.videoQuickly.revealFile(path), join(fixture, 'missing.mp4')));
  checks.dialogBridge = true;
  checks.directoryAndSaveDialogs = true;
  checks.revealBridge = true;
  const asset = await rpc('asset.import', { projectId: project.id, shotId: 'native-shot', path: video, kind: 'video' });
  const media = await page.evaluate(async ({ path, size }) => {
    const url = await window.videoQuickly.assetUrl(path);
    const read = async (range, method = 'GET') => {
      const response = await fetch(url, { method, headers: range ? { Range: range } : {} });
      return { status: response.status, range: response.headers.get('Content-Range'), length: response.headers.get('Content-Length'), bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
    };
    return { first: await read('bytes=0-31'), suffix: await read('bytes=-16'), tail: await read(`bytes=${size - 17}-`), head: await read(undefined, 'HEAD') };
  }, { path: asset.path, size: asset.size });
  const invalidMedia = await application.evaluate(async ({ net }, { path, size, outside }) => {
    const url = `video-quickly://app/__asset?path=${encodeURIComponent(path)}`;
    const invalid = await net.fetch(url, { headers: { Range: `bytes=${size}-` } }), write = await net.fetch(url, { method: 'POST' });
    const escaped = await net.fetch(`video-quickly://app/__asset?path=${encodeURIComponent(outside)}`);
    return { status: invalid.status, range: invalid.headers.get('Content-Range'), writeStatus: write.status, escapedStatus: escaped.status };
  }, { path: asset.path, size: asset.size, outside: video });
  const importedBytes = await readFile(asset.path);
  assert.equal(media.first.status, 206); assert.equal(media.first.range, `bytes 0-31/${asset.size}`); assert.deepEqual(media.first.bytes, [...importedBytes.subarray(0, 32)]);
  assert.equal(media.suffix.status, 206); assert.deepEqual(media.suffix.bytes, [...importedBytes.subarray(-16)]);
  assert.equal(media.tail.status, 206); assert.deepEqual(media.tail.bytes, [...importedBytes.subarray(-17)]);
  assert.equal(media.head.status, 200); assert.equal(media.head.length, String(asset.size)); assert.deepEqual(media.head.bytes, []);
  assert.equal(invalidMedia.status, 416); assert.equal(invalidMedia.range, `bytes */${asset.size}`); assert.equal(invalidMedia.writeStatus, 405); assert.equal(invalidMedia.escapedStatus, 404);
  await assert.rejects(page.evaluate(path => window.videoQuickly.assetUrl(path), video), /工作区/);
  await symlink(fixture, join(workspace, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(page.evaluate(path => window.videoQuickly.assetUrl(path), join(workspace, 'outside-link', '中文 原生媒体.mp4')), /工作区/);
  checks.mediaRange = true;
  checks.mediaBoundary = true;
  await expect.poll(() => page.locator('.preview-panel .scene-preview canvas').evaluate(canvas => { const pixel = canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data; return pixel[0] < 50 && pixel[1] < 50 && pixel[2] > 180; }), { timeout: 10_000 }).toBe(true);
  checks.videoPreview = true;
  const nativePreviewFullscreen = () => application.evaluate(() => globalThis.previewNativeFullscreen);
  if (process.platform === 'darwin') {
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      globalThis.previewNativeFullscreen = {};
      window.once('enter-full-screen', () => { globalThis.previewNativeFullscreen.enteredAt = Date.now(); });
      window.once('leave-full-screen', () => { globalThis.previewNativeFullscreen.leftAt = Date.now(); });
    });
    await page.evaluate(() => {
      function recordExit(event) {
        if (!event.isTrusted || !event.target.closest?.('button[aria-label="退出全屏预览"]')) return;
        globalThis.previewFullscreenExit = { clickedAt: Date.now(), previewWasFullscreen: document.fullscreenElement?.classList.contains('preview-player') };
        document.removeEventListener('click', recordExit, true);
      }
      document.addEventListener('click', recordExit, true);
    });
  }
  const enterPreviewFullscreen = page.getByRole('button', { name: '全屏预览', exact: true });
  await enterPreviewFullscreen.click();
  if (process.platform !== 'darwin') await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains('preview-player'))).toBe(true);
  // Click as soon as the player shows its exit control, while the Mac is still switching spaces.
  await page.getByRole('button', { name: '退出全屏预览', exact: true }).click();
  if (process.platform === 'darwin') {
    const exit = await page.evaluate(() => globalThis.previewFullscreenExit);
    assert.equal(exit?.previewWasFullscreen, true, 'A real click must reach the fullscreen preview exit control');
    await expect.poll(nativePreviewFullscreen).toMatchObject({ enteredAt: expect.any(Number) });
    const { enteredAt } = await nativePreviewFullscreen();
    previewFullscreenTiming = { clickBeforeNativeEnterMs: enteredAt - exit.clickedAt };
    assert.ok(previewFullscreenTiming.clickBeforeNativeEnterMs > 0, 'The exit click must arrive before the native fullscreen transition finishes');
  }
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  if (process.platform === 'darwin') {
    await expect.poll(nativePreviewFullscreen).toMatchObject({ leftAt: expect.any(Number) });
    const { enteredAt, leftAt } = await nativePreviewFullscreen();
    previewFullscreenTiming.nativeExitAfterEntryMs = leftAt - enteredAt;
    checks.previewFullscreenDuringTransition = true;
  }
  await expect(enterPreviewFullscreen).toBeVisible();
  checks.previewFullscreen = true;

  if (process.platform === 'darwin') {
    const setNativeFullscreen = fullscreen => application.evaluate(async ({ BrowserWindow }, enabled) => {
      const window = BrowserWindow.getAllWindows()[0];
      const completed = process.getBuiltinModule('node:events').once(window, enabled ? 'enter-full-screen' : 'leave-full-screen', { signal: AbortSignal.timeout(5_000) });
      window.setFullScreen(enabled);
      await completed;
    }, fullscreen);
    await setNativeFullscreen(true);
    await enterPreviewFullscreen.click();
    await page.getByRole('button', { name: '退出全屏预览', exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), true);
    await setNativeFullscreen(false);
    checks.previewFullscreenInNativeWindow = true;
  }

  const beforeCheck = await projectDocument(project.id), contactsBeforeCheck = credentialContacts;
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('button', { name: '制作前检查', exact: true }).click();
  const readinessDialog = page.getByRole('dialog', { name: '制作前检查', exact: true });
  await expect(readinessDialog.locator('.readiness-summary dd').first()).toHaveText(String(beforeCheck.revision));
  await expect(readinessDialog).toContainText('供应商连通性和计费状态需单独验证');
  await readinessDialog.getByRole('button', { name: '关闭', exact: true }).click();
  const exportNode = beforeCheck.workflow.nodes.find(node => node.kind === 'export');
  assert.ok(exportNode);
  const readiness = await rpc('project.readiness', { projectId: project.id, selection: { nodeId: exportNode.id, mode: 'node' } });
  assert.equal(readiness.ready, true); assert.equal(readiness.serviceCheck, 'not_contacted');
  assert.equal((await projectDocument(project.id)).revision, beforeCheck.revision); assert.equal(credentialContacts, contactsBeforeCheck);
  checks.productionReadiness = true;

  const recoveryDirectory = join(fixture, '中文 恢复来源'); await mkdir(recoveryDirectory);
  await writeFile(join(recoveryDirectory, '重命名的原视频.mp4'), importedBytes);
  await rm(asset.path);
  await assert.rejects(page.evaluate(path => window.videoQuickly.assetUrl(path), asset.path));
  const recovery = await rpc('asset.recovery.start', { projectId: project.id });
  await expect.poll(async () => (await rpc('asset.recovery.get', { jobId: recovery.id })).job.phase).toBe('awaiting_directory');
  const missing = (await rpc('asset.recovery.get', { jobId: recovery.id })).items.find(item => item.assetId === asset.id);
  assert.equal(missing?.status, 'missing');
  await rpc('asset.recovery.scan', { jobId: recovery.id, directory: recoveryDirectory });
  await expect.poll(async () => (await rpc('asset.recovery.get', { jobId: recovery.id })).job.phase).toBe('awaiting_confirmation');
  const matched = (await rpc('asset.recovery.get', { jobId: recovery.id })).items.find(item => item.assetId === asset.id);
  assert.ok(matched?.candidates.length);
  const reloadedMedia = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/__asset' && url.searchParams.get('path') === asset.path && url.searchParams.has('availability') && [200, 206].includes(response.status());
  }, { timeout: 10_000 }).then(response => ({ response }), error => ({ error }));
  await rpc('asset.recovery.confirm', { jobId: recovery.id, selections: [{ itemId: matched.id, candidateId: matched.candidates[0].id }] });
  await expect.poll(async () => (await rpc('asset.recovery.get', { jobId: recovery.id })).job.phase).toBe('succeeded');
  const mediaReload = await reloadedMedia;
  if ('error' in mediaReload) throw mediaReload.error;
  assert.deepEqual(await readFile(asset.path), importedBytes);
  const restored = (await rpc('project.get', { projectId: project.id })).assets.find(value => value.id === asset.id);
  for (const field of ['id', 'path', 'version', 'size', 'sha256']) assert.equal(restored[field], asset[field]);
  assert.equal((await projectDocument(project.id)).revision, beforeCheck.revision);
  checks.assetRecovery = true;

  const exportedVideo = join(fixture, '完整视频.mp4');
  // Substitute the selected path so the real IPC and renderer can save without manual input.
  await application.evaluate(({ dialog }, path) => {
    const original = dialog.showSaveDialog;
    dialog.showSaveDialog = async (_window, options) => {
      dialog.showSaveDialog = original;
      globalThis.__vqVideoSaveOptions = options;
      return { canceled: false, filePath: path };
    };
  }, exportedVideo);
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.getByRole('button', { name: `下载“${project.title}”的完整视频`, exact: true }).click();
  await expect(page.locator('.notice--success')).toContainText(exportedVideo, { timeout: 60_000 });
  const saveOptions = await application.evaluate(() => globalThis.__vqVideoSaveOptions);
  assert.equal(saveOptions.title, '保存完整视频');
  assert.deepEqual(saveOptions.filters[0].extensions, ['mp4']);
  assert.equal((await readFile(exportedVideo)).subarray(4, 8).toString('ascii'), 'ftyp');
  const { items: [exportRun] } = await rpc('run.list', { projectId: project.id, limit: 1 });
  const exportOutput = await rpc('node.result', { runId: exportRun.id, nodeId: 'export' });
  assert.equal(exportOutput.videoPath, exportedVideo);
  assert.deepEqual(exportOutput.assets.map(asset => asset.name), ['video.mp4', 'cover.png', 'subtitles.srt']);
  assert.equal(Object.hasOwn(exportOutput, 'timelinePath'), false);
  assert.equal((await readdir(dirname(exportOutput.coverPath))).includes('timeline.json'), false);
  await page.screenshot({ path: join(artifacts, 'desktop-project-video-download.png') });
  await openProject(project.title);
  checks.actualExport = true;

  const before = await rpc('runtime.status');
  process.kill(runtimePid, 'SIGKILL');
  await expect.poll(() => rpc('runtime.status'), { timeout: 10_000 }).toMatchObject({ state: 'disconnected' });
  const resumed = await rpc('runtime.reconnect');
  assert.equal(resumed.state, 'ready'); assert.ok(resumed.generation > before.generation);
  runtimePid = await findRuntime();
  assert.equal((await projectDocument(project.id)).shots[0].title, 'Electron 原生编辑');
  checks.reconnect = true;

  const narration = page.getByLabel('旁白', { exact: true });
  await narration.fill('Electron 重启后恢复的未保存草稿');
  await expect.poll(() => page.evaluate(async key => {
    const database = await new Promise((resolveDatabase, reject) => { const request = indexedDB.open('video-quickly-drafts', 1); request.onsuccess = () => resolveDatabase(request.result); request.onerror = () => reject(request.error); });
    try {
      return await new Promise((resolveResult, reject) => {
        const query = database.transaction('projects').objectStore('projects').get(key);
        query.onsuccess = () => resolveResult(query.result?.present?.shots?.[0]?.narration);
        query.onerror = () => reject(query.error);
      });
    } finally { database.close(); }
  }, `${workspace}:${project.id}`), { timeout: 10_000 }).toBe('Electron 重启后恢复的未保存草稿');
  await application.evaluate(({ dialog, BrowserWindow }) => {
    globalThis.__vqQuitDialogs = [];
    dialog.showMessageBoxSync = (_owner, options) => { globalThis.__vqQuitDialogs.push({ buttons: options.buttons, defaultId: options.defaultId, cancelId: options.cancelId }); return 0; };
    BrowserWindow.getAllWindows()[0].close();
  });
  await expect.poll(() => application.evaluate(() => globalThis.__vqQuitDialogs.length)).toBe(1);
  assert.equal((await rpc('runtime.status')).state, 'ready');
  assert.equal((await projectDocument(project.id)).id, project.id);
  await expect(narration).toHaveValue('Electron 重启后恢复的未保存草稿');
  checks.cancelWindowClose = true;
  await application.evaluate(({ app }) => app.quit());
  await expect.poll(() => application.evaluate(() => globalThis.__vqQuitDialogs.length)).toBe(2);
  const quitDialogs = await application.evaluate(() => globalThis.__vqQuitDialogs);
  assert.deepEqual(quitDialogs, Array.from({ length: 2 }, () => ({ buttons: ['继续编辑', '离开'], defaultId: 0, cancelId: 0 })));
  assert.equal((await rpc('runtime.status')).state, 'ready');
  assert.equal((await projectDocument(project.id)).id, project.id);
  assert.equal(await findRuntime(), runtimePid);
  checks.cancelQuit = true;
  if (process.platform === 'darwin') {
    const retainedPid = runtimePid, retainedGeneration = (await rpc('runtime.status')).generation;
    for (const activation of ['activate', 'second-instance']) {
      await application.evaluate(({ dialog, BrowserWindow }) => { dialog.showMessageBoxSync = () => 1; BrowserWindow.getAllWindows()[0].close(); });
      await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
      assert.equal(processAlive(retainedPid), true, 'Closing the last Mac window must leave its runtime available');
      const opened = application.waitForEvent('window');
      if (activation === 'activate') await application.evaluate(({ app }) => app.emit('activate'));
      else await execute(executablePath(), packaged ? [] : [desktop], { env: environment, timeout: 20_000 });
      observePage(await opened);
      await expect(page.locator('.workspace-shell')).toBeVisible();
      await inspectWindow();
      await expect.poll(() => rpc('runtime.status')).toMatchObject({ state: 'ready', generation: retainedGeneration });
      assert.equal(await findRuntime(), retainedPid, `${activation} must reuse exactly one runtime`);
      await openProject(project.title);
      await expect(page.getByLabel('旁白', { exact: true })).toHaveValue('Electron 重启后恢复的未保存草稿');
    }
    checks.macWindowReopen = true;
    checks.macSecondInstance = true;
  }
  await page.screenshot({ path: join(artifacts, 'desktop-editor.png') });
  await close(1);
  checks.confirmedQuit = true;
  await launch(); runtimePid = await findRuntime();
  await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
  checks.projectListStartup = true;
  await openProject(project.title);
  await expect(page.getByLabel('旁白', { exact: true })).toHaveValue('Electron 重启后恢复的未保存草稿');
  await expect(page.getByText('已恢复未保存的本地草稿，含撤销与重做历史。')).toBeVisible();
  checks.restartRecovery = true;
  assert.equal((await rpc('model.test', { modelId: credentialModel.id })).connected, true);
  assert.equal(credentialRequests, 2);
  expectedSecret = `isolated-electron-replacement-${randomUUID()}`;
  credentialModel = await rpc('model.save', { model: credentialModel, secret: expectedSecret });
  credentialReferences.add(credentialModel.credentialRef);
  assert.equal((await rpc('model.test', { modelId: credentialModel.id })).connected, true);
  assert.equal(credentialRequests, 3);
  checks.nativeCredentialReplacement = true;
  await rpc('model.delete', { modelId: credentialModel.id }); credentialModel = undefined;
  await cleanupCredentialReferences();
  checks.nativeCredentialDeletion = true;
  checks.nativeCredentialRestart = true;
  await page.screenshot({ path: join(artifacts, 'desktop-restored-draft.png') });
  assert.deepEqual(errors, [], 'Native renderer must have no application errors');
  checks.consoleHealth = true;
  await close(1);
  for (const component of ['desktop', 'runtime']) {
    const text = await readFile(join(workspace, 'logs', `${component}.log`), 'utf8');
    const records = text.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(records.every(record => record.schemaVersion === 1 && Number.isFinite(Date.parse(record.time)) && ['debug', 'info', 'warn', 'error'].includes(record.level)));
    assert.ok(records.some(record => record.event === (component === 'desktop' ? 'desktop.ready' : 'runtime.initialized')));
    assert.ok(records.some(record => record.event === (component === 'desktop' ? 'desktop.stopped' : 'runtime.stopped')));
    for (const secret of [testSecret, expectedSecret]) assert.ok(!text.includes(secret), 'Credentials must never enter automatic diagnostics');
    await writeFile(join(artifacts, `${component}.log`), text);
  }
  checks.structuredLogs = true;
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify({ status: 'passed', platform: process.platform, architecture: process.arch, packaged, compact, windows, distributionScope, relocatedExecutable: Boolean(process.env.VIDEO_QUICKLY_ELECTRON_EXECUTABLE), electron: actualElectronVersion, checks,
    nativeTextInputTypes,
    gettingStartedHelpBounds,
    previewFullscreenTiming,
    nativeDialogs: 'file/directory/save selection, cancellation and close decisions substituted; OS dialog UI requires manual verification',
    nativeShell: 'reveal invocation substituted; Finder/Explorer UI requires manual verification',
    screenshots: ['desktop-getting-started.png', 'desktop-getting-started-context.png', 'desktop-workflow-stage.png', 'desktop-editor.png', 'desktop-restored-draft.png', ...(compact ? ['desktop-compact-production-settings.png', 'desktop-compact-production-readiness.png', 'desktop-compact-export-mp4.png', 'desktop-compact-export-other.png'] : [])],
  }, null, 2));
  console.log('Electron 原生窗口、真实 IPC/Node、编辑历史、媒体 Range/导出、失联重连和重启草稿验收通过。');
} catch (error) {
  await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify({ status: 'failed', platform: process.platform, packaged, compact, windows, distributionScope, checks, previewFullscreenTiming, errors, failure: error instanceof Error ? error.message : String(error) }, null, 2));
  throw error;
} finally {
  if (credentialModel && application) await rpc('model.delete', { modelId: credentialModel.id }).catch(() => {});
  if (application) await cleanupCredentialReferences().catch(() => {});
  credentialServer.closeAllConnections();
  await new Promise(resolveClose => credentialServer.close(resolveClose));
  if (application) await close().catch(() => { application?.process().kill('SIGKILL'); });
  if (runtimePid && processAlive(runtimePid)) process.kill(runtimePid, 'SIGKILL');
  await rm(fixture, { recursive: true, force: true });
}
