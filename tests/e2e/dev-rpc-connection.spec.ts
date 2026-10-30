import { request as httpRequest, Agent } from 'node:http';
import type { Socket } from 'node:net';
import { expect, test } from '@playwright/test';
import { projectDetailSchema, projectSchema, workspaceSummarySchema } from '@video-quickly/contracts';

test('completes each development RPC on its own connection even when the caller pools sockets', async ({ baseURL }) => {
  const agent = new Agent({ keepAlive: true }), sockets = new Set<Socket>();
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
            expect(response.statusCode).toBe(200); expect(response.headers.connection).toBe('close');
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            expect(result.error).toBeUndefined(); resolve(result.result);
          } catch (error) { reject(error); }
        });
      });
      request.on('socket', socket => sockets.add(socket)); request.on('error', reject); request.end(body);
    });
  }
  try {
    const project = projectSchema.parse(await rpc('project.create', { title: '开发连接生命周期验收' }));
    expect(projectDetailSchema.parse(await rpc('project.get', { projectId: project.id })).project).toEqual(project);
    const summary = workspaceSummarySchema.parse(await rpc('workspace.summary'));
    expect(summary.projects.filter(item => item.id === project.id)).toHaveLength(1);
    expect(calls).toBe(3); expect(sockets.size).toBe(3);
  } finally { agent.destroy(); }
});
