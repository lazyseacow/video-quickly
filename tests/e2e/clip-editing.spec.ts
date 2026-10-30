import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { ProjectDocument } from '@video-quickly/contracts';

const frameUs = 1_000_000 * 1001 / 30000;

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  expect(response.ok()).toBe(true);
  const payload = await response.json();
  expect(payload.error).toBeUndefined();
  return payload.result;
}

async function createProject(request: APIRequestContext, title: string, sourceInUs = 0) {
  const project = await rpc<ProjectDocument>(request, 'project.create', { title });
  return rpc<ProjectDocument>(request, 'project.update', {
    projectId: project.id, revision: project.revision,
    patch: {
      profile: { ...project.profile, frameRate: { numerator: 30000, denominator: 1001 } },
      shots: [3_000_000, 1_500_000, 1_500_000].map((durationUs, index) => ({
        id: `clip-${index}`, title: `裁剪镜头 ${index + 1}`, narration: '', visualPrompt: '', durationUs,
        ...(index === 0 ? { sourceInUs, sceneInUs: sourceInUs, sceneDurationUs: 4_000_000 } : {}),
      })),
    },
  });
}

async function savedProject(request: APIRequestContext, projectId: string) {
  return (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId })).project;
}

async function openProject(page: Page, title: string) {
  await page.goto('/');
  await expect(page).toHaveTitle(/Video Quickly/);
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.locator('.project-card').filter({ hasText: title }).getByRole('button', { name: /继续创作/ }).click();
  await expect(page.getByLabel('镜头标题')).toHaveValue('裁剪镜头 1');
  await expect(page.getByRole('slider', { name: '镜头出点', exact: true })).toBeVisible();
}

function observeErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  return errors;
}

async function expectHealthy(page: Page, errors: string[]) {
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  expect(errors).toEqual([]);
}

async function seekFrames(page: Page, frames: number) {
  const ruler = page.getByRole('slider', { name: '预览播放位置', exact: true });
  await ruler.press('Home');
  for (let index = 0; index < Math.floor(frames / 10); index++) await ruler.press('Shift+ArrowRight');
  for (let index = 0; index < frames % 10; index++) await ruler.press('ArrowRight');
  await expect(ruler).toHaveAttribute('aria-valuenow', String(Math.round(frames * frameUs / 1000)));
}

async function dragBy(page: Page, handle: Locator, deltaX: number) {
  await expect(handle).toBeEnabled();
  await handle.click({ trial: true });
  const bounds = await handle.boundingBox();
  if (!bounds) throw new Error('时间轴拖动目标不可见');
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + deltaX, y, { steps: 8 });
  await expect(page.locator('.timeline-drop-marker')).toBeVisible();
  await page.mouse.up();
}

