import { expect, test } from '@playwright/test';
import type { ProjectDocument } from '@video-quickly/contracts';

for (const operation of ['split', 'trim', 'reorder'] as const) test(`${operation} preserves shot input entered while the preceding save is pending`, async ({ page, request }) => {
  async function rpc<T>(method: string, params: unknown): Promise<T> {
    const response = await request.post('/__desktop_rpc', { data: { method, params } });
    const payload = await response.json();
    expect(payload.error).toBeUndefined();
    return payload.result;
  }
  const created = await rpc<ProjectDocument>('project.create', { title: `保存期间编辑验收 ${operation}` });
  const project = await rpc<ProjectDocument>('project.update', {
    projectId: created.id, revision: created.revision,
    patch: { shots: [1, 2].map(index => ({ id: `race-${index}`, title: `并发输入镜头 ${index}`, narration: '', visualPrompt: '', durationUs: 3_000_000 })) },
  });
  await page.goto('/');
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.locator('.project-card').filter({ hasText: project.title }).getByRole('button', { name: /继续创作/ }).click();
  const ruler = page.getByRole('slider', { name: '预览播放位置', exact: true });
  await ruler.press('Home');
  for (let index = 0; index < 3; index++) await ruler.press('Shift+ArrowRight');
  await page.getByLabel('镜头标题', { exact: true }).fill('分割前的标题');
  if (operation === 'trim') {
    await page.getByLabel('素材入点（秒）', { exact: true }).fill('0.5');
    await page.getByLabel('素材出点（秒）', { exact: true }).fill('2.5');
  }

  let releaseSave!: () => void;
  let observeSave!: () => void;
  const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
  const pendingSave = new Promise<void>(resolve => { observeSave = resolve; });
  let held = false;
  await page.route('**/__desktop_rpc', async route => {
    if (!held && route.request().postDataJSON()?.method === 'project.update') {
      held = true; observeSave(); await saveGate;
    }
    await route.continue();
  });
  if (operation === 'split') await page.getByRole('button', { name: '在播放头处分割镜头', exact: true }).click();
  else if (operation === 'trim') await page.getByRole('button', { name: '应用入出点', exact: true }).click();
  else {
    const clip = await page.locator('.timeline-clip--video .timeline-clip__select').first().boundingBox();
    const track = await page.locator('.track--video .track-clips').boundingBox();
    if (!clip || !track) throw new Error('重排目标不可见');
    const x = clip.x + clip.width / 2, y = clip.y + clip.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + track.width / 2, y, { steps: 8 }); await page.mouse.up();
  }
  await pendingSave;
  await page.getByLabel('镜头标题', { exact: true }).fill('保存期间的新标题');
  releaseSave();
  async function saved() { return (await rpc<{ project: ProjectDocument }>('project.get', { projectId: project.id })).project; }
  await expect.poll(async () => (await saved()).revision).toBe(project.revision + 2);
  const edited = await saved();
  expect(edited.shots).toHaveLength(operation === 'split' ? 3 : 2);
  expect(edited.shots.find(shot => shot.id === 'race-1')?.title).toBe('保存期间的新标题');
  if (operation === 'split') expect(edited.shots[1].title).toBe('保存期间的新标题');
  if (operation === 'trim') expect(edited.shots[0].durationUs).toBe(2_000_000);
  if (operation === 'reorder') expect(edited.shots.map(shot => shot.id)).toEqual(['race-2', 'race-1']);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await saved()).revision).toBe(project.revision + 3);
  expect((await saved()).shots).toHaveLength(2);
  expect((await saved()).shots[0].title).toBe('保存期间的新标题');
  expect((await saved()).shots.map(shot => shot.id)).toEqual(['race-1', 'race-2']);
  expect((await saved()).shots[0].durationUs).toBe(3_000_000);
});
