import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ProjectDocument, RunSummary } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json(); expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function fixture(request: APIRequestContext) {
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: `审阅指针归属 ${randomUUID().slice(0, 8)}` });
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: {
    shots: [{ id: 'shot', title: '保留镜头', narration: '', visualPrompt: '', durationUs: 1_000_000 }],
    workflow: { ...created.workflow, nodes: [
      { id: 'first', kind: 'brief', label: '第一步审阅', requiresReview: true },
      { id: 'second', kind: 'brief', label: '第二步审阅', requiresReview: true },
    ], edges: [{ id: 'next', source: 'first', target: 'second' }] },
  } });
  const run = await rpc<RunSummary>(request, 'run.start', { projectId: project.id });
  const current = () => rpc<RunSummary>(request, 'run.get', { runId: run.id });
  await expect.poll(async () => { const value = await current(); return [value.currentNodeId, value.status]; }).toEqual(['first', 'waiting_review']);
  return { project, current, run: await current() };
}
async function open(page: Page, project: ProjectDocument) {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/');
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.getByLabel('搜索项目', { exact: true }).fill(project.title);
  await page.locator('.project-card').filter({ hasText: project.title }).getByRole('button', { name: '继续创作', exact: true }).click();
  await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(project.title);
}

for (const surface of ['workbench', 'history'] as const) {
  test(`does not approve a new checkpoint when a held pointer is released in ${surface}`, async ({ page, request }) => {
    const source = await fixture(request); await open(page, source.project);
    if (surface === 'history') {
      await page.getByRole('button', { name: '制作记录', exact: true }).click();
      await page.getByLabel('制作项目', { exact: true }).selectOption(source.project.id);
    } else await page.getByLabel('镜头标题', { exact: true }).fill('保留按住指针期间的镜头草稿');
    const panel = surface === 'workbench' ? page.getByRole('region', { name: '当前制作', exact: true }) : page.locator(`.run-card[data-run-id="${source.run.id}"]`);
    const approve = panel.getByRole('button', { name: surface === 'workbench' ? '通过审阅并继续' : '通过审阅', exact: true });
    await expect(approve).toBeEnabled();
    if (surface === 'workbench') await expect(panel.locator('.workbench-production__heading strong')).toHaveText('第一步审阅');
    let releaseReads!: () => void;
    const advanced = new Promise<void>(resolve => { releaseReads = resolve; });
    const reviews: unknown[] = [];
    await page.route('**/__desktop_rpc', async route => {
      const input = route.request().postDataJSON();
      if (['workspace.summary', 'project.get', 'run.inspect', 'run.list'].includes(input.method)) await advanced;
      if (input.method === 'run.review') reviews.push(input.params);
      await route.continue();
    });
    try {
      await approve.scrollIntoViewIfNeeded();
      const bounds = await approve.boundingBox(); expect(bounds).not.toBeNull();
      await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2); await page.mouse.down();
      await rpc(request, 'run.review', { runId: source.run.id, approved: true, expectedNodeId: source.run.currentNodeId, expectedUpdatedAt: source.run.updatedAt });
      await expect.poll(async () => { const value = await source.current(); return [value.currentNodeId, value.status]; }).toEqual(['second', 'waiting_review']);
      const second = await source.current(); releaseReads();
      if (surface === 'workbench') await expect(panel.locator('.workbench-production__heading strong')).toHaveText('第二步审阅');
      else await expect(panel.locator('.run-card__meta')).toContainText(`${second.completedNodeIds.length} 个步骤已完成`);
      await expect(approve).toBeEnabled(); await page.mouse.up();
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      expect(reviews).toEqual([]);
      expect(await source.current()).toEqual(second);
      if (surface === 'workbench') await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('保留按住指针期间的镜头草稿');
      await approve.click();
      await expect.poll(async () => (await source.current()).status).toBe('succeeded');
      expect(reviews).toEqual([{ runId: second.id, approved: true, expectedNodeId: second.currentNodeId, expectedUpdatedAt: second.updatedAt }]);
      expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: source.project.id })).project).toEqual(source.project);
    } finally { releaseReads(); await page.mouse.up(); await page.unrouteAll({ behavior: 'wait' }); }
  });
}
