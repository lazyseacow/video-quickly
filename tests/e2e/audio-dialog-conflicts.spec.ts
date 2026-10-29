import { writeFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { AssetRecord, ProjectDocument } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json(); expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function savedProject(request: APIRequestContext, projectId: string) {
  return (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId })).project;
}
async function createProject(request: APIRequestContext, title: string) {
  const project = await rpc<ProjectDocument>(request, 'project.create', { title });
  return rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: [
    { id: 'dialog-shot', title: '弹窗冲突镜头', narration: '第一句旁白。第二句旁白。', visualPrompt: '', durationUs: 4_000_000, sourceInUs: 0, sceneInUs: 0, sceneDurationUs: 4_000_000 },
  ] } });
}
async function openProject(page: Page, title: string) {
  await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/);
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.locator('.project-card').filter({ hasText: title }).getByRole('button', { name: /继续创作/ }).click();
  await expect(page.getByLabel('镜头标题')).toHaveValue('弹窗冲突镜头');
}
async function waitForRevision(page: Page, revision: number) {
  await expect(page.locator('.project-heading-copy')).toContainText(`修订 ${revision}`);
}
function observeErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  return errors;
}
async function expectHealthy(page: Page, errors: string[]) {
  await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
}
async function waitForStoredCommands(page: Page, projectId: string, kind: 'caption' | 'music', value: string | number) {
  await expect.poll(() => page.evaluate(async input => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('video-quickly-drafts', 1);
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    return new Promise<boolean>((resolve, reject) => {
      const query = db.transaction('projects').objectStore('projects').getAll();
      query.onsuccess = () => {
        resolve(query.result.some(draft => draft.projectId === input.projectId && draft.undo.length >= 2 && (input.kind === 'caption' ? draft.present.shots[0]?.captionTrack?.cues[0]?.text : draft.present.musicClips?.[0]?.gainDb) === input.value));
        db.close();
      };
      query.onerror = () => { db.close(); reject(query.error); };
    });
  }, { projectId, kind, value })).toBe(true);
}

test('keeps a caption draft when its source window changes externally and accepts unrelated title revisions', async ({ page, request }, info) => {
  const errors = observeErrors(page);
  const project = await createProject(request, '字幕弹窗外部修订验收');
  await openProject(page, project.title);
  await page.getByRole('button', { name: '编辑字幕', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑字幕', exact: true });
  await dialog.getByLabel('字幕 1 文字', { exact: true }).fill('保留的字幕草稿');
  const remote = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: project.shots.map(shot => ({ ...shot, sourceInUs: 1_000_000, sceneInUs: 1_000_000, durationUs: 3_000_000 })) } });
  await waitForRevision(page, remote.revision);
  await dialog.getByRole('button', { name: '应用字幕', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('字幕或镜头区间已在其他视图更新');
  await expect(dialog.getByLabel('字幕 1 文字', { exact: true })).toHaveValue('保留的字幕草稿');
  expect(await savedProject(request, project.id)).toEqual(remote);
  await page.screenshot({ path: info.outputPath('caption-dialog-external-range-conflict.png') });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '编辑字幕', exact: true }).click();
  await expect(dialog.getByLabel('字幕 1 出点（秒）', { exact: true })).toHaveValue('1');
  await dialog.getByLabel('字幕 1 文字', { exact: true }).fill('核对后的字幕');
  const title = '只修改标题的字幕项目';
  const renamed = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: remote.revision, patch: { title } });
  await waitForRevision(page, renamed.revision);
  await dialog.getByRole('button', { name: '应用字幕', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await savedProject(request, project.id)).shots[0].captionTrack?.cues.some(cue => cue.text === '核对后的字幕')).toBe(true);
  const saved = await savedProject(request, project.id);
  expect(saved.title).toBe(title); expect(saved.revision).toBe(renamed.revision + 1);
  expect(saved.shots[0]).toMatchObject({ sourceInUs: 1_000_000, sceneInUs: 1_000_000, durationUs: 3_000_000 });
  await expectHealthy(page, errors);
});

function wav() {
  const rate = 8000, samples = rate * 2, bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) bytes.writeInt16LE(Math.round(Math.sin(index / rate * Math.PI * 800) * 6000), 44 + index * 2);
  return bytes;
}

