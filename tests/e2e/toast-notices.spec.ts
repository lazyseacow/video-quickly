import { createServer } from 'node:http';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

async function openModels(page: Page, request: APIRequestContext, title: string) {
  const created = await request.post('/__desktop_rpc', { data: { method: 'project.create', params: { title } } });
  expect(created.ok()).toBe(true);
  await page.goto('/'); await page.getByRole('button', { name: `打开项目：${title}`, exact: true }).click();
  await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(title);
  await page.getByRole('button', { name: '模型连接', exact: true }).click();
  await expect(page.getByRole('heading', { name: '模型连接', exact: true })).toBeVisible();
}

test('keeps short replacement messages on one line and wraps long notices within a narrow window', async ({ page, request }) => {
  const name = '提示排版验收';
  const saved = await request.post('/__desktop_rpc', { data: { method: 'model.save', params: { model: { name, provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'notice-layout', capabilities: ['text'] } } } });
  expect(saved.ok()).toBe(true);
  let text = '';
  await page.route('**/__desktop_rpc', route => route.request().postDataJSON().method === 'model.test' ? route.fulfill({ status: 200, json: { error: text } }) : route.continue());
  await openModels(page, request, `${name}项目`);
  const trigger = page.getByRole('button', { name: `检查“${name}”连接`, exact: true });
  const active = page.locator('.toast__entry:not(.toast__entry--leaving) .toast__message');
  for (const message of ['连接检查完成', '已请求继续执行', '连接检查完成', '已请求继续执行']) {
    text = message; await trigger.click(); await expect(active).toHaveText(message);
    const layout = await active.evaluate(element => ({ height: element.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(element).lineHeight) }));
    expect(layout.height).toBeLessThanOrEqual(layout.lineHeight + 1);
    await expect(page.locator('.toast__entry')).toHaveCount(1);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  text = '请检查模型服务地址和访问权限，核对后再重试。'.repeat(8);
  await trigger.click(); await expect(active).toHaveText(text);
  const bounds = await page.locator('.toast').boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await expect(page.getByRole('button', { name: '关闭提示', exact: true })).toBeInViewport();
  await page.getByRole('button', { name: '关闭提示', exact: true }).click(); await expect(page.locator('.toast-anchor')).toHaveCount(0);
});

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`replaces repeated notices vertically, keeps the latest timer and preserves action icons (${reducedMotion})`, async ({ page, request }) => {
    let calls = 0;
    let release: (() => void) | undefined;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const server = createServer((_incoming, response) => { void (async () => {
      calls++; if (calls === 1) await pending;
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'notice-fixture' }] }));
    })().catch(error => response.destroy(error instanceof Error ? error : undefined)); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('提示测试服务未启动');
    const name = `连续提示 ${reducedMotion}`;
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    try {
      const saved = await request.post('/__desktop_rpc', { data: { method: 'model.save', params: { model: { name, provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'notice-fixture', capabilities: ['text'] } } } });
      expect(saved.ok()).toBe(true);
      await page.emulateMedia({ reducedMotion });
      const time = new Date('2026-01-01T00:00:00Z');
      await page.clock.install({ time });
      await openModels(page, request, `${name}项目`);
      await expect(page.getByRole('button', { name: '添加模型', exact: true }).locator('svg')).toHaveCount(1);
      await expect(page.getByRole('button', { name: '新建项目', exact: true }).locator('svg')).toHaveCount(1);
      await page.clock.pauseAt(new Date(time.getTime() + 60_000));
      const trigger = page.getByRole('button', { name: `检查“${name}”连接`, exact: true });
      await expect(trigger.locator('svg')).toHaveCount(1);
      await trigger.click(); await expect.poll(() => calls).toBe(1);
      await expect(page.locator('.workspace-action-status')).toHaveCount(0);
      release?.();
      const active = page.locator('.toast__entry:not(.toast__entry--leaving)');
      await expect(active).toHaveText('连接检查完成'); await page.clock.runFor(300);
      const firstId = Number(await active.getAttribute('data-toast-id'));
      await trigger.click(); await expect.poll(() => calls).toBe(2);
      await expect.poll(async () => Number(await active.getAttribute('data-toast-id'))).toBeGreaterThan(firstId);
      const secondId = Number(await active.getAttribute('data-toast-id'));
      if (reducedMotion === 'no-preference') {
        await expect(page.locator('.toast__entry')).toHaveCount(2);
        await expect(page.locator('.toast__entry--leaving')).toHaveAttribute('aria-hidden', 'true');
        await page.clock.runFor(60);
        const movement = await page.locator('.toast__entry').evaluateAll(entries => entries.map(entry => new DOMMatrixReadOnly(getComputedStyle(entry).transform).m42));
        expect(movement[0]).toBeLessThan(0); expect(movement[1]).toBeGreaterThan(0);
      } else {
        await page.clock.runFor(32);
        await expect(page.locator('.toast__entry')).toHaveCount(1);
      }
      await trigger.click(); await expect.poll(() => calls).toBe(3);
      await expect.poll(async () => Number(await active.getAttribute('data-toast-id'))).toBeGreaterThan(secondId);
      expect(await page.locator('.toast__entry').count()).toBeLessThanOrEqual(2);
      await page.clock.runFor(300);
      await expect(page.locator('.toast__entry')).toHaveCount(1); await expect(active).toHaveText('连接检查完成');
      await page.clock.runFor(1699); await expect(page.locator('.toast')).toBeVisible();
      await page.clock.runFor(1);
      if (reducedMotion === 'no-preference') await expect(page.locator('.toast')).toHaveAttribute('inert', '');
      await page.clock.runFor(200); await expect(page.locator('.toast-anchor')).toHaveCount(0);
      await page.getByRole('button', { name: '制作记录', exact: true }).click();
      await expect(page.getByRole('button', { name: '刷新', exact: true }).locator('svg')).toHaveCount(1);
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByRole('button', { name: '新建项目', exact: true }).locator('svg')).toHaveCount(1);
      expect(errors).toEqual([]);
    } finally { release?.(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
}
