import { writeFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { createSceneTemplate, DEFAULT_CAPTION_STYLE, type AssetRecord, type ProjectDocument } from '@video-quickly/contracts';

const selectionModifier: 'Meta' | 'Control' = process.platform === 'darwin' ? 'Meta' : 'Control';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json(); expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function saved(request: APIRequestContext, projectId: string) { return (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId })).project; }
async function fixture(request: APIRequestContext, title: string, lockedLast = false) {
  const project = await rpc<ProjectDocument>(request, 'project.create', { title, profile: { width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 }, fitMode: 'contain', previewScale: 1 } });
  return rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: {
    captionStyle: DEFAULT_CAPTION_STYLE, claims: [{ id: 'bulk-claim', text: '保留的人工资料', source: '原始材料', status: 'pending' }],
    shots: Array.from({ length: 6 }, (_, index) => ({ id: `bulk-${index}`, title: `多选镜头 ${index + 1}`, narration: `独立旁白 ${index + 1}`, visualPrompt: `独立画面 ${index + 1}`, durationUs: 2_000_000, sourceInUs: 500_000, sceneInUs: 500_000, sceneDurationUs: 4_000_000, sceneIndex: index, locked: lockedLast && index === 5, claimIds: index % 2 ? ['bulk-claim'] : [], animation: { panX: index === 0 ? .1 : 0, panY: 0, zoom: index === 0 ? 1.2 : 1.05, transition: 'fade' }, captionStyle: index === 0 ? { ...DEFAULT_CAPTION_STYLE, textColor: '#4455aa', fontWeight: 700 } : null,
      captionTrack: { timeBase: 'scene', alignment: 'manual', cues: [{ id: `bulk-cue-${index}`, startUs: 500_000, endUs: 2_500_000, text: `需要保留的字幕 ${index + 1}` }] },
      sceneTemplate: index === 1 ? { ...createSceneTemplate('bar-chart'), heading: '真实数据不复制', bars: [{ label: '原数据甲', value: 13 }, { label: '原数据乙', value: 27 }] } : { ...createSceneTemplate('process'), heading: `独立流程 ${index + 1}`, palette: index === 0 ? 'blue' : 'sage', motion: 'none' },
    })),
  } });
}
function observe(page: Page) { const errors = { page: [] as string[], console: [] as string[] }; page.on('pageerror', error => errors.page.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.console.push(message.text()); }); return errors; }
async function healthy(page: Page, errors: ReturnType<typeof observe>, expected400 = 0) { await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors.page).toEqual([]); expect(errors.console).toEqual(Array.from({ length: expected400 }, () => 'Failed to load resource: the server responded with a status of 400 (Bad Request)')); }
async function openProject(page: Page, title: string) { await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/); await page.getByRole('button', { name: `打开项目：${title}`, exact: true }).click(); await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('多选镜头 1'); }
function timeline(page: Page) { return page.getByRole('region', { name: '项目时间轴', exact: true }); }
function outline(page: Page) { return page.locator('#project-outline'); }
function videoClip(page: Page, index: number) { return page.locator('.track--video .timeline-clip__select').nth(index); }
async function select(page: Page, indices: number[]) {
  const clear = outline(page).getByRole('button', { name: '清除镜头选择', exact: true }); if (await clear.isEnabled()) await clear.click();
  for (let index = 0; index < indices.length; index++) await outline(page).locator('.outline-shot').nth(indices[index]).click({ modifiers: index ? [selectionModifier] : [] });
}
async function selection(page: Page, indices: number[]) {
  await expect(outline(page).locator('.outline-selection')).toContainText(`已选 ${indices.length} 个镜头`);
  await expect(timeline(page).locator('.timeline-selection-count')).toHaveText(`已选 ${indices.length} 个镜头`);
  for (let index = 0; index < 6; index++) {
    const pressed = String(indices.includes(index));
    await expect(outline(page).locator('.outline-shot').nth(index)).toHaveAttribute('aria-pressed', pressed);
    await expect(videoClip(page, index)).toHaveAttribute('aria-pressed', pressed);
    await expect(page.locator('.track--audio:not(.track--music) .timeline-clip__select').nth(index)).toHaveAttribute('aria-pressed', pressed);
  }
}
async function openBulk(page: Page) { await timeline(page).getByRole('button', { name: '批量编辑镜头', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '批量编辑镜头', exact: true }); await expect(dialog).toBeVisible(); return dialog; }
async function applyBulk(dialog: Locator) { const apply = dialog.getByRole('button', { name: '应用批量修改', exact: true }); await expect(apply).toBeEnabled(); await apply.click(); await expect(dialog).toHaveCount(0); }
async function undo(page: Page) { const button = page.getByRole('button', { name: '撤销', exact: true }); await expect(button).toBeEnabled(); await button.click(); }
async function screenshot(page: Page, dialog: Locator, path: string) {
  await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '1'); await expect(dialog.locator('.dialog__footer')).toBeInViewport({ ratio: 1 });
  const container = await dialog.locator('.bulk-shot-preview__canvas').boundingBox(), canvas = await dialog.locator('.bulk-shot-preview__canvas canvas').boundingBox();
  expect(container).not.toBeNull(); expect(canvas).not.toBeNull(); expect(canvas!.x).toBeGreaterThanOrEqual(container!.x - 1); expect(canvas!.x + canvas!.width).toBeLessThanOrEqual(container!.x + container!.width + 1);
  await page.screenshot({ path });
}
async function persistedHistory(page: Page, projectId: string, undoCount: number) {
  await expect.poll(() => page.evaluate(async ({ projectId, undoCount }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open('video-quickly-drafts', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    return new Promise<boolean>(resolve => { const query = db.transaction('projects').objectStore('projects').getAll(); query.onsuccess = () => { resolve(query.result.some(value => value.projectId === projectId && value.undo.length === undoCount)); db.close(); }; });
  }, { projectId, undoCount })).toBe(true);
}
async function startDrag(page: Page, clip: Locator, delta: number) {
  const bounds = await clip.boundingBox(); if (!bounds) throw new Error('拖动镜头不可见');
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  await clip.evaluate(element => {
    element.removeAttribute('data-test-pointer-id');
    element.addEventListener('pointerdown', event => element.setAttribute('data-test-pointer-id', String((event as PointerEvent).pointerId)), { once: true });
  });
  await page.mouse.move(x, y); await page.mouse.down();
  await expect.poll(() => clip.getAttribute('data-test-pointer-id')).not.toBeNull();
  const pointerId = Number(await clip.getAttribute('data-test-pointer-id'));
  await expect.poll(() => clip.evaluate((element, id) => element.hasPointerCapture(id), pointerId)).toBe(true);
  await clip.evaluate(element => element.removeAttribute('data-test-pointer-id'));
  await page.mouse.move(x + delta, y, { steps: 8 }); await expect(page.locator('.timeline-drop-marker')).toBeVisible(); return pointerId;
}
async function wav(path: string, seconds: number) {
  const rate = 16_000, frames = rate * seconds, bytes = frames * 2, data = Buffer.alloc(44 + bytes);
  data.write('RIFF'); data.writeUInt32LE(36 + bytes, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(bytes, 40);
  for (let index = 0; index < frames; index++) data.writeInt16LE(Math.round(Math.sin(index * Math.PI * 2 * 220 / rate) * 8000), 44 + index * 2);
  await writeFile(path, data);
}
async function gateFirstSave(page: Page, reject: boolean) {
  let started!: () => void, release!: () => void, writes = 0;
  const entered = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/__desktop_rpc', async route => {
    if (route.request().postDataJSON()?.method === 'project.update') {
      writes++;
      if (writes === 1) { started(); await gate; if (reject) { await route.fulfill({ status: 400, json: { error: '关闭批量窗口后的隔离保存失败' } }); return; } }
    }
    await route.continue();
  });
  return { entered, release, writes: () => writes };
}

