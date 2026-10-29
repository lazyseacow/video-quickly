import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, relative } from 'node:path';
import { createDeepAgent, type FileData } from 'deepagents';
import { createMiddleware, tool } from 'langchain';
import { ChatOpenAI } from '@langchain/openai';
import { isAIMessage, isToolMessage, mapStoredMessageToChatMessage, type StoredMessage } from '@langchain/core/messages';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { providerUsageSchema, requestModelParameters, type ModelProfile, type ProjectDocument, type SkillPackage } from '@video-quickly/contracts';
import { ActivityJournal, fingerprint, SimulatedProcessExit, type ActivityHooks } from './activities.js';
import type { createCostLedger } from './costs.js';
import { connectMcp, type McpServer } from './mcp.js';

interface AgentContext {
  database: Database.Database;
  model: ModelProfile;
  secret?: string;
  prompt: string;
  signal: AbortSignal;
  runId: string;
  nodeId: string;
  project: ProjectDocument;
  skills: SkillPackage[];
  mcpServers: Array<McpServer & { secret?: string }>;
  dataDirectory: string;
  failpoint?: ActivityHooks['failpoint'];
  costs?: ReturnType<typeof createCostLedger>;
}

function storedMessage(value: unknown): StoredMessage {
  if (!value || typeof value !== 'object' || !('type' in value) || !('data' in value) || typeof value.type !== 'string' || !value.data || typeof value.data !== 'object') throw new Error('已保存的 Agent 消息格式无效。');
  return value as StoredMessage;
}

