import { openProjectFromList } from './workspace-navigation';
import { setWorkspaceTheme } from './workspace-settings';
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ProjectDocument } from '@video-quickly/contracts';

interface DraftRetryWrite { revision: number; selectedShotId?: string; title: string; undo: number; redo: number; status: 'pending' | 'committed' | 'aborted' }
interface DraftRetryProbe { projectId: string; abortNext: boolean; abortRevision?: number; records: DraftRetryWrite[]; restore(): void }
interface StoredDraft { revision: number; selectedShotId?: string; present: { shots: Array<{ title: string }> }; undo: unknown[]; redo: unknown[] }
declare global { interface Window { __vqDraftRetry?: DraftRetryProbe; __vqDraftRetryGate?: { release(): Promise<void> } } }
async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json(); expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function fixture(request: APIRequestContext) {
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: `本机草稿显式重试 ${randomUUID().slice(0, 8)}` });
  return rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: { shots: [0, 1].map(index => ({ id: `retry-${index}`, title: `原始镜头 ${index}`, narration: '', visualPrompt: '', durationUs: 1_000_000 })) } });
}
async function openProject(page: Page, project: ProjectDocument, navigate = true) {
  if (navigate) await page.goto('/');
  await openProjectFromList(page, project.title);
  await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('原始镜头 0');
}
async function stored(page: Page, projectId: string) {
  return page.evaluate(async projectId => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open('video-quickly-drafts', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    try { return await new Promise<StoredDraft | undefined>((resolve, reject) => { const read = db.transaction('projects').objectStore('projects').getAll(); read.onsuccess = () => resolve(read.result.find(value => value.projectId === projectId)); read.onerror = () => reject(read.error); }); }
    finally { db.close(); }
  }, projectId);
}
async function probe(page: Page, project: ProjectDocument) {
  await expect.poll(async () => (await stored(page, project.id))?.selectedShotId).toBe('retry-0');
  await page.evaluate(projectId => {
    const put = IDBObjectStore.prototype.put;
    const probe: DraftRetryProbe = { projectId, abortNext: false, records: [], restore() { IDBObjectStore.prototype.put = put; } };
    window.__vqDraftRetry = probe;
    IDBObjectStore.prototype.put = function(...args) {
      const result = Reflect.apply(put, this, args), value = args[0];
      if (this.transaction.db.name === 'video-quickly-drafts' && value?.projectId === projectId) {
        const record: DraftRetryWrite = { revision: value.revision, selectedShotId: value.selectedShotId, title: value.present.shots[0].title, undo: value.undo.length, redo: value.redo.length, status: 'pending' };
        probe.records.push(record);
        this.transaction.addEventListener('complete', () => { record.status = 'committed'; }, { once: true });
        this.transaction.addEventListener('abort', () => { record.status = 'aborted'; }, { once: true });
        if (probe.abortNext || probe.abortRevision === value.revision) { probe.abortNext = false; probe.abortRevision = undefined; this.transaction.abort(); }
      }
      return result;
    };
  }, project.id);
}
async function holdWrites(page: Page) {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open('video-quickly-drafts', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const transaction = db.transaction('projects', 'readwrite'), store = transaction.objectStore('projects'); let holding = true;
    const done = new Promise<void>((resolve, reject) => { transaction.oncomplete = () => { db.close(); resolve(); }; transaction.onabort = () => { db.close(); reject(transaction.error); }; });
    function keepActive() { const read = store.get('__draft_retry_gate__'); read.onsuccess = () => { if (holding) keepActive(); }; } keepActive();
    window.__vqDraftRetryGate = { async release() { holding = false; await done; } };
  });
}
function updates(page: Page, projectId: string) { const calls: unknown[] = []; page.on('request', request => { if (!request.url().endsWith('/__desktop_rpc')) return; const input = request.postDataJSON(); if (input.method === 'project.update' && input.params?.projectId === projectId) calls.push(input); }); return calls; }
let errors: string[];
test.beforeEach(async ({ page }) => { errors = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); }); await page.emulateMedia({ reducedMotion: 'reduce' }); });
test.afterEach(async ({ page }) => { await page.evaluate(async () => { await window.__vqDraftRetryGate?.release(); window.__vqDraftRetry?.restore(); }); expect(errors).toEqual([]); await expect(page).toHaveTitle(/Video Quickly/); await expect(page.locator('vite-error-overlay')).toHaveCount(0); });