test('shares modifier and range selection across outline, picture and narration while preserving native input shortcuts', async ({ page, request }, info) => {
  const errors = observe(page), project = await fixture(request, '多选与键盘范围验收'); await openProject(page, project.title);
  await outline(page).locator('.outline-shot').nth(1).click(); await outline(page).locator('.outline-shot').nth(3).click({ modifiers: [selectionModifier] }); await selection(page, [1, 3]);
  await outline(page).locator('.outline-shot').nth(1).click(); await selection(page, [1, 3]); await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('多选镜头 2');
  await outline(page).locator('.outline-shot').nth(4).click({ modifiers: ['Shift'] }); await selection(page, [3, 4]);
  await page.locator('.track--audio:not(.track--music) .timeline-clip__select').nth(0).click({ modifiers: [selectionModifier] }); await selection(page, [0, 3, 4]); await expect(page.locator('.timeline-drop-marker')).toHaveCount(0);
  const title = page.getByLabel('镜头标题', { exact: true }); await title.press('Control+a'); await selection(page, [0, 3, 4]); await title.press(`${selectionModifier}+a`); expect(await title.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])).toEqual([0, '多选镜头 1'.length]); await title.press('Escape'); await selection(page, [0, 3, 4]);
  await expect(timeline(page).getByRole('button', { name: '在播放头处分割镜头', exact: true })).toBeDisabled(); await expect(page.getByRole('slider', { name: '镜头入点', exact: true })).toHaveCount(0);
  await videoClip(page, 0).focus(); await page.keyboard.press('Control+a'); await selection(page, [0, 1, 2, 3, 4, 5]); await page.keyboard.press('Escape'); await selection(page, []); await expect(title).toHaveValue('多选镜头 1');
  for (const name of ['将镜头前移', '将镜头后移', '复制镜头', '移除所选镜头', '在播放头处分割镜头', '批量编辑镜头']) await expect(timeline(page).getByRole('button', { name, exact: true })).toBeDisabled();
  await outline(page).locator('.outline-list').focus(); await page.keyboard.press('Meta+a'); await selection(page, [0, 1, 2, 3, 4, 5]); await expect(page.locator('.outline-selection')).toBeVisible(); await page.screenshot({ path: info.outputPath('bulk-selection-dark-1536.png') }); await page.keyboard.press('Escape'); await selection(page, []); await outline(page).locator('.outline-shot').nth(0).press('Control+Space'); await selection(page, [0]); await outline(page).locator('.outline-shot').nth(2).press('Shift+Enter'); await selection(page, [0, 1, 2]); await page.keyboard.press('Escape'); await selection(page, []); expect(await saved(request, project.id)).toEqual(project); await healthy(page, errors);
});

