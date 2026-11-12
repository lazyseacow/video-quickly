import { planningFixtureResponse, storyboardFixtureResponse } from '../../../../tests/fixtures/planning-response';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { assetSchema, createNativeVideoWorkflow, modelSchema, projectSchema, runInspectionSchema, runSchema, shotSchema, workflowNodeSchema, type FrameRate, type JsonValue, type ProjectDocument, type SkillPackage, type WorkspaceSnapshot } from '@video-quickly/contracts';
import { createRuntime, SimulatedProcessExit, type ActivityExecutionContext, type RunSnapshot, type RuntimeOptions } from '../src/index.js';
import { fingerprint } from '../src/activities.js';
import { DocumentStore, openDatabase } from '../src/database.js';
import { createLogger } from '../src/logging.js';
import { createSkillLibrary } from '../src/skill-library.js';
import { applyAgentTransitions, legacyVideoAgentNode } from '../src/video-agent.js';
import { importSkillFixture } from '../../../../tests/fixtures/import-skill';

type Runtime = ReturnType<typeof createRuntime>;
type Payload = { tools: Array<{ function: { name: string } }>; messages: Array<{ role: string; content?: string | null }> };
type Call = { name: string; input: Record<string, unknown> };
type Action = (payload: Payload) => Call | Call[] | undefined;
const directories: string[] = [], runtimes = new Set<Runtime>(), servers: Server[] = [];
afterEach(async () => {
  await Promise.all([...runtimes].map(runtime => runtime.close())); runtimes.clear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
const toolResult = (payload: Payload): unknown => JSON.parse(payload.messages.findLast(message => message.role === 'tool')?.content ?? '{}');
const business = (operation: string, requestId: string, input: Record<string, unknown> = {}): Call => ({ name: 'execute_video_task', input: { operation, requestId, ...input } });
async function current(runtime: Runtime, projectId: string) { return projectSchema.parse((await runtime.dispatch('project.get', { projectId }) as { project: ProjectDocument }).project); }

function transitionProject(frameRate: FrameRate, durations = [1_300_000, 700_000, 1_000_000]) {
  return projectSchema.parse({ id: 'transition-test', title: '转场验证', revision: 1, brief: '', style: '', createdAt: '', updatedAt: '',
    profile: { width: 160, height: 90, frameRate }, workflow: createNativeVideoWorkflow(),
    shots: durations.map((durationUs, index) => ({ id: `shot-${index + 1}`, title: `镜头 ${index + 1}`, durationUs, narration: '', visualPrompt: '', animation: { transition: 'cut' } })),
  });
}

it('reports the actual wipe and cut spans on the fractional export frame grid', () => {
  const project = transitionProject({ numerator: 30_000, denominator: 1_001 });
  const { editedProject, appliedTransitions } = applyAgentTransitions(project, [
    { fromShotId: 'shot-1', toShotId: 'shot-2', type: 'wipe' }, { fromShotId: 'shot-2', toShotId: 'shot-3', type: 'cut' },
  ]);
  expect(editedProject.shots.map(shot => shot.animation.transition)).toEqual(['cut', 'wipe', 'cut']);
  expect(appliedTransitions).toEqual([
    { fromShotId: 'shot-1', toShotId: 'shot-2', type: 'wipe', startFrame: 39, endFrameExclusive: 45, startUs: 1_301_300, durationUs: 200_200 },
    { fromShotId: 'shot-2', toShotId: 'shot-3', type: 'cut', startFrame: 60, endFrameExclusive: 60, startUs: 2_002_000, durationUs: 0 },
  ]);
});

it('validates adjacency on rendered pictures and reports a hard cut when padding rounds to zero', () => {
  const project = transitionProject({ numerator: 1, denominator: 1 }, [500_000, 500_000, 1_000_000]);
  const fade = { fromShotId: 'shot-1', toShotId: 'shot-2', type: 'fade' } as const;
  expect(() => applyAgentTransitions(project, [fade])).toThrow('都有输出帧的相邻镜头');
  const { appliedTransitions } = applyAgentTransitions(project, [{ ...fade, toShotId: 'shot-3' }]);
  expect(appliedTransitions).toEqual([{ fromShotId: 'shot-1', toShotId: 'shot-3', type: 'cut', startFrame: 1, endFrameExclusive: 1, startUs: 1_000_000, durationUs: 0 }]);
});

it('rejects reversed, nonadjacent, missing, duplicate and locked transition targets', () => {
  const project = transitionProject({ numerator: 30, denominator: 1 });
  const fade = { fromShotId: 'shot-1', toShotId: 'shot-2', type: 'fade' } as const;
  for (const invalid of [
    { ...fade, fromShotId: 'shot-2', toShotId: 'shot-1' }, { ...fade, toShotId: 'shot-3' }, { ...fade, toShotId: 'missing' },
  ]) {
    expect(() => applyAgentTransitions(project, [fade, invalid])).toThrow('相邻镜头');
  }
  expect(() => applyAgentTransitions(project, [fade, { ...fade, type: 'cut' }])).toThrow('只能指定一次');
  expect(project.shots.map(shot => shot.animation.transition)).toEqual(['cut', 'cut', 'cut']);
  project.shots[1].locked = true;
  expect(() => applyAgentTransitions(project, [fade])).toThrow('已锁定');
});

async function fixture(extra: Partial<RuntimeOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'video-quickly-video-agent-')); directories.push(directory);
  const actions: Action[] = [], requests: Payload[] = [], errors: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      let body = ''; for await (const chunk of request) body += chunk.toString();
      const payload = JSON.parse(body) as Payload, index = requests.length; requests.push(payload);
      const selected = actions[index]?.(payload), calls = selected ? Array.isArray(selected) ? selected : [selected] : [];
      for (const call of calls) expect(payload.tools.map(tool => tool.function.name)).toContain(call.name);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ id: `video-agent-response-${index}`, object: 'chat.completion', created: 1, model: 'fixture',
        choices: [{ index: 0, finish_reason: calls.length ? 'tool_calls' : 'stop', message: calls.length
          ? { role: 'assistant', content: null, tool_calls: calls.map((call, position) => ({ id: `call-${index}-${position}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } })) }
          : { role: 'assistant', content: '已完成视频制作，产物已保存。' } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
    } catch (error) { errors.push(error); response.statusCode = 500; response.end('Invalid fixture request'); }
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试服务未启动。');
  const provider = vi.fn<NonNullable<RuntimeOptions['provider']>>(async ({ prompt }) => {
    if (prompt.includes('自动视频制作步骤：创意简报')) return '六秒的水滴旅程，包含开端、变化和结尾。';
    if (prompt.includes('自动视频制作步骤：风格与角色')) { expect(prompt).toContain('水滴旅程'); return '蓝绿色水彩，柔和光线与连续场景。'; }
    expect(prompt).toContain('蓝绿色水彩');
    return JSON.stringify({ shots: [{ title: '水滴旅程', narration: '水汽遇冷形成雨滴。', visualPrompt: '水彩雨滴从云落入湖面', durationUs: 6_000_000 }], entities: [] });
  });
  let imageCount = 0, currentImageId = 'generated-image';
  const media = vi.fn(async (context: ActivityExecutionContext): Promise<JsonValue> => {
    const shot = context.project.shots[0];
    expect(context.project.brief).toContain('水滴旅程'); expect(context.project.style).toContain('蓝绿色水彩');
    expect(shot.title).toBe('水滴旅程');
    if (context.node.config.operation === 'prepare-edit') {
      expect(shot.videoAssetId).toBe('generated-video'); return { source: 'local', shots: context.project.shots.length };
    }
    if (context.node.kind === 'export') {
      expect(context.assets.some(asset => asset.id === shot.videoAssetId)).toBe(true);
      const videoPath = join(directory, 'finished.mp4'); await writeFile(videoPath, 'controlled export boundary');
      return { completed: true, videoPath, shotIds: context.project.shots.map(shot => shot.id) };
    }
    const kind = context.node.kind === 'assets' ? 'image' : 'video';
    if (kind === 'video') { expect(shot.assetId).toBe(currentImageId); expect(context.assets.some(asset => asset.id === shot.assetId)).toBe(true); }
    if (kind === 'image') { imageCount++; currentImageId = imageCount === 1 ? 'generated-image' : `generated-image-${imageCount}`; }
    const id = kind === 'image' ? currentImageId : 'generated-video';
    const bytes = Buffer.from(`controlled ${id} boundary`), path = join(directory, `${id}.fixture`); await writeFile(path, bytes);
    const asset = assetSchema.parse({ id, projectId: context.project.id, shotId: shot.id, name: kind, kind, path,
      mimeType: `${kind}/fixture`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), durationUs: 6_000_000,
      version: 1, createdAt: '', provenance: 'controlled media adapter', retained: false, active: true });
    return { assets: [asset] };
  });
  const options: RuntimeOptions = { dataDirectory: directory, seed: false, provider, executeActivity: media, ...extra };
  const runtime = createRuntime(options); runtimes.add(runtime);
  const created = projectSchema.parse(await runtime.dispatch('project.create', { title: '自主制作水滴旅程', brief: '介绍雨水循环，交付六秒视频' }));
  const text = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '制作 Agent', provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'fixture', connectionType: 'text', capabilities: ['text', 'tools'] } }));
  const image = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '图片边界', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture', connectionType: 'image', capabilities: ['image'] } }));
  const video = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '视频边界', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture', connectionType: 'video', capabilities: ['video'] } }));
  const workflow = createNativeVideoWorkflow();
  const project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: created.id, revision: created.revision, patch: { workflow: {
    ...workflow, production: { ...workflow.production, textModelId: text.id, imageModelId: image.id, videoModelId: video.id, referenceMode: 'generate' },
  } } }));
  // Standalone Agent runs are now only reachable through existing snapshots.
  async function resumeLegacyAgent() {
    const savedProject = await current(runtime, project.id);
    const { models } = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    const database = openDatabase(directory), id = randomUUID(), createdAt = new Date().toISOString();
    try {
      const store = new DocumentStore(database);
      const library = createSkillLibrary({ store, directory, changed() {}, logger: createLogger({ dataDirectory: directory, component: 'runtime' }) });
      const node = legacyVideoAgentNode(savedProject);
      const skillNodes = node.skillIds.length ? [node] : [node, ...savedProject.workflow.nodes];
      const legacyProduction = { ...savedProject.workflow.production, executionMode: 'agent' };
      const saved: RunSnapshot = { project: { ...savedProject, workflow: { ...savedProject.workflow, production: legacyProduction } },
        nodes: [node], models, mcpServers: store.list('mcp-server'), handlerVersion: 1, characters: [], characterAssets: [],
        ...await library.prepareForNodes(skillNodes) };
      store.put('run-snapshot', id, saved);
      store.put('run', id, runSchema.parse({ id, projectId: savedProject.id, projectRevision: savedProject.revision, workflowVersion: savedProject.workflow.version,
        snapshotDigest: fingerprint(saved), status: 'queued', stepCount: 1, createdAt, updatedAt: createdAt, events: [], activities: [] }));
    } finally { database.close(); }
    return runSchema.parse(await runtime.dispatch('run.resume', { runId: id }));
  }
  return { directory, runtime, options, project, actions, requests, errors, provider, media, resumeLegacyAgent };
}

function productionActions(actions: Action[], afterScript: Action[] = [], skillIds: string[] = []) {
  let shotId = '';
  actions.push(() => business('brief', 'brief-1', { skillIds }), () => business('style', 'style-1', { skillIds }), () => business('script', 'script-1', { skillIds }),
    () => ({ name: 'read_project_snapshot', input: {} }), payload => {
      const project = projectSchema.parse(toolResult(payload)); shotId = project.shots[0].id;
      expect(project.brief).toContain('水滴旅程'); expect(project.style).toContain('蓝绿色水彩');
      return afterScript.length ? afterScript[0](payload) : business('image', 'image-1', { shotId, skillIds });
    });
  actions.push(...afterScript.slice(1),
    () => business('image', 'image-1', { shotId, skillIds }),
    () => business('video', 'video-1', { shotId, skillIds }),
    () => business('edit', 'edit-1', { edits: [{ shotId, inUs: 0, outUs: 4_000_000, transition: 'fade' }] }), () => business('export', 'export-1'));
  return () => shotId;
}

it.each([false, true])('leaves production tools out of a selected workflow Agent (reserved id: %s)', async reserved => {
  const { runtime, project, directory, actions, requests, errors, media } = await fixture();
  const node = workflowNodeSchema.parse({ id: reserved ? 'video-agent' : 'ordinary-agent', kind: 'agent', label: '文字助手',
    modelId: project.workflow.production.textModelId, config: reserved ? { videoAgent: true } : {} });
  await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { workflow: {
    ...project.workflow, nodes: [node], edges: [], stages: undefined,
  } } });
  actions.push(payload => { expect(payload.tools.map(tool => tool.function.name)).not.toContain('execute_video_task'); return undefined; });
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id, nodeId: node.id,
    ...(reserved ? { destination: join(directory, 'unused.mp4') } : {}) })); await runtime.waitForIdle();
  expect(requests).toHaveLength(1); expect(errors).toEqual([]); expect(media).not.toHaveBeenCalled();
  expect((await runtime.dispatch('run.get', { runId: run.id }))).toMatchObject({ status: 'succeeded' });
});

it('discovers the latest enabled version of a Skill while honoring an explicit older binding', async () => {
  const { runtime, directory, project, actions, errors, requests, provider, resumeLegacyAgent } = await fixture();
  const folder = join(directory, 'versioned-skill'); await mkdir(folder);
  const ids: string[] = [];
  for (const version of ['first', 'second']) {
    await writeFile(join(folder, 'SKILL.md'), '---\nname: versioned\ndescription: 版本测试\n---\nVersion ' + version);
    ids.push((await importSkillFixture(runtime.dispatch, { path: folder })).skills[0].id);
  }
  for (const selected of [[], [ids[0]]]) {
    const currentProject = await current(runtime, project.id), expected = selected[0] ?? ids[1];
    await runtime.dispatch('project.update', { projectId: project.id, revision: currentProject.revision, patch: { workflow: {
      ...currentProject.workflow, production: { ...currentProject.workflow.production, agentSkillIds: selected },
      nodes: currentProject.workflow.nodes.map(node => node.kind === 'brief' ? { ...node, skillIds: [ids[0]] } : node),
    } } });
    actions.length = requests.length;
    actions.push(() => ({ name: 'list_capabilities', input: {} }), payload => {
      expect(toolResult(payload)).toMatchObject({ skills: [expect.objectContaining({ id: expected, name: 'versioned' })] });
      return business('brief', 'inherited-skill');
    });
    await resumeLegacyAgent(); await runtime.waitForIdle();
    expect(errors).toEqual([]);
    expect(provider.mock.calls.at(-1)?.[0].prompt).toContain('Version first');
  }
});

it('rejects local paths outside the run output directory and never requests a loopback artifact URL', async () => {
  const { runtime, directory, project, actions, errors, resumeLegacyAgent } = await fixture();
  const localPath = join(directory, 'private.png');
  await writeFile(localPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=', 'base64'));
  let gets = 0;
  const server = createServer((_request, response) => { gets++; response.writeHead(200, { 'content-type': 'text/plain' }); response.end('private fixture'); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试服务未启动。');
  const shot = shotSchema.parse({ id: 'test-shot', title: '镜头', visualPrompt: '场景', narration: '', durationUs: 1_000_000 });
  await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { shots: [shot] } });
  actions.push(
    () => business('import', 'outside-path', { shotId: shot.id, path: localPath }),
    payload => {
      expect(toolResult(payload)).toMatchObject({ recoverable: true });
      return business('import', 'local-url', { shotId: shot.id, url: `http://127.0.0.1:${address.port}/private`, mimeType: 'image/png' });
    },
    payload => { expect(toolResult(payload)).toMatchObject({ recoverable: true }); return undefined; },
  );
  await resumeLegacyAgent(); await runtime.waitForIdle();
  expect(gets).toBe(0); expect(errors).toEqual([]);
  const snapshot = await runtime.dispatch('workspace.snapshot') as { assets: unknown[] };
  expect(snapshot.assets).toEqual([]);
});

it('preserves historical output and holds an incomplete run containing an unverified legacy import', async () => {
  let interrupted = false;
  const { runtime, project, directory, options, actions, requests, errors, media, resumeLegacyAgent } = await fixture({
    failpoint(point, id) {
      if (point === 'after-commit' && id === 'video-agent/tool/import') {
        interrupted = true; throw new SimulatedProcessExit();
      }
    },
  });
  const shot = shotSchema.parse({ id: 'test-shot', title: '镜头', visualPrompt: '场景', narration: '', durationUs: 1_000_000 });
  await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { shots: [shot] } });
  actions.push(() => business('import', 'import', { shotId: shot.id, mimeType: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=' }));
  const run = await resumeLegacyAgent(); await runtime.waitForIdle();
  expect(interrupted).toBe(true);
  await runtime.close(); runtimes.delete(runtime);
  const database = openDatabase(directory);
  try {
    const store = new DocumentStore(database), key = run.id + ':video-agent/tool/import';
    const output = store.get<{ assets: Array<Record<string, unknown>> }>('node-result', key)!;
    store.put('node-result', key, { assets: output.assets.map(asset => ({ ...asset, provenance: '用户导入' })) });
  } finally { database.close(); }
  const reopened = createRuntime({ ...options, failpoint: undefined }); runtimes.add(reopened);
  const before = requests.length;
  await reopened.dispatch('run.resume', { runId: run.id }); await reopened.waitForIdle();
  expect(await reopened.dispatch('run.get', { runId: run.id })).toMatchObject({ status: 'needs_attention', error: expect.stringContaining('旧版工具导入') });
  expect(await reopened.dispatch('node.result', { runId: run.id, nodeId: 'video-agent/tool/import' })).toMatchObject({ assets: [expect.objectContaining({ provenance: '用户导入' })] });
  expect(requests).toHaveLength(before); expect(media).not.toHaveBeenCalled(); expect(errors).toEqual([]);
});

it('discovers task-bound Skill and MCP capabilities, imports their output and completes video production with bound assets', async () => {
  const { directory, runtime, project: initial, actions, errors, requests, provider, media, resumeLegacyAgent } = await fixture();
  const skillDirectory = join(directory, 'method'); await mkdir(join(skillDirectory, 'references'), { recursive: true }); await mkdir(join(skillDirectory, 'scripts'));
  await writeFile(join(skillDirectory, 'SKILL.md'), '---\nname: water-story\ndescription: 水循环的叙事方法\n---\n采用 references/story.md 中的起承转合。');
  await writeFile(join(skillDirectory, 'references/story.md'), '每个场景体现水滴状态的变化。');
  await writeFile(join(skillDirectory, 'scripts/marker.mjs'), 'process.stdout.write(JSON.stringify({method:"water-story-script"}));');
  await writeFile(join(skillDirectory, 'scripts/disabled.mjs'), 'throw new Error("disabled tool must never run");');
  const skill = (await importSkillFixture(runtime.dispatch, { path: skillDirectory })).skills[0];
  await runtime.dispatch('skill.tool.toggle', { skillId: skill.id, toolId: 'scripts/marker.mjs', enabled: true });
  const secondDirectory = join(directory, 'second-method'); await mkdir(secondDirectory);
  await writeFile(join(secondDirectory, 'SKILL.md'), '---\nname: water-color\ndescription: 水彩视觉方法\n---\n保持水彩的连续色彩。');
  const secondSkill = (await importSkillFixture(runtime.dispatch, { path: secondDirectory })).skills[0];
  const unboundDirectory = join(directory, 'unbound-method'); await mkdir(unboundDirectory);
  await writeFile(join(unboundDirectory, 'SKILL.md'), '---\nname: unbound-method\ndescription: 未选择的方法\n---\n当前任务没有选择。');
  const unboundSkill = (await importSkillFixture(runtime.dispatch, { path: unboundDirectory })).skills[0];
  const disabledDirectory = join(directory, 'disabled-method'); await mkdir(disabledDirectory);
  await writeFile(join(disabledDirectory, 'SKILL.md'), '---\nname: disabled-method\ndescription: 停用方法\n---\n当前任务不允许使用。');
  const disabledSkill = (await importSkillFixture(runtime.dispatch, { path: disabledDirectory })).skills[0];
  await runtime.dispatch('skill.toggle', { skillId: disabledSkill.id, enabled: false });
  const mcpPath = join(directory, 'mcp-image.mjs'), externalImage = 'external.png';
  await writeFile(mcpPath, `import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const send = result => process.stdout.write(JSON.stringify(result) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line); if (message.id === undefined) return;
  let result;
  if (message.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'image-fixture', version: '1' } };
  else if (message.method === 'tools/list') result = { tools: [{ name: 'make_image', description: 'Generate an external reference image', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
  else if (message.method === 'tools/call') {
    const path = join(process.env.VIDEO_QUICKLY_TOOL_OUTPUT_DIR, process.argv[2]);
    writeFileSync(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=', 'base64'));
    result = { content: [{ type: 'text', text: JSON.stringify({ path }) }] };
  } else result = {};
  send({ jsonrpc: '2.0', id: message.id, result });
});`);
  const mcp = await runtime.dispatch('tool.register', { server: { name: '外部参考图', transport: 'stdio', command: process.execPath, args: [mcpPath, externalImage], enabled: true } }) as { id: string };
  const secondMcp = await runtime.dispatch('tool.register', { server: { name: '辅助参考图', transport: 'stdio', command: process.execPath, args: [mcpPath, externalImage], enabled: true } }) as { id: string };
  const disabled = await runtime.dispatch('tool.register', { server: { name: '停用能力', transport: 'stdio', command: process.execPath, args: ['not-a-real-server'], enabled: false } }) as { id: string };
  const unboundMcp = await runtime.dispatch('tool.register', { server: { name: '没有为任务选择的离线服务', transport: 'stdio', command: process.execPath, args: ['not-a-real-server'], enabled: true } }) as { id: string };
  const project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: initial.id, revision: initial.revision, patch: { workflow: {
    ...initial.workflow, production: { ...initial.workflow.production, agentSkillIds: [skill.id, secondSkill.id], agentMcpServerIds: [mcp.id, secondMcp.id] },
  } } }));
  let scriptTool = '';
  actions.push(() => ({ name: 'list_capabilities', input: {} }), payload => {
    const result = toolResult(payload) as { skills: Array<{ id: string; tools: Array<{ id: string; name: string }> }>; mcpServers: Array<{ id: string }> };
    expect(result.skills.map(item => item.id).sort()).toEqual([skill.id, secondSkill.id].sort());
    expect(result.mcpServers.map(item => item.id).sort()).toEqual([mcp.id, secondMcp.id].sort());
    expect(result.skills.map(item => item.id)).not.toContain(unboundSkill.id);
    expect(result.skills.map(item => item.id)).not.toContain(disabledSkill.id);
    expect(result.mcpServers.map(item => item.id)).not.toContain(disabled.id);
    expect(result.mcpServers.map(item => item.id)).not.toContain(unboundMcp.id);
    const scripts = result.skills.find(item => item.id === skill.id)!.tools;
    expect(scripts.map(item => item.id)).toEqual(['scripts/marker.mjs']); scriptTool = scripts[0].name;
    return { name: 'read_skill', input: { skillId: unboundSkill.id } };
  }, payload => {
    expect(payload.messages.findLast(message => message.role === 'tool')?.content).toContain('允许');
    return { name: 'discover_mcp_tools', input: { serverId: unboundMcp.id } };
  }, payload => {
    expect(payload.messages.findLast(message => message.role === 'tool')?.content).toContain('允许');
    return { name: 'call_mcp_tool', input: { serverId: unboundMcp.id, toolName: 'make_image', input: {} } };
  }, payload => {
    expect(payload.messages.findLast(message => message.role === 'tool')?.content).toContain('允许');
    return business('brief', 'unbound-skill', { skillIds: [unboundSkill.id] });
  }, payload => {
    expect(payload.messages.findLast(message => message.role === 'tool')?.content).toContain('Skill');
    return { name: 'read_skill', input: { skillId: skill.id } };
  }, payload => {
    expect(JSON.stringify(toolResult(payload))).toContain('起承转合');
    return { name: scriptTool, input: { input: '{}' } };
  }, payload => {
    expect(JSON.stringify(toolResult(payload))).toContain('water-story-script');
    return { name: 'discover_mcp_tools', input: { serverId: mcp.id } };
  }, payload => {
    expect(JSON.stringify(toolResult(payload))).toContain('make_image');
    return { name: 'discover_mcp_tools', input: { serverId: secondMcp.id } };
  }, payload => {
    expect(JSON.stringify(toolResult(payload))).toContain('make_image');
    return { name: 'call_mcp_tool', input: { serverId: mcp.id, toolName: 'make_image', input: {} } };
  }, payload => {
    expect(JSON.stringify(toolResult(payload))).toContain('external.png');
    return { name: 'call_mcp_tool', input: { serverId: secondMcp.id, toolName: 'make_image', input: {} } };
  });
  const getShotId = productionActions(actions, [() => business('import', 'import-1', { path: externalImage, shotId: getShotId() })], [skill.id, secondSkill.id]);
  const run = await resumeLegacyAgent(); await runtime.waitForIdle();
  const finished = runSchema.parse(await runtime.dispatch('run.get', { runId: run.id }));
  expect(errors).toEqual([]); expect(requests.length).toBeGreaterThan(0); expect(finished.status, finished.error).toBe('succeeded');
  const saved = await current(runtime, project.id);
  expect(saved.revision).toBe(project.revision + 1);
  expect(saved.shots[0]).toMatchObject({ id: getShotId(), assetId: 'generated-image', videoAssetId: 'generated-video', durationUs: 4_000_000, animation: { transition: 'fade' } });
  expect(provider).toHaveBeenCalledTimes(3); expect(provider.mock.calls.every(([input]) => input.prompt.includes('起承转合') && input.prompt.includes('连续色彩'))).toBe(true);
  expect(media.mock.calls.map(([context]) => context.node.kind)).toEqual(['assets', 'animation', 'export']);
  expect(await readFile(join(directory, 'finished.mp4'), 'utf8')).toBe('controlled export boundary');
  const snapshot = await runtime.dispatch('workspace.snapshot') as { assets: Array<{ name: string; shotId?: string }> };
  expect(snapshot.assets).toContainEqual(expect.objectContaining({ name: 'external.png', shotId: getShotId() }));
  const inspection = runInspectionSchema.parse(await runtime.dispatch('run.inspect', { runId: run.id }));
  const steps = inspection.steps.filter(step => step.id.startsWith('video-agent/tool/'));
  expect(steps).toHaveLength(8); expect(steps.every(step => step.status === 'succeeded' && step.inputAvailable && step.outputAvailable)).toBe(true);
});

it('reuses a logical image request while continuing from the latest project after every business tool', async () => {
  const { runtime, project, actions, errors, requests, media, resumeLegacyAgent } = await fixture();
  actions.push(() => ({ name: 'list_capabilities', input: {} }), payload => {
    expect(toolResult(payload)).toMatchObject({ skills: [], mcpServers: [] }); return { name: 'read_project_snapshot', input: {} };
  });
  productionActions(actions);
  const run = await resumeLegacyAgent(); await runtime.waitForIdle();
  const completed = runSchema.parse(await runtime.dispatch('run.get', { runId: run.id }));
  expect(errors).toEqual([]); expect(requests.length).toBeGreaterThan(0); expect(completed.status, completed.error).toBe('succeeded');
  expect(media.mock.calls.filter(([context]) => context.node.kind === 'assets')).toHaveLength(1);
  expect((await current(runtime, project.id)).shots[0]).toMatchObject({ assetId: 'generated-image', videoAssetId: 'generated-video' });
  const count = media.mock.calls.length;
  expect(await runtime.dispatch('run.replay', { runId: run.id })).toMatchObject({ externalCalls: 0, matchesSnapshot: true });
  expect(media).toHaveBeenCalledTimes(count);
});

it.each(['none', 'skills', 'mcp'] as const)('automatically discovers the unbound capability class when %s is explicitly selected', async boundClass => {
  const { directory, runtime, project: initial, actions, errors, resumeLegacyAgent } = await fixture();
  const skills: SkillPackage[] = [];
  for (const name of ['first-method', 'second-method']) {
    const path = join(directory, name); await mkdir(path);
    await writeFile(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: 测试制作方法\n---\n保持水彩叙事连续。`);
    skills.push((await importSkillFixture(runtime.dispatch, { path })).skills[0]);
  }
  const connections: Array<{ id: string }> = [];
  for (const name of ['first-service', 'second-service']) connections.push(await runtime.dispatch('tool.register', {
    server: { name, transport: 'stdio', command: process.execPath, args: ['unused-during-capability-list'], enabled: true },
  }) as { id: string });
  await runtime.dispatch('project.update', { projectId: initial.id, revision: initial.revision, patch: { workflow: {
    ...initial.workflow, production: { ...initial.workflow.production,
      agentSkillIds: boundClass === 'skills' ? [skills[0].id] : [],
      agentMcpServerIds: boundClass === 'mcp' ? [connections[0].id] : [],
    },
  } } });
  actions.push(() => ({ name: 'list_capabilities', input: {} }), payload => {
    const result = toolResult(payload) as { skills: Array<{ id: string }>; mcpServers: Array<{ id: string }> };
    expect(result.skills.map(item => item.id).sort()).toEqual((boundClass === 'skills' ? [skills[0].id] : skills.map(skill => skill.id)).sort());
    expect(result.mcpServers.map(item => item.id).sort()).toEqual((boundClass === 'mcp' ? [connections[0].id] : connections.map(server => server.id)).sort());
    return { name: 'read_project_snapshot', input: {} };
  });
  productionActions(actions, [], [skills[0].id]);
  const run = await resumeLegacyAgent(); await runtime.waitForIdle();
  const completed = runSchema.parse(await runtime.dispatch('run.get', { runId: run.id }));
  expect(errors).toEqual([]); expect(completed.status, completed.error).toBe('succeeded');
});

it('regenerates a selected shot with a new request and forwards its replacement asset to video generation', async () => {
  const { runtime, project, actions, errors, media, resumeLegacyAgent } = await fixture();
  const getShotId = productionActions(actions);
  actions.splice(6, 0, () => business('image', 'image-revised', { shotId: getShotId(), instruction: '让雨滴从云层俯冲落下，强化动作。' }));
  const run = await resumeLegacyAgent(); await runtime.waitForIdle();
  const completed = runSchema.parse(await runtime.dispatch('run.get', { runId: run.id }));
  expect(errors).toEqual([]); expect(completed.status, completed.error).toBe('succeeded');
  const imageCalls = media.mock.calls.filter(([context]) => context.node.kind === 'assets');
  expect(imageCalls).toHaveLength(2); expect(imageCalls[1][0].node.prompt).toContain('强化动作');
  expect((await current(runtime, project.id)).shots[0]).toMatchObject({ assetId: 'generated-image-2', videoAssetId: 'generated-video' });
});

it.each(['run.resume', 'run.step.retry'])('opens a new durable continuation round through %s after exhausting the automatic attempts', async method => {
  let armed = false, crashed = false;
  const { runtime, options, project, actions, errors, requests, media, provider, resumeLegacyAgent } = await fixture({
    failpoint(point, id) {
      if (armed && point === 'after-commit' && id.startsWith('video-agent:model:')) {
        armed = false; crashed = true; throw new SimulatedProcessExit();
      }
    },
  });
  actions.push(() => business('brief', 'brief-1', { skillIds: [] }));
  const run = await resumeLegacyAgent(); await runtime.waitForIdle();
  const completed = runSchema.parse(await runtime.dispatch('run.get', { runId: run.id }));
  expect(requests).toHaveLength(5); expect(media).not.toHaveBeenCalled();
  expect(completed.status).toBe('needs_attention'); expect(completed.error).toContain('三次');
  expect(await current(runtime, project.id)).toEqual(project);
  const before = requests.length;
  actions.length = before;
  productionActions(actions);
  await runtime.close(); runtimes.delete(runtime);
  let reopened = createRuntime(options); runtimes.add(reopened);
  armed = method === 'run.resume';
  await reopened.dispatch(method, { runId: run.id, ...(method === 'run.step.retry' ? { nodeId: 'video-agent' } : {}) });
  await reopened.waitForIdle();
  if (method === 'run.resume') {
    expect(crashed).toBe(true); expect(requests).toHaveLength(before + 1);
    await reopened.close(); runtimes.delete(reopened);
    reopened = createRuntime(options); runtimes.add(reopened);
    await reopened.dispatch('run.resume', { runId: run.id }); await reopened.waitForIdle();
    expect(requests.filter(payload => payload.messages.at(-1)?.content?.includes('续作轮次 2'))).toHaveLength(1);
  }
  expect(errors).toEqual([]);
  const recovered = runSchema.parse(await reopened.dispatch('run.get', { runId: run.id }));
  expect(recovered.status, recovered.error).toBe('succeeded');
  expect(requests[before]?.messages.some(message => message.role === 'user' && message.content?.includes('续作轮次 2'))).toBe(true);
  expect(provider).toHaveBeenCalledTimes(3);
  expect(media.mock.calls.filter(([context]) => context.node.kind === 'export')).toHaveLength(1);
});

it('continues a premature final reply with real tools until the requested video is exported', async () => {
  const { runtime, project, actions, errors, requests, media, resumeLegacyAgent } = await fixture();
  productionActions(actions); actions.unshift(() => undefined);
  const run = await resumeLegacyAgent(); await runtime.waitForIdle();
  const completed = runSchema.parse(await runtime.dispatch('run.get', { runId: run.id }));
  expect(errors).toEqual([]); expect(completed.status, completed.error).toBe('succeeded');
  expect(requests[1].messages.some(message => message.role === 'user' && message.content?.includes('video-agent-continuation:1/3'))).toBe(true);
  expect(media.mock.calls.some(([context]) => context.node.kind === 'export')).toBe(true);
  expect((await current(runtime, project.id)).shots[0].videoAssetId).toBe('generated-video');
});

it('lets the Agent correct an invalid shot reference and continue the same production', async () => {
  const { runtime, project, actions, errors, media, resumeLegacyAgent } = await fixture();
  productionActions(actions);
  actions.splice(3, 0, () => business('image', 'wrong-shot', { shotId: 'unknown-shot' }));
  const readSnapshot = actions[4];
  actions[4] = payload => {
    expect(payload.messages.findLast(message => message.role === 'tool')?.content).toContain('镜头');
    return readSnapshot(payload);
  };
  const run = await resumeLegacyAgent(); await runtime.waitForIdle();
  const completed = runSchema.parse(await runtime.dispatch('run.get', { runId: run.id }));
  expect(errors).toEqual([]); expect(completed.status, completed.error).toBe('succeeded');
  expect(media.mock.calls.filter(([context]) => context.node.kind === 'assets')).toHaveLength(1);
  expect((await current(runtime, project.id)).shots[0]).toMatchObject({ assetId: 'generated-image', videoAssetId: 'generated-video' });
});

it('preserves concurrent user edits and retains the Agent production outputs for review', async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  const result = await fixture({ provider: async ({ prompt }) => {
    if (first) { first = false; entered(); await gate; return '六秒的水滴旅程，三幕叙事。'; }
    if (prompt.includes('自动视频制作步骤：风格与角色')) return '蓝绿色水彩，柔和光线。';
    return JSON.stringify({ shots: [{ title: '水滴旅程', narration: '', visualPrompt: '水彩雨滴', durationUs: 6_000_000 }], entities: [] });
  } });
  productionActions(result.actions);
  const run = await result.resumeLegacyAgent();
  await started;
  const edited = projectSchema.parse(await result.runtime.dispatch('project.update', { projectId: result.project.id, revision: result.project.revision, patch: { title: '用户在制作中修改的标题' } }));
  release(); await result.runtime.waitForIdle();
  expect(result.errors).toEqual([]); expect(result.requests.length).toBeGreaterThan(0);
  expect(await current(result.runtime, result.project.id)).toEqual(edited);
  expect(await result.runtime.dispatch('run.events', { runId: run.id })).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ type: 'project.apply_conflict' })]) });
});

it('recovers after committing a generated image without submitting the same media generation again', async () => {
  let crashed = false;
  const { runtime, directory, options, project, actions, errors, requests, provider, media, resumeLegacyAgent } = await fixture({ failpoint(point, activityId) {
    if (!crashed && point === 'after-commit' && activityId === 'video-agent/tool/image-1') { crashed = true; throw new SimulatedProcessExit(); }
  } });
  productionActions(actions);
  const run = await resumeLegacyAgent(); await runtime.waitForIdle();
  expect(crashed).toBe(true);
  expect(media.mock.calls.filter(([context]) => context.node.kind === 'assets')).toHaveLength(1);
  await runtime.close(); runtimes.delete(runtime);
  const reopened = createRuntime({ ...options, dataDirectory: directory, failpoint: undefined }); runtimes.add(reopened);
  await reopened.dispatch('run.resume', { runId: run.id }); await reopened.waitForIdle();
  const completed = runSchema.parse(await reopened.dispatch('run.get', { runId: run.id }));
  expect(errors).toEqual([]); expect(requests.length).toBeGreaterThan(0); expect(completed.status, completed.error).toBe('succeeded');
  expect(provider).toHaveBeenCalledTimes(3); expect(media.mock.calls.filter(([context]) => context.node.kind === 'assets')).toHaveLength(1);
  expect((await current(reopened, project.id)).shots[0]).toMatchObject({ assetId: 'generated-image', videoAssetId: 'generated-video' });
});

it('cancels an active business request and stops dispatching later production tools', async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const { runtime, project, actions, errors, requests, media, resumeLegacyAgent } = await fixture({ provider: async ({ signal }) => {
    entered();
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('controlled canceled provider')), { once: true });
    });
  } });
  productionActions(actions);
  const run = await resumeLegacyAgent();
  await started; await runtime.dispatch('run.cancel', { runId: run.id }); await runtime.waitForIdle();
  expect(errors).toEqual([]); expect(requests).toHaveLength(1); expect(media).not.toHaveBeenCalled();
  expect(runSchema.parse(await runtime.dispatch('run.get', { runId: run.id })).status).toBe('canceled');
  expect(await current(runtime, project.id)).toEqual(project);
});

it('restarts a canceled legacy Agent in the unified workflow', async () => {
  let entered!: () => void, canceled = false;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const { runtime, project, actions, errors, requests, resumeLegacyAgent } = await fixture({ provider: async ({ signal, prompt }) => {
    if (!canceled) {
      entered();
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => { canceled = true; reject(new Error('controlled cancellation')); }, { once: true }));
    }
    if (prompt.includes('自动视频制作步骤：创意简报')) return planningFixtureResponse(prompt, '六秒的水滴旅程，三幕叙事。');
    if (prompt.includes('自动视频制作步骤：风格与角色')) return planningFixtureResponse(prompt, '蓝绿色水彩，柔和光线。');
    return storyboardFixtureResponse(prompt, JSON.stringify({ shots: [{ title: '水滴旅程', narration: '', visualPrompt: '水彩雨滴', durationUs: 6_000_000 }], entities: [] }));
  } });
  actions.push(() => business('brief', 'canceled-brief'));
  const first = await resumeLegacyAgent();
  await started; await runtime.dispatch('run.cancel', { runId: first.id }); await runtime.waitForIdle();
  expect(runSchema.parse(await runtime.dispatch('run.get', { runId: first.id })).status).toBe('canceled');
  const restarted = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id, parentRunId: first.id })); await runtime.waitForIdle();
  const completed = runSchema.parse(await runtime.dispatch('run.get', { runId: restarted.id }));
  expect(errors).toEqual([]); expect(restarted.id).not.toBe(first.id); expect(completed.status, completed.error).toBe('succeeded');
  expect(requests).toHaveLength(1); expect((await current(runtime, project.id)).shots[0].videoAssetId).toBe('generated-video');
  expect((await runtime.dispatch('run.inspect', { runId: restarted.id }))).toMatchObject({ steps: project.workflow.nodes.map(({ id, kind }) => expect.objectContaining({ id, kind })) });
});

it('halts later parallel business calls after the first external task has an unconfirmed failure', async () => {
  const provider = vi.fn<NonNullable<RuntimeOptions['provider']>>(async () => { throw new Error('connection ended without a receipt'); });
  const { runtime, project, actions, errors, requests, media, resumeLegacyAgent } = await fixture({ provider });
  actions.push(() => [business('brief', 'uncertain-first'), business('style', 'must-not-dispatch')]);
  const run = await resumeLegacyAgent(); await runtime.waitForIdle();
  const completed = runSchema.parse(await runtime.dispatch('run.get', { runId: run.id }));
  expect(errors).toEqual([]); expect(requests).toHaveLength(1); expect(provider).toHaveBeenCalledTimes(1); expect(media).not.toHaveBeenCalled();
  expect(completed.status).not.toBe('succeeded');
  expect(await runtime.dispatch('node.result', { runId: run.id, nodeId: 'video-agent/tool/must-not-dispatch' })).toBeNull();
  expect(await current(runtime, project.id)).toEqual(project);
});
