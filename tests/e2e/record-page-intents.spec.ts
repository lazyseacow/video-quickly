import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { SeriesTemplate } from '@video-quickly/contracts';

interface PageCommitProbe {
  armed: boolean; holding: boolean; deferred: number; expectedName: string;
  latest?: { items: Array<{ id: string }>; nextCursor: number | null };
  release(): void; restore(): void;
}
declare global { interface Window { __vqRecordPageCommit: PageCommitProbe } }

const clockOrigin = new Date('2026-01-01T00:00:00Z');
async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json(); expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function openLibrary(page: Page, request: APIRequestContext, suffix: string) {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.clock.install({ time: clockOrigin });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const prefix = `刷新期间分页 ${suffix}`;
  let target!: SeriesTemplate;
  for (let index = 0; index < 22; index++) {
    const saved = await rpc<SeriesTemplate>(request, 'seriesTemplate.save', { template: { name: `${prefix} ${index}`, description: '', settings: { style: '', captionStyle: null, scenePreset: null } } });
    if (index === 0) target = saved;
  }
  await page.goto('/'); await page.getByRole('button', { name: '系列模板', exact: true }).click();
  const cards = page.locator('.series-template-card'), button = page.getByRole('button', { name: '加载更多系列模板', exact: true });
  await expect(cards).toHaveCount(20); await expect(button).toBeEnabled();
  const targetCard = cards.filter({ hasText: target.name }); await expect(targetCard).toHaveCount(0);
  return { cards, button, targetCard, errors };
}
async function holdRefresh(page: Page, request: APIRequestContext, name: string, reject = false) {
  const held = gate(), release = gate(); let holding = true, captured = 0;
  const reads: Array<{ archived: boolean; before?: string; limit: number }> = [];
  await page.route('**/__desktop_rpc', async route => {
    const input = route.request().postDataJSON();
    if (input.method === 'seriesTemplate.list') {
      reads.push(input.params);
      if (holding && !input.params.archived && !input.params.before && input.params.limit === 20) {
        captured++;
        const response = await route.fetch(); held.release(); await release.promise;
        if (reject) await route.fulfill({ status: 400, json: { error: '隔离的刷新读取失败' } });
        else await route.fulfill({ response });
        return;
      }
    }
    await route.continue();
  });
  await rpc(request, 'project.create', { title: name }); await held.promise;
  // The page is already validating from a real notification. Freeze further
  // debounce delivery only while this case establishes its owned interleaving.
  await page.clock.pauseAt(new Date(clockOrigin.getTime() + 2 * test.info().timeout));
  return { release: () => { holding = false; release.release(); }, heldCount: () => captured, reads };
}

test('accepts one real double-click during background validation and expands the captured first page', async ({ page, request }, info) => {
  const library = await openLibrary(page, request, '当前读取兑现');
  const refresh = await holdRefresh(page, request, '通知触发已挂起的系列库刷新');
  try {
    await expect(library.button).toBeEnabled();
    await library.button.dblclick(); await expect(library.button).toBeDisabled();
    expect(refresh.reads.filter(read => read.before)).toHaveLength(0);
    await page.screenshot({ path: info.outputPath('paging-intent-during-refresh.png') });
    refresh.release(); await expect(library.targetCard).toBeVisible();
    expect(await library.cards.count()).toBeGreaterThan(20); expect(await library.cards.count()).toBeLessThanOrEqual(40);
    expect(refresh.reads.filter(read => read.before)).toHaveLength(1);
    expect(library.errors).toEqual([]);
  } finally { refresh.release(); await page.unrouteAll({ behavior: 'wait' }); await page.clock.resume(); }
});

