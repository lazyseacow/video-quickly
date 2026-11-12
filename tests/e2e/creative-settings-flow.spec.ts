import { expect } from '@playwright/test';
import { test } from './isolated-workspace';
import { openProduction, productionFixture, productionStep, saveProduction } from './production-settings';

// Include the scrollbar in the long-text screenshots.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

// Browser plugin not available: exercise production components in the isolated Playwright preview.
for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 1024, height: 720, theme: 'light' }, { width: 390, height: 844, theme: 'light' }] as const) {
  test(`edits creative entities and opens the invalid entry at ${viewport.width}px`, async ({ page, request }, info) => {
    const errors: string[] = [], writes: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
    await page.setViewportSize(viewport); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
    const source = await productionFixture(request), dialog = await openProduction(page, source.project);
    page.on('request', request => {
      if (!request.url().endsWith('/__desktop_rpc') || request.method() !== 'POST') return;
      const method = request.postDataJSON().method;
      if (['project.update', 'run.start'].includes(method)) writes.push(method);
    });
    await expect(page).toHaveTitle(/Video Quickly/); expect(new URL(page.url()).pathname).toBe('/');
    const brief = dialog.getByLabel('简报内容', { exact: true }), style = dialog.getByLabel('风格内容', { exact: true });
    await expect(brief).toBeFocused();
    const roles = dialog.getByRole('button', { name: /^角色与连续性/ }), entities = dialog.getByRole('button', { name: /^人物、场景与道具/ });
    const rolePanel = dialog.getByRole('region', { name: '角色与连续性', exact: true }), entityPanel = dialog.getByRole('region', { name: '人物、场景与道具', exact: true });
    const next = dialog.getByRole('button', { name: '下一步', exact: true });
    await expect(dialog.getByRole('button', { name: '应用系列模板', exact: true })).toHaveCount(0);
    const agent = dialog.getByText('剪辑 Agent 设置', { exact: true });
    const positions = () => Promise.all([roles, entities, agent, next].map(control => control.evaluate(element => {
      const { x, y, width, height } = element.getBoundingClientRect();
      const scrollTop = element.closest('.production-settings__content')?.scrollTop ?? 0;
      return { x, y: y + scrollTop, width, height };
    })));
    await expect(rolePanel).not.toBeVisible(); await expect(entityPanel).not.toBeVisible();
    await expect(next).toBeInViewport({ ratio: 1 });
    await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: info.outputPath(`creative-flow-start-${viewport.width}.png`) });
    await brief.fill('面向第一次使用 AI 工具的职场新人。');
    await style.fill('柔和的蓝灰色调和简洁线条。');
    const compactPositions = await positions();
    for (const [field, paragraph] of [
      [brief, '面向第一次使用 AI 工具的职场新人。用两个办公场景演示如何整理会议纪要、生成待办清单，再对照原文核验结论。'],
      [style, '使用柔和的蓝灰色调和简洁线条。人物在连续镜头里保持同一套服装，光线从左侧窗户进入，重点操作用局部特写呈现。'],
    ] as const) {
      await field.fill(`${paragraph}\n\n`.repeat(8));
      await expect(field).toHaveAttribute('rows', '3');
      await expect(field).toHaveCSS('resize', 'none');
      const scroll = await field.evaluate(element => {
        element.scrollTop = element.scrollHeight;
        const offset = element.scrollTop;
        element.scrollTop = 0;
        return { offset, inset: parseFloat(getComputedStyle(element, '::-webkit-scrollbar-track').marginTop), radius: parseFloat(getComputedStyle(element).borderTopRightRadius) };
      });
      expect(scroll.offset).toBeGreaterThan(0);
      expect(scroll.inset).toBeGreaterThanOrEqual(scroll.radius);
    }
    expect(await positions()).toEqual(compactPositions);
    await page.screenshot({ path: info.outputPath(`creative-flow-long-text-${viewport.width}.png`) });
    await brief.fill('用两个场景介绍 AI 如何帮助职场新人，时长 45 秒。');
    await style.fill('简洁插画，蓝灰色调');
    const initialPositions = await positions();
    await roles.press('Enter');
    await expect(rolePanel).toBeInViewport({ ratio: 1 });
    const continuity = rolePanel.getByLabel('连续性要求', { exact: true });
    await page.keyboard.press('Tab'); await expect(continuity).toBeFocused();
    await continuity.fill('同一间办公室，保持傍晚光线');
    expect(await positions()).toEqual(initialPositions);
    await page.keyboard.press('Escape');
    await expect(rolePanel).not.toBeVisible(); await expect(roles).toBeFocused();
    await expect(roles).toContainText('已填写连续性要求');
    await page.keyboard.press('Tab');
    await expect(entities).toBeFocused(); await expect(entities).toHaveCSS('outline-style', 'solid');
    await page.screenshot({ path: info.outputPath(`creative-flow-focus-${viewport.width}.png`) });
    await entities.press('Space');
    await expect(entityPanel).toBeInViewport({ ratio: 1 });
    expect(await positions()).toEqual(initialPositions);
    const content = dialog.locator('.production-settings__content');
    await expect(content).toHaveCSS('overflow-y', 'hidden');
    const contentBox = (await content.boundingBox())!;
    const workspaceBox = (await entityPanel.boundingBox())!;
    expect(workspaceBox.width).toBeGreaterThan(contentBox.width * .9);
    expect(workspaceBox.y).toBeGreaterThanOrEqual(contentBox.y);
    expect(workspaceBox.y + workspaceBox.height).toBeLessThanOrEqual(contentBox.y + contentBox.height);
    const addScene = entityPanel.getByRole('button', { name: '添加场景设定', exact: true });
    const addPerson = entityPanel.getByRole('button', { name: '添加人物设定', exact: true });
    const returnToPlanning = entityPanel.getByRole('button', { name: '返回创作要求', exact: true });
    await expect(addPerson).toBeFocused();
    await addScene.click();
    const scene = entityPanel.getByRole('region', { name: '场景设定 1', exact: true });
    await expect(scene.getByLabel('设定名称', { exact: true })).toBeFocused();
    await expect(scene.getByLabel('设定名称', { exact: true })).toBeInViewport({ ratio: 1 });
    await expect(scene.locator('.creative-reference-picker__disclosure')).not.toHaveAttribute('open');
    await scene.getByLabel('设定名称', { exact: true }).fill('靠窗的办公室');
    await scene.getByLabel('固定特征', { exact: true }).fill('左侧落地窗，桌上有绿植');
    expect(await positions()).toEqual(initialPositions);
    const list = entityPanel.getByRole('tablist', { name: '设定列表', exact: true });
    const listBox = (await list.boundingBox())!, sceneBox = (await scene.boundingBox())!;
    if (viewport.width > 800) expect(sceneBox.x).toBeGreaterThan(listBox.x + listBox.width);
    else expect(sceneBox.y).toBeGreaterThan(listBox.y + listBox.height);
    const sceneTab = list.getByRole('tab', { name: '场景 · 靠窗的办公室', exact: true });
    await entityPanel.getByRole('button', { name: '添加道具设定', exact: true }).click();
    const prop = entityPanel.getByRole('region', { name: '道具设定 2', exact: true });
    const unnamedProp = list.getByRole('tab', { name: '道具 · 未命名', exact: true });
    await expect(prop.getByLabel('设定名称', { exact: true })).toBeFocused();
    if (viewport.width === 390) await prop.getByLabel('设定名称', { exact: true }).fill('   ');
    await expect(scene).not.toBeVisible();
    await unnamedProp.press(viewport.width > 800 ? 'ArrowUp' : 'ArrowLeft');
    await expect(sceneTab).toBeFocused(); await expect(prop).not.toBeVisible();
    // Validate from final review while a different entry is selected.
    await returnToPlanning.click();
    await expect(entityPanel).not.toBeVisible(); await expect(entities).toBeFocused();
    await expect(content).toHaveCSS('overflow-y', 'auto');
    await saveProduction(dialog);
    await expect(dialog.getByRole('button', { name: '创作要求', exact: true })).toHaveAttribute('aria-current', 'step');
    await expect(entityPanel).toBeVisible(); await expect(unnamedProp).toHaveAttribute('aria-selected', 'true');
    await expect(prop.getByLabel('设定名称', { exact: true })).toBeFocused();
    await expect(prop.getByLabel('设定名称', { exact: true })).toBeInViewport({ ratio: 1 });
    expect(writes).toEqual([]); expect((await source.saved()).revision).toBe(source.project.revision);
    await prop.getByLabel('设定名称', { exact: true }).fill('银色笔记本电脑');
    await prop.getByLabel('固定特征', { exact: true }).fill('银色外壳，屏幕朝向主角');
    await next.press('Enter');
    await expect(dialog.getByRole('combobox', { name: '文本模型', exact: true })).toBeFocused();
    await dialog.getByRole('button', { name: '上一步', exact: true }).click();
    await expect(dialog.getByLabel('简报内容', { exact: true })).toBeFocused();
    await expect(entityPanel).not.toBeVisible(); await entities.click();
    await expect(prop.getByLabel('固定特征', { exact: true })).toHaveValue('银色外壳，屏幕朝向主角');
    await sceneTab.click();
    await expect(scene.getByLabel('固定特征', { exact: true })).toHaveValue('左侧落地窗，桌上有绿植');
    await expect(prop).not.toBeVisible();
    await expect.poll(() => dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 2)).toBe(true);
    await expect(next).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath(`creative-flow-entities-${viewport.width}.png`) });
    await page.keyboard.press('Escape');
    await expect(entityPanel).not.toBeVisible(); await expect(entities).toBeFocused();
    await productionStep(dialog, '确认保存');
    await expect(dialog.getByRole('region', { name: '确认保存', exact: true })).toContainText('靠窗的办公室、银色笔记本电脑');
    await dialog.getByRole('button', { name: '修改创作要求', exact: true }).click();
    await expect(dialog.getByLabel('简报内容', { exact: true })).toBeFocused();
    await expect(dialog.getByLabel('简报内容', { exact: true })).toHaveValue('用两个场景介绍 AI 如何帮助职场新人，时长 45 秒。');
    await saveProduction(dialog); await expect(dialog).toHaveCount(0);
    const saved = await source.saved();
    expect(saved.creativeContext).toMatchObject({ continuity: '同一间办公室，保持傍晚光线', entities: [{ kind: 'scene', name: '靠窗的办公室', description: '左侧落地窗，桌上有绿植' }, { kind: 'prop', name: '银色笔记本电脑', description: '银色外壳，屏幕朝向主角' }] });
    expect(writes).toEqual(['project.update']);
    await page.getByRole('button', { name: '制作设置', exact: true }).click(); await productionStep(dialog, '创作要求');
    await expect(roles).toContainText('已填写连续性要求');
    await expect(entities).toContainText('靠窗的办公室、银色笔记本电脑');
    await entities.click(); await sceneTab.click();
    await scene.getByRole('button', { name: '移除场景设定 1', exact: true }).click();
    await expect(addPerson).toBeFocused();
    await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click(); await expect(dialog).toHaveCount(0);
    expect((await source.saved()).creativeContext?.entities).toHaveLength(2);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
  });
}
