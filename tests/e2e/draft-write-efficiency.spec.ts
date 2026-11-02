import { openProjectFromList } from './workspace-navigation';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ProjectDocument } from '@video-quickly/contracts';

interface DraftWrite {
  projectId: string; key: string; revision: number; selectedShotId?: string; title?: string;
  putSyncMs: number; status: 'pending' | 'committed' | 'aborted';
}
interface DraftWriteProbe {
  records: DraftWrite[]; submissions: number; abortNext: boolean;
  reset(projectIds: string[]): void; restore(): void;
}
interface DraftWriteGate { release(): Promise<void> }
declare global { interface Window { __vqDraftWrites?: DraftWriteProbe; __vqDraftWriteGate?: DraftWriteGate } }

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json(); expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function fixture(request: APIRequestContext, title: string, count = 2) {
  const project = await rpc<ProjectDocument>(request, 'project.create', { title });
  return rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision,
    patch: { shots: Array.from({ length: count }, (_, index) => ({ id: `write-shot-${index}`, title: `原始镜头 ${index}`,
      narration: '用于草稿写入测量的固定旁白。'.repeat(8), visualPrompt: '固定画面要求。'.repeat(8), durationUs: 1_000_000 })) } });
}
async function openProject(page: Page, project: ProjectDocument) {
  await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/);
  await openProjectFromList(page, project.title);
  await page.waitForFunction(({ title, count }) => [...document.querySelectorAll<HTMLElement>('.workbench')].some(root =>
    root.querySelector<HTMLInputElement>('input[aria-label="项目名称"]')?.value === title && root.querySelectorAll('.outline-shot').length === count &&
    root.getClientRects().length > 0 && getComputedStyle(root).visibility === 'visible'), { title: project.title, count: project.shots.length });
  await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('原始镜头 0');
  await expect(page.getByRole('button', { name: '保存修改', exact: true })).toBeDisabled();
  await settleWrites(page);
}
async function settleWrites(page: Page) {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open('video-quickly-drafts', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    // A native transaction runs after earlier writes on this object store.
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('projects'); transaction.objectStore('projects').get('__write_efficiency_barrier__');
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    });
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}
async function installProbe(page: Page) {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put, fetch = window.fetch;
    let projects = new Set<string>();
    const probe: DraftWriteProbe = { records: [], submissions: 0, abortNext: false,
      reset(ids) { projects = new Set(ids); this.records = []; this.submissions = 0; this.abortNext = false; },
      restore() { IDBObjectStore.prototype.put = put; window.fetch = fetch; },
    };
    window.__vqDraftWrites = probe;
    IDBObjectStore.prototype.put = function(...args) {
      const value = args[0] as { projectId?: string; revision?: number; selectedShotId?: string; present?: { shots?: Array<{ title?: string }> } };
      const owned = this.transaction.db.name === 'video-quickly-drafts' && typeof value?.projectId === 'string' && projects.has(value.projectId);
      const started = performance.now();
      const result = Reflect.apply(put, this, args);
      const putSyncMs = performance.now() - started;
      if (owned) {
        const record: DraftWrite = { projectId: value.projectId!, key: String(args[1]), revision: value.revision!, selectedShotId: value.selectedShotId,
          title: value.present?.shots?.[0]?.title, putSyncMs, status: 'pending' };
        probe.records.push(record);
        this.transaction.addEventListener('complete', () => { record.status = 'committed'; }, { once: true });
        this.transaction.addEventListener('abort', () => { record.status = 'aborted'; }, { once: true });
        if (probe.abortNext) { probe.abortNext = false; this.transaction.abort(); }
      }
      return result;
    };
    window.fetch = function(...args) {
      if (typeof args[1]?.body === 'string') {
        const body = JSON.parse(args[1].body) as { method?: string; params?: { projectId?: string } };
        if (body.method === 'project.update' && body.params?.projectId && projects.has(body.params.projectId)) probe.submissions++;
      }
      return Reflect.apply(fetch, this, args);
    };
  });
}
async function reset(page: Page, ...ids: string[]) { await page.evaluate(ids => window.__vqDraftWrites!.reset(ids), ids); }
async function records(page: Page) { return page.evaluate(() => window.__vqDraftWrites!.records); }
async function evidence(page: Page, extra: Record<string, unknown> = {}) {
  const writes = await records(page);
  await test.info().attach('draft-write-measurements', { body: Buffer.from(JSON.stringify({ ...extra, writes,
    putCalls: writes.length, putSyncTotalMs: writes.reduce((sum, write) => sum + write.putSyncMs, 0) })), contentType: 'application/json' });
  return writes;
}
async function holdWrites(page: Page) {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open('video-quickly-drafts', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const transaction = db.transaction('projects', 'readwrite'), store = transaction.objectStore('projects');
    let holding = true;
    const complete = new Promise<void>((resolve, reject) => { transaction.oncomplete = () => { db.close(); resolve(); }; transaction.onabort = () => { db.close(); reject(transaction.error); }; });
    function keepActive() { const read = store.get('__write_efficiency_gate__'); read.onsuccess = () => { if (holding) keepActive(); }; }
    keepActive();
    window.__vqDraftWriteGate = { async release() { holding = false; await complete; } };
  });
}
async function clean(page: Page) { await expect(page.getByRole('button', { name: '保存修改', exact: true })).toBeDisabled(); await settleWrites(page); }
test.beforeEach(async ({ page }) => { await page.emulateMedia({ reducedMotion: 'reduce' }); await installProbe(page); });
test.afterEach(async ({ page }) => { await page.evaluate(async () => { await window.__vqDraftWriteGate?.release(); window.__vqDraftWrites?.restore(); }); });

