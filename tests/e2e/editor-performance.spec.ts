import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Trace recording changes the timing under observation. Functional editor
// regressions retain their normal failure traces in project-editing.spec.ts.
test.use({ trace: 'off' });
const sourceFiles = ['apps/desktop/src/App.tsx', 'apps/desktop/src/lib/project-edits.ts', 'apps/desktop/src/lib/use-project-edits.ts', 'apps/desktop/src/components/ScenePreview.tsx'];
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
async function createProject(request: APIRequestContext, title: string, shotCount = 2) {
  const project = await rpc(request, 'project.create', { title });
  return rpc(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: Array.from({ length: shotCount }, (_, index) => ({ id: `shot-${index}`, title: `测试镜头 ${index + 1}`, narration: '', visualPrompt: '', durationUs: 2_000_000 })) } });
}
async function openProject(page: Page, title: string) {
  await page.goto('/');
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.locator('.project-card').filter({ hasText: title }).getByRole('button', { name: /继续创作/ }).click();
  await expect(page.getByLabel('镜头标题')).toBeVisible();
}

for (const shotCount of [200, 1000]) test(`loads ${shotCount} shots without snapshot or hidden historical reads and keeps controls responsive`, async ({ page, request, browser }, info) => {
  test.setTimeout(60_000);
  const project = await createProject(request, `${shotCount} 镜头读取验收`, shotCount);
  const methods: string[] = []; const errors: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/__desktop_rpc')) methods.push(request.postDataJSON().method); });
  page.on('pageerror', error => errors.push(error.message));
  const started = Date.now();
  await openProject(page, project.title);
  await expect(page.locator('.outline-shot')).toHaveCount(shotCount);
  const openMs = Date.now() - started;
  const editStarted = Date.now();
  await page.getByLabel('镜头标题').fill('大项目中的编辑');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByLabel('镜头标题')).toHaveValue('测试镜头 1');
  const editMs = Date.now() - editStarted;
  const selectStarted = Date.now();
  await page.locator('.outline-shot').last().click();
  await expect(page.getByLabel('镜头标题')).toHaveValue(`测试镜头 ${shotCount}`);
  const selectMs = Date.now() - selectStarted;
  const ruler = page.getByRole('slider', { name: '预览播放位置' });
  await ruler.press('End'); await expect(ruler).toHaveAttribute('aria-valuenow', String(Math.round(shotCount * 2000 - 1000 / 30)));
  await page.getByLabel('镜头标题').fill('待恢复的大项目草稿');
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
  await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
  await expect(page.getByLabel('镜头标题')).toHaveValue('待恢复的大项目草稿');
  const recoveryMs = Date.now() - recoveryStarted;
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByLabel('镜头标题')).toHaveValue(`测试镜头 ${shotCount}`);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(page.getByLabel('镜头标题')).toHaveValue('待恢复的大项目草稿');
  await expect(page.getByRole('button', { name: '保存修改', exact: true })).toBeDisabled();
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
