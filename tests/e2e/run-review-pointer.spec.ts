import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ProjectDocument, RunSummary } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json(); expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function fixture(request: APIRequestContext) {
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: `自动流程展示 ${randomUUID().slice(0, 8)}` });
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: {
    shots: [{ id: 'shot', title: '保留镜头', narration: '', visualPrompt: '', durationUs: 1_000_000 }],
    workflow: { ...created.workflow, id: 'custom-pointer-review', stages: undefined, nodes: [
      { id: 'first', kind: 'brief', label: '第一步生成', requiresReview: true },
      { id: 'second', kind: 'brief', label: '第二步生成', requiresReview: true },
    ], edges: [{ id: 'next', source: 'first', target: 'second' }] },
  } });
  const runId = (await rpc<RunSummary>(request, 'run.start', { projectId: project.id })).id;
  const current = () => rpc<RunSummary>(request, 'run.get', { runId });
  await expect.poll(async () => (await current()).status).toBe('succeeded');
  return { project, current };
}
async function open(page: Page, project: ProjectDocument) {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/');
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.getByLabel('搜索项目', { exact: true }).fill(project.title);
  await page.locator('.project-card').filter({ hasText: project.title }).getByRole('button', { name: '继续创作', exact: true }).click();
  await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(project.title);
}

test('shows automatic completion for legacy review flags in the workbench', async ({ page, request }) => {
  const source = await fixture(request), reviews: unknown[] = [];
  page.on('request', request => { if (request.url().endsWith('/__desktop_rpc') && request.postDataJSON()?.method === 'run.review') reviews.push(request.postDataJSON().params); });
  await open(page, source.project);
  const panel = page.getByRole('region', { name: '当前制作', exact: true });
  await expect(panel).toContainText('已完成');
  await expect(panel).not.toContainText('等待审阅');
  await panel.getByRole('button', { name: '打开步骤：第二步生成', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '本次制作', exact: true });
  await expect(detail.getByRole('navigation', { name: '本阶段制作步骤', exact: true })).toContainText('第二步生成');
  await expect(detail.getByRole('tab', { name: '制作信息', exact: true })).toHaveCount(0);
  await expect(detail).not.toContainText('人工审阅'); await expect(detail.getByRole('button', { name: /通过审阅|停止并修改/ })).toHaveCount(0);
  await detail.getByRole('button', { name: '关闭对话框', exact: true }).click();
  expect(reviews).toEqual([]); expect((await source.current()).completedNodeIds).toEqual(['first', 'second']);
  expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: source.project.id })).project).toEqual(source.project);
});
