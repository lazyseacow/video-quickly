import { execFile } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { expect } from '@playwright/test';
import type { AssetListItem, AssetRecord, CharacterProfile, ProjectDocument, RecordPage, RunSummary } from '@video-quickly/contracts';
import { fixtureCharacterImage } from '../fixtures/character-image';
import { fixtureNativeVideo } from '../fixtures/native-video';
import { confirmAction } from './confirmation-actions';
import { test } from './isolated-workspace';
import { rpc } from './native-video-fixture';
import { openAssetLibrary, openProjectFromList } from './workspace-navigation';
import { setWorkspaceTheme } from './workspace-settings';

test('shows actual media previews and compact file rows while keeping automatic exports with the run', async ({ page, request, isolatedWorkspace }, info) => {
  const videoPath = join(isolatedWorkspace.directory, 'video.mp4');
  const audioPath = join(isolatedWorkspace.directory, '参考配乐.wav');
  const imagePath = join(isolatedWorkspace.directory, '角色参考.png');
  const documentPath = join(isolatedWorkspace.directory, '场景资料.txt');
  const subtitlePath = join(isolatedWorkspace.directory, 'subtitles.srt');
  await Promise.all([
    writeFile(videoPath, fixtureNativeVideo()),
    fixtureCharacterImage().then(bytes => writeFile(imagePath, bytes)),
    writeFile(documentPath, '巷口的灯光来自右侧。'),
    writeFile(subtitlePath, '1\n00:00:00,000 --> 00:00:00,800\n开场\n'),
  ]);
  await promisify(execFile)(process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', videoPath, '-vn', audioPath]);
  const video = await rpc<AssetRecord>(request, 'asset.import', { path: videoPath });
  const image = await rpc<AssetRecord>(request, 'asset.import', { path: imagePath });
  const audio = await rpc<AssetRecord>(request, 'asset.import', { path: audioPath });
  const notes = await rpc<AssetRecord>(request, 'asset.import', { path: documentPath });
  const subtitle = await rpc<AssetRecord>(request, 'asset.import', { path: subtitlePath });
  const project = await rpc<ProjectDocument>(request, 'project.create', { title: '素材预览验收', profile: { width: 320, height: 180, frameRate: { numerator: 30, denominator: 1 } } });
  await rpc(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: [{ id: 'shot', title: '开场', durationUs: 800_000, narration: '', visualPrompt: '', videoAssetId: video.id }] } });
  const { runId } = await rpc<{ runId: string }>(request, 'render.export', { projectId: project.id });
  await expect.poll(async () => (await rpc<RunSummary>(request, 'run.get', { runId })).status, { timeout: 20_000 }).toBe('succeeded');
  const output = await rpc<{ assets: AssetRecord[] }>(request, 'node.result', { runId, nodeId: 'export' });
  expect(output.assets.map(asset => asset.name)).toEqual(['video.mp4', 'cover.png', 'subtitles.srt', 'timeline.json']);
  expect(await rpc(request, 'asset.getMany', { assetIds: output.assets.map(asset => asset.id) })).toHaveLength(4);
  const firstPage = await rpc<RecordPage<AssetListItem>>(request, 'asset.list', { hideExportOutputs: true, limit: 1 });
  expect(firstPage.items.map(asset => asset.id)).toEqual([subtitle.id]);
  expect(firstPage.nextCursor).not.toBeNull();

  await page.setViewportSize({ width: 1464, height: 895 });
  await page.goto('/');
  await page.getByRole('button', { name: '素材库', exact: true }).click();
  const card = (asset: AssetRecord) => page.locator('.asset-card').filter({ has: page.getByRole('heading', { name: asset.name, exact: true }) });
  await expect(card(video)).toHaveCount(1);
  await expect(card(subtitle)).toHaveCount(1);
  await expect(page.getByRole('heading', { name: /^(cover\.png|timeline\.json)$/ })).toHaveCount(0);
  await expect(card(image).locator('.asset-card__thumbnail')).toHaveAttribute('data-state', 'ready');
  await expect(card(video).locator('.asset-card__thumbnail')).toHaveAttribute('data-state', 'ready');
  const blue = await card(video).locator('canvas').evaluate((canvas: HTMLCanvasElement) => canvas.getContext('2d')!.getImageData(5, 5, 1, 1).data[2]);
  expect(blue).toBeGreaterThan(200);
  for (const file of [audio, notes, subtitle]) {
    await expect(card(file).locator('.asset-card__preview')).toHaveCount(0);
    expect((await card(file).boundingBox())!.height).toBeLessThan(80);
  }
  await page.getByRole('heading', { name: '素材库', exact: true }).hover();
  await page.screenshot({ path: info.outputPath('asset-types-dark-1464.png') });

  const videoPreview = card(video).getByRole('button', { name: `预览“${video.name}”`, exact: true });
  await videoPreview.press('Enter');
  const videoDialog = page.getByRole('dialog', { name: video.name, exact: true });
  const player = videoDialog.locator('video');
  await expect(player).toHaveJSProperty('controls', true);
  await expect(player).toHaveJSProperty('videoWidth', 160);
  await page.keyboard.press('Escape');
  await expect(videoDialog).toHaveCount(0);
  await expect(videoPreview).toBeFocused();

  const audioPreview = card(audio).getByRole('button', { name: `试听“${audio.name}”`, exact: true });
  await expect(card(audio).locator('audio')).toHaveCount(0);
  await audioPreview.press('Enter');
  const audioDialog = page.getByRole('dialog', { name: audio.name, exact: true });
  const audioPlayer = audioDialog.locator('audio');
  await expect(audioPlayer).toHaveJSProperty('controls', true);
  await expect.poll(() => audioPlayer.evaluate((element: HTMLAudioElement) => element.duration)).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(audioDialog).toHaveCount(0);
  await expect(audioPreview).toBeFocused();

  await page.setViewportSize({ width: 1024, height: 720 });
  await setWorkspaceTheme(page, 'light');
  await page.getByRole('heading', { name: '素材库', exact: true }).hover();
  await page.screenshot({ path: info.outputPath('asset-types-light-1024.png') });
  await page.getByRole('button', { name: '资料', exact: true }).click();
  await expect(card(notes)).toBeVisible();
  await expect(card(subtitle)).toContainText('SRT');
  await expect(card(video)).toHaveCount(0);
  await page.setViewportSize({ width: 600, height: 720 });
  expect(await page.locator('.page-body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);

  await page.setViewportSize({ width: 1024, height: 720 });
  await openProjectFromList(page, project.title);
  await page.getByRole('button', { name: '打开阶段：审阅与导出', exact: true }).click();
  const runDialog = page.getByRole('dialog', { name: '本次制作', exact: true });
  await runDialog.getByRole('navigation', { name: '本次制作步骤', exact: true }).getByRole('button', { name: /导出成片/ }).click();
  await runDialog.getByRole('button', { name: '查看 timeline.json', exact: true }).click();
  const timeline = page.getByRole('dialog', { name: 'timeline.json', exact: true });
  await expect(timeline.getByRole('region', { name: 'JSON 内容', exact: true })).toContainText('"videoSha256"');
  await page.keyboard.press('Escape');
  await expect(timeline).toHaveCount(0);
  await expect(runDialog).toBeVisible();
});

test('opens the exact JSON for same-named assets and identifies their projects in the list and confirmation', async ({ page, request, isolatedWorkspace }, info) => {
  const name = '角色设定.json';
  const path = join(isolatedWorkspace.directory, name);
  const first = await rpc<ProjectDocument>(request, 'project.create', { title: '东街故事' });
  const second = await rpc<ProjectDocument>(request, 'project.create', { title: '西街故事' });
  const firstText = '{\n  "地点": "<b>东街</b>",\n  "identifier": 9007199254740993\n}';
  const secondText = '{"地点":"西街"}';
  await writeFile(path, secondText);
  const secondAsset = await rpc<AssetRecord>(request, 'asset.import', { path, projectId: second.id });
  await writeFile(path, firstText);

  await page.setViewportSize({ width: 1464, height: 895 });
  await page.goto('/');
  await openProjectFromList(page, first.title);
  await openAssetLibrary(page, '媒体');
  await page.getByRole('button', { name: '导入素材', exact: true }).click();
  const importDialog = page.getByRole('dialog', { name: '导入本地素材', exact: true });
  await importDialog.getByRole('textbox', { name: '文件路径', exact: true }).fill(path);
  await importDialog.getByRole('button', { name: '导入', exact: true }).click();
  await expect(importDialog).toHaveCount(0);
  await page.getByRole('button', { name: '资料', exact: true }).click();
  const files = page.getByRole('article', { name, exact: true });
  const projectFile = (owner: string) => files.filter({ has: page.getByText(owner, { exact: true }) });
  await expect(files).toHaveCount(2);
  await expect(projectFile(first.title)).toHaveAccessibleDescription(first.title);
  await expect(projectFile(second.title)).toHaveAccessibleDescription(second.title);
  await expect(page.locator('.toast')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('json-assets-projects-dark.png') });

  const document = page.getByRole('dialog', { name, exact: true });
  const code = document.getByRole('region', { name: 'JSON 内容', exact: true });
  await page.setViewportSize({ width: 600, height: 720 });
  await setWorkspaceTheme(page, 'light');
  for (const [project, text] of [[first, firstText], [second, secondText]] as const) {
    const view = projectFile(project.title).getByRole('button', { name: `查看“${name}”`, exact: true });
    await expect(view).toHaveAccessibleDescription(project.title);
    await view.press('Enter');
    await expect(code).toBeVisible();
    expect(await code.textContent()).toBe(text);
    await expect(code.locator('b')).toHaveCount(0);
    if (project.id === first.id) {
      await expect(document.locator('.dialog__surface')).toHaveCSS('opacity', '1');
      await page.screenshot({ path: info.outputPath('json-asset-preview-light.png') });
    }
    await page.keyboard.press('Escape');
    await expect(document).toHaveCount(0);
    await expect(view).toBeFocused();
  }

  await rpc(request, 'project.update', { projectId: second.id, revision: second.revision, patch: { title: first.title } });
  const firstOwner = `${first.title} · ${first.id.slice(0, 8)}`;
  const secondOwner = `${first.title} · ${second.id.slice(0, 8)}`;
  await expect(projectFile(firstOwner)).toBeVisible();
  await expect(projectFile(secondOwner)).toBeVisible();
  await projectFile(firstOwner).getByRole('button', { name: `移除素材“${name}”`, exact: true }).click();
  const remove = page.getByRole('alertdialog', { name: '移除素材记录？', exact: true });
  await expect(remove).toContainText(firstOwner);
  await confirmAction(page, '确认移除');
  await expect(projectFile(firstOwner)).toHaveCount(0);
  await expect(projectFile(secondOwner)).toBeVisible();
  expect(await rpc(request, 'asset.getMany', { assetIds: [secondAsset.id] })).toEqual([secondAsset]);
});