test('applies duration, motion and caption changes as one undoable command across reload', async ({ page, request }, info) => {
  const errors = observe(page), project = await fixture(request, '批量时长与样式历史验收'); await openProject(page, project.title); await select(page, [1, 3]); const dialog = await openBulk(page);
  await dialog.getByRole('checkbox', { name: '批量修改时长', exact: true }).check(); await dialog.getByLabel('批量镜头时长（秒）', { exact: true }).fill('3'); await dialog.getByRole('checkbox', { name: '批量修改运镜', exact: true }).check(); await dialog.getByLabel('批量缩放', { exact: true }).fill('1.35'); await dialog.getByLabel('批量转场', { exact: true }).selectOption('wipe'); await dialog.getByRole('checkbox', { name: '批量修改字幕样式', exact: true }).check(); await dialog.getByLabel('文字颜色', { exact: true }).fill('#00aa55'); await dialog.locator('.bulk-shot-dialog__scope').scrollIntoViewIfNeeded(); await screenshot(page, dialog, info.outputPath('bulk-edit-dark-1536.png')); await applyBulk(dialog);
  const next = await saved(request, project.id); expect(next.revision).toBe(project.revision + 1);
  for (let index = 0; index < 6; index++) expect(next.shots[index]).toEqual([1, 3].includes(index) ? { ...project.shots[index], durationUs: 3_000_000, animation: { ...project.shots[index].animation, zoom: 1.35, transition: 'wipe' }, captionStyle: { ...DEFAULT_CAPTION_STYLE, textColor: '#00aa55' } } : project.shots[index]);
  expect(next.claims).toEqual(project.claims); await persistedHistory(page, project.id, 1); await page.reload(); await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click(); await undo(page); await expect.poll(async () => (await saved(request, project.id)).shots).toEqual(project.shots); await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled(); await page.getByRole('button', { name: '重做', exact: true }).click(); await expect.poll(async () => (await saved(request, project.id)).shots).toEqual(next.shots); await healthy(page, errors);
});

