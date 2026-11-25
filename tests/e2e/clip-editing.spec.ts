import { openProjectFromList } from './workspace-navigation';
import { clickShotAction, openShotActions } from './storyboard-actions';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ProjectDocument } from '@video-quickly/contracts';

const frameUs = 1_000_000 * 1001 / 30000;
const selectionModifier: 'Meta' | 'Control' = process.platform === 'darwin' ? 'Meta' : 'Control';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  expect(response.ok()).toBe(true);
  const payload = await response.json();
  expect(payload.error).toBeUndefined();
  return payload.result;
}

async function createProject(request: APIRequestContext, title: string, sourceInUs = 0) {
  const project = await rpc<ProjectDocument>(request, 'project.create', { originalText: '清晨，林夏在书房发现一封未寄出的信。她来到旧城寻找信的主人，与朋友在雨中的城门重逢。两人读完信后决定一起回家。', title });
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
  await openProjectFromList(page, title);
  await expect(page.getByLabel('镜头标题')).toHaveValue('裁剪镜头 1');
  await expect(page.getByLabel('素材出点（秒）', { exact: true })).toBeVisible();
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
  const ruler = page.getByRole('slider', { name: '播放器播放位置', exact: true });
  await ruler.press('Home');
  for (let index = 0; index < Math.floor(frames / 10); index++) await ruler.press('Shift+ArrowRight');
  for (let index = 0; index < frames % 10; index++) await ruler.press('ArrowRight');
  await expect(ruler).toHaveAttribute('data-playhead-ms', String(Math.round(frames * frameUs / 1000)));
}

for (const transport of ['rapid frames', 'pressed frames', 'unchanged Home', 'no newer command', 'newer shot selection', 'additive shot selection'] as const) {
  test(`keeps newer keyboard transport after a delayed shot-selection save: ${transport}`, async ({ page, request }, info) => {
    const errors = observeErrors(page);
    const project = await createProject(request, `保存等待期间的播放头定位 ${transport}`);
    await openProject(page, project.title);
    let releaseSave!: () => void, committedSave!: () => void;
    const released = new Promise<void>(resolve => { releaseSave = resolve; });
    const committed = new Promise<void>(resolve => { committedSave = resolve; });
    let intercepted = false;
    await page.route('**/__desktop_rpc', async route => {
      const body = route.request().postDataJSON();
      if (intercepted || body.method !== 'project.update' || body.params?.projectId !== project.id) { await route.continue(); return; }
      intercepted = true;
      const response = await route.fetch();
      committedSave();
      await released;
      await route.fulfill({ response });
    });
    try {
      await page.getByLabel('镜头标题').fill('保存中的第一镜头');
      await page.locator('.outline-shot').nth(1).click();
      // The server commit is durable, but the selecting click still awaits its
      // acknowledgement. Keyboard intent must survive that late continuation.
      await committed;
      expect((await savedProject(request, project.id)).shots[0].title).toBe('保存中的第一镜头');
      const ruler = page.getByRole('slider', { name: '播放器播放位置', exact: true });
      await ruler.focus();
      const framesRequested = transport === 'rapid frames' || transport === 'pressed frames';
      if (transport === 'rapid frames') {
        // Dispatch a burst in one browser task, before any animation frame or
        // React render can occur between commands.
        await ruler.evaluate(element => {
          for (let index = 0; index < 6; index++) element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true }));
        });
        await expect(ruler).toHaveAttribute('data-playhead-ms', '2002');
      } else if (transport === 'pressed frames') {
        for (let index = 0; index < 6; index++) await ruler.press('Shift+ArrowRight');
        await expect(ruler).toHaveAttribute('data-playhead-ms', '2002');
      } else if (transport === 'unchanged Home') {
        await expect(ruler).toHaveAttribute('data-playhead-ms', '0');
        await ruler.press('Home');
        await expect(ruler).toHaveAttribute('data-playhead-ms', '0');
      } else if (transport === 'newer shot selection' || transport === 'additive shot selection') {
        await page.locator('.outline-shot').nth(2).click({ modifiers: transport === 'additive shot selection' ? [selectionModifier] : [] });
      }
      releaseSave();
      const nextSelection = transport === 'newer shot selection' || transport === 'additive shot selection';
      await expect(page.getByLabel('镜头标题')).toHaveValue(nextSelection ? '裁剪镜头 3' : '裁剪镜头 2');
      await expect(ruler).toHaveAttribute('data-playhead-ms', framesRequested ? '2002' : transport === 'unchanged Home' ? '0' : nextSelection ? '4505' : '3003');
      if (transport === 'additive shot selection') {
        await expect(page.locator('.outline-shot').nth(0)).toHaveAttribute('aria-pressed', 'false');
        await expect(page.locator('.outline-shot').nth(1)).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('.outline-shot').nth(2)).toHaveAttribute('aria-pressed', 'true');
      }
      if (framesRequested) await page.screenshot({ path: info.outputPath('delayed-selection-keeps-60-frames.png') });
      await expectHealthy(page, errors);
    } finally { releaseSave(); }
  });
}

