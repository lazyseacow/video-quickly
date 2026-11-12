import { expect, it } from 'vitest';
import { createNativeVideoWorkflow, DEFAULT_VIDEO_PROFILE, projectSchema, shotSchema, skillSchema } from '@video-quickly/contracts';
import { buildWorkflowPrompt, parseWorkflowShots } from '../src/packages/runtime/src/workflow-prompts';
import { parseProductionDocument, productionDocumentContract } from '../src/packages/runtime/src/workflow-outputs';
import { planningFixtureFields } from './fixtures/planning-response';

const project = () => projectSchema.parse({ id: 'prompt-project', title: '自动制作主题', brief: '上一步已生成的创意简报', style: '上一步已生成的视觉风格', revision: 1, profile: DEFAULT_VIDEO_PROFILE, workflow: createNativeVideoWorkflow(), shots: [], createdAt: '', updatedAt: '' });
const generated = (title: string, extra: Record<string, unknown> = {}) => ({ title, narration: `${title}的旁白`, visualPrompt: `${title}的画面`, durationUs: 2_000_000, ...extra });
const response = (...shots: ReturnType<typeof generated>[]) => JSON.stringify({ shots });
const existing = (id: string, extra: Record<string, unknown> = {}) => shotSchema.parse({ id, ...generated(id), ...extra });

it('keeps the frozen brief output contract and validates fields for new runs', () => {
  const value = project(), node = value.workflow.nodes.find(node => node.id === 'brief')!;
  const legacy = productionDocumentContract(node, 1)!, current = productionDocumentContract(node, 2)!;
  expect(buildWorkflowPrompt(value, node, [], false, [], [], 1)).toContain('{"text":"正文"}');
  expect(parseProductionDocument('{"text":"已冻结的正文"}', legacy)).toEqual({ text: '已冻结的正文' });
  const fields = { ...planningFixtureFields('brief', '天气变化'), audience: '学生' };
  expect(parseProductionDocument(JSON.stringify(fields), current)).toEqual({ text: '主题\n天气变化\n\n目标受众\n学生', fields });
  expect(() => parseProductionDocument('{"text":"非结构化正文"}', current)).toThrow('topic');
});

it('builds downstream generation input from current project, actual upstream results and enabled selected skills', () => {
  const current = project(), node = { ...current.workflow.nodes.find(node => node.kind === 'script')!, skillIds: ['selected', 'disabled'], prompt: '镜头不要超过三条' };
  const skills = [
    { id: 'selected', name: '叙事节奏', enabled: true, instructions: '按起承转合组织故事' },
    { id: 'disabled', name: '已停用', enabled: false, instructions: '不可执行的停用内容' },
    { id: 'unselected', name: '未选择', enabled: true, instructions: '不可执行的未选择内容' },
  ].map(skill => skillSchema.parse({ description: '测试方法', source: 'fixture', version: 'version-1', contentHash: 'fixture', importedAt: '', ...skill }));
  const prompt = buildWorkflowPrompt(current, node, skills, false, [], [{ nodeId: 'custom-plan', label: '上游规划', kind: 'agent', output: { text: '上一步的实际计划', sceneCount: 3 } }]);
  for (const value of [current.title, current.brief, current.style, '上一步的实际计划', '"sceneCount":3', skills[0].instructions, node.prompt]) expect(prompt).toContain(value);
  for (const skill of skills.slice(1)) expect(prompt).not.toContain(skill.instructions);
  expect(prompt).toContain('durationUs'); expect(prompt).toContain('1000000 微秒等于 1 秒');
});