test('copies appearance from another shot while retaining each target topic, evidence, template data and media', async ({ page, request }, info) => {
  const errors = observe(page); let project = await fixture(request, '批量样式内容隔离验收'); const imagePath = info.outputPath('retained-target.svg'); await writeFile(imagePath, '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#557799"/></svg>'); const asset = await rpc<AssetRecord>(request, 'asset.import', { projectId: project.id, path: imagePath }); project = await saved(request, project.id); project = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: project.shots.map((shot, index) => index === 1 ? { ...shot, assetId: asset.id } : shot) } }); await openProject(page, project.title); await select(page, [1, 3]); await page.getByRole('button', { name: '浅色外观', exact: true }).click(); const dialog = await openBulk(page); await dialog.getByRole('checkbox', { name: '从镜头复制样式', exact: true }).check(); await dialog.getByLabel('复制样式来源镜头', { exact: true }).selectOption(project.shots[0].id); await page.setViewportSize({ width: 600, height: 900 }); await dialog.locator('.bulk-shot-preview').scrollIntoViewIfNeeded(); await screenshot(page, dialog, info.outputPath('bulk-copy-style-light-600.png')); await applyBulk(dialog);
  const next = await saved(request, project.id), source = project.shots[0];
  for (let index = 0; index < 6; index++) expect(next.shots[index]).toEqual([1, 3].includes(index) ? { ...project.shots[index], animation: source.animation, captionStyle: source.captionStyle, sceneTemplate: { ...project.shots[index].sceneTemplate!, palette: source.sceneTemplate!.palette, motion: source.sceneTemplate!.motion } } : project.shots[index]);
  expect(next.shots[1].assetId).toBe(asset.id); expect(next.shots[1].claimIds).toEqual(['bulk-claim']); expect(next.shots[1].sceneTemplate).toMatchObject({ heading: '真实数据不复制', bars: [{ label: '原数据甲', value: 13 }, { label: '原数据乙', value: 27 }] }); expect(next.claims).toEqual(project.claims); await healthy(page, errors);
});