test('splits at 29.97 fps with continuous source ranges and restores undo/redo after reload', async ({ page, request }, info) => {
  const errors = observeErrors(page);
  const project = await createProject(request, '分数帧率分割与恢复验收', 500_500);
  await openProject(page, project.title);
  const split = page.getByRole('button', { name: '在播放头处分割镜头', exact: true });
  await openShotActions(page);
  await expect(split).toBeDisabled();
  await page.keyboard.press('Escape');
  await seekFrames(page, 30);
  await clickShotAction(page, '在播放头处分割镜头');
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
  await openProjectFromList(page, project.title);
  await expect(page.getByRole('button', { name: '重做', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots).toEqual(divided.shots);
  const restored = await savedProject(request, project.id);
  expect(restored.revision).toBe(project.revision + 5);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots).toEqual(project.shots);
  await seekFrames(page, 30);
  await page.getByRole('slider', { name: '播放器播放位置', exact: true }).press('s');
  await expect.poll(async () => (await savedProject(request, project.id)).shots.length).toBe(4);
  expect((await savedProject(request, project.id)).revision).toBe(project.revision + 7);
  await expectHealthy(page, errors);
});

test('validates entered source ranges and rounds both edges to the project frame rate', async ({ page, request }, info) => {
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
  await inPoint.fill('0.534');
  await apply.click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots[0].sourceInUs).toBe(533_867);
  await outPoint.fill('2.169');
  await apply.click();
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
  await page.screenshot({ path: info.outputPath('trim-fields-29-97.png') });
  await expectHealthy(page, errors);
});

test('moves the selected storyboard shot and keeps the preview at its new position', async ({ page, request }, info) => {
  const errors = observeErrors(page);
  const project = await createProject(request, '分镜顺序与播放位置验收');
  await openProject(page, project.title);
  await openShotActions(page);
  await expect(page.getByRole('button', { name: '向前移动', exact: true })).toBeDisabled();
  await clickShotAction(page, '向后移动');
  await expect.poll(async () => (await savedProject(request, project.id)).shots.map(shot => shot.id)).toEqual(['clip-1', 'clip-0', 'clip-2']);
  await clickShotAction(page, '向后移动');
  await expect.poll(async () => (await savedProject(request, project.id)).shots.map(shot => shot.id)).toEqual(['clip-1', 'clip-2', 'clip-0']);
  await expect(page.locator('.outline-shot').last()).toContainText('裁剪镜头 1');
  await expect(page.getByRole('slider', { name: '播放器播放位置', exact: true })).toHaveAttribute('data-playhead-ms', '3003');
  await openShotActions(page);
  await expect(page.getByRole('button', { name: '向后移动', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots.map(shot => shot.id)).toEqual(['clip-1', 'clip-0', 'clip-2']);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots).toEqual(project.shots);
  await page.screenshot({ path: info.outputPath('storyboard-reorder.png') });
  await expectHealthy(page, errors);
});

test('commits the shortest valid source range as one undoable change', async ({ page, request }, info) => {
  const errors = observeErrors(page);
  const project = await createProject(request, '最短镜头入出点与撤销验收');
  await page.setViewportSize({ width: 1280, height: 900 });
  await openProject(page, project.title);
  const outPoint = page.getByLabel('素材出点（秒）', { exact: true });
  const apply = page.getByRole('button', { name: '应用入出点', exact: true });
  await outPoint.fill('0.3');
  await expect(apply).toBeDisabled();
  expect((await savedProject(request, project.id)).revision).toBe(project.revision);
  await outPoint.fill('0.5005');
  await apply.click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots[0].durationUs).toBe(500_500);
  expect((await savedProject(request, project.id)).revision).toBe(project.revision + 1);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots).toEqual(project.shots);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots[0].durationUs).toBe(500_500);
  expect((await savedProject(request, project.id)).revision).toBe(project.revision + 3);
  await page.screenshot({ path: info.outputPath('trim-minimum.png') });
  await expectHealthy(page, errors);
});
