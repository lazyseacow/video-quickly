import { expect, test, type APIRequestContext } from '@playwright/test';
import type { ProjectDocument } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json(); expect(payload.error).toBeUndefined(); return payload.result;
}

for (const platform of [
  { browser: 'Win32', key: 'Control', label: 'Ctrl', prefix: 'D:' },
  { browser: 'MacIntel', key: 'Meta', label: '⌘', prefix: '/Users/you/' },
]) test(`matches ${platform.browser} shortcut and path hints while retaining editing and focus`, async ({ page, request }, info) => {
  // Only this isolated browser profile is emulated. Actual native input and
  // window/menu behavior remain separate Windows/macOS Electron gates.
  await page.addInitScript(value => Object.defineProperty(navigator, 'platform', { get: () => value }), platform.browser);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: `平台适配 ${platform.browser}` });
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: { shots: [{ id: 'platform-shot', title: '平台原镜头', narration: '', visualPrompt: '', durationUs: 1_000_000 }] } });
  await page.goto('/');
  await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
  await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('平台原镜头');
  await expect(page.locator('.statusbar .shortcut').filter({ hasText: '保存' })).toContainText(platform.label);
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toHaveAttribute('title', `撤销（${platform.label} Z）`);
  await expect(page.locator('.outline-shot').first()).toHaveAttribute('title', new RegExp(`${platform.label} 切换选择`));
  const field = page.getByLabel('镜头标题', { exact: true });
  await field.fill('平台键盘保存'); await field.press(`${platform.key}+s`);
  const saved = async () => (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project;
  await expect.poll(async () => (await saved()).shots[0].title).toBe('平台键盘保存');
  await page.getByRole('button', { name: '撤销', exact: true }).focus(); await page.keyboard.press(`${platform.key}+z`);
  await expect.poll(async () => (await saved()).shots[0].title).toBe('平台原镜头');
  await page.getByRole('button', { name: '重做', exact: true }).focus(); await page.keyboard.press(`${platform.key}+Shift+z`);
  await expect.poll(async () => (await saved()).shots[0].title).toBe('平台键盘保存');

  const create = page.getByRole('button', { name: '新建项目', exact: true }); await create.click();
  const dialog = page.getByRole('dialog', { name: '新建视频项目', exact: true });
  const title = dialog.getByLabel('项目名称', { exact: true });
  await expect(title).toBeFocused(); await title.fill(''); await title.pressSequentially('native input');
  // Chromium's native text editing uses the actual host modifier, even when
  // navigator.platform is emulated for the hint and application-level tests.
  await title.press('ControlOrMeta+z'); await expect(title).not.toHaveValue('native input');
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(create).toBeFocused();

  await page.getByRole('button', { name: '导出', exact: true }).click();
  const exporter = page.getByRole('dialog', { name: '导出视频', exact: true });
  await exporter.getByRole('tab', { name: '输出设置', exact: true }).click();
  const placeholder = await exporter.getByLabel('输出文件路径', { exact: true }).getAttribute('placeholder');
  expect(placeholder?.startsWith(platform.prefix)).toBe(true);
  expect(placeholder).not.toContain(String.fromCharCode(92).repeat(2));
  await page.keyboard.press('Escape'); await expect(exporter).toHaveCount(0);

  await page.getByRole('button', { name: '流程', exact: true }).click();
  await expect(page.locator('.flow-gestures')).toContainText(`${platform.label} + 滚轮缩放`);
  const canvas = page.locator('.react-flow__viewport');
  const zoom = () => canvas.evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).a);
  const before = await zoom();
  await page.locator('.react-flow__pane').hover({ position: { x: 20, y: 20 } });
  await page.keyboard.down(platform.key); await page.mouse.wheel(0, 120); await page.keyboard.up(platform.key);
  await expect.poll(zoom).not.toBe(before);
  await page.screenshot({ path: info.outputPath(`platform-${platform.browser}.png`) });
  expect(errors).toEqual([]);
});
