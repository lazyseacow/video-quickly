import { openProjectFromList } from './workspace-navigation';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ProjectDocument } from '@video-quickly/contracts';

// Trace recording changes the timing under observation. Functional editor
// regressions retain their normal failure traces in project-editing.spec.ts.
test.use({ trace: 'off' });
const sourceFiles = ['src/renderer/App.tsx', 'src/renderer/features/Workbench.tsx', 'src/renderer/features/use-workbench-production.ts', 'src/renderer/lib/project-edits.ts', 'src/renderer/lib/use-project-edits.ts', 'src/renderer/components/ScenePreview.tsx'];
const source = {
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
  sha256: Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')])),
};

async function rpc(request: APIRequestContext, method: string, params: unknown = {}) {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json();
  expect(payload.error).toBeUndefined();
  return payload.result;
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function createProject(request: APIRequestContext, title: string, shotCount = 2) {
  const project = await rpc(request, 'project.create', { title });
  return rpc(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: Array.from({ length: shotCount }, (_, index) => ({ id: `shot-${index}`, title: `测试镜头 ${index + 1}`, narration: '', visualPrompt: '', durationUs: 2_000_000 })) } });
}
async function waitForEditor(page: Page, project: Pick<ProjectDocument, 'title' | 'shots'>) {
  await page.waitForFunction(({ title, count }) => [...document.querySelectorAll<HTMLElement>('.workbench')].some(root =>
    root.querySelector<HTMLInputElement>('input[aria-label="项目名称"]')?.value === title && root.querySelectorAll('.outline-shot').length === count &&
    root.getClientRects().length > 0 && getComputedStyle(root).visibility === 'visible'), { title: project.title, count: project.shots.length });
  await expect(page.getByLabel('镜头标题', { exact: true })).toBeVisible();
}
async function openProject(page: Page, project: Pick<ProjectDocument, 'title' | 'shots'>) {
  await page.goto('/');
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.locator('.project-card').filter({ hasText: project.title }).getByRole('button', { name: /继续创作/ }).click();
  await waitForEditor(page, project);
}