test('moves, duplicates, removes and drags whole selections with cancelable pointer capture', async ({ page, request }) => {
  const errors = observe(page), project = await fixture(request, '镜头组排序与取消验收'); await openProject(page, project.title); await select(page, [1, 3]); const track = page.locator('.track--video .track-clips'), bounds = await track.boundingBox(); if (!bounds) throw new Error('时间轴不可见'); let clip = videoClip(page, 1);
  const pointerId = await startDrag(page, clip, bounds.width / 4); const transformed = await page.locator('.timeline-clip.selected').evaluateAll(elements => elements.map(element => (element as HTMLElement).style.transform)); expect(transformed).toHaveLength(4); expect(new Set(transformed).size).toBe(1); expect(transformed[0]).toContain('translateX'); await clip.dispatchEvent('pointercancel', { pointerId, pointerType: 'mouse', isPrimary: true }); expect(await clip.evaluate((element, id) => element.hasPointerCapture(id), pointerId)).toBe(false); await page.mouse.up(); await expect(page.locator('.timeline-drop-marker')).toHaveCount(0); expect(await saved(request, project.id)).toEqual(project);
  await startDrag(page, clip, bounds.width / 4); await page.keyboard.press('Escape'); await page.mouse.up(); await selection(page, []); await expect(page.locator('.timeline-drop-marker')).toHaveCount(0); expect(await saved(request, project.id)).toEqual(project);
  await select(page, [1, 3]); clip = videoClip(page, 1); await startDrag(page, clip, bounds.width / 2); await page.mouse.up(); await expect.poll(async () => (await saved(request, project.id)).shots.map(shot => shot.id)).toEqual(['bulk-0', 'bulk-2', 'bulk-4', 'bulk-5', 'bulk-1', 'bulk-3']); expect((await saved(request, project.id)).revision).toBe(project.revision + 1); await undo(page); await expect.poll(async () => (await saved(request, project.id)).shots).toEqual(project.shots);
  await select(page, [1, 3]); await timeline(page).getByRole('button', { name: '将镜头前移', exact: true }).click(); await expect.poll(async () => (await saved(request, project.id)).shots.map(shot => shot.id)).toEqual(['bulk-1', 'bulk-0', 'bulk-3', 'bulk-2', 'bulk-4', 'bulk-5']); await undo(page); await expect.poll(async () => (await saved(request, project.id)).shots).toEqual(project.shots);
  await select(page, [1, 3]); await timeline(page).getByRole('button', { name: '复制镜头', exact: true }).click(); await expect.poll(async () => (await saved(request, project.id)).shots.length).toBe(8); const duplicated = await saved(request, project.id); expect(duplicated.shots.map(shot => shot.title)).toEqual(['多选镜头 1', '多选镜头 2', '多选镜头 2 · 副本', '多选镜头 3', '多选镜头 4', '多选镜头 4 · 副本', '多选镜头 5', '多选镜头 6']); await timeline(page).getByRole('button', { name: '移除所选镜头', exact: true }).click(); await expect.poll(async () => (await saved(request, project.id)).shots).toEqual(project.shots); await undo(page); await expect.poll(async () => (await saved(request, project.id)).shots).toEqual(duplicated.shots); await undo(page); await expect.poll(async () => (await saved(request, project.id)).shots).toEqual(project.shots); await healthy(page, errors);
});

test('rejects an entire selected group when any target is locked', async ({ page, request }) => {
  const errors = observe(page), project = await fixture(request, '锁定镜头整批拒绝验收', true); await openProject(page, project.title); await select(page, [1, 5]);
  for (const name of ['将镜头前移', '复制镜头', '移除所选镜头']) { await timeline(page).getByRole('button', { name, exact: true }).click(); await expect(page.getByRole('alert').filter({ hasText: '多选镜头 6' })).toBeVisible(); expect(await saved(request, project.id)).toEqual(project); }
  const dialog = await openBulk(page); await dialog.getByRole('checkbox', { name: '批量修改时长', exact: true }).check(); await dialog.getByLabel('批量镜头时长（秒）', { exact: true }).fill('3'); await expect(dialog.getByRole('alert')).toContainText('多选镜头 6'); await expect(dialog.getByRole('button', { name: '应用批量修改', exact: true })).toBeDisabled(); expect(await saved(request, project.id)).toEqual(project); await dialog.getByRole('button', { name: '取消', exact: true }).click(); await healthy(page, errors);
});

