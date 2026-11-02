import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssetRecord, ProjectDocument } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  expect(response.ok()).toBe(true);
  const payload = await response.json();
  expect(payload.error).toBeUndefined();
  return payload.result;
}

function twoSecondWav(): Buffer {
  const sampleRate = 16_000, dataSize = sampleRate * 2 * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataSize, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(dataSize, 40);
  return wav;
}

let directory: string;
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'video-quickly-source-metadata-'));
  await writeFile(join(directory, 'two-seconds.wav'), twoSecondWav());
  await writeFile(join(directory, 'unreadable.wav'), 'This is not an audio file.');
});
test.afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

async function createProject(request: APIRequestContext, title: string) {
  const project = await rpc<ProjectDocument>(request, 'project.create', { title });
  const good = await rpc<AssetRecord>(request, 'asset.import', { projectId: project.id, path: join(directory, 'two-seconds.wav'), kind: 'audio' });
  const bad = await rpc<AssetRecord>(request, 'asset.import', { projectId: project.id, path: join(directory, 'unreadable.wav'), kind: 'audio' });
  const saved = await rpc<ProjectDocument>(request, 'project.update', {
    projectId: project.id, revision: project.revision,
    patch: {
      profile: { ...project.profile, frameRate: { numerator: 30000, denominator: 1001 } },
      shots: [
        { id: 'media-shot', title: '两秒音频镜头', narration: '', visualPrompt: '', durationUs: 2_000_000, audioAssetId: good.id },
        { id: 'scene-shot', title: '无媒体二维镜头', narration: '', visualPrompt: '', durationUs: 2_000_000 },
      ],
    },
  });
  return { project: saved, good, bad };
}

async function savedProject(request: APIRequestContext, projectId: string) {
  return (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId })).project;
}

async function openProject(page: Page, title: string) {
  await page.goto('/');
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.locator('.project-card').filter({ hasText: title }).getByRole('button', { name: /继续创作/ }).click();
  await expect(page.getByLabel('镜头标题')).toHaveValue('两秒音频镜头');
}

test('reads real two-second media and bounds the final frame while authored scenes can extend', async ({ page, request }, info) => {
  const { project } = await createProject(request, '真实素材时长上界验收');
  await openProject(page, project.title);
  await expect(page.locator('.clip-timing')).toContainText('可用素材出点上限 2.000 秒');
  const outPoint = page.getByLabel('素材出点（秒）', { exact: true });
  const apply = page.getByRole('button', { name: '应用入出点', exact: true });
  await outPoint.fill('2.01');
  await expect(page.locator('.clip-timing [role=alert]')).toContainText('出点超出真实时长');
  await expect(apply).toBeDisabled();
  expect((await savedProject(request, project.id)).revision).toBe(project.revision);

  await outPoint.fill('2');
  await expect(apply).toBeEnabled();
  await apply.click();
  // The 60th 29.97 fps frame ends beyond the physical 2-second source.
  await expect.poll(async () => (await savedProject(request, project.id)).shots[0].durationUs).toBe(1_968_633);
  const bounded = await savedProject(request, project.id);
  const outHandle = page.getByRole('slider', { name: '镜头出点', exact: true });
  await expect(outHandle).toBeEnabled();
  await outHandle.press('ArrowRight');
  expect((await savedProject(request, project.id)).revision).toBe(bounded.revision);
  await page.screenshot({ path: info.outputPath('real-media-frame-bound.png') });

  // Observe the first committed values for the new shot, before a later effect
  // can reset the inputs and interrupt a user who has already started typing.
  const firstShotTiming = await page.evaluateHandle(() => {
    const result = { outPoint: '' };
    const observer = new MutationObserver(() => {
      if (document.querySelector<HTMLInputElement>('[aria-label="镜头标题"]')?.value !== '无媒体二维镜头') return;
      observer.disconnect();
      result.outPoint = document.querySelector<HTMLInputElement>('[aria-label="素材出点（秒）"]')?.value ?? 'missing';
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    return result;
  });
  await page.locator('.outline-shot').filter({ hasText: '无媒体二维镜头' }).click();
  await expect.poll(() => firstShotTiming.evaluate(value => value.outPoint)).toBe('2');
  await firstShotTiming.dispose();
  await expect(page.locator('.clip-timing')).toContainText('未关联音视频素材，可延长二维场景');
  await outPoint.fill('3');
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots[1].durationUs).toBe(3_003_000);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});

test('blocks trimming throughout source replacement loading and decode failure without blocking inputs', async ({ page, request }, info) => {
  const { project, bad } = await createProject(request, '素材切换读取状态验收');
  await openProject(page, project.title);
  await expect(page.locator('.clip-timing')).toContainText('可用素材出点上限 2.000 秒');
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/__desktop_asset?*', async route => {
    if (new URL(route.request().url()).searchParams.get('path') === bad.path) await gate;
    await route.continue();
  });
  try {
    await page.getByLabel('旁白音频', { exact: true }).selectOption(bad.id);
    await expect(page.locator('.clip-timing [role=status]')).toContainText('正在读取素材时长');
    const outPoint = page.getByLabel('素材出点（秒）', { exact: true });
    const apply = page.getByRole('button', { name: '应用入出点', exact: true });
    await expect(outPoint).toBeEnabled();
    await outPoint.fill('9');
    await expect(apply).toBeDisabled();
    await expect(page.getByRole('slider', { name: '镜头出点', exact: true })).toBeDisabled();
    await page.screenshot({ path: info.outputPath('source-loading-trim-blocked.png') });

    release();
    await expect(page.locator('.clip-timing [role=alert]')).toContainText('无法读取');
    await expect(apply).toBeDisabled();
    await expect(outPoint).toHaveValue('9');
    await page.screenshot({ path: info.outputPath('source-failed-trim-blocked.png') });
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  } finally { release(); }
});

test('projects independent audio duration onto the common trim clock and blocks an exhausted source', async ({ page, request }) => {
  const { project: original } = await createProject(request, '独立音频入点时长验收');
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: original.id, revision: original.revision, patch: {
    profile: { ...original.profile, frameRate: { numerator: 30, denominator: 1 } },
    shots: original.shots.map((shot, index) => index ? shot : { ...shot, sourceInUs: 1_000_000, audioInUs: 0, durationUs: 1_000_000 }),
  } });
  await openProject(page, project.title);
  await expect(page.locator('.clip-timing')).toContainText('可用素材出点上限 3.000 秒');
  const outPoint = page.getByLabel('素材出点（秒）', { exact: true });
  const apply = page.getByRole('button', { name: '应用入出点', exact: true });
  await expect(page.getByLabel('素材入点（秒）', { exact: true })).toHaveAttribute('min', '1');
  await outPoint.fill('3'); await expect(apply).toBeEnabled(); await apply.click();
  await expect.poll(async () => (await savedProject(request, project.id)).shots[0].durationUs).toBe(2_000_000);
  const saved = await savedProject(request, project.id);
  expect(saved.shots[0]).toMatchObject({ sourceInUs: 1_000_000, audioInUs: 0 });
  await rpc(request, 'project.update', { projectId: project.id, revision: saved.revision, patch: { shots: saved.shots.map((shot, index) => index ? shot : { ...shot, audioInUs: 3_000_000 }) } });
  await expect(page.locator('.clip-timing [role=alert]')).toContainText('入点之后没有可用素材');
  await expect(apply).toBeDisabled();
  await expect(page.getByRole('slider', { name: '镜头出点', exact: true })).toBeDisabled();
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});
