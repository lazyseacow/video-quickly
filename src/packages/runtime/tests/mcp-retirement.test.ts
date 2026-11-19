import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage } from '@langchain/core/messages';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { modelSchema, projectSchema, runSchema, workflowNodeSchema, type MCPServer } from '@video-quickly/contracts';
import { createRuntime, type RunSnapshot } from '../src/index.js';
import { fingerprint } from '../src/activities.js';
import { DocumentStore, openDatabase } from '../src/database.js';

const directories: string[] = [], servers: Server[] = [], runtimes: ReturnType<typeof createRuntime>[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(retiredCall = false) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-mcp-retirement-')); directories.push(directory);
  const marker = join(directory, 'stdio-started'), command = join(directory, 'retired-server.mjs');
  await writeFile(command, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'started');`);
  let requests = 0, mcpRequests = 0;
  const errors: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/mcp') { mcpRequests++; throw new Error('Retired MCP connection was contacted'); }
      let body = ''; for await (const chunk of request) body += chunk.toString();
      const payload = JSON.parse(body) as { tools: Array<{ function: { name: string } }>; messages: Array<{ role: string; content?: string }> };
      const names = payload.tools.map(tool => tool.function.name);
      expect(names).not.toContain('discover_mcp_tools'); expect(names).not.toContain('call_mcp_tool');
      requests++;
      if (requests === 2) {
        const capabilities = JSON.parse(payload.messages.findLast(message => message.role === 'tool')?.content ?? '{}');
        expect(capabilities.skills).toEqual([]); expect(capabilities).not.toHaveProperty('mcpServers');
      }
      const call = requests === 1 ? { id: 'capabilities', name: retiredCall ? 'call_mcp_tool' : 'list_capabilities',
        input: retiredCall ? { serverId: 'legacy-http', toolName: 'echo', input: {} } : {} } : undefined;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ id: `response-${requests}`, object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0,
        finish_reason: call ? 'tool_calls' : 'stop', message: call
          ? { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }] }
          : { role: 'assistant', content: '已读取项目可用能力。' } }] }));
    } catch (error) { errors.push(error); response.statusCode = 500; response.end('Fixture failed'); }
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture failed to listen');
  const secretStore = { get: vi.fn(async () => 'stored-secret'), set: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
  const runtime = createRuntime({ dataDirectory: directory, seed: false, secretStore }); runtimes.push(runtime);
  const created = projectSchema.parse(await runtime.dispatch('project.create', { title: '历史连接兼容' }));
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '自定义 Agent', provider: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'fixture', connectionType: 'text', capabilities: ['text', 'tools'] } }));
  const connections: MCPServer[] = [
    { id: 'legacy-http', name: '历史网络连接', transport: 'http', url: `http://127.0.0.1:${address.port}/mcp`, enabled: true, args: [], credentialRef: 'legacy-secret', hasSecret: true },
    { id: 'legacy-stdio', name: '历史进程连接', transport: 'stdio', command: process.execPath, args: [command], enabled: true, hasSecret: false },
  ];
  const node = workflowNodeSchema.parse({ id: 'custom-agent', kind: 'agent', label: '自定义 Agent', modelId: model.id,
    config: { mcpServerIds: connections.map(connection => connection.id) } });
  const project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: created.id, revision: created.revision, patch: { workflow: {
    id: 'custom', name: '自定义流程', version: 1, production: { ...created.workflow.production, agentMcpServerIds: connections.map(connection => connection.id) }, nodes: [node], edges: [],
  } } }));
  const database = openDatabase(directory);
  try { const store = new DocumentStore(database); for (const connection of connections) store.put('mcp-server', connection.id, connection); }
  finally { database.close(); }
  async function freeze(pendingMcp = false) {
    const database = openDatabase(directory), id = randomUUID(), createdAt = new Date().toISOString();
    try {
      const store = new DocumentStore(database);
      const saved: RunSnapshot = { project, nodes: [node], models: [model], skills: [], mcpServers: connections, handlerVersion: 1 };
      store.put('run-snapshot', id, saved);
      store.put('run', id, runSchema.parse({ id, projectId: project.id, projectRevision: project.revision, workflowVersion: project.workflow.version,
        status: 'queued', snapshotDigest: fingerprint(saved), stepCount: 1, createdAt, updatedAt: createdAt, events: [], activities: [] }));
      if (pendingMcp) await new SqliteSaver(database).put({ configurable: { thread_id: `${id}:${node.id}:agent`, checkpoint_ns: '' } }, {
        v: 4, id: randomUUID(), ts: createdAt, channel_values: { messages: [new AIMessage({ content: '', tool_calls: [
          { id: 'old-pending-tool', name: 'call_mcp_tool', args: { serverId: 'legacy-http', toolName: 'echo', input: {} } },
        ] })] }, channel_versions: { messages: 1 }, versions_seen: {},
      }, { source: 'loop', step: 1, parents: {} });
      return id;
    } finally { database.close(); }
  }
  async function unchanged() {
    expect(mcpRequests).toBe(0); expect(errors).toEqual([]); await expect(access(marker)).rejects.toThrow();
    expect(secretStore.get).not.toHaveBeenCalled(); expect(secretStore.set).not.toHaveBeenCalled(); expect(secretStore.delete).not.toHaveBeenCalled();
    const database = openDatabase(directory);
    try { expect(new DocumentStore(database).list('mcp-server')).toEqual(connections); }
    finally { database.close(); }
  }
  return { runtime, directory, project, freeze, unchanged, requests: () => requests };
}

it.each(['new', 'frozen historical'] as const)('runs a %s custom Agent without exposing or executing stored MCP connections', async mode => {
  const source = await fixture();
  for (const method of ['tool.list', 'tool.register', 'tool.toggle', 'tool.delete', 'tool.inspect']) {
    await expect(source.runtime.dispatch(method, { serverId: 'legacy-http', enabled: true, server: { name: 'retired', transport: 'http', url: 'http://127.0.0.1:1' } })).rejects.toThrow(`未知操作：${method}`);
  }
  const run = runSchema.parse(mode === 'new' ? await source.runtime.dispatch('run.start', { projectId: source.project.id })
    : await source.runtime.dispatch('run.resume', { runId: await source.freeze() }));
  await source.runtime.waitForIdle();
  const completed = runSchema.parse(await source.runtime.dispatch('run.get', { runId: run.id }));
  expect(completed.status, completed.error).toBe('succeeded'); expect(source.requests()).toBe(2);
  expect(await source.runtime.dispatch('run.replay', { runId: run.id })).toMatchObject({ externalCalls: 0, matchesSnapshot: true });
  await source.unchanged();
  const database = openDatabase(source.directory);
  try {
    const saved = new DocumentStore(database).get<RunSnapshot>('run-snapshot', run.id);
    if (mode === 'new') expect(saved).not.toHaveProperty('mcpServers'); else expect(saved?.mcpServers).toHaveLength(2);
  } finally { database.close(); }
});

it.each(['pending checkpoint', 'new model response'] as const)('reports retired MCP explicitly for a %s without contacting its service', async mode => {
  const source = await fixture(mode === 'new model response');
  const run = runSchema.parse(await source.runtime.dispatch('run.resume', { runId: await source.freeze(mode === 'pending checkpoint') }));
  await source.runtime.waitForIdle();
  const stopped = runSchema.parse(await source.runtime.dispatch('run.get', { runId: run.id }));
  expect(stopped.status).toBe('needs_attention'); expect(stopped.error).toContain('MCP 工具已移除');
  expect(source.requests()).toBe(mode === 'pending checkpoint' ? 0 : 1);
  await source.unchanged();
});