it('passes semantic media references and structured shots without transport metadata or duplicate model text', () => {
  const current = project(), node = current.workflow.nodes.find(node => node.kind === 'style')!;
  const upstream = [
    { nodeId: 'images', label: '画面', kind: 'assets' as const, output: { assets: [{ id: 'generated-image', shotId: 'first', kind: 'image', name: '镜头图片', mimeType: 'image/png', version: 1, path: 'C:/private-workspace/image.png', size: 100, sha256: 'binary-hash' }], providerUsage: { inputTokens: 123 }, modelId: 'transport-model-id', source: 'model' } },
    { nodeId: 'script', label: '分镜', kind: 'script' as const, output: { text: 'duplicate-raw-response', shots: [{ title: '已生成镜头', narration: '真实旁白', durationUs: 2_000_000 }] } },
    { nodeId: 'custom', label: '自定义产物', kind: 'agent' as const, output: { custom: { path: 'logical/custom/field', source: 'business-source' }, count: 3 } },
  ];
  const before = structuredClone(upstream), prompt = buildWorkflowPrompt(current, node, [], false, [], upstream);
  for (const value of ['generated-image', 'first', '镜头图片', '已生成镜头', '真实旁白', 'logical/custom/field', 'business-source']) expect(prompt).toContain(value);
  for (const value of ['C:/private-workspace', 'binary-hash', 'providerUsage', 'transport-model-id', 'duplicate-raw-response']) expect(prompt).not.toContain(value);
  expect(upstream).toEqual(before);
});

it('retains stable shot identities and protected fields while accepting legacy positional output', () => {
  const before = [existing('stable-shot', { assetId: 'image', audioAssetId: 'audio', claimIds: ['claim'], characterIds: ['character'], clipEdit: { planId: 'plan', inUs: 0, restoreInUs: 0, restoreDurationUs: 2_000_000 } })];
  const [shot] = parseWorkflowShots(`\`\`\`json\n${response(generated('新分镜', { durationUs: 9_000_000, assetId: 'fabricated', characterIds: ['fabricated'] }))}\n\`\`\``, before);
  expect(shot).toMatchObject({ id: 'stable-shot', title: '新分镜', durationUs: 2_000_000, assetId: 'image', audioAssetId: 'audio', claimIds: ['claim'], characterIds: ['character'], clipEdit: before[0].clipEdit });
});

it('matches explicit existing IDs to their original content when editable shots are reordered', () => {
  const before = [existing('first', { assetId: 'first-image' }), existing('second', { assetId: 'second-image' })];
  const result = parseWorkflowShots(response(generated('第二镜头新标题', { id: 'second' }), generated('第一镜头新标题', { id: 'first' })), before);
  expect(result.map(({ id, assetId }) => ({ id, assetId }))).toEqual([{ id: 'second', assetId: 'second-image' }, { id: 'first', assetId: 'first-image' }]);
});

it('preserves locked objects and rejects deleting or displacing a locked shot', () => {
  const before = [existing('first'), existing('locked', { locked: true })];
  expect(parseWorkflowShots(response(generated('新第一镜头'), generated('模型改变锁定镜头')), before)[1]).toBe(before[1]);
  expect(() => parseWorkflowShots(response(generated('只返回一镜')), before)).toThrow('锁定镜头');
  expect(() => parseWorkflowShots(response(generated('锁定镜头错位', { id: 'locked' }), generated('第一镜头错位', { id: 'first' })), before)).toThrow('锁定镜头');
});

it('rejects invalid model JSON, durations, duplicate and unknown identities before downstream generation', () => {
  const before = [existing('first'), existing('second')];
  expect(() => parseWorkflowShots('生成计划：稍后制作分镜', before)).toThrow('有效 JSON');
  for (const durationUs of [0, 0.5, 499999, 600000001]) expect(() => parseWorkflowShots(response(generated('坏时长', { durationUs })), before)).toThrow();
  expect(() => parseWorkflowShots(response(generated('重复一', { id: 'first' }), generated('重复二', { id: 'first' })), before)).toThrow('重复');
  expect(() => parseWorkflowShots(response(generated('未知镜头', { id: 'invented' })), before)).toThrow('不存在');
});

it('assigns collision-free IDs to new shots and constrains single-shot candidates to the selected identity', () => {
  const before = [existing('shot-2')];
  const result = parseWorkflowShots(response(generated('保留镜头'), generated('新镜头')), before);
  expect(result.map(shot => shot.id)).toEqual(['shot-2', 'shot-3']);
  expect(parseWorkflowShots(response(generated('目标候选')), before, true)[0]).toMatchObject({ id: 'shot-2', title: '目标候选' });
  expect(() => parseWorkflowShots(response(generated('其他目标', { id: 'other' })), before, true)).toThrow('目标镜头编号');
  expect(() => parseWorkflowShots(response(generated('候选一'), generated('候选二')), before, true)).toThrow('恰好返回一条');
});
