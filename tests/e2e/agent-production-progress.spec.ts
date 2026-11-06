import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import type { ModelProfile, ProjectDocument, RunInspection, RunSummary } from '@video-quickly/contracts';
import { rpc } from './native-video-fixture';
import { openProjectFromList } from './workspace-navigation';

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

for (const surface of [{ width: 1536, height: 960, theme: 'dark', custom: false }, { width: 600, height: 900, theme: 'light', custom: true }]) test(`shows actual Agent tasks and export separately at ${surface.width}px`, async ({ page, request }, info) => {
  test.setTimeout(60000);
  const sourcePath = info.outputPath('agent-source.mp4');
  await promisify(execFile)(process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourcePath]);
  const planning = gate(), planned = gate(), script = gate(), scripting = gate(), errors: string[] = [];
  let controllerCalls = 0;
  const server = createServer({ keepAliveTimeout: 0 }, async (incoming, response) => {
    try {
      let encoded = ''; for await (const chunk of incoming) encoded += chunk.toString();
      const payload = JSON.parse(encoded) as { tools?: unknown[]; messages: Array<{ role: string; content?: string }> };
      let tool: Record<string, unknown> | undefined;
      if (payload.tools?.length) {
        controllerCalls++;
        if (controllerCalls === 1) { planned.release(); await planning.promise; tool = { operation: 'script', requestId: 'script' }; }
        else if (controllerCalls === 2) {
          const result = JSON.parse(payload.messages.findLast(message => message.role === 'tool')?.content ?? '{}') as { project: ProjectDocument };
          tool = { operation: 'import', requestId: 'import', path: sourcePath, shotId: result.project.shots[0].id };
        } else if (controllerCalls === 3) tool = { operation: 'edit', requestId: 'edit' };
        else if (controllerCalls === 4) tool = { operation: 'export', requestId: 'export' };
      } else { scripting.release(); await script.promise; }
      const content = payload.tools?.length ? '视频已通过导出工具完成。' : JSON.stringify({ shots: [{ title: 'Agent 蓝色镜头', narration: '这是蓝色的天空。', visualPrompt: '蓝色天空', durationUs: 2_000_000 }], entities: [] });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ id: `agent-ui-${controllerCalls}`, object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, finish_reason: tool ? 'tool_calls' : 'stop', message: tool ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${controllerCalls}`, type: 'function', function: { name: 'execute_video_task', arguments: JSON.stringify(tool) } }] } : { role: 'assistant', content } }] }));
    } catch (error) { errors.push(String(error)); response.statusCode = 500; response.end('Fixture request failed'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Agent 测试服务未启动');
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['warning', 'error'].includes(message.type())) errors.push(message.text()); });
  try {
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const text = await rpc<ModelProfile>(request, 'model.save', { model: { name: `Agent 进度 ${randomUUID()}`, provider: 'openai-compatible', baseUrl, model: 'fixture', connectionType: 'text', capabilities: ['text', 'tools'] } });
    const video = await rpc<ModelProfile>(request, 'model.save', { model: { name: `未调用的视频模型 ${randomUUID()}`, provider: 'openai-compatible', baseUrl, model: 'fixture', connectionType: 'video', capabilities: ['video'] } });
    const created = await rpc<ProjectDocument>(request, 'project.create', { title: `Agent 制作进度 ${randomUUID()}`, brief: '制作蓝色天空视频', profile: { width: 160, height: 90, frameRate: { numerator: 30, denominator: 1 } } });
    const project = await rpc<ProjectDocument>(request, 'workflow.save', { projectId: created.id, revision: created.revision, workflow: { ...created.workflow, ...(surface.custom ? { id: 'custom-agent-ui', name: '自定义 Agent 制作' } : {}), production: { ...created.workflow.production, executionMode: 'agent', textModelId: text.id, videoModelId: video.id } } });
    await page.setViewportSize(surface); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), surface.theme);
    await page.goto('/'); await openProjectFromList(page, project.title);
    await page.getByRole('button', { name: '开始制作', exact: true }).click(); await planned.promise;
    const latest = async () => (await rpc<{ items: RunSummary[] }>(request, 'run.list', { projectId: project.id })).items[0];
    const run = await latest();
    const progress = page.getByRole('region', { name: '当前制作', exact: true });
    await expect(progress.getByRole('status', { name: 'Agent 制作状态', exact: true })).toContainText('Agent 正在选择下一项任务');
    await expect(progress.getByRole('list', { name: '模型生成进度', exact: true }).getByRole('button')).toHaveCount(0);
    planning.release(); await scripting.promise;
    await expect(progress.getByRole('list', { name: '模型生成进度', exact: true }).locator('.workbench-guide__step-copy > strong')).toHaveText(['分镜生成']);
    await progress.getByRole('button', { name: '打开步骤：分镜生成', exact: true }).click();
    const detail = page.getByRole('dialog', { name: '本次制作', exact: true });
    await expect(detail.getByRole('navigation', { name: '本次制作步骤', exact: true })).toContainText('分镜生成');
    await expect(detail.getByRole('navigation', { name: '本次制作步骤', exact: true }).locator('button[aria-current="step"]')).toContainText('分镜生成');
    await page.keyboard.press('Escape'); await expect(detail).toHaveCount(0); script.release();
    await expect.poll(async () => (await latest()).status, { timeout: 30000 }).toBe('succeeded');
    const inspection = await rpc<RunInspection>(request, 'run.inspect', { runId: run.id });
    expect(inspection.steps.map(step => step.id)).toEqual(['video-agent', 'video-agent/tool/script', 'video-agent/tool/import', 'video-agent/tool/edit', 'video-agent/tool/export']);
    expect(inspection.steps.every(step => step.status === 'succeeded')).toBe(true);
    const exportResult = await rpc<{ videoPath: string }>(request, 'node.result', { runId: run.id, nodeId: 'video-agent/tool/export' });
    const videoBytes = await readFile(exportResult.videoPath); expect(videoBytes.subarray(4, 8).toString()).toBe('ftyp');
    await expect(progress.getByRole('list', { name: '模型生成进度', exact: true }).locator('.workbench-guide__step-copy > strong')).toHaveText(['分镜生成']);
    const exported = progress.getByRole('button', { name: '导出成片 · 已完成', exact: true }); await expect(exported).toBeVisible(); await exported.click();
    await expect(detail.getByRole('navigation', { name: '本次制作步骤', exact: true }).locator('button[aria-current="step"]')).toContainText('导出成片');
    await expect(detail.getByRole('navigation', { name: '本次制作步骤', exact: true }).getByRole('button')).toHaveCount(5);
    await expect(detail).not.toContainText('未纳入本次制作');
    await page.keyboard.press('Escape'); await expect(detail).toHaveCount(0);
    await progress.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`agent-progress-${surface.width}.png`) });
    await expect(page).toHaveTitle('Video Quickly · 视频创作工作台'); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]);
  } finally { planning.release(); script.release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
