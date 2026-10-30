import { expect, test } from '@playwright/test';

test('loads the built browser client and receives real runtime notifications without development modules', async ({ page, request }, info) => {
  const errors: string[] = [], paths: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => paths.push(new URL(request.url()).pathname));
  const events: string[] = [], network = await page.context().newCDPSession(page);
  await network.send('Network.enable'); network.on('Network.eventSourceMessageReceived', event => events.push(event.data));
  await page.goto('/'); await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toBeVisible();
  await expect.poll(() => paths.includes('/__desktop_events')).toBe(true);
  const response = await request.post('/__desktop_rpc', { data: { method: 'project.create', params: { title: '构建产物与真实事件验收' } } });
  expect(response.ok()).toBe(true); const payload = await response.json(); expect(payload.error).toBeUndefined();
  await expect.poll(() => events.some(event => JSON.parse(event).type === 'workspace.changed')).toBe(true);
  await expect(page.getByRole('button', { name: `打开项目：${payload.result.title}`, exact: true })).toBeVisible();
  expect(paths.some(path => path.startsWith('/assets/'))).toBe(true);
  expect(paths.filter(path => /^\/(?:src\/|@vite\/|@react-refresh)/.test(path))).toEqual([]);
  await page.screenshot({ path: info.outputPath('browser-bundle-ready.png') });
  expect(errors).toEqual([]);
});
