import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ProjectDocument } from '@video-quickly/contracts';

interface DraftOrderProbe { writes: number; queued: number; submissions: number; release(): Promise<void>; restore(): Promise<void> }
interface DraftFaultProbe { reject: boolean; holdNext: boolean; deferred: number; release(): void; restore(): void }
declare global { interface Window { __vqDraftOrder?: DraftOrderProbe; __vqDraftFault?: DraftFaultProbe } }
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json(); expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function fixture(request: APIRequestContext, title: string) {
  const created = await rpc<ProjectDocument>(request, 'project.create', { title });
  return rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: { shots: [{ id: 'draft-order-shot', title: '原始镜头', narration: '', visualPrompt: '', durationUs: 1_000_000 }] } });
}
async function openProject(page: Page, project: ProjectDocument) {
  await page.goto('/');
  await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
  await expect(page.getByLabel('镜头标题', { exact: true })).toBeVisible();
}
async function current(request: APIRequestContext, projectId: string) { return (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId })).project; }
async function pendingUndoStored(page: Page, projectId: string) {
  return page.evaluate(async projectId => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open('video-quickly-drafts', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    return new Promise<boolean>((resolve, reject) => {
      const request = db.transaction('projects').objectStore('projects').getAll();
      request.onsuccess = () => { const saved = request.result.find(value => value.projectId === projectId); db.close(); resolve(saved?.base.shots[0].title === '已提交的新镜头' && saved?.present.shots[0].title === '原始镜头'); };
      request.onerror = () => { db.close(); reject(request.error); };
    });
  }, projectId);
}
async function holdDraftWrites(page: Page, projectId: string) {
  await page.evaluate(async projectId => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open('video-quickly-drafts', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    // An ordinary exclusive transaction delays subsequent real writes. Repeated
    // reads keep it active; no draft value or business response is replaced.
    const transaction = db.transaction('projects', 'readwrite'), store = transaction.objectStore('projects');
    let holding = true;
    const finished = new Promise<void>((resolve, reject) => { transaction.oncomplete = () => { db.close(); resolve(); }; transaction.onabort = () => { db.close(); reject(transaction.error); }; });
    function keepActive() { const request = store.get('__draft_order_gate__'); request.onsuccess = () => { if (holding) keepActive(); }; }
    keepActive();
    const put = IDBObjectStore.prototype.put, fetch = window.fetch;
    const probe: DraftOrderProbe = { writes: 0, queued: 0, submissions: 0,
      async release() { holding = false; await finished; },
      async restore() { IDBObjectStore.prototype.put = put; window.fetch = fetch; await this.release(); },
    };
    window.__vqDraftOrder = probe;
    IDBObjectStore.prototype.put = function(...args) {
      const value = args[0] as { projectId?: string; present?: { shots?: Array<{ title?: string }> } };
      if (this.transaction.db.name === 'video-quickly-drafts' && value?.projectId === projectId) { probe.queued++; if (value.present?.shots?.[0]?.title === '已提交的新镜头') probe.writes++; }
      return Reflect.apply(put, this, args);
    };
    window.fetch = function(...args) {
      const body = typeof args[1]?.body === 'string' ? JSON.parse(args[1].body) : undefined;
      if (body?.method === 'project.update' && body.params.projectId === projectId && body.params.patch.shots?.[0]?.title === '已提交的新镜头') probe.submissions++;
      return Reflect.apply(fetch, this, args);
    };
  }, projectId);
}