test('reads real media bounds before enabling a batch and blocks metadata failures without partial edits', async ({ page, request }, info) => {
  const errors = observe(page); let project = await fixture(request, '批量真实素材时长验收'); const path = info.outputPath('bulk-boundary.wav'); await wav(path, 2.5); const asset = await rpc<AssetRecord>(request, 'asset.import', { projectId: project.id, shotId: project.shots[1].id, path, kind: 'audio' }); project = await saved(request, project.id); project = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: project.shots.map((shot, index) => index === 1 ? { ...shot, audioInUs: 500_000 } : shot) } });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let held = 0;
  await page.route('**/__desktop_asset?**', async route => { if (new URL(route.request().url()).searchParams.get('path') === asset.path) { held++; await gate; } await route.continue(); });
  try { await openProject(page, project.title); await select(page, [1, 3]); const dialog = await openBulk(page); await dialog.getByRole('checkbox', { name: '批量修改时长', exact: true }).check(); await dialog.getByLabel('批量镜头时长（秒）', { exact: true }).fill('2.1'); await expect(dialog.getByRole('status')).toContainText('正在读取所选镜头的真实素材时长'); await expect(dialog.getByRole('button', { name: '应用批量修改', exact: true })).toBeDisabled(); expect(held).toBeGreaterThan(0); release(); await expect(dialog.getByRole('alert')).toContainText('真实时长'); await expect(dialog.getByRole('button', { name: '应用批量修改', exact: true })).toBeDisabled(); expect(await saved(request, project.id)).toEqual(project); await dialog.getByLabel('批量镜头时长（秒）', { exact: true }).fill('1.9'); await applyBulk(dialog); } finally { release(); }
  const next = await saved(request, project.id); expect(next.shots[1]).toMatchObject({ audioAssetId: asset.id, sourceInUs: 500_000, audioInUs: 500_000, durationUs: 1_900_000 }); expect(next.shots[3].durationUs).toBe(1_900_000);
  await page.unroute('**/__desktop_asset?**'); await page.route('**/__desktop_asset?**', async route => { if (new URL(route.request().url()).searchParams.get('path') === asset.path) { await route.fulfill({ status: 200, contentType: 'audio/wav', body: 'invalid-audio-fixture' }); return; } await route.continue(); }); await page.reload(); await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click(); await select(page, [1, 3]); const failed = await openBulk(page); await failed.getByRole('checkbox', { name: '批量修改时长', exact: true }).check(); await expect(failed.getByRole('alert').filter({ hasText: asset.name })).toContainText('无法读取'); await expect(failed.getByRole('button', { name: '应用批量修改', exact: true })).toBeDisabled(); expect(await saved(request, project.id)).toEqual(next); await failed.getByRole('button', { name: '取消', exact: true }).click(); await healthy(page, errors);
});

test('retains local inputs on a related conflict and preserves unrelated live project edits', async ({ page, request }) => {
  const errors = observe(page), project = await fixture(request, '批量修改并发保护验收'); await openProject(page, project.title); await select(page, [1, 3]); let dialog = await openBulk(page); await dialog.getByRole('checkbox', { name: '批量修改时长', exact: true }).check(); await dialog.getByLabel('批量镜头时长（秒）', { exact: true }).fill('3'); const remote = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: project.shots.map((shot, index) => index === 1 ? { ...shot, durationUs: 2_500_000 } : shot) } }); await expect(page.locator('.project-heading-copy')).toHaveAttribute('data-revision', String(remote.revision)); await dialog.getByRole('button', { name: '应用批量修改', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('变化'); await expect(dialog.getByLabel('批量镜头时长（秒）', { exact: true })).toHaveValue('3'); expect(await saved(request, project.id)).toEqual(remote); await dialog.getByRole('button', { name: '取消', exact: true }).click();
  dialog = await openBulk(page); await dialog.getByRole('checkbox', { name: '批量修改运镜', exact: true }).check(); await dialog.getByLabel('批量缩放', { exact: true }).fill('1.4'); const titled = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: remote.revision, patch: { title: '批量保存保留外部标题' } }); await expect(page.locator('.project-heading-copy')).toHaveAttribute('data-revision', String(titled.revision)); await applyBulk(dialog); const next = await saved(request, project.id); expect(next.title).toBe(titled.title); expect(next.shots[1].durationUs).toBe(2_500_000); expect(next.shots[1].animation.zoom).toBe(1.4); expect(next.shots[3].animation.zoom).toBe(1.4); await healthy(page, errors);
});

