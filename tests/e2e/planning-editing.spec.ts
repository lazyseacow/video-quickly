import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { type ProjectDocument } from '@video-quickly/contracts';
import { fixture, latest, rpc, saved } from './native-video-fixture';
import { openProjectFromList } from './workspace-navigation';

test.use({ reducedMotion: 'reduce' });

async function openWorkbench(page: Page, project: ProjectDocument) {
  await page.goto('/');
  await openProjectFromList(page, project.title);
}

async function prepared(page: Page, request: APIRequestContext, info: TestInfo) {
  const source = await fixture(request, info, false, 2);
  try {
    await rpc(request, 'workflow.save', { projectId: source.project.id, workflow: { ...source.project.workflow, production: { ...source.project.workflow.production!, textModelId: source.models[0].id, videoModelId: source.video.id } } });
    await rpc(request, 'run.start', { projectId: source.project.id });
    await expect.poll(async () => (await latest(request, source.project.id))?.status, { timeout: 30000 }).toBe('succeeded');
    await openWorkbench(page, source.project);
    await page.getByRole('button', { name: '打开步骤：简报生成', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '本次制作', exact: true });
    await expect(dialog.getByRole('button', { name: '编辑创意简报', exact: true })).toBeVisible();
    return { source, dialog, run: (await latest(request, source.project.id))! };
  } catch (error) { await source.close(); throw error; }
}
const mediaAndTiming = (project: ProjectDocument) => project.shots.map(({ title: _title, narration: _narration, visualPrompt: _visual, soundPrompt: _sound, ...rest }) => rest);

