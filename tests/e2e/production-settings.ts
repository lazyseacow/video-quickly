import { confirmAction } from './confirmation-actions';
import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { ModelProfile, ProjectDocument } from '@video-quickly/contracts';
import { openProjectFromList } from './workspace-navigation';

export async function productionFixture(request: APIRequestContext) {
  async function rpc<T>(method: string, params: unknown): Promise<T> {
    const response = await request.post('/__desktop_rpc', { data: { method, params } }), payload = await response.json();
    expect(response.ok(), JSON.stringify(payload.error)).toBe(true); return payload.result;
  }
  const suffix = randomUUID().slice(0, 8), models: ModelProfile[] = [];
  for (const [role, name] of [['text', '统一文本'], ['text', '独立文本'], ['image', '参考图片'], ['video', '视频']] as const) models.push(await rpc<ModelProfile>('model.save', { model: {
    name: `${name} ${suffix}`, provider: 'openai-compatible', connectionType: role, capabilities: [role], model: `fixture-${role}`, baseUrl: 'http://127.0.0.1:1/v1', parameters: {},
  } }));
  const project = await rpc<ProjectDocument>('project.create', { title: `统一制作 ${suffix}` });
  return { project, text: models[0], override: models[1], image: models[2], video: models[3], async saved() { return (await rpc<{ project: ProjectDocument }>('project.get', { projectId: project.id })).project; } };
}

export async function pickProductionModel(dialog: Locator, label: string, model: ModelProfile) {
  const control = dialog.getByRole('combobox', { name: label, exact: true });
  if (!await control.isVisible() && ['文本模型', '视频模型', '图片模型'].includes(label)) await productionStep(dialog, '模型与素材');
  await control.fill(model.name);
  await dialog.getByRole('option', { name: model.name, exact: true }).click();
  await expect(control).toHaveValue(model.name);
}
export async function productionStep(dialog: Locator, label: '创作要求' | '模型与素材' | '声音与成片' | '确认保存') {
  await dialog.getByRole('navigation', { name: '制作设置步骤', exact: true }).getByRole('button', { name: label, exact: true }).click();
}
export async function openStoryboardProfile(dialog: Locator) {
  const disclosure = dialog.locator('.production-settings__storyboard');
  if (await disclosure.getAttribute('open') === null) await disclosure.locator(':scope > summary').click();
  return dialog.getByRole('group', { name: '分镜全局参数', exact: true });
}
export async function saveProduction(dialog: Locator) {
  await productionStep(dialog, '确认保存');
  await dialog.getByRole('button', { name: /^(保存设置|保存待用配置)$/ }).click();
}
export async function saveAndStartProduction(dialog: Locator) {
  await saveProduction(dialog); await expect(dialog).toHaveCount(0);
  await dialog.page().getByRole('button', { name: '开始制作', exact: true }).click(); await confirmAction(dialog.page(), '确认开始制作');
}
export async function openProduction(page: Page, project: ProjectDocument) {
  await page.goto('/'); await openProjectFromList(page, project.title);
  await page.getByRole('button', { name: '制作设置', exact: true }).click();
  return page.getByRole('dialog', { name: '制作设置', exact: true });
}