test('splits at 29.97 fps with continuous source ranges and restores undo/redo after reload', async ({ page, request }, info) => {
  const errors = observeErrors(page);
  const project = await createProject(request, '分数帧率分割与恢复验收', 500_500);
  await openProject(page, project.title);
  const split = page.getByRole('button', { name: '在播放头处分割镜头', exact: true });
  await expect(split).toBeDisabled();
  await seekFrames(page, 30);
  await expect(split).toBeEnabled();
  await split.click();
  await expect(page.locator('.outline-shot')).toHaveCount(4);
  await expect.poll(async () => (await savedProject(request, project.id)).shots.length).toBe(4);
  const divided = await savedProject(request, project.id);
  const [left, right] = divided.shots;
  expect(left.durationUs).toBe(1_001_000);
  expect(left.sourceInUs).toBe(500_500);
  expect(right.sourceInUs).toBe(left.sourceInUs! + left.durationUs);
  expect(right.sceneInUs).toBe(left.sceneInUs! + left.durationUs);
  expect(right.sceneDurationUs).toBe(left.sceneDurationUs);
  expect(right.id).not.toBe(left.id);
  expect(right.animation.transition).toBe('cut');
  expect(Math.abs(divided.shots.reduce((sum, shot) => sum + shot.durationUs, 0) - 6_000_000)).toBeLessThanOrEqual(frameUs / 2);
  expect(divided.revision).toBe(project.revision + 1);
  await page.screenshot({ path: info.outputPath('split-29-97.png') });

  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.outline-shot')).toHaveCount(3);
  await expect.poll(async () => (await savedProject(request, project.id)).shots).toEqual(project.shots);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots).toEqual(divided.shots);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots).toEqual(project.shots);
  await expect.poll(() => page.evaluate(async projectId => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('video-quickly-drafts', 1);
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    return new Promise<boolean>(resolve => {
      const query = db.transaction('projects').objectStore('projects').getAll();
      query.onsuccess = () => { resolve(query.result.some(value => value.projectId === projectId && value.redo.length > 0)); db.close(); };
    });
  }, project.id)).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
  await expect(page.getByRole('button', { name: '重做', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots).toEqual(divided.shots);
  const restored = await savedProject(request, project.id);
  expect(restored.revision).toBe(project.revision + 5);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots).toEqual(project.shots);
  await seekFrames(page, 30);
  await page.keyboard.press('s');
  await expect.poll(async () => (await savedProject(request, project.id)).shots.length).toBe(4);
  expect((await savedProject(request, project.id)).revision).toBe(project.revision + 7);
  await expectHealthy(page, errors);
});

test('validates trim ranges and adjusts selected edges by one frame or ten frames', async ({ page, request }, info) => {
  const errors = observeErrors(page);
  const project = await createProject(request, '镜头入出点与键盘验收');
  await openProject(page, project.title);
  const inPoint = page.getByLabel('素材入点（秒）', { exact: true });
  const outPoint = page.getByLabel('素材出点（秒）', { exact: true });
  const apply = page.getByRole('button', { name: '应用入出点', exact: true });
  await inPoint.fill('0.5'); await outPoint.fill('2.5'); await apply.click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots[0].durationUs).toBe(2_002_000);
  const trimmed = await savedProject(request, project.id);
  expect(trimmed.shots[0]).toMatchObject({ sourceInUs: 500_500, sceneInUs: 500_500, sceneDurationUs: 4_000_000 });
  await expect(apply).toBeDisabled();

  await inPoint.fill('2.4'); await outPoint.fill('2.5');
  await expect(page.getByRole('alert')).toContainText('片段至少保留 0.5 秒');
  await expect(apply).toBeDisabled();
  expect((await savedProject(request, project.id)).revision).toBe(trimmed.revision);
  await inPoint.fill('0.5005'); await outPoint.fill('2.5025');
  await expect(apply).toBeDisabled();
  const inHandle = page.getByRole('slider', { name: '镜头入点', exact: true });
  await expect(inHandle).toBeEnabled();
  await inHandle.press('ArrowRight');
  await expect.poll(async () => (await savedProject(request, project.id)).shots[0].sourceInUs).toBe(533_867);
  const outHandle = page.getByRole('slider', { name: '镜头出点', exact: true });
  await expect(outHandle).toBeEnabled();
  await outHandle.press('Shift+ArrowLeft');
  await expect.poll(async () => {
    const shot = (await savedProject(request, project.id)).shots[0];
    return shot.sourceInUs! + shot.durationUs;
  }).toBe(2_168_833);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => {
    const shot = (await savedProject(request, project.id)).shots[0];
    return shot.sourceInUs! + shot.durationUs;
  }).toBe(2_502_500);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots).toEqual(trimmed.shots);
  await page.screenshot({ path: info.outputPath('trim-keyboard-29-97.png') });
  await expectHealthy(page, errors);
});