test('retries a failed batch save without adding a second undo command', async ({ page, request }) => {
  const errors = observe(page), project = await fixture(request, '批量保存重试与一次撤销验收'); await openProject(page, project.title); await select(page, [1, 3]); const dialog = await openBulk(page); await dialog.getByRole('checkbox', { name: '批量修改时长', exact: true }).check(); await dialog.getByLabel('批量镜头时长（秒）', { exact: true }).fill('3'); let failures = 0; await page.route('**/__desktop_rpc', async route => { if (!failures && route.request().postDataJSON()?.method === 'project.update') { failures++; await route.fulfill({ status: 400, json: { error: '隔离的首次批量保存失败' } }); return; } await route.continue(); }); await dialog.getByRole('button', { name: '应用批量修改', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('尚未保存'); await expect(dialog.getByLabel('批量镜头时长（秒）', { exact: true })).toHaveValue('3'); await expect(dialog.getByLabel('批量镜头时长（秒）', { exact: true })).toBeDisabled(); expect(await saved(request, project.id)).toEqual(project); await dialog.getByRole('button', { name: '重试保存批量修改', exact: true }).click(); await expect(dialog).toHaveCount(0); const next = await saved(request, project.id); expect(next.revision).toBe(project.revision + 1); expect(next.shots[1].durationUs).toBe(3_000_000); expect(next.shots[3].durationUs).toBe(3_000_000); await persistedHistory(page, project.id, 1); await page.reload(); await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click(); await undo(page); await expect.poll(async () => (await saved(request, project.id)).shots).toEqual(project.shots); await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled(); await healthy(page, errors, 1);
});

test('keeps the active shot aligned with the remaining selection after an external primary deletion', async ({ page, request }) => {
  const errors = observe(page), project = await fixture(request, '外部移除主选镜头区间验收'); await openProject(page, project.title); await select(page, [1, 3]); await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('多选镜头 4');
  const remote = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: project.shots.filter(shot => shot.id !== 'bulk-3') } });
  await expect(page.locator('.project-heading-copy')).toHaveAttribute('data-revision', String(remote.revision)); await expect(outline(page).locator('.outline-selection')).toContainText('已选 1 个镜头'); await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('多选镜头 2'); await expect(outline(page).locator('.outline-shot')).toHaveCount(5);
  for (let index = 0; index < 5; index++) { const pressed = String(index === 1); await expect(outline(page).locator('.outline-shot').nth(index)).toHaveAttribute('aria-pressed', pressed); await expect(videoClip(page, index)).toHaveAttribute('aria-pressed', pressed); await expect(page.locator('.track--audio:not(.track--music) .timeline-clip__select').nth(index)).toHaveAttribute('aria-pressed', pressed); }
  await page.getByLabel('素材入点（秒）', { exact: true }).fill('0.8'); await page.getByLabel('素材出点（秒）', { exact: true }).fill('2.3'); const apply = page.getByRole('button', { name: '应用入出点', exact: true }); await expect(apply).toBeEnabled(); await apply.click();
  await expect.poll(async () => (await saved(request, project.id)).shots.find(shot => shot.id === 'bulk-1')?.durationUs).toBe(1_500_000); const next = await saved(request, project.id); expect(next.shots[0]).toEqual(remote.shots[0]); expect(next.shots[1]).toEqual({ ...remote.shots[1], sourceInUs: 800_000, sceneInUs: 800_000, durationUs: 1_500_000 }); expect(next.shots.slice(2)).toEqual(remote.shots.slice(2));
  await undo(page); await expect.poll(async () => (await saved(request, project.id)).shots).toEqual(remote.shots); await page.getByRole('button', { name: '重做', exact: true }).click(); await expect.poll(async () => (await saved(request, project.id)).shots).toEqual(next.shots); await healthy(page, errors);
});

