import { saveProduction } from './production-settings';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { ProjectDocument } from '@video-quickly/contracts';
import { openProjectFromList } from './workspace-navigation';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }), payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}

for (const conflict of [false, true]) test('preserves concurrent project settings with ' + (conflict ? 'a field conflict' : 'independent fields'), async ({ page, request }) => {
  const project = await rpc<ProjectDocument>(request, 'project.create', { title: '统一设置并发 ' + conflict, brief: '打开设置前的简报' });
  await page.goto('/'); await openProjectFromList(page, project.title);
  await page.locator('.project-heading-actions').getByRole('button', { name: '制作设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '制作设置', exact: true });
  await dialog.getByLabel('创作要求', { exact: true }).fill('本地正在编辑的创作要求');
  const patch = conflict ? { brief: '其他视图保存的创作要求' } : { profile: { ...project.profile, width: 640, height: 360 } };
  const remote = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch });
  await expect(page.locator('.project-heading-copy')).toHaveAttribute('data-revision', String(remote.revision));
  await saveProduction(dialog);
  if (conflict) {
    await expect(dialog.getByRole('alert')).toContainText('其他视图修改');
    await expect(dialog.getByLabel('创作要求', { exact: true })).toHaveValue('本地正在编辑的创作要求');
  } else await expect(dialog).toHaveCount(0);
  const saved = (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project;
  expect(saved.brief).toBe(conflict ? remote.brief : '本地正在编辑的创作要求');
  expect(saved.profile).toEqual(remote.profile);
});
