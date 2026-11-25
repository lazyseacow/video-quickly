import { confirmAction } from './confirmation-actions';
import { planningFixtureResponse, storyboardFixtureResponse } from '../fixtures/planning-response';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect } from '@playwright/test';
import type { ModelProfile, ProjectDocument, RunInspection, RunSummary } from '@video-quickly/contracts';
import { test } from './isolated-workspace';
import { rpc } from './native-video-fixture';
import { openProjectFromList } from './workspace-navigation';

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

const stageLabels = ['策划与分镜', '素材与配音', '剪辑与动画', '审阅与导出'];
for (const surface of [{ width: 1536, height: 960, theme: 'dark' }, { width: 600, height: 900, theme: 'light' }]) test(`tracks fixed local editing and workflow export without invoking enabled tools at ${surface.width}px`, async ({ page, request }, info) => {
  test.setTimeout(60000);
  const sourcePath = info.outputPath('agent-source.mp4');
  await promisify(execFile)(process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourcePath]);
  const source = await readFile(sourcePath);
  const generating = gate(), entered = gate(), errors: string[] = [];
  let baseUrl = '', controllerCalls = 0, mcpCalls = 0, videoRequests = 0;
  const server = createServer({ keepAliveTimeout: 0 }, async (incoming, response) => {
    try {
      if (incoming.url === '/source.mp4') { response.setHeader('content-type', 'video/mp4'); response.end(source); return; }
      if (incoming.url === '/mcp') { mcpCalls++; throw new Error('Built-in production must not connect to MCP'); }
      let encoded = ''; for await (const chunk of incoming) encoded += chunk.toString();
      const payload = JSON.parse(encoded) as { images?: string[]; tools?: unknown[]; messages: Array<{ role: string; content?: string }> };
      response.setHeader('content-type', 'application/json');
      if (incoming.url === '/generate-video') { videoRequests++; expect(payload.images).toEqual([]); entered.release(); await generating.promise; response.end(JSON.stringify({ url: `${baseUrl}/source.mp4` })); return; }
      if (payload.tools?.length) {
        controllerCalls++;
        throw new Error('Built-in production must not invoke an editing Agent');
      }
      const text = '采用柔和的蓝色画面。';
      const content = encoded.includes('自动视频制作步骤：旁白与分镜')
        ? storyboardFixtureResponse(payload.messages[0].content, JSON.stringify({ shots: [{ title: '蓝色镜头', narration: '这是蓝色的天空。', visualPrompt: '蓝色天空', durationUs: 2_000_000 }], entities: [] }))
        : planningFixtureResponse(encoded, text);
      response.end(JSON.stringify({ id: 'production-ui', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] }));
    } catch (error) { errors.push(String(error)); response.statusCode = 500; response.end('Fixture request failed'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Agent 测试服务未启动');
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['warning', 'error'].includes(message.type())) errors.push(message.text()); });
  try {
    baseUrl = `http://127.0.0.1:${address.port}`;
    const text = await rpc<ModelProfile>(request, 'model.save', { model: { name: `本地剪辑进度 ${randomUUID()}`, provider: 'openai-compatible', baseUrl: `${baseUrl}/v1`, model: 'fixture', connectionType: 'text', capabilities: ['text', 'tools'] } });
    const video = await rpc<ModelProfile>(request, 'model.save', { model: { name: `镜头生成 ${randomUUID()}`, provider: 'custom-http', baseUrl, model: 'fixture', connectionType: 'video', capabilities: ['video'], parameters: { requestPath: 'generate-video', requestTemplate: { prompt: '{{prompt}}', images: '{{character_images}}' }, resultUrlPath: 'url' } } });
    const created = await rpc<ProjectDocument>(request, 'project.create', { originalText: '清晨，林夏在书房发现一封未寄出的信。她来到旧城寻找信的主人，与朋友在雨中的城门重逢。两人读完信后决定一起回家。', title: `本地剪辑制作进度 ${randomUUID()}`, brief: '制作蓝色天空视频', profile: { width: 160, height: 90, frameRate: { numerator: 30, denominator: 1 } } });
    const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision,
      patch: { workflow: { ...created.workflow, production: { ...created.workflow.production, textModelId: text.id, videoModelId: video.id } } } });
    await page.setViewportSize(surface); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), surface.theme);
    await page.goto('/'); await openProjectFromList(page, project.title);
    await page.getByRole('button', { name: '开始制作', exact: true }).click(); await confirmAction(page, '确认开始制作'); await entered.promise;
    const latest = async () => (await rpc<{ items: RunSummary[] }>(request, 'run.list', { projectId: project.id })).items[0];
    const run = await latest();
    const progress = page.getByRole('region', { name: '当前制作', exact: true });
    const stages = progress.getByRole('list', { name: '制作阶段进度', exact: true });
    await expect(stages.locator('.workbench-guide__step-copy > strong')).toHaveText(stageLabels);
    await expect(stages.locator('.workbench-guide__step[data-state="succeeded"]')).toHaveCount(1);
    const generatingCard = stages.getByRole('button', { name: '打开阶段：素材与配音', exact: true });
    await expect(generatingCard).toHaveAttribute('aria-current', 'step'); await generatingCard.click();
    const detail = page.getByRole('dialog', { name: '本次制作', exact: true });
    await expect(detail.getByRole('navigation', { name: '本次制作步骤', exact: true })).toContainText('分镜生成');
    await expect(detail.getByRole('navigation', { name: '本次制作步骤', exact: true }).locator('button[aria-current="step"]')).toContainText('镜头视频生成');
    await page.keyboard.press('Escape'); await expect(detail).toHaveCount(0); generating.release();
    await expect.poll(async () => (await latest()).status, { timeout: 30000 }).toBe('succeeded');
    const inspection = await rpc<RunInspection>(request, 'run.inspect', { runId: run.id, nodeId: 'animation' });
    expect(inspection.steps.map(step => step.id)).toEqual(['screenplay', 'brief', 'style', 'script', 'assets', 'video', 'animation', 'export']);
    expect(inspection.steps.every(step => step.status === 'succeeded')).toBe(true);
    expect(inspection.selected?.node).toMatchObject({ kind: 'animation', skillIds: [], config: { operation: 'prepare-edit' } });
    expect(inspection.selected?.node.config.requiresModel).toBeUndefined();
    expect(inspection.selected?.node.modelId).toBeUndefined();
    expect({ controllerCalls, mcpCalls }).toEqual({ controllerCalls: 0, mcpCalls: 0 });
    expect(videoRequests).toBe(1);
    const exportResult = await rpc<{ videoPath: string }>(request, 'node.result', { runId: run.id, nodeId: 'export' });
    const videoBytes = await readFile(exportResult.videoPath); expect(videoBytes.subarray(4, 8).toString()).toBe('ftyp');
    await expect(stages.locator('.workbench-guide__step-copy > strong')).toHaveText(stageLabels);
    await expect(stages.locator('.workbench-guide__step[data-state="succeeded"]')).toHaveCount(4);
    await stages.getByRole('button', { name: '打开阶段：审阅与导出', exact: true }).click();
    const steps = detail.getByRole('navigation', { name: '本次制作步骤', exact: true });
    await expect(steps.locator('button[aria-current="step"]')).toContainText('导出成片');
    await expect(steps.getByRole('button')).toHaveCount(inspection.steps.length);
    await expect(steps.getByRole('img', { name: '已保存产物', exact: true })).toHaveCount(inspection.steps.length);
    await expect(detail).not.toContainText('未纳入本次制作');

    await expect(steps.getByRole('button', { name: /剪辑与运镜准备/ })).toHaveCount(1);
    await steps.getByRole('button', { name: /剪辑与运镜准备/ }).click();
    await expect(detail.getByRole('heading', { name: '剪辑与运镜准备', exact: true })).toBeVisible();
    const result = detail.getByRole('region', { name: '本次产物', exact: true });
    await expect(result).toContainText('动画与运镜参数已就绪');
    await expect(result).not.toContainText(/项目编号|模板编号|项目修订|editedProject|execute_video_task/);
    await expect(result).not.toContainText(project.id);
    expect(await detail.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`local-editing-${surface.width}.png`) });

    await expect(steps.locator('.run-inspector__index')).toHaveText(['01', '02', '03', '04', '05', '06', '07', '08']);
    for (const [index, label] of ['剧本正文', '简报生成', '风格与角色生成', '分镜生成'].entries()) {
      await expect(steps.getByRole('button').nth(index).locator('strong')).toHaveText(label);
    }
    await page.keyboard.press('Escape'); await expect(detail).toHaveCount(0);
    await progress.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`agent-progress-${surface.width}.png`) });

    await expect(page).toHaveTitle('Video Quickly · 视频创作工作台'); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]);
  } finally { generating.release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