for (const shotCount of [200, 1000]) test(`loads ${shotCount} shots without snapshot or hidden historical reads and keeps controls responsive`, async ({ page, request, browser }, info) => {
  test.setTimeout(60_000);
  const project = await createProject(request, `${shotCount} 镜头读取验收`, shotCount);
  const methods: string[] = []; const errors: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/__desktop_rpc')) methods.push(request.postDataJSON().method); });
  page.on('pageerror', error => errors.push(error.message));
  const started = Date.now();
  await openProject(page, project);
  await expect(page.locator('.outline-shot')).toHaveCount(shotCount);
  const openMs = Date.now() - started;
  const editStarted = Date.now();
  await page.getByLabel('镜头标题', { exact: true }).fill('大项目中的编辑');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('测试镜头 1');
  const editMs = Date.now() - editStarted;
  const selectStarted = Date.now();
  await page.locator('.outline-shot').last().click();
  await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue(`测试镜头 ${shotCount}`);
  const selectMs = Date.now() - selectStarted;
  const ruler = page.getByRole('slider', { name: '预览播放位置' });
  await ruler.press('End'); await expect(ruler).toHaveAttribute('aria-valuenow', String(Math.round(shotCount * 2000 - 1000 / 30)));
  await page.getByLabel('镜头标题', { exact: true }).fill('待恢复的大项目草稿');
  await expect.poll(() => page.evaluate(async ({ id, last }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open('video-quickly-drafts', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const read = db.transaction('projects').objectStore('projects').getAll();
        read.onsuccess = () => resolve(read.result.some(value => value.projectId === id && value.selectedShotId === `shot-${last}` && value.present.shots[last]?.title === '待恢复的大项目草稿'));
        read.onerror = () => reject(read.error);
      });
    } finally { db.close(); }
  }, { id: project.id, last: shotCount - 1 })).toBe(true);
  const recoveryStarted = Date.now();
  await page.reload();
  // Large-project readiness is measured within this case's budget, with every shot restored.
  await openProjectFromList(page, project.title, { waitForReady: false });
  await waitForEditor(page, project);
  await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('待恢复的大项目草稿');
  const recoveryMs = Date.now() - recoveryStarted;
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue(`测试镜头 ${shotCount}`);
  const heldRedo = gate(), releaseRedo = gate();
  const isRedoSave = (input: { method?: string; params?: { projectId?: string; patch?: { shots?: Array<{ id: string; title: string }> } } }) =>
    input.method === 'project.update' && input.params?.projectId === project.id && input.params.patch?.shots?.at(-1)?.id === `shot-${shotCount - 1}` && input.params.patch.shots.at(-1)?.title === '待恢复的大项目草稿';
  await page.route('**/__desktop_rpc', async route => {
    if (!isRedoSave(route.request().postDataJSON())) { await route.continue(); return; }
    const response = await route.fetch(); heldRedo.release(); await releaseRedo.promise; await route.fulfill({ response });
  });
  const savedRedo = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && isRedoSave(response.request().postDataJSON()), { timeout: 0 })
    .then(response => ({ response }), error => ({ error }));
  try {
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('待恢复的大项目草稿');
    await heldRedo.promise;
    // History updates optimistically; its restored title does not acknowledge the save.
    await expect(page.getByRole('button', { name: '正在保存修改', exact: true })).toBeDisabled();
    releaseRedo.release();
    const receipt = await savedRedo; if ('error' in receipt) throw receipt.error;
    expect(receipt.response.ok()).toBe(true);
    const body = await receipt.response.json(), submitted = receipt.response.request().postDataJSON();
    expect(body.error).toBeUndefined(); expect(body.result.id).toBe(project.id);
    expect(body.result.revision).toBe(submitted.params.revision + 1);
    expect(body.result.shots.at(-1)).toMatchObject({ id: `shot-${shotCount - 1}`, title: '待恢复的大项目草稿' });
    // Keep this wait within the case budget without repeatedly traversing the large accessibility tree.
    await page.waitForFunction(title => [...document.querySelectorAll<HTMLElement>('.workbench')].some(root =>
      root.querySelector<HTMLInputElement>('input[aria-label="项目名称"]')?.value === title && root.getClientRects().length > 0 && getComputedStyle(root).visibility === 'visible' &&
      !root.querySelector('button[aria-label="正在保存修改"]') && root.querySelector<HTMLButtonElement>('button[aria-label="保存修改"]')?.disabled), project.title);
    await expect(page.getByRole('button', { name: '保存修改', exact: true })).toBeDisabled();
  } finally { releaseRedo.release(); await page.unrouteAll({ behavior: 'wait' }); }
  const cdp = await page.context().newCDPSession(page);
  const heap = await cdp.send('Runtime.getHeapUsage'); await cdp.detach();
  await page.screenshot({ path: info.outputPath('large-project-dark-1536.png') });
  expect(methods).not.toContain('workspace.snapshot'); expect(methods).not.toContain('run.events'); expect(methods).not.toContain('run.activities'); expect(methods).not.toContain('run.list'); expect(methods).not.toContain('asset.list');
  expect(errors).toEqual([]); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  const metrics = { source, machine: { platform: process.platform, architecture: process.arch, cpu: cpus()[0]?.model, memoryGiB: totalmem() / 1024 ** 3 }, measuredAt: new Date().toISOString(),
    shots: shotCount, viewport: page.viewportSize(), profile: project.profile, browser: browser.version(), trace: 'off', scope: 'Automated browser actions including locator queries; single sample, no latency threshold',
    openMs, editAndUndoMs: editMs, selectLastShotMs: selectMs, recoveryMs, heapUsedMiB: Math.round(heap.usedSize / 1024 / 1024 * 100) / 100, methods };
  await writeFile(info.outputPath('large-project-metrics.json'), JSON.stringify(metrics, null, 2));
  await info.attach('large-project-interactions', { body: JSON.stringify(metrics), contentType: 'application/json' });
});