export async function executeDeepAgent(context: AgentContext): Promise<string> {
  const { model, secret, project, skills, signal, database, runId, nodeId, dataDirectory } = context;
  const journal = new ActivityJournal(database, { failpoint: context.failpoint });
  const readonlyProject = tool(async () => JSON.stringify(project), { name: 'read_project_snapshot', description: '读取本次执行固定的项目简报、事实主张、分镜和视频规格。', schema: z.object({}) });
  const registeredScripts: Array<{ root: string; id: string; name: string; description: string }> = [];
  const connections: Awaited<ReturnType<typeof connectMcp>>[] = [];
  const externalTools = new Set<string>();
  const timestamp = project.updatedAt;
  const files: Record<string, FileData> = {};
  try {
  for (const skill of skills) {
    files[`/skills/${skill.name}/SKILL.md`] = { content: ['---', `name: ${skill.name}`, `description: ${JSON.stringify(skill.description)}`, '---', skill.instructions], created_at: timestamp, modified_at: timestamp };
    const root = join(dataDirectory, 'skills', skill.id);
    for (const resource of skill.resources) {
      const path = resolve(root, resource);
      if (relative(root, path).startsWith('..') || !['.md', '.txt', '.json', '.yaml', '.yml', '.csv'].includes(extname(resource).toLowerCase())) continue;
      const content = await readFile(path, 'utf8');
      if (Buffer.byteLength(content) <= 500_000) files[`/skills/${skill.name}/${resource}`] = { content: content.split('\n'), created_at: timestamp, modified_at: timestamp };
    }
    for (const definition of skill.tools.filter(item => item.enabled)) {
      const name = `skill_${fingerprint({ skillId: skill.id, toolId: definition.id }).slice(0, 16)}`;
      externalTools.add(name);
      registeredScripts.push({ root, id: definition.id, name, description: `${skill.name}: ${definition.label}。向脚本标准输入传递 JSON 或文本，读取结果。` });
    }
  }
  const registeredMcp: Array<{ name: string; description: string; execute(input: Record<string, unknown>): Promise<string> }> = [];
  for (const server of context.mcpServers) {
    const connection = await connectMcp(server, server.secret); connections.push(connection);
    for (const definition of connection.tools) {
      const name = `mcp_${fingerprint({ server: server.id, tool: definition.name }).slice(0, 16)}`;
      externalTools.add(name);
      registeredMcp.push({ name, description: `${server.name} / ${definition.name}: ${definition.description ?? ''}\ninput 参数格式：${JSON.stringify(definition.inputSchema).slice(0, 8000)}`, async execute(input) {
        const result = await connection.client.callTool({ name: definition.name, arguments: input }, undefined, { timeout: 60_000, signal });
        const encoded = JSON.stringify(result);
        if (Buffer.byteLength(encoded) > 1_000_000) throw new Error('MCP 工具结果超过 1 MB，请缩小请求范围。');
        return encoded;
      } });
    }
  }
  const tools = [readonlyProject,
    ...registeredScripts.map(definition => tool(async ({ input }: { input: string }) => runNodeScript(definition.root, definition.id, input, signal), { name: definition.name, description: definition.description, schema: z.object({ input: z.string().max(100_000) }) })),
    ...registeredMcp.map(definition => tool(async ({ input }) => definition.execute(input), { name: definition.name, description: definition.description, schema: z.object({ input: z.record(z.string(), z.unknown()) }) })),
  ];
  const invocationLedger = createMiddleware({
    name: 'PersistentInvocationReceipts',
    wrapModelCall: async (request, handler) => {
      const messages = request.messages.map(message => message.toDict());
      const input = { modelId: model.id, messages };
      const id = `${nodeId}:model:${fingerprint(input)}`;
      const operationId = `${runId}:${id}`;
      const existing = context.costs?.get(operationId);
      if (journal.get(runId, id)?.status !== 'completed' || existing) context.costs?.begin({ operationId, runId, nodeId, projectId: project.id, model, capability: 'text', requestMetrics: { source: 'request', requestCount: 1 } });
      if (journal.get(runId, id)?.status === 'completed' && existing) context.costs?.status(operationId, 'completed');
      let result: unknown;
      try {
        result = await journal.execute(runId, id, input, 'external', async () => {
          const response = await handler(request);
          const measured = response.usage_metadata;
          const usage = measured ? providerUsageSchema.safeParse({ source: 'provider', inputTokens: measured.input_tokens, outputTokens: measured.output_tokens, totalTokens: measured.total_tokens, cachedInputTokens: measured.input_token_details?.cache_read }) : undefined;
          context.costs?.status(operationId, 'completed', usage?.success ? usage.data : undefined);
          return response.toDict();
        });
      } catch (error) {
        if (!(error instanceof SimulatedProcessExit)) context.costs?.status(operationId, signal.aborted ? 'canceled' : 'unknown');
        throw error;
      }
      const restored = mapStoredMessageToChatMessage(storedMessage(result));
      if (!isAIMessage(restored)) throw new Error('Agent 模型结果类型无效。');
      return restored;
    },
    wrapToolCall: async (request, handler) => {
      if (!externalTools.has(request.toolCall.name)) return handler(request);
      const input = { tool: request.toolCall.name, args: request.toolCall.args };
      const id = `${nodeId}:tool:${request.toolCall.id ?? fingerprint(input)}`;
      const result = await journal.execute(runId, id, input, 'external', async () => {
        const response = await handler(request);
        if (!isToolMessage(response)) throw new Error('脚本工具结果格式无效。');
        return response.toDict();
      });
      const restored = mapStoredMessageToChatMessage(storedMessage(result));
      if (!isToolMessage(restored)) throw new Error('Agent 工具结果类型无效。');
      return restored;
    },
  });
  const checkpointer = new SqliteSaver(database);
  const { temperature, max_tokens: maximumTokens, ...modelKwargs } = requestModelParameters(model, 'text');
  const agent = createDeepAgent({
    model: new ChatOpenAI({ model: model.model, apiKey: secret ?? 'local-service', maxRetries: 0, timeout: 120_000, configuration: { baseURL: model.baseUrl }, temperature: typeof temperature === 'number' ? temperature : 0.7, maxTokens: typeof maximumTokens === 'number' ? maximumTokens : undefined, modelKwargs }),
    tools, middleware: [invocationLedger], checkpointer, skills: skills.length ? ['/skills/'] : [],
    permissions: [{ operations: ['write'], paths: ['/skills/**'], mode: 'deny' }],
    systemPrompt: '你是视频制作助手。读取本次项目快照与已选择 Skill，输出供人工审阅的结果。工作区文件为本次运行的虚拟上下文。事实未核验时保留待核验标记。',
  });
  const config = { configurable: { thread_id: `${runId}:${nodeId}:agent` }, signal, recursionLimit: 40, durability: 'sync' as const };
  const previous = await checkpointer.getTuple(config);
  const result = await agent.invoke(previous ? null : { messages: [{ role: 'user', content: context.prompt }], files }, config);
  const message = result.messages.at(-1);
  if (!message || typeof message.content !== 'string') throw new Error('Agent 没有返回可用文本。');
  return message.content;
  } finally { await Promise.allSettled(connections.map(connection => connection.close())); }
}

async function runNodeScript(root: string, script: string, input: string, signal: AbortSignal): Promise<string> {
  const path = resolve(root, script);
  if (relative(root, path).startsWith('..') || !['.js', '.mjs', '.cjs'].includes(extname(path))) throw new Error('当前工具支持 Skill 目录内的 JavaScript 文件。');
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [path], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP }, signal });
    let output = '';
    let diagnostic = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Skill 工具执行超过 60 秒，已停止。')); }, 60_000);
    child.stdout.on('data', chunk => { output += chunk.toString(); if (Buffer.byteLength(output) > 1_000_000) { child.kill(); reject(new Error('Skill 工具输出超过 1 MB。')); } });
    child.stderr.on('data', chunk => { if (diagnostic.length < 2000) diagnostic += chunk.toString(); });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => { clearTimeout(timeout); if (code === 0) resolvePromise(output); else reject(new Error(`Skill 工具退出状态 ${code ?? '已停止'}。${diagnostic ? '请检查脚本或项目输入。' : ''}`)); });
    child.stdin.on('error', () => { /* A terminated tool may close stdin before accepting input. */ });
    child.stdin.end(input);
  });
}
