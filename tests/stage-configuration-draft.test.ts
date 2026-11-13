import { describe, expect, it } from 'vitest';
import { createNativeVideoWorkflow, DEFAULT_VIDEO_PROFILE, type WorkflowNode } from '@video-quickly/contracts';
import { applyProductionProjectDraft, applyStageConfigurationDraft, stageConfigurationDraftSchema, updateProductionConfigurationDraft, updateStageConfigurationDraft } from '../src/renderer/lib/stage-configuration-draft';

const projectId = 'stage-configuration-project';
function task(id: string, changes: Partial<WorkflowNode> = {}) {
  const node = createNativeVideoWorkflow().nodes.find(node => node.id === id);
  if (!node) throw new Error(`Missing task: ${id}`);
  return { ...node, ...changes, config: { ...node.config, ...(changes.modelId ? { modelOverride: true } : {}), ...changes.config } };
}

describe('pending stage configuration', () => {
  it('can edit original text alongside a recovered pending configuration and detect a concurrent text edit', () => {
    const workflow = createNativeVideoWorkflow();
    const settings = { brief: '简报', style: '', profile: DEFAULT_VIDEO_PROFILE };
    const oldDraft = updateProductionConfigurationDraft(projectId, undefined, workflow, workflow.nodes, workflow.production, settings, { ...settings, brief: '待用简报' });
    const current = { ...settings, originalText: '旧分集原文' };
    const recovered = applyProductionProjectDraft(current, oldDraft).settings;
    const next = updateProductionConfigurationDraft(projectId, oldDraft, workflow, workflow.nodes, workflow.production, recovered, { ...recovered, originalText: '' });
    expect(applyProductionProjectDraft(current, next)).toEqual({ settings: { ...current, brief: '待用简报', originalText: '' }, conflicts: [] });
    expect(applyProductionProjectDraft({ ...current, originalText: '其他窗口的原文' }, next).conflicts).toEqual(['originalText']);
  });

  it('restores pending task edits from a legacy draft and discards its media concurrency setting', () => {
    const workflow = createNativeVideoWorkflow();
    const edited = task('style', { prompt: '待用风格要求' });
    const draft = updateStageConfigurationDraft(projectId, undefined, workflow.nodes, [edited]);
    const restored = stageConfigurationDraftSchema.parse({ ...draft, execution: { value: { maxConcurrentShots: 3, modelLimits: { video: 2 } } } });
    const applied = applyStageConfigurationDraft(workflow, restored);
    expect(restored).toEqual(draft);
    expect(applied.conflicts).toEqual([]);
    expect(applied.workflow.nodes.find(node => node.id === 'style')).toEqual(edited);
  });
  it('retains frozen prompt bindings and template versions in pending configuration', () => {
    const workflow = createNativeVideoWorkflow();
    const configured = task('style', { prompt: '{{tone}}', promptBindings: { tone: { literal: '水彩' } }, promptTemplate: { id: 'fixed-style', version: 2 } });
    const draft = stageConfigurationDraftSchema.parse(updateStageConfigurationDraft(projectId, undefined, workflow.nodes, [configured]));
    const applied = applyStageConfigurationDraft(workflow, draft);
    expect(applied.conflicts).toEqual([]);
    expect(applied.workflow.nodes.find(node => node.id === configured.id)).toEqual(configured);
    expect(workflow.nodes.find(node => node.id === configured.id)?.promptBindings).toBeUndefined();
  });
  it('changes only the requested tasks while preserving workflow structure, versions and other nodes', () => {
    const workflow = createNativeVideoWorkflow(), before = structuredClone(workflow);
    const configured = task('style', { modelId: 'next-text-model', prompt: '下一次采用的风格要求。' });
    const draft = updateStageConfigurationDraft(projectId, undefined, workflow.nodes, [configured]);
    const result = applyStageConfigurationDraft(workflow, draft);
    expect(result.conflicts).toEqual([]); expect(result.workflow.nodes.find(node => node.id === 'style')).toEqual(configured);
    expect(result.workflow.version).toBe(workflow.version); expect(result.workflow.edges).toBe(workflow.edges); expect(result.workflow.stages).toBe(workflow.stages);
    expect(result.workflow.nodes.find(node => node.id === 'script')).toEqual(workflow.nodes.find(node => node.id === 'script'));
    expect(workflow).toEqual(before); expect(draft.projectId).toBe(projectId);
  });

  it('retains the first baseline across repeated saves and keeps other stages pending', () => {
    const workflow = createNativeVideoWorkflow(), style = task('style', { prompt: '第一次待用风格' }), script = task('script', { prompt: '待用分镜要求' });
    const first = updateStageConfigurationDraft(projectId, undefined, workflow.nodes, [style]);
    const second = updateStageConfigurationDraft(projectId, first, workflow.nodes, [script]);
    const third = updateStageConfigurationDraft(projectId, second, workflow.nodes.map(node => node.id === 'style' ? { ...node, modelId: 'remote-model' } : node), [{ ...style, prompt: '第二次待用风格' }]);
    expect(third.changes).toHaveLength(2);
    expect(third.changes.find(change => change.node.id === 'style')).toMatchObject({ baseline: task('style'), node: { prompt: '第二次待用风格' } });
    expect(third.changes.find(change => change.node.id === 'script')).toEqual(second.changes.find(change => change.node.id === 'script'));
    expect(first.changes[0].node.prompt).toBe('第一次待用风格');
  });

  it('removes reverted settings without clearing pending changes to other stages', () => {
    const workflow = createNativeVideoWorkflow();
    const first = updateStageConfigurationDraft(projectId, undefined, workflow.nodes, [task('style', { prompt: '待用风格' }), task('script', { prompt: '待用分镜' })]);
    const reverted = updateStageConfigurationDraft(projectId, first, workflow.nodes, [task('style')]);
    expect(reverted.changes.map(change => change.node.id)).toEqual(['script']);
    const empty = updateStageConfigurationDraft(projectId, reverted, workflow.nodes, [task('script')]);
    expect(empty.changes).toEqual([]); expect(applyStageConfigurationDraft(workflow, empty).workflow).toBe(workflow);
  });

  it('recognizes already applied settings across workflow version changes without reporting a conflict', () => {
    const workflow = createNativeVideoWorkflow(), configured = task('script', { modelId: 'next-text-model' });
    const draft = updateStageConfigurationDraft(projectId, undefined, workflow.nodes, [configured]);
    const applied = { ...workflow, version: workflow.version + 1, nodes: workflow.nodes.map(node => node.id === configured.id ? configured : node) };
    expect(applyStageConfigurationDraft(applied, draft)).toEqual({ workflow: applied, conflicts: [] });
    expect(applyStageConfigurationDraft(applied, draft).workflow).toBe(applied);
    expect(applyStageConfigurationDraft(workflow, undefined).workflow).toBe(workflow);
  });

  it('preserves unrelated remote configuration and refuses to overwrite changed or deleted tasks', () => {
    const workflow = createNativeVideoWorkflow();
    const draft = updateStageConfigurationDraft(projectId, undefined, workflow.nodes, [task('style', { prompt: '待用风格' }), task('script', { prompt: '待用分镜' })]);
    const remote = { ...workflow, version: workflow.version + 2, nodes: workflow.nodes.filter(node => node.id !== 'script').map(node => node.id === 'style' ? { ...node, prompt: '其他窗口保存的风格' } : node.id === 'assets' ? { ...node, modelId: 'remote-image-model', config: { ...node.config, modelOverride: true } } : node) };
    const result = applyStageConfigurationDraft(remote, draft);
    expect(result.conflicts.sort()).toEqual(['script', 'style']); expect(result.workflow).toBe(remote);
    const independent = { ...workflow, nodes: workflow.nodes.map(node => node.id === 'video' ? { ...node, modelId: 'remote-video-model', config: { ...node.config, modelOverride: true } } : node) };
    const merged = applyStageConfigurationDraft(independent, draft);
    expect(merged.conflicts).toEqual([]); expect(merged.workflow.nodes.find(node => node.id === 'video')?.modelId).toBe('remote-video-model');
  });

  it('starts a separate project draft without inheriting another project configuration', () => {
    const workflow = createNativeVideoWorkflow(), first = updateStageConfigurationDraft('other-project', undefined, workflow.nodes, [task('style', { prompt: '另一个项目' })]);
    const draft = updateStageConfigurationDraft(projectId, first, workflow.nodes, [task('script', { prompt: '当前项目' })]);
    expect(draft.changes.map(change => change.node.id)).toEqual(['script']); expect(draft.projectId).toBe(projectId);
  });

  it('rejects invalid identity changes, duplicate tasks and settings for unknown tasks', () => {
    const workflow = createNativeVideoWorkflow(), style = task('style');
    expect(() => stageConfigurationDraftSchema.parse({ version: 1, projectId, changes: [{ baseline: style, node: { ...style, id: 'renamed' } }] })).toThrow('不能变更任务标识');
    expect(() => stageConfigurationDraftSchema.parse({ version: 1, projectId, changes: [{ baseline: style, node: style }, { baseline: style, node: style }] })).toThrow('重复任务');
    expect(() => updateStageConfigurationDraft(projectId, undefined, workflow.nodes, [style, style])).toThrow('重复任务');
    expect(() => updateStageConfigurationDraft(projectId, undefined, workflow.nodes, [{ ...style, id: 'missing' }])).toThrow('已移除');
  });

  it('round trips only the versioned configuration and preserves baseline conflict detection after recovery', () => {
    const workflow = createNativeVideoWorkflow(), draft = updateStageConfigurationDraft(projectId, undefined, workflow.nodes, [task('style', { prompt: '本机待用配置' })]);
    const restored = stageConfigurationDraftSchema.parse(JSON.parse(JSON.stringify({ ...draft, runId: 'unrelated-run', shots: [] })));
    expect(restored).toEqual(draft); expect(restored).not.toHaveProperty('runId'); expect(restored).not.toHaveProperty('shots');
    const remote = { ...workflow, nodes: workflow.nodes.map(node => node.id === 'style' ? { ...node, modelId: 'changed-after-restart' } : node) };
    expect(applyStageConfigurationDraft(remote, restored).conflicts).toEqual(['style']);
  });
});