test('previews assets, moves a filtered selection to the recycle bin and restores its original record', async ({ page, request, isolatedWorkspace }, info) => {
  const illustration = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><path fill="#5e87a6" d="M0 0h320v180H0z"/><circle fill="#f1dbad" cx="239" cy="49" r="23"/><path fill="#314c63" d="M0 170 95 75l77 81 65-56 83 65v15H0z"/></svg>';
  async function importFile(name: string, bytes: string) {
    const path = join(isolatedWorkspace.directory, name);
    await writeFile(path, bytes);
    return rpc<AssetRecord>(request, 'asset.import', { path });
  }
  const first = await importFile('青石巷 · 暮色街道远景与屋檐光照参考长文件名.svg', illustration);
  const second = await importFile('青石巷 · 街道中景.svg', illustration);
  const retained = await importFile('青石巷 · 保留版本.svg', illustration);
  const used = await importFile('青石巷 · 镜头画面.svg', illustration);
  const document = await importFile('青石巷 · 场景说明.txt', '可移除的场景资料');
  await rpc(request, 'asset.retain', { assetId: retained.id, retained: true });
  const project = await rpc<ProjectDocument>(request, 'project.create', { title: '青石巷' });
  await rpc(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: [{ id: 'used-shot', title: '已用画面', narration: '', visualPrompt: '', durationUs: 2_000_000, assetId: used.id }] } });
  const { items } = await rpc<RecordPage<AssetListItem>>(request, 'asset.list', { kind: 'image' });
  const removableIds = items.filter(asset => !asset.inUse && !asset.retained).map(asset => asset.id);
  const writes: string[][] = [];
  page.on('request', request => {
    if (!request.url().endsWith('/__desktop_rpc')) return;
    const input = request.postDataJSON();
    if (input.method === 'asset.deleteMany') writes.push(input.params.assetIds);
  });

  await page.setViewportSize({ width: 1464, height: 895 });
  await page.goto('/');
  await page.getByRole('button', { name: '素材库', exact: true }).click();
  const heading = (asset: AssetRecord) => page.getByRole('heading', { name: asset.name, exact: true });
  const card = (asset: AssetRecord) => page.locator('.asset-card').filter({ has: heading(asset) });
  await expect(heading(first)).toBeVisible();
  await expect(page.getByRole('button', { name: '恢复缺失素材', exact: true })).toHaveCount(0);
  await expect(card(first).locator('.asset-actions').getByRole('button')).toHaveCount(3);
  await expect(card(first).getByRole('button', { name: '保留此版本', exact: true })).toBeEnabled();
  await expect(card(first).getByRole('button', { name: `移除素材“${first.name}”`, exact: true })).toBeEnabled();
  await expect.poll(() => card(first).locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await expect(heading(first)).toHaveAttribute('title', first.name);
  expect(await page.locator('.asset-grid').evaluate(grid => getComputedStyle(grid).gridTemplateColumns.split(' ').length)).toBe(6);
  expect((await card(first).boundingBox())?.height).toBeLessThan(220);
  expect(await card(first).locator('.asset-actions').getByRole('button').evaluateAll(buttons => new Set(buttons.map(button => button.getBoundingClientRect().top)).size)).toBe(1);
  const preview = card(first).getByRole('button', { name: `预览“${first.name}”`, exact: true });
  await preview.press('Enter');
  const imageDialog = page.getByRole('dialog', { name: first.name, exact: true });
  const fullImage = imageDialog.getByRole('img', { name: first.name, exact: true });
  await expect(fullImage).toHaveJSProperty('naturalWidth', 320);
  await expect(imageDialog.locator('.dialog__surface')).toHaveCSS('opacity', '1');
  expect((await fullImage.boundingBox())!.width).toBeGreaterThan((await preview.boundingBox())!.width);
  await page.screenshot({ path: info.outputPath('asset-full-image-dark.png') });
  await page.keyboard.press('Escape');
  await expect(imageDialog).toHaveCount(0);
  await expect(preview).toBeFocused();
  await page.getByRole('heading', { name: '素材库', exact: true }).hover();
  await page.screenshot({ path: info.outputPath('asset-library-dark-1464.png') });
  const trash = page.getByRole('button', { name: '回收站', exact: true });
  const back = page.getByRole('button', { name: '返回素材库', exact: true });
  await trash.click();
  await expect(page.getByText('回收站为空', { exact: true })).toBeVisible();
  await back.click();

  await page.getByRole('button', { name: '多选', exact: true }).click();
  const choice = (asset: AssetRecord) => page.getByRole('checkbox', { name: `选择“${asset.name}”`, exact: true });
  const selectAll = page.getByRole('checkbox', { name: '全选已加载', exact: true });
  const remove = page.getByRole('button', { name: '批量移除', exact: true });
  await choice(document).check();
  await expect(page.getByText('已选 1 项', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '图片', exact: true }).click();
  await expect(remove).toBeDisabled();
  await expect(choice(document)).toHaveCount(0);
  await expect(choice(retained)).toBeDisabled();
  await expect(choice(used)).toBeDisabled();
  await expect(card(retained)).toContainText('已保留');
  await expect(card(used)).toContainText('使用中');

  await choice(first).focus();
  await page.keyboard.press('Space');
  await expect(choice(first)).toBeChecked();
  await expect(card(first)).toHaveAttribute('data-selected', 'true');
  await expect(selectAll).toHaveJSProperty('indeterminate', true);
  await selectAll.check();
  await expect(page.getByText(`已选 ${removableIds.length} 项`, { exact: true })).toBeVisible();
  await expect(choice(second)).toBeChecked();

  await page.setViewportSize({ width: 600, height: 900 });
  await setWorkspaceTheme(page, 'light');
  expect(await page.locator('.page-body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('asset-library-selection-light-600.png') });

  const confirmation = page.getByRole('alertdialog', { name: '批量移除素材记录？' });
  const confirm = confirmation.getByRole('button', { name: '确认移除', exact: true });
  await remove.click();
  await expect(confirmation).toContainText(`${removableIds.length} 条记录`);
  await expect(confirmation).toContainText('素材文件会保留');
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(remove).toBeFocused();
  expect(writes).toEqual([]);
  await expect(choice(second)).toBeChecked();

  await remove.click();
  await expect(confirmation).toBeVisible();
  await rpc(request, 'asset.retain', { assetId: second.id, retained: true });
  await confirm.click();
  await expect(page.getByText(`“${second.name}”正在使用或已保留，请重新选择后重试。`, { exact: true })).toBeVisible();
  await expect(choice(second)).toBeDisabled();
  await expect(choice(first)).toBeChecked();
  expect(writes).toEqual([removableIds]);

  await remove.click();
  await confirm.click();
  await expect(heading(first)).toHaveCount(0);
  await expect(heading(second)).toBeVisible();
  await expect(heading(used)).toBeVisible();
  await expect(heading(retained)).toBeVisible();
  expect(writes).toEqual([removableIds, removableIds.filter(id => id !== second.id)]);
  expect(await readFile(first.path, 'utf8')).toBe(illustration);
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await expect(choice(document)).not.toBeChecked();
  await page.getByRole('button', { name: '退出多选', exact: true }).click();
  await expect(card(document).getByRole('button', { name: `移除素材“${document.name}”` })).toBeEnabled();

  await trash.press('Enter');
  await expect(page.getByRole('heading', { name: '素材回收站', exact: true })).toBeVisible();
  await expect(heading(first)).toBeVisible();
  await expect(heading(second)).toHaveCount(0);
  await expect(heading(used)).toHaveCount(0);
  await expect(heading(retained)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '多选', exact: true })).toHaveCount(0);
  const restore = card(first).getByRole('button', { name: `恢复素材“${first.name}”`, exact: true });
  expect(await page.locator('.page-body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(page.locator('.toast')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('asset-recycle-bin-light-600.png') });
  await restore.press('Enter');
  await expect(heading(first)).toHaveCount(0);
  await expect(back).toBeFocused();
  await back.press('Enter');
  await expect(heading(first)).toBeVisible();
  expect(await rpc(request, 'asset.getMany', { assetIds: [first.id] })).toEqual([first]);
  expect(await readFile(first.path, 'utf8')).toBe(illustration);
});

test('keeps media and role views in one library and lets two roles reference the same public image', async ({ page, request, isolatedWorkspace }, info) => {
  const portrait = await fixtureCharacterImage();
  const path = join(isolatedWorkspace.directory, '青衣旅人参考图.png');
  const projectPath = join(isolatedWorkspace.directory, '项目专属图.png');
  const notesPath = join(isolatedWorkspace.directory, '场景说明.txt');
  await Promise.all([writeFile(path, portrait), writeFile(projectPath, portrait), writeFile(notesPath, '场景说明')]);
  const shared = await rpc<AssetRecord>(request, 'asset.import', { path });
  const project = await rpc<ProjectDocument>(request, 'project.create', { title: '素材与角色共用验收' });
  const projectImage = await rpc<AssetRecord>(request, 'asset.import', { path: projectPath, projectId: project.id });
  const notes = await rpc<AssetRecord>(request, 'asset.import', { path: notesPath });
  const archived = await rpc<CharacterProfile>(request, 'character.save', { character: { name: '归档角色验收', description: '', referenceAssetIds: [] } });
  await rpc(request, 'character.archive', { characterId: archived.id, revision: archived.revision });
  const beforeFiles = (await readdir(dirname(shared.path))).sort();
  const beforeImages = await rpc<RecordPage<AssetListItem>>(request, 'asset.list', { kind: 'image' });

  await page.setViewportSize({ width: 1464, height: 895 });
  await page.goto('/');
  const library = page.getByRole('button', { name: '素材库', exact: true });
  await library.click();
  const views = page.getByRole('tablist', { name: '素材库视图', exact: true });
  const media = views.getByRole('tab', { name: '媒体', exact: true });
  const roles = views.getByRole('tab', { name: '角色', exact: true });
  const mediaPanel = page.getByRole('tabpanel', { name: '媒体', exact: true });
  const rolePanel = page.getByRole('tabpanel', { name: '角色', exact: true });
  const card = (asset: AssetRecord) => mediaPanel.locator('.asset-card').filter({ has: page.getByRole('heading', { name: asset.name, exact: true }) });
  const createFromImage = (asset: AssetRecord) => card(asset).getByRole('button', { name: `用“${asset.name}”新建角色`, exact: true });
  await expect(media).toHaveAttribute('aria-selected', 'true');
  await expect(card(projectImage)).toBeVisible();
  await expect(card(notes)).toBeVisible();
  await expect(createFromImage(projectImage)).toHaveCount(0);
  await expect(createFromImage(notes)).toHaveCount(0);
  await mediaPanel.getByRole('button', { name: '图片', exact: true }).click();
  await media.press('ArrowRight');
  await expect(roles).toBeFocused();
  await expect(roles).toHaveAttribute('aria-selected', 'true');
  const archivedFilter = rolePanel.getByRole('button', { name: '已归档', exact: true });
  await archivedFilter.click();
  await expect(rolePanel.getByRole('heading', { name: archived.name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '模型连接', exact: true }).click();
  await library.click();
  await expect(roles).toHaveAttribute('aria-selected', 'true');
  await expect(archivedFilter).toHaveAttribute('aria-pressed', 'true');
  await roles.press('Home');
  await expect(media).toBeFocused();
  await expect(mediaPanel.getByRole('button', { name: '图片', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(card(notes)).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('asset-library-media-dark-1464.png') });

  const imports: string[] = [];
  page.on('request', outgoing => {
    if (!outgoing.url().endsWith('/__desktop_rpc')) return;
    const input = outgoing.postDataJSON();
    if (input.method === 'asset.import') imports.push(input.params.path);
  });
  const trigger = createFromImage(shared);
  const editor = page.getByRole('dialog', { name: '新建角色', exact: true });
  await trigger.press('Enter');
  await expect(editor.getByLabel('角色名称', { exact: true })).toBeFocused();
  await expect(editor.getByRole('checkbox', { name: shared.name })).toBeChecked();
  await expect(editor.locator('summary').first()).toContainText('已选 1 张');
  await expect(editor.locator('.dialog__surface')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: info.outputPath('asset-library-use-image-dark-1464.png') });
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(trigger).toBeFocused();
  for (const name of ['青衣旅人', '青衣旅人的替身']) {
    await trigger.click();
    await expect(editor.getByRole('checkbox', { name: shared.name })).toBeChecked();
    await editor.getByLabel('角色名称', { exact: true }).fill(name);
    await editor.getByRole('button', { name: '保存角色', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(media).toHaveAttribute('aria-selected', 'true');
  }
  await expect(page.locator('.toast__entry:not(.toast__entry--leaving) .toast__message')).toHaveText('角色已创建');
  const created = (await rpc<RecordPage<CharacterProfile>>(request, 'character.list')).items;
  expect(created.map(role => role.name).sort()).toEqual(['青衣旅人', '青衣旅人的替身'].sort());
  for (const role of created) {
    expect(role.referenceAssetIds).toEqual([shared.id]);
    expect(await rpc(request, 'character.references', { characterId: role.id })).toEqual([shared]);
  }
  expect(imports).toEqual([]);
  expect((await rpc<RecordPage<AssetListItem>>(request, 'asset.list', { kind: 'image' })).items.map(asset => asset.id)).toEqual(beforeImages.items.map(asset => asset.id));
  expect((await readdir(dirname(shared.path))).sort()).toEqual(beforeFiles);
  await expect(card(shared)).toContainText('使用中');
  await expect(card(shared).getByRole('button', { name: `移除素材“${shared.name}”`, exact: true })).toBeDisabled();

  await media.press('End');
  await expect(archivedFilter).toHaveAttribute('aria-pressed', 'true');
  await rolePanel.getByRole('button', { name: '可用角色', exact: true }).click();
  for (const role of created) await expect(rolePanel.getByRole('heading', { name: role.name, exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await setWorkspaceTheme(page, 'light');
  expect(await page.locator('.page-body').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await expect(page.locator('.toast')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('asset-library-roles-light-390.png') });
});

test('selects loaded assets across pages without adding new rows to the selection automatically', async ({ page, request, isolatedWorkspace }) => {
  const olderPath = join(isolatedWorkspace.directory, '下一页资料.txt');
  const firstPagePath = join(isolatedWorkspace.directory, '首页资料.txt');
  await Promise.all([writeFile(olderPath, '下一页'), writeFile(firstPagePath, '首页')]);
  const older = await rpc<AssetRecord>(request, 'asset.import', { path: olderPath });
  for (let index = 0; index < 100; index++) await rpc(request, 'asset.import', { path: firstPagePath });

  await page.goto('/');
  await page.getByRole('button', { name: '素材库', exact: true }).click();
  await page.getByRole('button', { name: '资料', exact: true }).click();
  await page.getByRole('button', { name: '多选', exact: true }).click();
  const selectAll = page.getByRole('checkbox', { name: '全选已加载', exact: true });
  const nextChoice = page.getByRole('checkbox', { name: `选择“${older.name}”`, exact: true });
  await expect(nextChoice).toHaveCount(0);
  await selectAll.check();
  await expect(page.getByText('已选 100 项', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '加载更多素材', exact: true }).click();
  await expect(nextChoice).not.toBeChecked();
  await expect(selectAll).toHaveJSProperty('indeterminate', true);

  await selectAll.check();
  await page.getByRole('button', { name: '批量移除', exact: true }).click();
  const confirmation = page.getByRole('alertdialog', { name: '批量移除素材记录？' });
  await expect(confirmation).toContainText('101 条记录');
  await confirmation.getByRole('button', { name: '确认移除', exact: true }).click();
  await expect(page.getByText('没有此类素材', { exact: true })).toBeVisible();
  expect(await rpc(request, 'asset.list', { kind: 'document' })).toEqual({ items: [], nextCursor: null });

  await page.reload();
  await page.getByRole('button', { name: '素材库', exact: true }).click();
  await page.getByRole('button', { name: '资料', exact: true }).click();
  await page.getByRole('button', { name: '回收站', exact: true }).click();
  const restoreOlder = page.getByRole('button', { name: `恢复素材“${older.name}”`, exact: true });
  const more = page.getByRole('button', { name: '加载更多素材', exact: true });
  await expect(more).toBeEnabled();
  await expect(restoreOlder).toHaveCount(0);
  await more.click();
  await restoreOlder.click();
  await expect(restoreOlder).toHaveCount(0);
  await page.getByRole('button', { name: '返回素材库', exact: true }).click();
  await expect(page.getByRole('heading', { name: older.name, exact: true })).toBeVisible();
});

test('gives archived characters only restore and confirmed deletion while keeping shared reference images', async ({ page, request, isolatedWorkspace }, info) => {
  const path = join(isolatedWorkspace.directory, '共用角色参考.png');
  const image = await fixtureCharacterImage();
  await writeFile(path, image);
  const reference = await rpc<AssetRecord>(request, 'asset.import', { path });
  const save = (name: string) => rpc<CharacterProfile>(request, 'character.save', { character: { name, description: '角色设定', referenceAssetIds: [reference.id] } });
  const archived = await save('归档验收角色');
  const shared = await save('共用参考图的角色');
  await rpc(request, 'character.archive', { characterId: archived.id, revision: archived.revision });
  const deletions: string[] = [];
  page.on('request', request => {
    if (!request.url().endsWith('/__desktop_rpc')) return;
    const input = request.postDataJSON();
    if (input.method === 'character.delete') deletions.push(input.params.characterId);
  });

  await page.setViewportSize({ width: 1024, height: 720 });
  await page.goto('/');
  await page.getByRole('button', { name: '素材库', exact: true }).click();
  await page.getByRole('tab', { name: '角色', exact: true }).click();
  const archivedFilter = page.getByRole('button', { name: '已归档', exact: true });
  const availableFilter = page.getByRole('button', { name: '可用角色', exact: true });
  const card = page.locator('.character-card').filter({ has: page.getByRole('heading', { name: archived.name, exact: true }) });
  await archivedFilter.click();
  await expect(card.getByRole('button')).toHaveCount(2);
  await expect(card.getByRole('button', { name: '编辑角色', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '新建角色', exact: true })).toHaveCount(0);
  const restore = card.getByRole('button', { name: `恢复角色：${archived.name}`, exact: true });
  const remove = card.getByRole('button', { name: `删除角色：${archived.name}`, exact: true });
  await expect(remove).toBeEnabled();
  await expect(card.getByRole('img', { name: `${archived.name}参考图` })).toBeVisible();
  await page.screenshot({ path: info.outputPath('archived-character-dark.png') });

  await restore.press('Enter');
  await expect(card).toHaveCount(0);
  await availableFilter.click();
  await expect(card.getByRole('button', { name: '编辑角色', exact: true })).toBeEnabled();
  await expect(remove).toHaveCount(0);
  await card.getByRole('button', { name: `归档角色：${archived.name}`, exact: true }).click();
  await confirmAction(page, '确认归档');
  await expect(card).toHaveCount(0);
  await archivedFilter.click();

  await remove.press('Enter');
  const confirmation = page.getByRole('alertdialog', { name: '彻底删除角色？', exact: true });
  await expect(confirmation).toContainText(archived.name);
  await expect(confirmation).toContainText('参考图会保留');
  const cancel = confirmation.getByRole('button', { name: '取消', exact: true });
  await expect(cancel).toBeFocused();
  await cancel.click();
  await expect(remove).toBeFocused();
  expect(deletions).toEqual([]);

  await remove.press('Enter');
  await confirmAction(page, '彻底删除');
  await expect(card).toHaveCount(0);
  await expect(archivedFilter).toBeFocused();
  expect(deletions).toEqual([archived.id]);
  expect(await rpc(request, 'character.getMany', { characterIds: [archived.id, shared.id] })).toEqual([shared]);
  expect(await rpc(request, 'character.references', { characterId: shared.id })).toEqual([reference]);
  expect(await readFile(reference.path)).toEqual(image);
});