test('closes a busy bulk dialog while its parent save continues and keeps a rejected draft recoverable', async ({ page, request }, info) => {
  const errors = observe(page), project = await fixture(request, '批量保存期间关闭窗口验收'); await openProject(page, project.title); await select(page, [1, 3]); const dialog = await openBulk(page); await dialog.getByRole('checkbox', { name: '批量修改时长', exact: true }).check(); await dialog.getByLabel('批量镜头时长（秒）', { exact: true }).fill('3'); const gate = await gateFirstSave(page, true);
  try {
    await dialog.getByRole('button', { name: '应用批量修改', exact: true }).click(); await gate.entered; await expect(dialog.getByRole('button', { name: '关闭并继续保存', exact: true })).toBeEnabled(); await screenshot(page, dialog, info.outputPath('bulk-saving-before-close.png'));
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(page.locator('dialog[open]')).toHaveCount(0); await page.getByRole('button', { name: '项目设置', exact: true }).click(); await page.getByRole('button', { name: '镜头属性', exact: true }).click(); gate.release();
    const save = page.getByRole('button', { name: '保存修改', exact: true }); await expect(save).toBeEnabled(); await expect(page.locator('.project-heading-copy')).toContainText('未保存'); await expect(page.getByLabel('时长（秒）', { exact: true })).toHaveValue('3'); expect(await saved(request, project.id)).toEqual(project); await page.screenshot({ path: info.outputPath('bulk-closed-failed-save-draft.png') });
    await save.click(); await expect.poll(async () => (await saved(request, project.id)).shots[1].durationUs).toBe(3_000_000); expect((await saved(request, project.id)).shots[3].durationUs).toBe(3_000_000); expect(gate.writes()).toBe(2); await undo(page); await expect.poll(async () => (await saved(request, project.id)).shots).toEqual(project.shots); await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled(); await healthy(page, errors, 1);
  } finally { gate.release(); }
});

test('preserves new narration typed while the selected group waits for its first save before removal', async ({ page, request }, info) => {
  const errors = observe(page), project = await fixture(request, '移除组等待保存时输入保护验收'); await openProject(page, project.title); await select(page, [1, 3]); const narration = page.getByLabel('旁白', { exact: true }), first = '开始移除之前已经编辑的旁白', newest = '保存等待期间继续输入的新旁白'; await narration.fill(first); const gate = await gateFirstSave(page, false);
  try {
    await timeline(page).getByRole('button', { name: '移除所选镜头', exact: true }).click(); await gate.entered; await narration.fill(newest); gate.release(); await expect(page.getByRole('alert').filter({ hasText: '待移除镜头有新的修改' })).toBeVisible(); await expect(outline(page).locator('.outline-shot')).toHaveCount(6); await expect(narration).toHaveValue(newest); await expect(page.locator('.project-heading-copy')).toContainText('未保存');
    const firstSaved = await saved(request, project.id); expect(firstSaved.shots).toEqual(project.shots.map((shot, index) => index === 3 ? { ...shot, narration: first } : shot)); await page.screenshot({ path: info.outputPath('bulk-remove-preserved-new-input.png') });
    const save = page.getByRole('button', { name: '保存修改', exact: true }); await expect(save).toBeEnabled(); await save.click(); await expect.poll(async () => (await saved(request, project.id)).shots).toEqual(project.shots.map((shot, index) => index === 3 ? { ...shot, narration: newest } : shot)); expect(gate.writes()).toBe(2); await healthy(page, errors);
  } finally { gate.release(); }
});
