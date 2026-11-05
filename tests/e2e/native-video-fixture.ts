import { pickProductionModel } from './production-settings';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, type APIRequestContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { ModelProfile, ProjectDocument, RunSummary } from '@video-quickly/contracts';
import { openProjectFromList } from './workspace-navigation';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const result = await response.json(); expect(response.ok(), JSON.stringify(result.error)).toBe(true); return result.result;
}
async function saved(request: APIRequestContext, projectId: string) { return (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId })).project; }
async function latest(request: APIRequestContext, projectId: string) { return (await rpc<{ items: RunSummary[] }>(request, 'run.list', { projectId })).items[0]; }
async function pick(dialog: Locator, label: string, model: ModelProfile) { await pickProductionModel(dialog, label, model); }
async function open(page: Page, project: ProjectDocument) { await page.goto('/'); await openProjectFromList(page, project.title); await page.locator('.project-heading-actions').getByRole('button', { name: '制作设置', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '制作设置', exact: true }); await expect(dialog).toBeVisible(); return dialog; }

async function fixture(request: APIRequestContext, info: TestInfo, hold = false, shotCount = 1, documents: { brief?: string; style?: string } = {}) {
  const path = info.outputPath('native-source.mp4');
  await promisify(execFile)(process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path]);
  const bytes = await readFile(path), requests: Record<string, unknown>[] = [];
  let release!: () => void, entered!: () => void, held = false, baseUrl = '';
  const gate = new Promise<void>(resolve => { release = resolve; }), pending = new Promise<void>(resolve => { entered = resolve; });
  const server = createServer(async (incoming, response) => {
    if (incoming.url === '/source.mp4') { response.setHeader('content-type', 'video/mp4'); response.end(bytes); return; }
    response.setHeader('content-type', 'application/json');
    if (incoming.method === 'GET') { response.end(JSON.stringify({ status: 'succeeded', content: { video_url: `${baseUrl}/source.mp4` } })); return; }
    let body = ''; for await (const chunk of incoming) body += chunk; const value = JSON.parse(body); requests.push(value);
    if (incoming.url?.includes('contents/generations/tasks')) { response.end(JSON.stringify({ id: `video-${requests.length}` })); return; }
    if (hold && !held) { held = true; entered(); await gate; }
    const prompt = JSON.stringify(value), content = prompt.includes('自动视频制作步骤：旁白与分镜') ? JSON.stringify({ shots: Array.from({ length: shotCount }, (_, index) => ({ title: `生成的蓝色镜头${shotCount > 1 ? ` ${index + 1}` : ''}`, narration: '天空是蓝色的。', visualPrompt: '蓝色天空', soundPrompt: '自然讲述', durationUs: 1_000_000 })) }) : (prompt.includes('自动视频制作步骤：创意简报') ? documents.brief : documents.style) ?? '采用柔和蓝色画面，面向普通观众讲述。';
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture address'); baseUrl = `http://127.0.0.1:${address.port}`;
  const suffix = randomUUID().slice(0, 8), models: ModelProfile[] = [];
  for (const name of ['文本一', '文本二']) models.push(await rpc<ModelProfile>(request, 'model.save', { model: { name: `${name} ${suffix}`, provider: 'openai-compatible', connectionType: 'text', capabilities: ['text'], model: name, baseUrl } }));
  const video = await rpc<ModelProfile>(request, 'model.save', { model: { name: `视频 ${suffix}`, provider: 'seedance', connectionType: 'video', capabilities: ['video'], model: 'custom-video-endpoint', baseUrl } });
  const project = await rpc<ProjectDocument>(request, 'project.create', { title: `统一制作 ${suffix}`, brief: '用一个镜头介绍蓝色天空', profile: { width: 160, height: 90, frameRate: { numerator: 30, denominator: 1 } } });
  return { project, models, video, requests, pending, release, async close() { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}


export { rpc, fixture, saved, latest, open, pick };
