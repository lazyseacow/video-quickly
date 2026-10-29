import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ProjectDocument, WorkspaceSummary } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }); const payload = await response.json(); expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
function observe(page: Page) { const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); return errors; }
async function expectCleanChrome(page: Page) {
  await expect(page.locator('.topbar, .breadcrumb, .sidebar-local, .avatar')).toHaveCount(0);
  for (const text of ['本地工作区', '已连接本机', '项目与执行进度保存在本机']) await expect(page.getByText(text, { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('本地创作者', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toBeVisible(); await expect(page.getByRole('navigation', { name: '资源导航', exact: true })).toBeVisible(); await expect(page.locator('.sidebar').getByRole('button', { name: '新建项目', exact: true })).toBeVisible();
}

test('keeps one page heading and functional guidance after removing repeated desktop chrome and slogans', async ({ page, request }, info) => {
  const errors = observe(page); await page.goto('/'); await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toBeVisible(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const removed = ['从一个想法开始，把每个镜头打磨成自己的作品。', '收集画面、旁白与参考资料，把值得保留的素材带到下一次创作。', '把熟悉的创作方法带进工作流，让每个步骤遵循你的规范。'];
  for (const name of ['我的项目', '素材库', 'Skill 工作室', '模型连接']) {
    await page.getByRole('button', { name, exact: true }).click(); await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible(); await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1); await expectCleanChrome(page);
    for (const text of removed) await expect(page.getByText(text, { exact: true })).toHaveCount(0);
    if (name === 'Skill 工作室') {
      await expect(page.getByRole('heading', { name: '一个 Skill，一套创作方法', exact: true })).toHaveCount(0); await expect(page.getByRole('heading', { level: 2, name: '工具连接', exact: true })).toBeVisible(); await expect(page.getByText(/每次制作固定 Skill 版本/)).toBeVisible(); await expect(page.getByText(/工具需要单独启用/)).toBeVisible();
    }
    if (name === '模型连接') {
      await expect(page.getByRole('heading', { name: '让每个步骤各有所长', exact: true })).toHaveCount(0); await expect(page.getByText('Ollama 与 ComfyUI 连接到你已启动的本地服务。', { exact: true })).toBeVisible(); await expect(page.getByText(/密钥不会显示在项目、日志或导出文件中/)).toBeVisible();
      const workspace = await rpc<WorkspaceSummary>(request, 'workspace.summary'); if (!workspace.system.secureStorageAvailable) await expect(page.getByText('系统安全存储当前不可用，密钥仅在本次会话中使用。', { exact: true })).toBeVisible();
    }
  }
  await expect(page.locator('.statusbar')).toBeVisible(); await expect(page.locator('.statusbar-right')).toContainText('媒体引擎'); await expect(page.locator('.statusbar-right')).toContainText('播放 / 暂停'); await expect(page.locator('.statusbar-right')).toContainText('保存');
  await page.screenshot({ path: info.outputPath('workspace-cleanup-dark-1536.png') });
  await page.locator('.sidebar').getByRole('button', { name: '新建项目', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '新建视频项目', exact: true }); await expect(dialog).toBeVisible(); await expect(dialog.getByLabel('项目名称', { exact: true })).toBeFocused(); await expect(dialog.getByLabel('创意简报', { exact: true })).toBeVisible(); await dialog.getByRole('button', { name: '取消', exact: true }).click(); await expect(dialog).toHaveCount(0); expect(errors).toEqual([]);
});

test('keeps recovery feedback and editing actions on a compact light workspace without an empty footer', async ({ page, request }, info) => {
  const errors = observe(page); let project = await rpc<ProjectDocument>(request, 'project.create', { title: '精简工作区恢复验收', profile: { width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 }, fitMode: 'contain', previewScale: .5 } }); project = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: [{ id: 'cleanup-shot', title: '原镜头标题', narration: '', visualPrompt: '', durationUs: 1_000_000 }] } });
  await page.goto('/'); await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click(); await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('原镜头标题'); await page.getByRole('button', { name: '浅色外观', exact: true }).click(); await page.setViewportSize({ width: 600, height: 900 }); await expect(page.locator('html')).toHaveAttribute('data-theme', 'light'); await expectCleanChrome(page);
  await expect(page.locator('.statusbar')).toBeHidden(); const spacing = await page.locator('.main-shell').evaluate(element => { const body = element.querySelector('.page-body')!; return element.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom; }); expect(Math.abs(spacing)).toBeLessThan(1);
  const heading = page.locator('.project-heading-copy'); await expect(heading).toContainText('1 个镜头'); await expect(heading).toContainText(`修订 ${project.revision}`); await expect(heading).toContainText('640 × 360'); await expect(heading.getByText(/^(历史手绘|视频项目|·)$/)).toHaveCount(0);
  for (const name of ['画面与素材', '运镜', '配音']) await expect(page.getByRole('heading', { level: 3, name, exact: true })).toBeVisible();
  let rejected = false;
  await page.route('**/__desktop_rpc', async route => { if (!rejected && route.request().postDataJSON()?.method === 'project.update') { rejected = true; await route.abort('failed'); return; } await route.continue(); });
  await page.getByLabel('镜头标题', { exact: true }).fill('连接恢复后应保留的镜头草稿'); await page.getByRole('button', { name: '保存镜头', exact: true }).click(); await expect(page.getByText('本地执行组件已断开', { exact: true })).toBeVisible(); await expect(page.locator('.runtime-connection-notice')).toContainText('重新连接'); await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('连接恢复后应保留的镜头草稿'); await expect(page.locator('.unsaved-dot')).toHaveText('未保存');
  await page.getByRole('button', { name: '重新连接', exact: true }).click(); await expect(page.locator('.runtime-connection-notice')).toHaveCount(0); await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('连接恢复后应保留的镜头草稿');
  page.once('dialog', dialog => dialog.accept()); await page.reload(); await page.getByRole('button', { name: '我的项目', exact: true }).click(); await page.locator('.project-card').filter({ has: page.getByRole('heading', { name: project.title, exact: true }) }).getByRole('button', { name: '继续创作', exact: true }).click(); await expect(page.getByText('已恢复未保存的本地草稿，含撤销与重做历史。', { exact: true })).toBeVisible(); await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('连接恢复后应保留的镜头草稿'); await expectCleanChrome(page); await expect(page.locator('.statusbar')).toBeHidden();
  const save = page.getByRole('button', { name: '保存镜头', exact: true }); await expect(save).toBeEnabled(); await save.click(); await expect.poll(async () => (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project.shots[0].title).toBe('连接恢复后应保留的镜头草稿');
  const exportButton = page.getByRole('button', { name: '导出', exact: true }); await expect(exportButton).toBeEnabled();
  const controls = await page.locator('.project-heading').evaluate(element => ({ viewport: innerWidth, heading: element.getBoundingClientRect().toJSON(), actions: element.querySelector('.project-heading-actions')!.getBoundingClientRect().toJSON(), buttons: Array.from(element.querySelectorAll('button')).filter(button => button.checkVisibility()).map(button => ({ name: button.getAttribute('aria-label') || button.textContent, left: button.getBoundingClientRect().left, right: button.getBoundingClientRect().right })) }));
  expect(controls.buttons.filter(button => button.left < 52 || button.right > controls.viewport), JSON.stringify(controls)).toEqual([]);
  await exportButton.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('workspace-cleanup-light-600.png') }); await exportButton.click(); const dialog = page.getByRole('dialog', { name: '导出视频', exact: true }); await expect(dialog).toBeVisible(); await expect(dialog.getByRole('button', { name: '导出 MP4', exact: true })).toBeEnabled(); expect(errors).toEqual([]);
});