test('keeps a music draft when its position changes externally and accepts unrelated title revisions', async ({ page, request }, info) => {
  const errors = observeErrors(page);
  let project = await createProject(request, '音乐弹窗外部修订验收');
  const path = info.outputPath('dialog-music.wav'); await writeFile(path, wav());
  const asset = await rpc<AssetRecord>(request, 'asset.import', { projectId: project.id, path, kind: 'audio' });
  project = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { musicClips: [{ id: 'dialog-music', assetId: asset.id, startUs: 0, sourceInUs: 0, durationUs: 2_000_000, gainDb: -18, fadeInUs: 0, fadeOutUs: 0, loop: true }] } });
  await openProject(page, project.title);
  await page.getByRole('button', { name: '背景音乐', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '背景音乐', exact: true });
  await dialog.getByLabel('音乐 1 音量（dB）', { exact: true }).fill('-6');
  const remote = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { musicClips: project.musicClips?.map(clip => ({ ...clip, startUs: 1_000_000 })) } });
  await waitForRevision(page, remote.revision);
  await dialog.getByRole('button', { name: '应用背景音乐', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('背景音乐已在其他视图更新');
  await expect(dialog.getByLabel('音乐 1 音量（dB）', { exact: true })).toHaveValue('-6');
  await expect(dialog.getByLabel('音乐 1 项目起点（秒）', { exact: true })).toHaveValue('0');
  expect(await savedProject(request, project.id)).toEqual(remote);
  await page.screenshot({ path: info.outputPath('music-dialog-external-position-conflict.png') });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '背景音乐', exact: true }).click();
  await expect(dialog.getByLabel('音乐 1 项目起点（秒）', { exact: true })).toHaveValue('1');
  await dialog.getByLabel('音乐 1 音量（dB）', { exact: true }).fill('-9');
  const title = '只修改标题的音乐项目';
  const renamed = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: remote.revision, patch: { title } });
  await waitForRevision(page, renamed.revision);
  await dialog.getByRole('button', { name: '应用背景音乐', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await savedProject(request, project.id)).musicClips?.[0].gainDb).toBe(-9);
  const saved = await savedProject(request, project.id);
  expect(saved.title).toBe(title); expect(saved.revision).toBe(renamed.revision + 1);
  expect(saved.musicClips?.[0].startUs).toBe(1_000_000);
  await expectHealthy(page, errors);
});

test('retries its own unsaved caption edit after a rejected save and restores both commands after reload', async ({ page, request }) => {
  const errors = observeErrors(page);
  const project = await createProject(request, '字幕保存失败重试验收');
  await openProject(page, project.title);
  let rejectedWrites = 0;
  await page.route('**/__desktop_rpc', async route => {
    if (route.request().postDataJSON().method === 'project.update' && rejectedWrites === 0) {
      rejectedWrites++;
      await route.fulfill({ status: 400, json: { error: '字幕保存失败重试夹具' } }); return;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: '编辑字幕', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑字幕', exact: true });
  await dialog.getByLabel('字幕 1 文字', { exact: true }).fill('首次提交字幕');
  await dialog.getByRole('button', { name: '应用字幕', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('字幕修改尚未保存，草稿已保留，可重试。');
  await expect(dialog.getByLabel('字幕 1 文字', { exact: true })).toHaveValue('首次提交字幕');
  expect(await savedProject(request, project.id)).toEqual(project);
  await dialog.getByLabel('字幕 1 文字', { exact: true }).fill('重试后字幕');
  await dialog.getByRole('button', { name: '应用字幕', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await savedProject(request, project.id)).shots[0].captionTrack?.cues[0].text).toBe('重试后字幕');
  expect((await savedProject(request, project.id)).revision).toBe(project.revision + 1);
  expect(rejectedWrites).toBe(1);
  await waitForStoredCommands(page, project.id, 'caption', '重试后字幕');
  await page.reload();
  await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots[0].captionTrack?.cues[0].text).toBe('首次提交字幕');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots[0].captionTrack).toBeUndefined();
  await expectHealthy(page, errors.filter(message => !message.includes('400 (Bad Request)')));
});

test('retries its own unsaved music edit after a rejected save and restores both commands after reload', async ({ page, request }, info) => {
  const errors = observeErrors(page);
  let project = await createProject(request, '音乐保存失败重试验收');
  const path = info.outputPath('retry-music.wav'); await writeFile(path, wav());
  const asset = await rpc<AssetRecord>(request, 'asset.import', { projectId: project.id, path, kind: 'audio' });
  project = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { musicClips: [{ id: 'retry-music', assetId: asset.id, startUs: 0, sourceInUs: 0, durationUs: 2_000_000, gainDb: -18, fadeInUs: 0, fadeOutUs: 0, loop: true }] } });
  await openProject(page, project.title);
  let rejectedWrites = 0;
  await page.route('**/__desktop_rpc', async route => {
    if (route.request().postDataJSON().method === 'project.update' && rejectedWrites === 0) {
      rejectedWrites++;
      await route.fulfill({ status: 400, json: { error: '音乐保存失败重试夹具' } }); return;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: '背景音乐', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '背景音乐', exact: true });
  await dialog.getByLabel('音乐 1 音量（dB）', { exact: true }).fill('-6');
  await dialog.getByRole('button', { name: '应用背景音乐', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('音乐修改尚未保存，草稿已保留，可重试。');
  await expect(dialog.getByLabel('音乐 1 音量（dB）', { exact: true })).toHaveValue('-6');
  expect(await savedProject(request, project.id)).toEqual(project);
  await dialog.getByLabel('音乐 1 音量（dB）', { exact: true }).fill('-9');
  await dialog.getByRole('button', { name: '应用背景音乐', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await savedProject(request, project.id)).musicClips?.[0].gainDb).toBe(-9);
  expect((await savedProject(request, project.id)).revision).toBe(project.revision + 1);
  expect(rejectedWrites).toBe(1);
  await waitForStoredCommands(page, project.id, 'music', -9);
  await page.reload();
  await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).musicClips?.[0].gainDb).toBe(-6);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await savedProject(request, project.id)).musicClips).toEqual(project.musicClips);
  await expectHealthy(page, errors.filter(message => !message.includes('400 (Bad Request)')));
});
