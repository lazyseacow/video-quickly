import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ProjectDocument } from '@video-quickly/contracts';
import { writeFile } from 'node:fs/promises';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }); expect(response.ok()).toBe(true);
  const data = await response.json(); expect(data.error).toBeUndefined(); return data.result;
}
async function fixture(request: APIRequestContext, title: string) {
  const created = await rpc<ProjectDocument>(request, 'project.create', { title });
  return rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: { shots: [{ id: 'keyframe-shot', title: '源窗口关键帧镜头', narration: '', visualPrompt: '', durationUs: 2_000_000, sourceInUs: 2_000_000, sceneInUs: 2_000_000, sceneDurationUs: 4_000_000 }] } });
}
async function saved(request: APIRequestContext, projectId: string) { return (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId })).project; }
async function open(page: Page, project: ProjectDocument) {
  await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/); await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.locator('.project-card').filter({ hasText: project.title }).getByRole('button', { name: '继续创作', exact: true }).click();
  await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('源窗口关键帧镜头');
  await page.getByRole('button', { name: '关键帧与曲线', exact: true }).click(); return page.getByRole('dialog', { name: '关键帧与曲线', exact: true });
}
function observe(page: Page) { const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); }); return errors; }

test('edits original-time keyframes and custom curves as one recoverable command, with dark and narrow light layouts', async ({ page, request }, info) => {
  const errors = observe(page), project = await fixture(request, '关键帧曲线与恢复验收'); let dialog = await open(page, project);
  await dialog.getByRole('checkbox', { name: '使用关键帧运镜', exact: true }).check(); await expect(dialog.getByLabel('关键帧预览位置')).toContainText('原场景 2.000 秒');
  await dialog.getByRole('button', { name: '添加当前时刻', exact: true }).click(); await expect(dialog.getByLabel('原场景时间（秒）', { exact: true })).toHaveValue('2');
  await dialog.getByLabel('水平位置（%）', { exact: true }).fill('15'); await dialog.getByLabel('关键帧缩放（倍）', { exact: true }).fill('1.4');
  await dialog.getByLabel('到下一关键帧的曲线', { exact: true }).selectOption('cubic-bezier'); await dialog.getByLabel('控制点 1 X', { exact: true }).fill('0.3');
  await expect(dialog.getByRole('img', { name: '所选关键帧的时间曲线', exact: true })).toBeVisible();
  expect((await saved(request, project.id)).shots[0].animation.keyframes).toBeUndefined();
  await expect(dialog.locator('.scene-preview canvas')).toBeVisible(); await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '1'); await expect(dialog.locator('.dialog__surface')).toHaveCSS('transform', 'none'); await page.screenshot({ path: info.outputPath('keyframes-dark-1536.png') });
  await dialog.getByRole('button', { name: '取消', exact: true }).click(); await expect(dialog).toHaveCount(0); expect((await saved(request, project.id)).shots).toEqual(project.shots);
  await page.getByRole('button', { name: '浅色外观', exact: true }).click(); await page.setViewportSize({ width: 600, height: 900 });
  await page.getByRole('button', { name: '关键帧与曲线', exact: true }).click(); dialog = page.getByRole('dialog', { name: '关键帧与曲线', exact: true });
  await dialog.getByRole('checkbox', { name: '使用关键帧运镜', exact: true }).check(); await dialog.getByRole('button', { name: '添加当前时刻', exact: true }).click();
  await dialog.getByLabel('关键帧缩放（倍）', { exact: true }).fill('1.4'); await dialog.getByLabel('到下一关键帧的曲线', { exact: true }).selectOption('cubic-bezier');
  await dialog.getByRole('button', { name: '应用关键帧', exact: true }).scrollIntoViewIfNeeded(); await expect(dialog.getByRole('button', { name: '应用关键帧', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await dialog.locator('.dialog__body').evaluate(element => { element.scrollTop = 0; }); await page.screenshot({ path: info.outputPath('keyframes-light-600.png') });
  await dialog.getByRole('button', { name: '应用关键帧', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const save = page.getByRole('button', { name: '保存镜头', exact: true }); await expect(save).toBeEnabled(); await save.click();
  await expect.poll(async () => (await saved(request, project.id)).shots[0].animation.keyframes?.length).toBe(3);
  const edited = await saved(request, project.id); expect(edited.shots[0].animation.keyframes?.map(frame => frame.timeUs)).toEqual([0, 2_000_000, 4_000_000]);
  expect(edited.shots[0]).toMatchObject({ sourceInUs: 2_000_000, sceneInUs: 2_000_000, sceneDurationUs: 4_000_000 });
  await page.reload(); await page.getByRole('button', { name: '我的项目', exact: true }).click(); await page.locator('.project-card').filter({ hasText: project.title }).getByRole('button', { name: '继续创作', exact: true }).click();
  await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect.poll(async () => (await saved(request, project.id)).shots).toEqual(project.shots);
  await page.getByRole('button', { name: '重做', exact: true }).click(); await expect.poll(async () => (await saved(request, project.id)).shots).toEqual(edited.shots);
  expect(errors).toEqual([]);
});

test('preserves its candidate on a changed source window and accepts unrelated title edits', async ({ page, request }) => {
  const errors = observe(page), project = await fixture(request, '关键帧外部修改保护'); let dialog = await open(page, project);
  await dialog.getByRole('checkbox', { name: '使用关键帧运镜', exact: true }).check();
  const moved = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: project.shots.map(shot => ({ ...shot, sceneInUs: 1_000_000 })) } });
  await expect(page.locator('.project-heading-copy')).toHaveAttribute('data-revision', String(moved.revision));
  await dialog.getByRole('button', { name: '应用关键帧', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('剪辑区间已更新');
  await expect(dialog.getByRole('checkbox', { name: '使用关键帧运镜', exact: true })).toBeChecked(); expect(await saved(request, project.id)).toEqual(moved);
  await dialog.getByRole('button', { name: '取消', exact: true }).click(); await page.getByRole('button', { name: '关键帧与曲线', exact: true }).click(); dialog = page.getByRole('dialog', { name: '关键帧与曲线', exact: true });
  await dialog.getByRole('checkbox', { name: '使用关键帧运镜', exact: true }).check();
  const titled = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: moved.revision, patch: { title: '关键帧应保留的外部新标题' } }); await expect(page.locator('.project-heading-copy')).toHaveAttribute('data-revision', String(titled.revision));
  await dialog.getByRole('button', { name: '应用关键帧', exact: true }).click(); await expect(dialog).toHaveCount(0); await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect.poll(async () => (await saved(request, project.id)).shots[0].animation.keyframes?.length).toBe(2); expect((await saved(request, project.id)).title).toBe(titled.title); expect(errors).toEqual([]);
});

test('authors the complete measured legacy voice window without persisting a new shot duration', async ({ page, request }, info) => {
  const errors = observe(page); let project = await fixture(request, '旧长旁白完整运镜窗口');
  const rate = 16000, count = 3 * rate, pcm = Buffer.alloc(44 + count * 2);
  pcm.write('RIFF'); pcm.writeUInt32LE(pcm.length - 8, 4); pcm.write('WAVEfmt ', 8); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22); pcm.writeUInt32LE(rate, 24); pcm.writeUInt32LE(rate * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(count * 2, 40);
  for (let index = 0; index < count; index++) pcm.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / rate) * 2000), 44 + index * 2);
  const path = info.outputPath('legacy-voice.wav'); await writeFile(path, pcm);
  const asset = await rpc<{ id: string }>(request, 'asset.import', { projectId: project.id, path, kind: 'audio' });
  project = await saved(request, project.id);
  project = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: [{ id: 'keyframe-shot', title: '源窗口关键帧镜头', narration: '', visualPrompt: '', durationUs: 1_000_000, audioAssetId: asset.id }] } });
  await page.goto('/'); await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
  await expect(page.locator('.preview-panel .prepared-mix-preview')).toHaveAttribute('data-status', 'ready', { timeout: 20000 });
  await page.getByRole('button', { name: '关键帧与曲线', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '关键帧与曲线', exact: true });
  await dialog.getByRole('checkbox', { name: '使用关键帧运镜', exact: true }).check(); await dialog.getByRole('button', { name: '编辑关键帧 2', exact: true }).click();
  await expect(dialog.getByLabel('原场景时间（秒）', { exact: true })).toHaveValue('3');
  await expect(dialog.getByLabel('关键帧预览位置')).toContainText('镜头内 2.967 秒');
  await dialog.getByRole('button', { name: '应用关键帧', exact: true }).click(); await page.getByRole('button', { name: '保存镜头', exact: true }).click();
  await expect.poll(async () => (await saved(request, project.id)).shots[0].animation.keyframes?.at(-1)?.timeUs).toBe(3_000_000);
  expect((await saved(request, project.id)).shots[0].durationUs).toBe(1_000_000); expect(errors).toEqual([]);
});