test('reorders clips by pointer and snaps trim edges to the playhead and neighboring boundaries', async ({ page, request }, info) => {
  const errors = observeErrors(page);
  const project = await createProject(request, '拖动重排与时间轴吸附验收');
  await openProject(page, project.title);
  const track = page.locator('.track--video .track-clips');
  const trackBox = await track.boundingBox();
  if (!trackBox) throw new Error('视频轨道不可见');
  await dragBy(page, page.locator('.timeline-clip--video .timeline-clip__select').first(), trackBox.width / 2);
  await expect.poll(async () => (await savedProject(request, project.id)).shots.map(shot => shot.id)).toEqual(['clip-1', 'clip-2', 'clip-0']);
  await expect(page.locator('.outline-shot').last()).toContainText('裁剪镜头 1');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots).toEqual(project.shots);
  await page.locator('.outline-shot').first().click();

  const snapping = page.getByRole('button', { name: '时间轴吸附', exact: true });
  await expect(snapping).toHaveAttribute('aria-pressed', 'true');
  await seekFrames(page, 60);
  await dragBy(page, page.getByRole('slider', { name: '镜头出点', exact: true }), (2_002_000 - 3_000_000) / 6_000_000 * trackBox.width + 4);
  await expect.poll(async () => (await savedProject(request, project.id)).shots[0].durationUs).toBe(2_002_000);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots).toEqual(project.shots);

  await snapping.click();
  await expect(snapping).toHaveAttribute('aria-pressed', 'false');
  await seekFrames(page, 60);
  await dragBy(page, page.getByRole('slider', { name: '镜头出点', exact: true }), (2_002_000 - 3_000_000) / 6_000_000 * trackBox.width + 4);
  await expect.poll(async () => (await savedProject(request, project.id)).revision).toBeGreaterThan(project.revision + 4);
  const unsnapped = (await savedProject(request, project.id)).shots[0].durationUs;
  expect(Math.abs(unsnapped - 2_002_000)).toBeGreaterThan(frameUs / 2);
  expect(Math.abs(unsnapped - 2_002_000)).toBeLessThanOrEqual(frameUs * 2);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots).toEqual(project.shots);

  await snapping.click();
  await dragBy(page, page.getByRole('slider', { name: '镜头出点', exact: true }), 1_500_000 / 6_000_000 * trackBox.width + 3);
  await expect.poll(async () => (await savedProject(request, project.id)).shots[0].durationUs).toBe(4_504_500);
  await page.screenshot({ path: info.outputPath('pointer-boundary-snapping.png') });
  await expectHealthy(page, errors);
});

test('retains pointer capture while trimming below 84 pixels and commits the minimum clip as one undo step', async ({ page, request }, info) => {
  const errors = observeErrors(page);
  const project = await createProject(request, '最短镜头拖动与撤销验收');
  await page.setViewportSize({ width: 1280, height: 900 });
  await openProject(page, project.title);
  const track = await page.locator('.track--video .track-clips').boundingBox();
  const handle = page.getByRole('slider', { name: '镜头出点', exact: true });
  const bounds = await handle.boundingBox();
  if (!track || !bounds) throw new Error('视频轨道或裁剪手柄不可见');
  expect(track.width * 500_500 / 6_000_000).toBeLessThan(84);
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + (300_000 - 3_000_000) / 6_000_000 * track.width, y, { steps: 12 });
  await expect(handle).toBeAttached();
  await expect(page.locator('.timeline-drop-marker')).toBeVisible();
  await expect.poll(async () => (await page.locator('.timeline-clip--video').first().boundingBox())?.width).toBeLessThan(84);
  expect((await savedProject(request, project.id)).revision).toBe(project.revision);
  await page.screenshot({ path: info.outputPath('pointer-minimum-drag.png') });
  await page.mouse.up();
  await expect(page.locator('.timeline-drop-marker')).toHaveCount(0);
  await expect.poll(async () => (await savedProject(request, project.id)).shots[0].durationUs).toBe(500_500);
  expect((await savedProject(request, project.id)).revision).toBe(project.revision + 1);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots).toEqual(project.shots);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots[0].durationUs).toBe(500_500);
  expect((await savedProject(request, project.id)).revision).toBe(project.revision + 3);
  await expectHealthy(page, errors);
});