for (const { width, theme } of [{ width: 1536, theme: 'dark' }, { width: 1024, theme: 'light' }, { width: 390, theme: 'light' }]) {
  test(`edits planning results, persists them and preserves media with undo at ${width}px`, async ({ page, request }, info) => {
    const errors: string[] = [], methods: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
    page.on('request', request => { if (request.url().endsWith('/__desktop_rpc')) methods.push(request.postDataJSON().method); });
    await page.setViewportSize({ width, height: 960 }); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), theme);
    const { source, dialog, run } = await prepared(page, request, info);
    try {
      const baseline = await saved(request, source.project.id), calls = source.requests.length;
      const frozen = await Promise.all(source.project.workflow.nodes.filter(node => ['brief', 'style', 'script'].includes(node.kind)).map(node => rpc(request, 'run.step.payload', { runId: run.id, nodeId: node.id, kind: 'output' })));
      await expect(dialog.getByRole('button', { name: '历史产物', exact: true })).toHaveCount(0);
      await dialog.getByRole('button', { name: '编辑创意简报', exact: true }).click();
      const briefEditor = page.getByRole('dialog', { name: '编辑创意简报', exact: true });
      await expect(briefEditor.getByLabel('创意简报', { exact: true })).toHaveValue(baseline.brief);
      await briefEditor.getByLabel('创意简报', { exact: true }).fill('取消的简报'); await briefEditor.getByRole('button', { name: '取消', exact: true }).click();
      await expect(briefEditor).toHaveCount(0); expect(await saved(request, source.project.id)).toEqual(baseline);
      await dialog.getByRole('button', { name: '编辑创意简报', exact: true }).click();
      const brief = '主题：修改后的创作主题\n目标观众：新入职的同学\n核心信息：三个具体操作。';
      await briefEditor.getByLabel('创意简报', { exact: true }).fill(brief);
      await expect(briefEditor.locator('.dialog__surface')).toHaveCSS('opacity', '1');
      await page.screenshot({ path: info.outputPath(`planning-brief-editor-${width}.png`) });
      await briefEditor.getByRole('button', { name: '保存到项目', exact: true }).click();
      await expect(briefEditor).toHaveCount(0); await expect(dialog.getByRole('heading', { name: '修改后的创作主题', exact: true })).toBeVisible();

      const steps = dialog.getByRole('navigation', { name: '本次制作步骤', exact: true });
      await steps.getByRole('button', { name: /风格与角色/ }).click(); await dialog.getByRole('button', { name: '编辑风格与角色', exact: true }).click();
      const styleEditor = page.getByRole('dialog', { name: '编辑风格与角色', exact: true });
      await styleEditor.getByLabel('视觉风格', { exact: true }).fill('修改后的漫画风格');
      await styleEditor.getByLabel('连续性要求', { exact: true }).fill('全片保留同一件蓝色外套');
      await styleEditor.getByRole('button', { name: '保存到项目', exact: true }).click(); await expect(styleEditor).toHaveCount(0);
      await expect(dialog.getByRole('region', { name: '本次产物', exact: true })).toContainText('全片保留同一件蓝色外套');

      await steps.getByRole('button', { name: /分镜生成/ }).click(); await dialog.getByRole('button', { name: '编辑旁白与分镜', exact: true }).click();
      const scriptEditor = page.getByRole('dialog', { name: '编辑旁白与分镜', exact: true }), first = scriptEditor.getByRole('group', { name: '镜头 1 内容', exact: true });
      await first.getByLabel('镜头标题', { exact: true }).fill('人工调整的第一镜');
      await first.getByLabel('旁白', { exact: true }).fill('修改后的旁白，先讲最重要的一点。');
      await first.locator('summary').click(); await first.getByLabel('画面要求', { exact: true }).fill('主角站在窗边演示操作');
      await first.getByLabel('声音要求', { exact: true }).fill('自然的讲述声');
      expect(await scriptEditor.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await expect(scriptEditor.locator('.dialog__surface')).toHaveCSS('opacity', '1');
      await page.screenshot({ path: info.outputPath(`planning-script-editor-${width}.png`) });
      await scriptEditor.getByRole('button', { name: '保存到项目', exact: true }).click(); await expect(scriptEditor).toHaveCount(0);
      await expect(dialog.getByRole('heading', { name: '人工调整的第一镜', exact: true })).toBeVisible();
      const modified = await saved(request, source.project.id);
      expect(modified).toMatchObject({ brief, style: '修改后的漫画风格', creativeContext: { continuity: '全片保留同一件蓝色外套' } });
      expect(mediaAndTiming(modified)).toEqual(mediaAndTiming(baseline)); expect(source.requests.length).toBe(calls);
      await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click(); await expect(dialog).toHaveCount(0);
      await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect.poll(async () => (await saved(request, source.project.id)).shots).toEqual(baseline.shots);
      expect((await saved(request, source.project.id)).brief).toBe(brief);
      await page.getByRole('button', { name: '重做', exact: true }).click(); await expect.poll(async () => (await saved(request, source.project.id)).shots).toEqual(modified.shots);
      await openWorkbench(page, source.project);
      await page.getByRole('button', { name: '打开步骤：简报生成', exact: true }).click();
      await expect(dialog.getByRole('heading', { name: '修改后的创作主题', exact: true })).toBeVisible();
      const currentFrozen = await Promise.all(source.project.workflow.nodes.filter(node => ['brief', 'style', 'script'].includes(node.kind)).map(node => rpc(request, 'run.step.payload', { runId: run.id, nodeId: node.id, kind: 'output' })));
      expect(currentFrozen).toEqual(frozen); expect(source.requests.length).toBe(calls); expect(methods).not.toContain('run.step.versions');
      await expect(page).toHaveTitle(/Video Quickly/); await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
    } finally { await source.close(); }
  });
}

