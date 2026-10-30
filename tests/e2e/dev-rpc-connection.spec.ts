import { request as httpRequest, Agent } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { expect, test } from '@playwright/test';
import { projectDetailSchema, projectSchema, workspaceSummarySchema } from '@video-quickly/contracts';

test('reuses a development RPC connection across bursts and idle periods without repeating a write', async ({ baseURL }) => {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 }), sockets = new Set<Socket>();
  let calls = 0;
  function rpc(method: string, params: unknown = {}) {
    calls++;
    return new Promise<unknown>((resolve, reject) => {
      const body = JSON.stringify({ method, params });
      const request = httpRequest(new URL('/__desktop_rpc', baseURL), { agent, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
        const chunks: Buffer[] = [];
        response.on('error', reject); response.on('data', bytes => chunks.push(bytes));
        response.on('end', () => {
          try {
            expect(response.statusCode).toBe(200); expect(response.headers.connection).toBe('keep-alive');
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            expect(result.error).toBeUndefined(); resolve(result.result);
          } catch (error) { reject(error); }
        });
      });
      request.on('socket', socket => sockets.add(socket)); request.on('error', reject); request.end(body);
    });
  }
  try {
    const project = projectSchema.parse(await rpc('project.create', { title: `开发连接生命周期验收 ${randomUUID()}` }));
    expect(projectDetailSchema.parse(await rpc('project.get', { projectId: project.id })).project).toEqual(project);
    const summary = workspaceSummarySchema.parse(await rpc('workspace.summary'));
    expect(summary.projects.filter(item => item.title === project.title)).toHaveLength(1);
    expect(calls).toBe(3); expect(sockets.size).toBe(1);
    for (let index = 0; index < 64; index++) projectDetailSchema.parse(await rpc('project.get', { projectId: project.id }));
    await new Promise(resolve => setTimeout(resolve, 6500));
    const afterIdle = workspaceSummarySchema.parse(await rpc('workspace.summary'));
    expect(afterIdle.projects.filter(item => item.title === project.title)).toHaveLength(1);
    expect(calls).toBe(68); expect(sockets.size).toBe(1);
  } finally { agent.destroy(); }
});
