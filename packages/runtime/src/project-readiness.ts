import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { projectReadinessSchema, usesVideoAudio, type AssetRecord, type CharacterProfile, type ModelProfile, type ProjectDocument, type ReadinessIssue, type RunSelection, type RuntimeSystem, type SkillPackage, type WorkflowNode } from '@video-quickly/contracts';
import { fingerprint } from './activities.js';
import { audioFileHash } from './audio-preview.js';
import { ExecutionModelError, validateExecutionModel } from './execution-model.js';
import { redactInspectionText } from './run-inspection.js';
import type { RuntimeOptions } from './index.js';

export interface ReadinessSnapshot {
  project: ProjectDocument; nodes: WorkflowNode[]; models: ModelProfile[]; assets: AssetRecord[];
  characters: CharacterProfile[]; skills: SkillPackage[]; selection?: RunSelection;
  blockedIssue?: Pick<ReadinessIssue, 'category' | 'message' | 'fix' | 'nodeId'>;
}

export function createProjectReadiness(options: {
  snapshot(projectId: string, selection?: RunSelection): ReadinessSnapshot;
  system: RuntimeSystem;
  directory: string;
  hasMediaExecutor: boolean;
  preflight?: RuntimeOptions['preflightActivity'];
  redactText(text: string, models: ModelProfile[]): string;
}) {
  const controllers = new Set<AbortController>(), pending = new Set<Promise<unknown>>();
  const requests = new Map<string, { projectId: string; controller: AbortController; work: Promise<unknown> }>();
  let closed = false;
  async function inspect(saved: ReadinessSnapshot, signal: AbortSignal) {
    const { project, nodes } = saved, issues: ReadinessIssue[] = [];
    const assets = new Map(saved.assets.map(asset => [asset.id, asset])), models = new Map(saved.models.map(model => [model.id, model]));
    const characters = new Map(saved.characters.map(character => [character.id, character])), enabledSkills = new Set(saved.skills.filter(skill => skill.enabled).map(skill => skill.id));
    const imported = new Map<string, AssetRecord>(), issueIndexes = new Map<string, number>();
    for (const asset of saved.assets) if (asset.active && asset.projectId === project.id && asset.shotId) {
      const key = `${asset.shotId}:${asset.kind}`;
      if (!imported.has(key)) imported.set(key, asset);
    }
    const required = new Map<string, { asset: AssetRecord; node: WorkflowNode; severity: 'error' | 'warning' }>();
    const inspected = new Set<string>(), invalidModels = new Set<string>();
    function add(issue: Omit<ReadinessIssue, 'id'>, key: string) {
      const id = `${issue.category}:${key}`;
      const previous = issueIndexes.get(id), node = issue.nodeId ? nodes.find(value => value.id === issue.nodeId) : undefined;
      const value = { ...issue, id, nodeLabel: node?.label, modelName: issue.modelId ? models.get(issue.modelId)?.name : undefined, message: redactInspectionText(issue.message, text => options.redactText(text, saved.models)) };
      if (previous === undefined) { issueIndexes.set(id, issues.length); issues.push(value); }
      else if (issues[previous].severity === 'warning' && issue.severity === 'error') issues[previous] = value;
    }
    function requireAsset(id: string, node: WorkflowNode, severity: 'error' | 'warning' = 'error') {
      inspected.add(id);
      const asset = assets.get(id);
      if (!asset?.active || asset.projectId && asset.projectId !== project.id) {
        add({ severity, category: 'media', assetId: id, nodeId: node.id, message: '步骤引用的素材已移除或不属于当前项目。', hint: '请在素材库恢复文件或重新关联有效素材。', fix: 'assets' }, `missing:${id}`); return;
      }
      const previous = required.get(id);
      if (!previous || previous.severity === 'warning' && severity === 'error') required.set(id, { asset, node, severity });
    }
    if (saved.blockedIssue) add({ ...saved.blockedIssue, severity: 'error' }, 'blocked');
    if (nodes.some(node => node.kind === 'export') && (!options.hasMediaExecutor || !options.system.ffmpegAvailable)) add({ severity: 'error', category: 'environment', message: '媒体导出引擎尚未就绪。', hint: '请检查随应用安装的媒体组件，修复后重新连接执行器并再次检查。', fix: 'runtime' }, 'media-engine');
    const characterIds = new Set(project.shots.flatMap(shot => shot.characterIds ?? []));
    for (const id of characterIds) {
      const character = characters.get(id);
      if (!character || character.archived) {
        add({ severity: 'error', category: 'media', message: character ? `角色「${character.name}」已归档。` : '镜头引用的角色不存在。', hint: '请恢复角色或修改镜头绑定。', fix: 'characters' }, `character:${id}`); continue;
      }
      for (const assetId of character.referenceAssetIds) {
        const asset = assets.get(assetId);
        if (!asset?.active || asset.kind !== 'image' || asset.projectId !== undefined) add({ severity: 'error', category: 'media', assetId, message: `角色「${character.name}」的参考图不再是有效公共图片。`, fix: 'characters' }, `character-asset:${assetId}`);
        else requireAsset(assetId, nodes[0]);
      }
    }
    let futureShots = false, futureImages = false, futureVoice = false;
    for (const node of nodes) {
      signal.throwIfAborted();
      const model = node.modelId ? models.get(node.modelId) : undefined;
      try { validateExecutionModel(node, model); }
      catch (failure) {
        invalidModels.add(node.id);
        add({ severity: 'error', category: 'model', nodeId: node.id, modelId: node.modelId, message: failure instanceof Error ? failure.message : '模型配置无效。', fix: failure instanceof ExecutionModelError ? failure.target : 'models' }, node.id);
      }
      if (model?.hasSecret && !model.credentialRef) add({ severity: 'error', category: 'model', nodeId: node.id, modelId: model.id, message: '模型凭据配置不完整，请重新保存连接密钥。', fix: 'models' }, `credential:${model.id}`);
      for (const id of node.skillIds) if (!enabledSkills.has(id)) add({ severity: 'warning', category: 'skill', nodeId: node.id, message: '步骤引用的 Skill 不可用，执行时不会采用该指令。', fix: 'step' }, `${node.id}:${id}`);
      if (!model) {
        if (node.kind === 'agent') add({ severity: 'error', category: 'model', nodeId: node.id, message: 'Agent 步骤需要选择具备文本和工具能力的模型。', fix: 'step' }, `agent:${node.id}`);
        if (node.kind === 'script' && !project.shots.length) add({ severity: futureShots ? 'warning' : 'error', category: 'workflow', nodeId: node.id, message: '本地脚本步骤没有可采用的分镜，请先添加镜头或选择文本模型。', fix: 'step' }, `script:${node.id}`);
        if (node.kind === 'assets' || node.kind === 'voice') {
          const kind = node.kind === 'assets' ? 'image' : 'audio';
          for (const shot of project.shots) {
            const deferred = !shot.locked && (futureShots || (kind === 'image' ? futureImages : futureVoice));
            const asset = options.hasMediaExecutor ? imported.get(`${shot.id}:${kind}`) : assets.get((kind === 'image' ? shot.assetId ?? shot.videoAssetId : shot.audioAssetId) ?? '');
            if (!asset) add({ severity: deferred ? 'warning' : 'error', category: 'media', nodeId: node.id, message: `镜头「${shot.title}」缺少此步骤可采用的${kind === 'image' ? '画面' : '配音'}素材。`, hint: deferred ? '上游步骤可能生成输入，执行到此步骤时仍会再次校验。' : '请导入相应素材或为步骤选择生成模型。', fix: 'step' }, `${node.id}:${shot.id}`);
            else requireAsset(asset.id, node, deferred ? 'warning' : 'error');
          }
        }
      }
      if (node.kind === 'export') {
        if (!project.shots.length) add({ severity: futureShots ? 'warning' : 'error', category: 'workflow', nodeId: node.id, message: '当前没有可导出的镜头。', hint: futureShots ? '上游脚本可能生成分镜，导出时仍会再次校验。' : '请先添加镜头，或将生成分镜的脚本步骤包含在执行范围内。', fix: 'step' }, `empty-export:${node.id}`);
        for (const shot of project.shots) {
          const visual = !shot.sceneTemplate ? shot.videoAssetId ?? shot.assetId : undefined;
          if (visual) requireAsset(visual, node, !shot.locked && (futureShots || futureImages) ? 'warning' : 'error');
          if (shot.audioAssetId) requireAsset(shot.audioAssetId, node, !shot.locked && (futureShots || futureVoice) ? 'warning' : 'error');
          if (usesVideoAudio(shot) && shot.videoAssetId) requireAsset(shot.videoAssetId, node, !shot.locked && (futureShots || futureImages) ? 'warning' : 'error');
        }
        for (const clip of project.musicClips ?? []) requireAsset(clip.assetId, node);
      }
      if (model && !invalidModels.has(node.id)) {
        if (node.kind === 'script') futureShots = true;
        if (node.kind === 'assets') futureImages = true;
        if (node.kind === 'voice') futureVoice = true;
      }
    }
    for (const { asset, node, severity } of required.values()) {
      signal.throwIfAborted();
      try {
        const metadata = await stat(asset.path);
        if (!metadata.isFile() || metadata.size !== asset.size || await audioFileHash(asset.path, signal) !== asset.sha256) throw new Error('文件大小或 SHA-256 与已保存的素材记录不一致。');
      } catch (failure) {
        signal.throwIfAborted();
        add({ severity, category: 'media', nodeId: node.id, assetId: asset.id, message: `素材「${asset.name}」缺失、无法读取或内容已变化。`, hint: failure instanceof Error && 'code' in failure ? String(failure.code) : '请恢复原始文件，或重新导入并确认新的关联。', fix: 'assets' }, `file:${asset.id}`);
      }
    }
    if (options.preflight && !issues.some(issue => issue.severity === 'error' && issue.category === 'media')) {
      for (const node of nodes) {
        signal.throwIfAborted();
        const model = node.modelId ? models.get(node.modelId) : undefined;
        if (!model || invalidModels.has(node.id) || !['assets', 'voice', 'animation'].includes(node.kind)) continue;
        try { await options.preflight({ project, node, assets: saved.assets, model, characters: saved.characters.filter(character => characterIds.has(character.id)), signal, dataDirectory: options.directory }); }
        catch (failure) { signal.throwIfAborted(); add({ severity: 'error', category: 'model', nodeId: node.id, modelId: model.id, message: failure instanceof Error ? failure.message : '媒体输入条件无法通过本地检查。', fix: 'models' }, `preflight:${node.id}`); }
      }
    }
    return projectReadinessSchema.parse({ projectId: project.id, projectTitle: project.title, projectRevision: project.revision, workflowVersion: project.workflow.version,
      selection: saved.selection, checkedAt: new Date().toISOString(), digest: fingerprint(saved), ready: !issues.some(issue => issue.severity === 'error'), serviceCheck: 'not_contacted',
      stepCount: nodes.length, modelCount: new Set(nodes.flatMap(node => node.modelId ? [node.modelId] : [])).size, assetCount: inspected.size, issues });
  }
  return {
    check(projectId: string, selection?: RunSelection, requestId: string = randomUUID()) {
      if (closed) throw new Error('执行器正在关闭。');
      if (requests.has(requestId)) throw new Error('相同的制作检查仍在执行。');
      const controller = new AbortController(); controllers.add(controller);
      const work = (async () => inspect(options.snapshot(projectId, selection), controller.signal))().finally(() => { controllers.delete(controller); pending.delete(work); requests.delete(requestId); });
      requests.set(requestId, { projectId, controller, work });
      pending.add(work); return work;
    },
    async cancel(projectId: string, requestId: string) {
      const request = requests.get(requestId);
      if (!request || request.projectId !== projectId) return { canceled: false };
      request.controller.abort(); await Promise.allSettled([request.work]); return { canceled: true };
    },
    async waitForIdle() { while (pending.size) await Promise.allSettled([...pending]); },
    async close() { closed = true; for (const controller of controllers) controller.abort(); await Promise.allSettled([...pending]); },
  };
}