test('carries an accepted background pagination intent into the next version and ignores the older first page', async ({ page, request }) => {
  const library = await openLibrary(page, request, '新版本兑现');
  const refresh = await holdRefresh(page, request, '新版本前的挂起刷新');
  try {
    await expect(library.button).toBeEnabled(); await library.button.click(); await expect(library.button).toBeDisabled();
    await page.clock.resume();
    await rpc(request, 'project.create', { title: '分页意图登记后的真实新版本' });
    await expect(library.targetCard).toBeVisible();
    expect(refresh.reads.some(read => !read.archived && !read.before && read.limit === 40)).toBe(true);
    const oldResponse = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.method === 'seriesTemplate.list' && response.request().postDataJSON()?.params.limit === 20);
    refresh.release(); await (await oldResponse).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(library.targetCard).toBeVisible(); expect(await library.cards.count()).toBeGreaterThan(20); expect(await library.cards.count()).toBeLessThanOrEqual(40);
    expect(library.errors).toEqual([]);
  } finally { refresh.release(); await page.unrouteAll({ behavior: 'wait' }); await page.clock.resume(); }
});

test('retains the cursor on a queued pagination error and expands only after an explicit retry', async ({ page, request }) => {
  const library = await openLibrary(page, request, '错误重试');
  const refresh = await holdRefresh(page, request, '分页错误前的挂起刷新', true);
  try {
    await expect(library.button).toBeEnabled(); await library.button.click(); refresh.release();
    await expect(page.getByRole('alert')).toContainText('隔离的刷新读取失败');
    await expect(library.cards).toHaveCount(20); await expect(library.button).toBeEnabled();
    await page.clock.resume();
    const notified = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.status() === 200 && response.request().postDataJSON()?.method === 'seriesTemplate.list' && response.request().postDataJSON()?.params.archived === false && response.request().postDataJSON()?.params.limit === 20);
    await rpc(request, 'project.create', { title: '分页错误后的无关通知' });
    await (await notified).finished();
    await expect.poll(() => refresh.reads.filter(read => !read.before && read.limit === 20).length).toBeGreaterThan(1);
    await expect(library.cards).toHaveCount(20);
    expect(refresh.reads.some(read => read.before || read.limit > 20)).toBe(false);
    await library.button.click(); await expect(library.targetCard).toBeVisible();
    expect(await library.cards.count()).toBeLessThanOrEqual(40);
    expect(refresh.reads.some(read => read.before || read.limit > 20)).toBe(true);
    expect(library.errors).toEqual(Array.from({ length: refresh.heldCount() }, () => 'Failed to load resource: the server responded with a status of 400 (Bad Request)'));
  } finally { refresh.release(); await page.unrouteAll({ behavior: 'wait' }); await page.clock.resume(); }
});

test('drops a queued pagination intent on a filter change while ignoring the old response', async ({ page, request }) => {
  const library = await openLibrary(page, request, '筛选隔离');
  const refresh = await holdRefresh(page, request, '筛选切换前的挂起刷新');
  try {
    await expect(library.button).toBeEnabled(); await library.button.click();
    await page.getByRole('button', { name: '已归档模板', exact: true }).click();
    await expect.poll(() => refresh.reads.some(read => read.archived)).toBe(true);
    const oldResponse = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.method === 'seriesTemplate.list' && response.request().postDataJSON()?.params.archived === false);
    refresh.release(); await (await oldResponse).finished();
    await page.getByRole('button', { name: '可用模板', exact: true }).click();
    await expect(library.cards).toHaveCount(20); await expect(library.targetCard).toHaveCount(0); await expect(library.button).toBeEnabled();
    expect(refresh.reads.some(read => read.before || read.limit > 20)).toBe(false);
    expect(library.errors).toEqual([]);
  } finally { refresh.release(); await page.unrouteAll({ behavior: 'wait' }); await page.clock.resume(); }
});