test('persists the redo intent before submitting its save and restores it after a committed reply is lost', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const project = await fixture(request, '保存意图与旧撤销草稿的顺序');
  const undoReply = gate(), undoCommitted = gate(), redoReply = gate(), redoCommitted = gate();
  try {
    await openProject(page, project);
    await page.getByLabel('镜头标题', { exact: true }).fill('已提交的新镜头'); await page.getByRole('button', { name: '保存镜头', exact: true }).click();
    await expect.poll(async () => (await current(request, project.id)).shots[0].title).toBe('已提交的新镜头');
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeEnabled();
    await page.route('**/__desktop_rpc', async route => {
      const input = route.request().postDataJSON();
      if (input.method !== 'project.update' || input.params.projectId !== project.id) { await route.continue(); return; }
      const response = await route.fetch();
      if (input.params.patch.shots[0].title === '原始镜头') { undoCommitted.release(); await undoReply.promise; }
      else { redoCommitted.release(); await redoReply.promise; }
      await route.fulfill({ response });
    });
    await page.getByRole('button', { name: '撤销', exact: true }).click(); await undoCommitted.promise;
    await expect.poll(() => pendingUndoStored(page, project.id)).toBe(true);
    await holdDraftWrites(page, project.id); undoReply.release();
    const redo = page.getByRole('button', { name: '重做', exact: true }); await expect(redo).toBeEnabled(); await redo.click();
    await expect.poll(() => page.evaluate(() => window.__vqDraftOrder!.writes)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__vqDraftOrder!.submissions)).toBe(0);
    await page.evaluate(() => window.__vqDraftOrder!.restore()); await redoCommitted.promise;
    expect((await current(request, project.id)).shots[0].title).toBe('已提交的新镜头');
    // Keep the real committed HTTP reply pending across the page restart.
    await page.reload(); redoReply.release();
    await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
    await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('已提交的新镜头');
    await page.getByLabel('旁白', { exact: true }).fill('重启后的独立编辑'); await page.getByRole('button', { name: '保存镜头', exact: true }).click();
    await expect.poll(async () => (await current(request, project.id)).shots[0].narration).toBe('重启后的独立编辑');
    expect((await current(request, project.id)).shots[0].title).toBe('已提交的新镜头');
  } finally {
    undoReply.release(); redoReply.release();
    await page.evaluate(() => window.__vqDraftOrder?.restore());
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('reports unavailable draft storage while allowing a manual project save and later storage recovery', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const transaction = IDBDatabase.prototype.transaction, complete = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
    if (!complete?.get || !complete.set) throw new Error('IndexedDB completion delivery is unavailable');
    const callbacks: Array<() => void> = [];
    let holding = false;
    const captured: Array<{ transaction: IDBTransaction; listener: EventListener }> = [];
    const fault: DraftFaultProbe = { reject: false, holdNext: false, deferred: 0,
      release() { holding = false; for (const callback of callbacks.splice(0)) callback(); },
      restore() { this.release(); IDBDatabase.prototype.transaction = transaction; for (const item of captured) { Reflect.apply(complete.set!, item.transaction, [item.listener]); delete (item.transaction as { oncomplete?: unknown }).oncomplete; } },
    };
    window.__vqDraftFault = fault;
    IDBDatabase.prototype.transaction = function(...args) {
      const owned = this.name === 'video-quickly-drafts' && args[1] === 'readwrite';
      if (owned && fault.reject) throw new DOMException('隔离草稿写入故障', 'UnknownError');
      const created = Reflect.apply(transaction, this, args) as IDBTransaction;
      if (owned && fault.holdNext) {
        fault.holdNext = false; holding = true;
        let original: EventListener | null = null;
        Object.defineProperty(created, 'oncomplete', { ...complete,
          get() { return original; },
          set(listener: EventListener | null) {
            original = listener;
            if (!listener) { Reflect.apply(complete.set!, created, [listener]); return; }
            captured.push({ transaction: created, listener });
            Reflect.apply(complete.set!, created, [function(this: IDBTransaction, event: Event) {
              if (holding) { fault.deferred++; callbacks.push(() => Reflect.apply(listener, this, [event])); }
              else Reflect.apply(listener, this, [event]);
            }]);
          },
        });
      }
      return created;
    };
  });
  const project = await fixture(request, '草稿故障时保存项目');
  try {
    await openProject(page, project);
    await page.evaluate(() => { window.__vqDraftFault!.holdNext = true; });
    await page.getByLabel('镜头标题', { exact: true }).fill('较早的草稿写入');
    await expect.poll(() => page.evaluate(() => window.__vqDraftFault!.deferred)).toBeGreaterThan(0);
    await page.evaluate(() => { window.__vqDraftFault!.reject = true; });
    await page.getByLabel('镜头标题', { exact: true }).fill('仍可保存到项目'); await page.getByRole('button', { name: '保存镜头', exact: true }).click();
    await expect.poll(async () => (await current(request, project.id)).shots[0].title).toBe('仍可保存到项目');
    await expect(page.getByRole('button', { name: '保存修改', exact: true })).toBeDisabled();
    await expect(page.getByRole('alert')).toContainText('隔离草稿写入故障');
    await page.evaluate(() => window.__vqDraftFault!.release());
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole('alert')).toContainText('隔离草稿写入故障');
    await page.evaluate(() => { window.__vqDraftFault!.reject = false; });
    await page.getByLabel('旁白', { exact: true }).fill('恢复后的草稿写入'); await page.getByRole('button', { name: '保存镜头', exact: true }).click();
    await expect.poll(async () => (await current(request, project.id)).shots[0].narration).toBe('恢复后的草稿写入');
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally { await page.evaluate(() => window.__vqDraftFault?.restore()); }
});

test('reads queued selection writes before remounting the same project without crossing draft keys', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let first = await fixture(request, '选择草稿排写项目');
  first = await rpc<ProjectDocument>(request, 'project.update', { projectId: first.id, revision: first.revision, patch: { shots: [...first.shots, { ...first.shots[0], id: 'second-shot', title: '排写期间的第二镜头' }] } });
  const second = await fixture(request, '独立草稿键项目');
  try {
    await openProject(page, first); await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('原始镜头');
    await holdDraftWrites(page, first.id);
    await page.locator('.outline-shot').filter({ hasText: '排写期间的第二镜头' }).click();
    await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('排写期间的第二镜头');
    await expect.poll(() => page.evaluate(() => window.__vqDraftOrder!.queued)).toBeGreaterThan(0);
    await page.getByRole('button', { name: `打开项目：${second.title}`, exact: true }).click();
    await expect(page.getByText('正在读取项目与本地草稿…', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: `打开项目：${first.title}`, exact: true }).click();
    await expect(page.getByText('正在读取项目与本地草稿…', { exact: true })).toBeVisible();
    await page.evaluate(() => window.__vqDraftOrder!.restore());
    await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('排写期间的第二镜头');
    await page.getByRole('button', { name: `打开项目：${second.title}`, exact: true }).click();
    await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('原始镜头');
    expect((await current(request, first.id)).shots.map(shot => shot.title)).toEqual(['原始镜头', '排写期间的第二镜头']);
    expect((await current(request, second.id)).shots).toHaveLength(1);
  } finally { await page.evaluate(() => window.__vqDraftOrder?.restore()); }
});
