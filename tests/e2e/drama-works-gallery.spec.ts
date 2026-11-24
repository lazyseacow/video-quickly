import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Locator } from '@playwright/test';
import { DEFAULT_VIDEO_PROFILE, type AssetRecord, type ProjectDocument } from '@video-quickly/contracts';
import { openWorks } from './workspace-navigation';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json();
  expect(response.ok(), JSON.stringify(payload.error)).toBe(true);
  expect(payload.error).toBeUndefined();
  return payload.result;
}

async function expectSourceFrame(preview: Locator) {
  const canvas = preview.getByRole('img', { name: '蓝色试片 · 镜头预览' });
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate((frame: HTMLCanvasElement) => {
    const context = frame.getContext('2d');
    return context?.getImageData(Math.floor(frame.width / 2), Math.floor(frame.height / 2), 1, 1).data[2];
  })).toBeGreaterThan(200);
}

test('keeps an earlier real cover while continuing the newest episode', async ({ page, request }, info) => {
  const title = `巷口来信 ${randomUUID().slice(0, 8)}`;
  const profile = { ...DEFAULT_VIDEO_PROFILE, width: 360, height: 640 };
  const first = await rpc<ProjectDocument>(request, 'project.create', { title, profile, originalText: '昨夜雨停后，一封旧信被送回巷口。' });
  const workId = first.drama!.workId;
  const path = info.outputPath('earlier-episode.svg');
  await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="640"><rect width="100%" height="100%" fill="#2255ff"/></svg>');
  const asset = await rpc<AssetRecord>(request, 'asset.import', { path, projectId: first.id, kind: 'image' });
  await rpc(request, 'project.update', {
    projectId: first.id,
    revision: first.revision,
    patch: { shots: [{ id: 'blue-frame', title: '蓝色试片', narration: '', visualPrompt: '', durationUs: 1_000_000, assetId: asset.id }] },
  });
  const second = await rpc<ProjectDocument>(request, 'project.create', {
    title: '归还之日', brief: '她沿着信封上的笔迹去找寄信人。', profile,
    drama: { workId, number: 2, scenes: [] },
  });

  await page.goto('/');
  await openWorks(page);
  const search = page.getByRole('searchbox', { name: '搜索作品' });
  await search.fill(title);
  const card = page.locator(`.drama-work-card[data-work-id="${workId}"]`);
  const cover = card.locator('.drama-library__cover');
  await expectSourceFrame(cover);
  await expect(cover).toHaveText('第 1 集');
  await expect(card.getByText('最近编辑 · 第 2 集')).toBeVisible();

  await card.getByRole('button', { name: '查看分集' }).click();
  const firstRow = page.locator(`.drama-episode-row[data-project-id="${first.id}"]`);
  const secondRow = page.locator(`.drama-episode-row[data-project-id="${second.id}"]`);
  await expectSourceFrame(firstRow);
  await expect(firstRow.getByText('最近编辑', { exact: true })).toHaveCount(0);
  await expect(secondRow.getByText('最近编辑', { exact: true })).toBeVisible();
  await expect(secondRow.locator('.drama-library__episode-preview')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.drama-library__detail-header')).toHaveCSS('animation-name', 'none');
  await expect(secondRow.getByText('最近编辑', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 844 });
  const section = page.locator('.drama-library');
  expect(await section.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: '返回作品列表' }).click();
  await expect(card.getByRole('button', { name: '查看分集' })).toBeFocused();
  await card.getByRole('button', { name: '继续创作' }).click();
  await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(second.title);
});