test('retries a clean selection draft explicitly, keeps a repeated failure visible and waits for one native transaction', async ({ page, request }, info) => {
  const project = await fixture(request), calls = updates(page, project.id); await openProject(page, project); await probe(page, project);
  await page.evaluate(() => { window.__vqDraftRetry!.abortNext = true; }); await page.locator('.outline-shot').nth(1).click();
  await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('原始镜头 1');
  await expect(page.getByRole('alert')).toContainText('草稿尚未写入本机：草稿未能写入本机存储。');
  await expect(page.getByRole('alert')).not.toContainText('null');
  const retry = page.getByRole('button', { name: '重试保存草稿', exact: true }); await expect(retry).toBeVisible();
  await expect(page.getByRole('button', { name: '保存修改', exact: true })).toBeDisabled();
  await page.screenshot({ path: info.outputPath('draft-retry-dark.png') });
  await page.evaluate(() => { window.__vqDraftRetry!.abortNext = true; }); await retry.focus(); await expect(retry).toBeFocused(); await retry.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__vqDraftRetry!.records.map(record => record.status))).toEqual(['aborted', 'aborted']);
  await expect(page.getByRole('alert')).toContainText('草稿未能写入本机存储。'); await expect(retry).toBeEnabled();
  try {
    await holdWrites(page); await retry.focus(); await retry.press('Enter'); await expect(retry).toHaveAttribute('aria-busy', 'true'); await expect(retry).toBeDisabled();
    await page.keyboard.press('Enter'); expect(await page.evaluate(() => window.__vqDraftRetry!.records.length)).toBe(3);
    await page.evaluate(() => window.__vqDraftRetryGate!.release());
    await expect(page.getByRole('alert')).toHaveCount(0); await expect.poll(async () => (await stored(page, project.id))?.selectedShotId).toBe('retry-1');
    expect(calls).toHaveLength(0); expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project.revision).toBe(project.revision);
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: '重做', exact: true })).toBeDisabled();
  } finally { await page.evaluate(() => window.__vqDraftRetryGate?.release()); }
  await page.reload(); await openProjectFromList(page, project.title);
  await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('原始镜头 1'); expect(calls).toHaveLength(0);
});

test('retries the clean saved baseline without another project revision and remains usable in a narrow light window', async ({ page, request }, info) => {
  const project = await fixture(request), calls = updates(page, project.id); await openProject(page, project); await probe(page, project);
  await setWorkspaceTheme(page, 'light');
  await page.evaluate(revision => { window.__vqDraftRetry!.abortRevision = revision; }, project.revision + 1);
  await page.getByLabel('镜头标题', { exact: true }).fill('已提交项目的镜头'); await page.getByRole('button', { name: '保存镜头', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存修改', exact: true })).toBeDisabled(); await expect(page.getByRole('alert')).toContainText('草稿未能写入本机存储。');
  expect(calls).toHaveLength(1); await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeEnabled();
  await page.setViewportSize({ width: 600, height: 900 });
  const retry = page.getByRole('button', { name: '重试保存草稿', exact: true }); await expect(retry).toBeVisible();
  await page.screenshot({ path: info.outputPath('draft-retry-light-600.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); await retry.click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  const draft = await stored(page, project.id); expect(draft?.revision).toBe(project.revision + 1); expect(draft?.undo).toHaveLength(1); expect(draft?.redo).toHaveLength(0); expect(draft?.present.shots[0].title).toBe('已提交项目的镜头');
  expect(calls).toHaveLength(1); expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project.revision).toBe(project.revision + 1);
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeEnabled();
});

test('keeps an unread corrupt draft protected and offers manual project saving without an ineffective draft retry', async ({ page, request }) => {
  await page.goto('/'); await expect(page.getByLabel('镜头标题', { exact: true })).toBeVisible();
  const project = await fixture(request), calls = updates(page, project.id), workspace = await rpc<{ system: { dataDirectory: string } }>(request, 'workspace.summary');
  const corrupt = { projectId: project.id, version: 2, revision: project.revision, base: 'unreadable fixture', present: 'protected fixture', undo: [], redo: [] };
  await page.evaluate(async ({ key, corrupt }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open('video-quickly-drafts', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    await new Promise<void>((resolve, reject) => { const transaction = db.transaction('projects', 'readwrite'); transaction.objectStore('projects').put(corrupt, key); transaction.oncomplete = () => { db.close(); resolve(); }; transaction.onabort = () => { db.close(); reject(transaction.error); }; });
  }, { key: `${workspace.system.dataDirectory}:${project.id}`, corrupt });
  await openProject(page, project, false); await expect(page.getByRole('alert')).toContainText('草稿恢复失败');
  await expect(page.getByRole('button', { name: '重试保存草稿', exact: true })).toHaveCount(0);
  await page.getByLabel('镜头标题', { exact: true }).fill('恢复边界仍允许手动保存'); await page.getByRole('button', { name: '保存镜头', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存修改', exact: true })).toBeDisabled(); expect(calls).toHaveLength(1);
  expect(await stored(page, project.id)).toEqual(corrupt); await expect(page.getByRole('alert')).toContainText('草稿恢复失败');
  await expect(page.getByRole('button', { name: '重试保存草稿', exact: true })).toHaveCount(0);
});