test('keeps edited input after save failure and commits a retried save once while controls are frozen', async ({ page, request }, info) => {
  const { source, dialog } = await prepared(page, request, info);
  let release = () => {};
  try {
    const baseline = await saved(request, source.project.id);
    await dialog.getByRole('button', { name: '编辑创意简报', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '编辑创意简报', exact: true });
    await editor.getByLabel('创意简报', { exact: true }).fill('保存失败后仍然保留的简报');
    let updates = 0; const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/__desktop_rpc', async route => {
      const input = route.request().postDataJSON();
      if (input.method !== 'project.update') { await route.continue(); return; }
      updates++;
      if (updates === 1) { await route.fulfill({ status: 500, json: { error: '隔离的保存失败' } }); return; }
      await gate; await route.continue();
    });
    await editor.getByRole('button', { name: '保存到项目', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText('保存未完成'); await expect(editor.getByLabel('创意简报', { exact: true })).toHaveValue('保存失败后仍然保留的简报');
    expect(await saved(request, source.project.id)).toEqual(baseline);
    await editor.getByRole('button', { name: '保存到项目', exact: true }).click(); await expect.poll(() => updates).toBe(2);
    await expect(editor.getByLabel('创意简报', { exact: true })).toBeDisabled(); await page.keyboard.press('Control+s'); expect(updates).toBe(2);
    release(); await expect(editor).toHaveCount(0);
    const value = await saved(request, source.project.id); expect(value.brief).toBe('保存失败后仍然保留的简报'); expect(value.revision).toBe(baseline.revision + 1);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); await source.close(); }
});

test('retains local editor input and rejects overwriting a concurrently changed planning field', async ({ page, request }, info) => {
  const { source, dialog } = await prepared(page, request, info);
  try {
    await dialog.getByRole('button', { name: '编辑创意简报', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '编辑创意简报', exact: true });
    await editor.getByLabel('创意简报', { exact: true }).fill('编辑器里的输入');
    const before = await saved(request, source.project.id);
    const external = await rpc<ProjectDocument>(request, 'project.update', { projectId: before.id, revision: before.revision, patch: { brief: '外部修改的简报' } });
    await expect(dialog.locator('.result-document')).toContainText('外部修改的简报');
    await editor.getByRole('button', { name: '保存到项目', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText('已在其他位置修改');
    await expect(editor.getByLabel('创意简报', { exact: true })).toHaveValue('编辑器里的输入'); expect(await saved(request, before.id)).toEqual(external);
  } finally { await source.close(); }
});

test('keeps locked shot inputs read-only while allowing another shot to be edited', async ({ page, request }, info) => {
  const { source, dialog } = await prepared(page, request, info);
  try {
    const before = await saved(request, source.project.id);
    await rpc(request, 'project.update', { projectId: before.id, revision: before.revision, patch: { shots: before.shots.map((shot, index) => index === 0 ? { ...shot, locked: true } : shot) } });
    await expect(page.locator('[aria-label="解锁镜头"]')).toHaveCount(1);
    await dialog.getByRole('navigation', { name: '本次制作步骤', exact: true }).getByRole('button', { name: /分镜生成/ }).click();
    await dialog.getByRole('button', { name: '编辑旁白与分镜', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '编辑旁白与分镜', exact: true });
    await expect(editor.getByRole('group', { name: '镜头 1 内容', exact: true }).getByLabel('旁白', { exact: true })).toBeDisabled();
    await editor.getByRole('group', { name: '镜头 2 内容', exact: true }).getByLabel('旁白', { exact: true }).fill('第二镜头可以修改');
    await editor.getByRole('button', { name: '保存到项目', exact: true }).click(); await expect(editor).toHaveCount(0);
    const after = await saved(request, before.id); expect(after.shots[0]).toEqual({ ...before.shots[0], locked: true }); expect(after.shots[1].narration).toBe('第二镜头可以修改');
  } finally { await source.close(); }
});

test('disables planning editing while the current production is active', async ({ page, request }, info) => {
  const source = await fixture(request, info, true);
  let runId = '';
  try {
    await rpc(request, 'workflow.save', { projectId: source.project.id, workflow: { ...source.project.workflow, production: { ...source.project.workflow.production!, textModelId: source.models[0].id, videoModelId: source.video.id } } });
    const run = await rpc<{ id: string }>(request, 'run.start', { projectId: source.project.id }); runId = run.id; await source.pending;
    await openWorkbench(page, source.project);
    await page.getByRole('button', { name: '打开步骤：简报生成', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '本次制作', exact: true });
    await expect(dialog.getByRole('tablist', { name: '步骤详情视图', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '编辑创意简报', exact: true })).toBeDisabled();
    await expect(dialog).toContainText('完成或停止后可修改策划内容');
  } finally { if (runId) await rpc(request, 'run.cancel', { runId }); await source.close(); }
});