test('uses the last successful page cursor when a real click precedes its React commit', async ({ page, request }) => {
  await page.addInitScript(() => {
    const callbacks: Array<() => void> = [];
    const message = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
    if (!message?.get || !message.set) throw new Error('MessagePort message delivery is unavailable');
    const read = message.get, write = message.set, fetch = window.fetch;
    const listeners = new Map<MessagePort, NonNullable<MessagePort['onmessage']>>();
    const probe: PageCommitProbe = { armed: false, holding: false, deferred: 0, expectedName: '提交间隔新插入的模板',
      release() { this.holding = false; for (const callback of callbacks.splice(0)) callback(); },
      restore() {
        this.release();
        for (const [port, listener] of listeners) Reflect.apply(write, port, [listener]);
        listeners.clear(); Object.defineProperty(MessagePort.prototype, 'onmessage', message); window.fetch = fetch;
      },
    };
    window.__vqRecordPageCommit = probe;
    // Check at delivery: a null message can already be queued before the HTTP
    // response activates the gate, so intercepting postMessage alone is too late.
    Object.defineProperty(MessagePort.prototype, 'onmessage', { ...message,
      get: function(this: MessagePort) { return listeners.get(this) ?? Reflect.apply(read, this, []); },
      set: function(this: MessagePort, listener: MessagePort['onmessage']) {
        if (typeof listener !== 'function') { listeners.delete(this); Reflect.apply(write, this, [listener]); return; }
        listeners.set(this, listener);
        Reflect.apply(write, this, [function(this: MessagePort, event: MessageEvent) {
          if (probe.holding && event.data === null) { probe.deferred++; callbacks.push(() => Reflect.apply(listener, this, [event])); return; }
          return Reflect.apply(listener, this, [event]);
        }]);
      },
    });
    window.fetch = async (...args) => {
      const response = await fetch(...args);
      const body = typeof args[1]?.body === 'string' ? JSON.parse(args[1].body) : undefined;
      if (probe.armed && body?.method === 'seriesTemplate.list' && !body.params.before && body.params.archived === false) {
        const json = response.json.bind(response);
        response.json = async () => {
          const value = await json();
          if (probe.armed && value.result.items.some((item: SeriesTemplate) => item.name === probe.expectedName)) { probe.armed = false; probe.holding = true; probe.latest = value.result; }
          return value;
        };
      }
      return response;
    };
  });
  const probe = () => page.evaluate(() => { const { deferred, latest } = window.__vqRecordPageCommit; return { deferred, latest }; });
  const library = await openLibrary(page, request, '提交间隔游标');
  const previous = await rpc<{ items: SeriesTemplate[]; nextCursor: unknown }>(request, 'seriesTemplate.list', { archived: false, limit: 20 });
  const boundary = previous.items.at(-1)!;
  try {
    await page.evaluate(() => { window.__vqRecordPageCommit.armed = true; });
    const inserted = await rpc<SeriesTemplate>(request, 'seriesTemplate.save', { template: { name: '提交间隔新插入的模板', description: '', settings: { style: '', captionStyle: null, scenePreset: null } } });
    await expect.poll(async () => (await probe()).deferred).toBeGreaterThan(0);
    const accepted = (await probe()).latest!;
    expect(accepted.items.some(item => item.id === inserted.id)).toBe(true); expect(accepted.items.some(item => item.id === boundary.id)).toBe(false);
    await expect(page.getByRole('heading', { name: inserted.name, exact: true })).toHaveCount(0);
    await expect(library.cards).toHaveCount(20);
    const paging = page.waitForRequest(value => value.url().endsWith('/__desktop_rpc') && value.postDataJSON()?.method === 'seriesTemplate.list' && value.postDataJSON()?.params.before !== undefined);
    await library.button.click(); expect((await paging).postDataJSON().params.before).toEqual(accepted.nextCursor);
    await page.evaluate(() => window.__vqRecordPageCommit.release());
    await expect(page.getByRole('heading', { name: boundary.name, exact: true })).toBeVisible();
    const loaded = await library.cards.count(); expect(loaded).toBeGreaterThan(20);
    const refreshed = page.waitForResponse(value => value.url().endsWith('/__desktop_rpc') && value.request().postDataJSON()?.method === 'seriesTemplate.list' && value.request().postDataJSON()?.params.before === undefined);
    await rpc(request, 'project.create', { title: '提交间隔翻页后的真实刷新' });
    const response = await refreshed; expect(response.request().postDataJSON().params.limit).toBe(loaded); await response.finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(library.cards).toHaveCount(loaded); expect(library.errors).toEqual([]);
  } finally {
    await page.evaluate(() => window.__vqRecordPageCommit.restore());
    await page.clock.resume();
  }
});