for (const count of [200, 1000]) test(`writes the edit and saved baseline once each for ${count} shots`, async ({ page, request }) => {
  const project = await fixture(request, `大项目草稿写入 ${count}`, count); await openProject(page, project); await reset(page, project.id);
  await page.getByLabel('镜头标题', { exact: true }).fill('一次编辑意图');
  await page.getByRole('button', { name: '保存镜头', exact: true }).click(); await clean(page);
  const writes = await evidence(page, { shots: count });
  expect(writes.map(write => ({ revision: write.revision, title: write.title, status: write.status }))).toEqual([
    { revision: project.revision, title: '一次编辑意图', status: 'committed' },
    { revision: project.revision + 1, title: '一次编辑意图', status: 'committed' },
  ]);
});

test('does not rewrite the draft when the already selected shot is clicked', async ({ page, request }) => {
  const project = await fixture(request, '重复选择不复制完整草稿'); await openProject(page, project); await reset(page, project.id);
  const selected = page.locator('.outline-shot').first(); await expect(selected).toHaveAttribute('aria-pressed', 'true'); await selected.click();
  await settleWrites(page); const writes = await evidence(page); expect(writes).toEqual([]);
});

test('awaits the existing edit transaction before submitting a save without duplicating its snapshot', async ({ page, request }) => {
  const project = await fixture(request, '保存复用已排草稿事务'); await openProject(page, project); await reset(page, project.id);
  try {
    await holdWrites(page); await page.getByLabel('镜头标题', { exact: true }).fill('必须先落盘的意图');
    await expect.poll(async () => (await records(page)).length).toBe(1);
    await page.getByRole('button', { name: '保存镜头', exact: true }).click();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate(() => window.__vqDraftWrites!.submissions)).toBe(0);
    const queued = await evidence(page, { phase: 'checkpoint-held' }); expect(queued).toHaveLength(1); expect(queued[0].status).toBe('pending');
    await page.evaluate(() => window.__vqDraftWriteGate!.release()); await clean(page);
    expect(await page.evaluate(() => window.__vqDraftWrites!.submissions)).toBe(1);
    expect((await records(page)).map(write => write.status)).toEqual(['committed', 'committed']);
  } finally { await page.evaluate(() => window.__vqDraftWriteGate?.release()); }
});

test('retries a failed write of the same snapshot when project saving is requested', async ({ page, request }) => {
  const project = await fixture(request, '同意图失败后显式重试'); await openProject(page, project); await reset(page, project.id);
  await page.evaluate(() => { window.__vqDraftWrites!.abortNext = true; });
  await page.getByLabel('镜头标题', { exact: true }).fill('失败后仍需写入');
  await expect(page.getByRole('alert')).toContainText('草稿尚未写入本机');
  await page.getByRole('button', { name: '保存镜头', exact: true }).click(); await clean(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const writes = await evidence(page);
  expect(writes.filter(write => write.revision === project.revision).map(write => write.status)).toEqual(['aborted', 'committed']);
  expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project.shots[0].title).toBe('失败后仍需写入');
});

test('keeps pending writes owned by their project through A to B to A remounts', async ({ page, request }) => {
  const first = await fixture(request, '写入身份项目 A'), second = await fixture(request, '写入身份项目 B');
  await openProject(page, first); await reset(page, first.id, second.id);
  try {
    await holdWrites(page); await page.locator('.outline-shot').nth(1).click();
    await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('原始镜头 1');
    await expect.poll(async () => (await records(page)).length).toBeGreaterThan(0);
    await openProjectFromList(page, second.title);
    await expect(page.getByText('正在读取项目与本地草稿…', { exact: true })).toBeVisible();
    await openProjectFromList(page, first.title);
    await expect(page.getByText('正在读取项目与本地草稿…', { exact: true })).toBeVisible();
    await page.evaluate(() => window.__vqDraftWriteGate!.release());
    await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('原始镜头 1'); await clean(page);
    await openProjectFromList(page, second.title);
    await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('原始镜头 0'); await clean(page);
    const writes = await evidence(page);
    expect(writes.every(write => write.key.endsWith(`:${write.projectId}`))).toBe(true);
    expect(new Set(writes.map(write => write.key)).size).toBe(2);
    expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: first.id })).project).toEqual(first);
    expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: second.id })).project).toEqual(second);
  } finally { await page.evaluate(() => window.__vqDraftWriteGate?.release()); }
});
