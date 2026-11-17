import { expect, type Page } from '@playwright/test';
import { createSceneTemplate, DEFAULT_VIDEO_PROFILE, type DramaWork, type ProjectDocument, type ProjectSummary } from '@video-quickly/contracts';

export const sampleProjectTitle = '一纸登科，改变了什么？';
const samples = new WeakMap<Page, ProjectDocument>();

async function rpc<T>(page: Page, method: string, params: unknown = {}): Promise<T> {
  const result = await page.request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await result.json(); expect(result.ok(), JSON.stringify(payload.error)).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}

/** A test owns this explicit four-shot story; production workspaces start without example projects. */
export async function ensureSampleProject(page: Page): Promise<ProjectDocument> {
  const previous = samples.get(page); if (previous) return previous;
  const created = await rpc<ProjectDocument>(page, 'project.create', {
    title: sampleProjectTitle, originalText: '第一场：清晨的书院，一位年轻人收到登科的消息。第二场：他告别家人来到城门。第三场：他见到等待已久的朋友，两人商量未来的选择。第四场：他回望家乡，决定用所学帮助更多人。',
    profile: DEFAULT_VIDEO_PROFILE,
  });
  const saved = await rpc<ProjectDocument>(page, 'project.update', { projectId: created.id, revision: created.revision, patch: {
    shots: ['一纸登科，改变了什么？', '告别书院', '城门相会', '回望故乡'].map((title, index) => ({ id: `${created.id}-shot-${index + 1}`, title, narration: ['一纸消息，改变了少年的一生。', '他带着家人的期望踏上旅程。', '老友相见，共同商量未来。', '他决定以所学帮助更多人。'][index], visualPrompt: '古装书院与城门，少年在清晨出发，人物服装与光线保持一致。', durationUs: 3_000_000, sceneTemplate: createSceneTemplate('process') })),
  } });
  samples.set(page, saved); return saved;
}

export async function openStudio(page: Page) {
  await page.getByRole('complementary', { name: '工作空间导航', exact: true }).getByRole('button', { name: '短剧工作室', exact: true }).click();
  await expect(page.locator('.drama-library')).toBeVisible();
  const back = page.locator('.page-heading').getByRole('button', { name: '短剧工作室', exact: true });
  if (await back.count()) await back.click();
  await expect(page.getByRole('heading', { name: '短剧工作室', exact: true, level: 1 })).toBeVisible();
}

export async function openAssetLibrary(page: Page, view: '媒体' | '角色') {
  await page.getByRole('button', { name: '素材库', exact: true }).click();
  const tab = page.getByRole('tablist', { name: '素材库视图', exact: true }).getByRole('tab', { name: view, exact: true });
  if (await tab.getAttribute('aria-selected') !== 'true') await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

export async function openProjectFromList(page: Page, title?: string, { waitForReady = true }: { waitForReady?: boolean } = {}) {
  const name = title ?? await page.locator('.project-title-input').inputValue();
  const sample = name === sampleProjectTitle ? await ensureSampleProject(page) : undefined;
  const workspace = await rpc<{ projects: ProjectSummary[] }>(page, 'workspace.summary');
  const project = sample ? workspace.projects.find(project => project.id === sample.id) : workspace.projects.find(project => project.title === name && !project.archived);
  if (!project?.drama) throw new Error(`未找到测试短剧分集：${name}`);
  const work = await rpc<DramaWork>(page, 'dramaWork.get', { workId: project.drama.workId });
  await openStudio(page);
  await page.getByRole('group', { name: '作品筛选', exact: true }).getByRole('button', { name: '可用', exact: true }).click();
  await page.getByRole('searchbox', { name: '搜索作品', exact: true }).fill(work.title);
  const card = page.locator(`.drama-work-card[data-work-id="${work.id}"]`);
  const more = page.getByRole('button', { name: '加载更多作品', exact: true });
  await expect.poll(async () => {
    if (await card.count()) return true;
    if (await more.count() && await more.isEnabled()) await more.click();
    return false;
  }, { message: `作品列表中应能打开“${work.title}”`, timeout: 15_000 }).toBe(true);
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '查看分集', exact: true }).click();
  await page.locator(`.drama-episode-row[data-project-id="${project.id}"]`).getByRole('button', { name: '打开分集', exact: true }).click();
  if (waitForReady) {
    const workbench = page.locator('.workbench');
    await expect(workbench).toBeVisible();
    await expect(workbench.getByLabel('项目名称', { exact: true })).toHaveValue(name);
  }
  return project;
}
