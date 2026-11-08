import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { expect } from '@playwright/test';

const execute = promisify(execFile);
const button = (root, name) => root.getByRole('button', { name, exact: true });

async function checkLayout(dialog, ...controls) {
  const surface = dialog.locator('.dialog__surface');
  await expect(surface).toHaveCSS('opacity', '1');
  for (const control of [surface, button(dialog, '关闭对话框'), ...controls]) {
    await expect(control).toBeInViewport({ ratio: 1 });
  }
  assert.equal(await surface.evaluate(element => element.scrollWidth <= element.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1), true);
}

export async function verifyNativeCompactDialogs({ page, rpc, openProject, fixture, artifacts, ffmpegPath, environment, checks }) {
  const created = await rpc('project.create', { title: '最小窗口弹窗验收', profile: { width: 320, height: 180, frameRate: { numerator: 30, denominator: 1 }, fitMode: 'contain', previewScale: 1 } });
  const project = await rpc('project.update', { projectId: created.id, revision: created.revision, patch: {
    shots: [{ id: 'compact-preview', title: '窄窗口首镜头', narration: '本地弹窗验收字幕', visualPrompt: '', durationUs: 700_000 }],
    workflow: { id: 'compact-dialogs', name: '本地范围验收', version: 1, production: created.workflow.production,
      nodes: [
        { id: 'compact-start', kind: 'condition', label: '局部起点', config: { value: true } },
        { id: 'compact-tail', kind: 'brief', label: '后续步骤' },
        { id: 'export', kind: 'export', label: '导出成片' },
      ],
      edges: [
        { id: 'compact-edge', source: 'compact-start', target: 'compact-tail', condition: 'true' },
        { id: 'compact-output', source: 'compact-tail', target: 'export' },
      ],
    },
  } });
  await openProject(project.title);

  await button(page, '制作设置').press('Enter');
  const settings = page.getByRole('dialog', { name: '制作设置', exact: true });
  const settingsFooter = settings.locator('.production-settings__footer');
  const next = button(settings, '下一步'), back = button(settings, '上一步');
  const brief = '最小窗口中的已确认制作配置';
  await expect(settingsFooter.getByRole('button')).toHaveText(['下一步']);
  await checkLayout(settings, next);
  await settings.getByLabel('创作要求', { exact: true }).fill(brief);
  await next.click(); await expect(button(settings, '模型与素材')).toHaveAttribute('aria-current', 'step');
  await back.press('Enter'); await expect(settings.getByLabel('创作要求', { exact: true })).toHaveValue(brief);
  await next.click();
  const advanced = button(settings, '打开高级编排');
  await advanced.scrollIntoViewIfNeeded(); await checkLayout(settings, advanced, back, next);
  await page.screenshot({ path: join(artifacts, 'desktop-compact-production-settings.png') });
  await advanced.click();
  await expect(button(settings, '确认保存')).toHaveAttribute('aria-current', 'step');
  await expect(settings).toContainText('保存设置后将打开高级编排');
  assert.equal((await rpc('project.get', { projectId: project.id })).project.revision, project.revision);
  const save = button(settings, '保存并打开');
  await checkLayout(settings, back, save);
  await save.press('Enter'); await expect(settings).toHaveCount(0);
  await expect(page.locator('.react-flow')).toBeVisible();
  assert.equal((await rpc('project.get', { projectId: project.id })).project.brief, brief);
  checks.compactProductionSettings = true;

  const start = page.locator('.react-flow__node[data-id="compact-start"]');
  await start.press('Enter'); await expect(start).toHaveClass(/selected/);
  const scope = page.getByRole('dialog', { name: '执行范围', exact: true });
  async function openScope() {
    await button(page, '配置与执行步骤').click();
    const editor = page.getByRole('dialog', { name: '局部起点', exact: true });
    await button(editor, '预览这步及后续').click();
    await expect(scope).toBeVisible();
  }
  await openScope();
  const plan = scope.getByRole('list', { name: '将执行的步骤' }).locator('li');
  const single = scope.getByRole('radio', { name: '仅此步骤', exact: true });
  const downstream = scope.getByRole('radio', { name: '此步骤及后续', exact: true });
  const cancel = button(scope, '取消'), confirm = button(scope, '确认执行');
  await expect(plan).toHaveCount(3);
  await single.check(); await expect(plan).toHaveCount(1);
  await single.press('ArrowRight'); await expect(downstream).toBeChecked(); await expect(plan).toHaveCount(3);
  await expect(scope.locator('.dialog__footer').getByRole('button')).toHaveText(['取消', '执行']);
  await checkLayout(scope, single, downstream, cancel, confirm);
  await page.screenshot({ path: join(artifacts, 'desktop-compact-run-scope.png') });
  await cancel.click(); await expect(scope).toHaveCount(0);
  assert.equal((await rpc('run.list', { projectId: project.id })).items.length, 0);
  await openScope(); await single.check(); await expect(plan).toHaveCount(1);
  await confirm.press('Enter'); await expect(scope).toHaveCount(0);
  await expect.poll(async () => (await rpc('run.list', { projectId: project.id })).items[0]).toMatchObject({ status: 'succeeded', selection: { nodeId: 'compact-start', mode: 'node' }, stepCount: 1 });
  checks.compactRunScope = true;

  await button(page, '返回工作台').click();
  const openExport = button(page, '导出');
  await openExport.click();
  const exporter = page.getByRole('dialog', { name: '导出视频', exact: true });
  const formats = exporter.getByRole('tablist', { name: '导出类型', exact: true });
  const mp4 = formats.getByRole('tab', { name: 'MP4', exact: true });
  const other = formats.getByRole('tab', { name: '其他导出', exact: true });
  const path = exporter.getByLabel('输出文件路径', { exact: true });
  const exportMp4 = button(exporter, '导出 MP4');
  await expect(mp4).toHaveAttribute('aria-selected', 'true');
  await checkLayout(exporter, mp4, other, path, exportMp4);
  await exporter.getByLabel('画面比例', { exact: true }).selectOption('9:16');
  await expect(exporter.locator('.export-dialog__preview figcaption')).toContainText('180 × 320');
  await page.screenshot({ path: join(artifacts, 'desktop-compact-export-mp4.png') });
  const destination = join(fixture, '窄窗口 竖屏导出.mp4');
  await path.fill(destination);
  await mp4.press('ArrowRight'); await expect(other).toBeFocused();
  await expect(exportMp4).toHaveCount(0);
  const capCut = button(exporter, '剪映／CapCut 工程');
  await checkLayout(exporter, capCut, button(exporter, '多比例批量导出'), button(exporter, '导出字幕'), button(exporter, '导出分镜'));
  await page.screenshot({ path: join(artifacts, 'desktop-compact-export-other.png') });
  await capCut.click();
  const editorExport = page.getByRole('dialog', { name: '剪映／CapCut 工程导出', exact: true });
  await expect(editorExport).toBeVisible();
  await page.keyboard.press('Escape'); await expect(editorExport).toHaveCount(0); await expect(capCut).toBeFocused();
  await other.press('ArrowLeft'); await expect(mp4).toBeFocused();
  await expect(path).toHaveValue(destination); await expect(exporter.getByLabel('画面比例', { exact: true })).toHaveValue('9:16');
  await exportMp4.click();
  await expect(exporter.getByText(/文件已保存/)).toBeVisible({ timeout: 30_000 });
  assert.ok((await stat(destination)).size > 500);
  const ffprobe = environment.VIDEO_QUICKLY_FFPROBE ?? join(dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  const { stdout } = await execute(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', destination], { env: environment, windowsHide: true });
  assert.deepEqual(JSON.parse(stdout).streams, [{ width: 180, height: 320 }]);
  await button(exporter, '关闭对话框').click(); await expect(exporter).toHaveCount(0); await expect(openExport).toBeFocused();
  checks.compactExport = true;
}
