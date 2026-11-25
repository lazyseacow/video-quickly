import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { dramaStudioCreateResultSchema, dramaStylePresets, dramaTopicSchema, dramaWorkSchema, projectSchema, promptPreviewSchema, runSchema, seriesTemplateSchema, type DramaWork, type ProjectDocument, type RecordPage } from '@video-quickly/contracts';
import { createRuntime, type RuntimeOptions } from '../src/packages/runtime/src';
import { storyboardFixtureResponse } from './fixtures/planning-response';

const directories: string[] = [], runtimes = new Set<ReturnType<typeof createRuntime>>();
afterEach(async () => { await Promise.all([...runtimes].map(runtime => runtime.close())); runtimes.clear(); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
function open(options: RuntimeOptions) { const runtime = createRuntime(options); runtimes.add(runtime); return runtime; }
async function fixture(extra: Partial<RuntimeOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-drama-studio-')); directories.push(directory);
  const options: RuntimeOptions = { dataDirectory: directory, seed: false, seedBuiltInTemplates: true, ffmpegPath: '/unused', ...extra };
  return { directory, options, runtime: open(options) };
}
async function current(runtime: ReturnType<typeof createRuntime>, projectId: string) { return projectSchema.parse((await runtime.dispatch('project.get', { projectId }) as { project: ProjectDocument }).project); }
const baseWork = { title: '失约的列车', description: '同一组人物的连续故事', visualStyle: 'animation', narrativeMode: 'mixed' } as const;

it('creates one work and its first episode atomically, expanding selected topics, styles, templates and Skills into actual production inputs', async () => {
  const { runtime } = await fixture();
  const first = dramaTopicSchema.parse(await runtime.dispatch('dramaTopic.save', { topic: { title: '悬疑', logline: '迟到的旅人收到一封不属于自己的信。', description: '围绕一封信展开。', tags: ['悬疑'] } }));
  const second = dramaTopicSchema.parse(await runtime.dispatch('dramaTopic.save', { topic: { title: '亲情', logline: '旅人决定寻找寄信人。' } }));
  const style = dramaStylePresets.find(style => style.id === 'cel-animation')!;
  const templates = await runtime.dispatch('seriesTemplate.list') as RecordPage<ReturnType<typeof seriesTemplateSchema.parse>>;
  const template = templates.items.find(item => item.creationDefaults)!;
  const created = dramaStudioCreateResultSchema.parse(await runtime.dispatch('dramaStudio.create', { work: { ...baseWork, topicIds: [first.id, second.id], stylePresetId: style.id, skillIds: style.skillIds }, mode: 'write', originalText: '', seriesTemplateId: template.id, seriesTemplateRevision: template.revision }));
  expect(created.project.drama).toMatchObject({ workId: created.work.id, number: 1, visualStyle: 'animation', narrativeMode: 'mixed' });
  expect(created.project.brief).toContain(first.logline); expect(created.project.brief).toContain(second.logline);
  expect(created.project.style).toBe(style.prompt);
  expect(created.project.captionStyle).toEqual(template.settings.captionStyle);
  expect(created.project.profile).toEqual(template.creationDefaults!.profile);
  const expectedSkills = style.skillIds;
  for (const node of created.project.workflow.nodes.filter(node => ['brief', 'style', 'script'].includes(node.kind))) expect(node.skillIds).toEqual(expectedSkills);
  expect(created.project.workflow.nodes[0]).toMatchObject({ id: 'screenplay', kind: 'brief', config: { documentRole: 'screenplay' } });
  expect(created.project.workflow.stages?.map(stage => stage.label)).toEqual(['策划与分镜', '素材与配音', '剪辑与动画', '审阅与导出']);
  expect((await runtime.dispatch('dramaWork.list', { search: '失约' }) as RecordPage<DramaWork>).items.map(work => work.id)).toEqual([created.work.id]);
  expect((await runtime.dispatch('dramaWork.list', { search: '连续故事' }) as RecordPage<DramaWork>).items.map(work => work.id)).toEqual([created.work.id]);
  expect((await runtime.dispatch('dramaWork.list', { search: '没有匹配的故事' }) as RecordPage<DramaWork>).items).toEqual([]);
  await runtime.dispatch('dramaTopic.save', { topic: { ...first, logline: '已经修改的选题正文' } });
  expect((await current(runtime, created.project.id)).brief).toBe(created.project.brief);
  const before = await runtime.dispatch('dramaWork.list') as RecordPage<DramaWork>;
  await expect(runtime.dispatch('dramaStudio.create', { work: baseWork, mode: 'write', seriesTemplateId: template.id, seriesTemplateRevision: template.revision + 1 })).rejects.toThrow('其他视图修改');
  expect(await runtime.dispatch('dramaWork.list')).toEqual(before);
  await expect(runtime.dispatch('dramaStudio.create', { work: baseWork, mode: 'upload', originalText: '  ' })).rejects.toThrow('正文');
  const longTitle = '长'.repeat(151) + '😀' + '余'.repeat(7);
  const longWork = dramaStudioCreateResultSchema.parse(await runtime.dispatch('dramaStudio.create', { work: { ...baseWork, title: longTitle }, mode: 'write' }));
  expect(longWork.work.title).toBe(longTitle); expect(longWork.project.title).toBe('长'.repeat(151) + ' · 第 1 集');
});

it('reads local screenplay files without saving, truncating or scheduling production', async () => {
  let calls = 0;
  const { runtime, directory } = await fixture({ provider: async () => { calls++; throw new Error('import must remain local'); } });
  const path = join(directory, '第一集.md'); await writeFile(path, '\uFEFF第一场\r\n林夏：明天见。');
  expect(await runtime.dispatch('dramaScript.read', { path })).toEqual({ fileName: '第一集.md', text: '第一场\n林夏：明天见。' });
  await writeFile(path, '长'.repeat(30001));
  await expect(runtime.dispatch('dramaScript.read', { path })).rejects.toThrow('30000');
  await expect(runtime.dispatch('dramaScript.read', { url: 'https://example.com/script' })).rejects.toThrow();
  expect((await runtime.dispatch('dramaWork.list') as RecordPage<DramaWork>).items).toEqual([]); expect(calls).toBe(0);
});

it('respects explicit Skill removal and local library availability without silently restoring style recommendations', async () => {
  const { runtime } = await fixture();
  const style = dramaStylePresets.find(style => style.id === 'cel-animation')!;
  await runtime.dispatch('skill.toggle', { skillId: style.skillIds[0], enabled: false });
  const templates = await runtime.dispatch('seriesTemplate.list') as RecordPage<ReturnType<typeof seriesTemplateSchema.parse>>;
  const template = templates.items.find(item => item.creationDefaults)!;
  const input = { mode: 'write', seriesTemplateId: template.id, seriesTemplateRevision: template.revision };
  const cleared = dramaStudioCreateResultSchema.parse(await runtime.dispatch('dramaStudio.create', { ...input, work: { ...baseWork, stylePresetId: style.id, skillIds: [] } }));
  expect(cleared.work.skillIds).toEqual([]); expect(cleared.project.workflow.nodes[0].skillIds).toEqual([]);
  expect(cleared.project.style).toBe(style.prompt);
  const inherited = dramaStudioCreateResultSchema.parse(await runtime.dispatch('dramaStudio.create', { ...input, work: baseWork }));
  expect(inherited.work.skillIds).toEqual(template.creationDefaults!.skillIds);
  expect(inherited.project.workflow.nodes[0].skillIds).toEqual(inherited.work.skillIds);
  const before = await runtime.dispatch('dramaWork.list');
  await expect(runtime.dispatch('dramaStudio.create', { mode: 'write', work: { ...baseWork, skillIds: [style.skillIds[0]] } })).rejects.toThrow('已停用');
  await expect(runtime.dispatch('dramaStudio.create', { mode: 'write', work: { ...baseWork, topicIds: ['missing-topic'] } })).rejects.toThrow('选题');
  await expect(runtime.dispatch('dramaStudio.create', { mode: 'write', work: { ...baseWork, stylePresetId: 'missing-style' } })).rejects.toThrow('画风');
  await expect(runtime.dispatch('dramaStudio.create', { mode: 'write', work: { ...baseWork, stylePresetId: 'natural-live-action' } })).rejects.toThrow('不一致');
  expect(await runtime.dispatch('dramaWork.list')).toEqual(before);
  const liveAction = projectSchema.parse(await runtime.dispatch('project.create', { title: '真人重述本集', drama: { workId: cleared.work.id, number: 2, visualStyle: 'live-action' } }));
  expect(liveAction.drama?.visualStyle).toBe('live-action'); expect(liveAction.style).toBe('');
  const mixed = projectSchema.parse(await runtime.dispatch('project.create', { title: '混合画风本集', drama: { workId: cleared.work.id, number: 3, visualStyle: 'mixed' } }));
  expect(mixed.style).toBe(style.prompt);
});

it('freezes and persists an explicitly confirmed AI screenplay draft, applies it once, and uses its saved text for actual storyboard generation', async () => {
  const calls: { prompt: string; schema?: string }[] = [];
  const screenplay = '第一场 车站 夜\n林夏把信递给站长。\n林夏：这封信，是给你的。\n站长没有回答，远处列车突然熄灯。';
  const { runtime, options } = await fixture({ requireChargeConfirmation: true, provider: async ({ prompt, outputSchemaName }) => {
    calls.push({ prompt, schema: outputSchemaName });
    return outputSchemaName === 'drama_screenplay' ? JSON.stringify({ text: screenplay })
      : storyboardFixtureResponse(prompt, JSON.stringify({ shots: [{ title: '递信', narration: '这封信，是给你的。', visualPrompt: '林夏在夜间车站向站长递信。', durationUs: 4_000_000 }] }));
  } });
  const { project } = dramaStudioCreateResultSchema.parse(await runtime.dispatch('dramaStudio.create', { work: baseWork, mode: 'write' }));
  const model = await runtime.dispatch('model.save', { model: { name: '本地文本边界', provider: 'ollama', connectionType: 'text', capabilities: ['text'], baseUrl: 'http://127.0.0.1:1', model: 'fixture-text' } }) as { id: string };
  const node = { ...project.workflow.nodes.find(node => node.id === 'screenplay')!, modelId: model.id };
  const draft = { requestId: randomUUID(), projectId: project.id, projectRevision: project.revision, node };
  expect(calls).toEqual([]);
  const preview = promptPreviewSchema.parse(await runtime.dispatch('prompt.preview', draft));
  expect(preview.prompt).toContain('完整剧本正文'); expect(preview.prompt).toContain(baseWork.description); expect(preview.node.config.screenplayDraft).toBe(true);
  await expect(runtime.dispatch('planning.prefill.start', draft)).rejects.toThrow('确认'); expect(calls).toEqual([]);
  const charge = await runtime.dispatch('billing.prepare', { method: 'planning.prefill.start', params: draft }) as { confirmationId: string };
  const run = runSchema.parse(await runtime.dispatch('planning.prefill.start', { ...draft, chargeConfirmationId: charge.confirmationId }));
  await runtime.waitForIdle();
  expect((await runtime.dispatch('run.get', { runId: run.id }) as { status: string }).status).toBe('succeeded');
  expect(await runtime.dispatch('node.result', { runId: run.id, nodeId: node.id })).toMatchObject({ text: screenplay });
  expect((await current(runtime, project.id)).originalText).toBe(''); expect(calls).toHaveLength(1);
  await runtime.close(); runtimes.delete(runtime); const reopened = open(options);
  const application = { runId: run.id, nodeId: node.id, revision: project.revision, applicationId: randomUUID() };
  const saved = projectSchema.parse(await reopened.dispatch('node.apply', application));
  expect(saved.originalText).toBe(screenplay); expect(saved.brief).toBe(project.brief);
  expect(await reopened.dispatch('node.apply', application)).toEqual(saved);
  const storyboard = { requestId: randomUUID(), projectId: saved.id, projectRevision: saved.revision, node: { ...saved.workflow.nodes.find(node => node.id === 'script')!, modelId: model.id } };
  const storyboardCharge = await reopened.dispatch('billing.prepare', { method: 'planning.prefill.start', params: storyboard }) as { confirmationId: string };
  const script = runSchema.parse(await reopened.dispatch('planning.prefill.start', { ...storyboard, chargeConfirmationId: storyboardCharge.confirmationId }));
  await reopened.waitForIdle();
  expect((await reopened.dispatch('run.get', { runId: script.id }) as { status: string }).status).toBe('succeeded');
  expect(calls.slice(1).every(call => call.prompt.includes(screenplay))).toBe(true);
  const filmed = projectSchema.parse(await reopened.dispatch('node.apply', { runId: script.id, nodeId: 'script', revision: saved.revision }));
  expect(filmed.shots[0].title).toBe('递信'); expect(filmed.originalText).toBe(screenplay);
});

it('rejects stale screenplay application and can consume an uploaded screenplay locally without a text model', async () => {
  const { runtime } = await fixture({ provider: async () => JSON.stringify({ text: '模型草稿' }) });
  const { project } = dramaStudioCreateResultSchema.parse(await runtime.dispatch('dramaStudio.create', { work: baseWork, mode: 'upload', originalText: '上传的剧本正文' }));
  const local = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id, nodeId: 'screenplay' }));
  await runtime.waitForIdle();
  expect(await runtime.dispatch('node.result', { runId: local.id, nodeId: 'screenplay' })).toMatchObject({ text: '上传的剧本正文', source: 'project' });
  const model = await runtime.dispatch('model.save', { model: { name: '文本边界', provider: 'ollama', connectionType: 'text', capabilities: ['text'], baseUrl: 'http://127.0.0.1:1', model: 'fixture-text' } }) as { id: string };
  const latest = await current(runtime, project.id), node = { ...latest.workflow.nodes[0], modelId: model.id };
  const draft = runSchema.parse(await runtime.dispatch('planning.prefill.start', { projectId: latest.id, projectRevision: latest.revision, node, requestId: randomUUID() }));
  await runtime.waitForIdle();
  const edited = projectSchema.parse(await runtime.dispatch('project.update', { projectId: latest.id, revision: latest.revision, patch: { originalText: '人工修订后的剧本' } }));
  await expect(runtime.dispatch('node.apply', { runId: draft.id, nodeId: node.id, revision: edited.revision })).rejects.toThrow('修改');
  expect((await current(runtime, latest.id)).originalText).toBe('人工修订后的剧本');
  const work = dramaWorkSchema.parse(await runtime.dispatch('dramaWork.get', { workId: latest.drama!.workId })); expect(work.topicIds).toEqual([]);
});
