import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import type { AssetListItem, AssetRecord, ProjectDocument, RecordPage } from '@video-quickly/contracts';
import { test } from './isolated-workspace';
import { rpc } from './native-video-fixture';
import { setWorkspaceTheme } from './workspace-settings';

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
  await expect(card(first).locator('.asset-actions').getByRole('button')).toHaveCount(2);
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
