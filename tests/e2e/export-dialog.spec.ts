import { readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { ProjectDocument } from '@video-quickly/contracts';
import { showSettingsPreview } from './settings';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }); const payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }]) {
  test(`retains export settings across sections and produces the selected MP4 and downloads at ${viewport.width}px`, async ({ page, request }, info) => {
    const created = await rpc<ProjectDocument>(request, 'project.create', { title: `分区导出验收 ${viewport.width}`, profile: { width: 320, height: 180, frameRate: { numerator: 30000, denominator: 1001 }, fitMode: 'contain', previewScale: 1 } });
    const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: { shots: [{ id: 'export-scene', title: '导出首镜头', narration: '分区导出测试字幕', visualPrompt: '', durationUs: 700_000 }] } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
    await page.goto('/'); await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
    await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('导出首镜头');
    await page.setViewportSize(viewport); await page.getByRole('button', { name: '导出', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '导出视频', exact: true });
    const frameRate = dialog.getByLabel('视频帧率', { exact: true });
    await expect(frameRate).toHaveValue('current'); await expect(frameRate.locator('option:checked')).toHaveText('29.97 fps · 当前');
    expect(await frameRate.locator('option:not([disabled])').allTextContents()).toEqual(['30 fps', '60 fps']);
    await expect(dialog.getByLabel('帧率分子', { exact: true })).toHaveCount(0); await expect(dialog.getByLabel('帧率分母', { exact: true })).toHaveCount(0);
    await dialog.getByLabel('画面比例', { exact: true }).selectOption('9:16');
    await dialog.getByLabel('素材适配', { exact: true }).selectOption('cover');
    await expect(dialog.getByLabel('视频宽度', { exact: true })).toHaveValue('180');
    await expect(dialog.getByLabel('视频高度', { exact: true })).toHaveValue('320');
    const destination = info.outputPath('portrait.mp4');
    await dialog.getByRole('tab', { name: '输出设置', exact: true }).click();
    await dialog.getByLabel('输出文件路径', { exact: true }).fill(destination);
    await dialog.getByRole('tab', { name: '视频规格', exact: true }).click();
    await expect(dialog.getByLabel('视频宽度', { exact: true })).toHaveValue('180');
    await expect(dialog.getByLabel('素材适配', { exact: true })).toHaveValue('cover');
    await showSettingsPreview(dialog); await expect(dialog.locator('.export-dialog__frame')).toBeVisible();
    const frame = await dialog.locator('.export-dialog__frame').boundingBox(); expect(frame!.width / frame!.height).toBeCloseTo(9 / 16, 2);
    await expect(dialog.locator('.dialog__footer')).toBeInViewport({ ratio: 1 });
    await expect(dialog.locator('[role="tabpanel"]:visible')).toHaveCount(1);
    await page.screenshot({ path: info.outputPath('export-sections.png') });
    await dialog.getByRole('tab', { name: '输出设置', exact: true }).click();
    await expect(dialog.getByLabel('输出文件路径', { exact: true })).toHaveValue(destination);
    await dialog.getByRole('tab', { name: '其他导出', exact: true }).click();
    const srtPending = page.waitForEvent('download'); await dialog.getByRole('button', { name: '导出字幕', exact: true }).click();
    const srt = await srtPending; await expect(async () => { expect(await readFile((await srt.path())!, 'utf8')).toContain('分区导出测试字幕'); }).toPass();
    const jsonPending = page.waitForEvent('download'); await dialog.getByRole('button', { name: '导出分镜', exact: true }).click();
    const json = await jsonPending; const exported = JSON.parse(await readFile((await json.path())!, 'utf8')) as ProjectDocument;
    expect(exported.profile).toEqual(project.profile); expect(exported.shots).toEqual(project.shots);
    await dialog.getByRole('button', { name: '导出 MP4', exact: true }).click();
    await expect(dialog.getByText(/文件已保存/)).toBeVisible({ timeout: 30000 });
    expect((await stat(destination)).size).toBeGreaterThan(500);
    const probe = spawnSync(process.env.VIDEO_QUICKLY_FFPROBE ?? 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', destination], { encoding: 'utf8' });
    expect(probe.status, probe.stderr).toBe(0); expect(JSON.parse(probe.stdout).streams[0]).toMatchObject({ width: 180, height: 320, r_frame_rate: '30000/1001' });
    const saved = await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id }); expect(saved.project).toEqual(project);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
  });
}
