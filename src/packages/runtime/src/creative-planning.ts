import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import {
  assetSchema, CREATIVE_SEGMENT_COUNT, CREATIVE_SEGMENT_DURATION_US, creativePlanningEntrySchema, creativePlanningResultSchema,
  creativePlanningReviseInputSchema, creativePlanningStartInputSchema, creativePreviewApplyInputSchema, creativePreviewStartInputSchema,
  creativeStyleCardContentSchema, creativeStyleCardSchema, formatPlanningDocument, pageInputSchema, projectCharacterIds, shotSchema, workflowNodeSchema,
  type CharacterProfile,
  type AssetRecord, type CreativeObjectiveExecution, type CreativeObjectivePlan, type CreativePlanningEntry, type CreativePlanningResult, type CreativeStyleCard,
  type ModelProfile, type ProjectDocument, type RunInspection, type RunRecord, type SkillPackage,
} from '@video-quickly/contracts';
import { fingerprint } from './activities.js';
import { previewAssetHash, previewStoryboardRevision, previewVisualInput, verifyPreviewImage } from './creative-preview.js';
import { readCreativeReferenceImage } from './creative-planning-execution.js';
import { applyCreativeRevisionPatch, creativeRevisionPatchSchema, creativeRevisionTarget } from './creative-planning-revisions.js';
import type { DocumentStore } from './database.js';
import { validateExecutionModel } from './execution-model.js';
import type { CreativePlanningSnapshot, RunSnapshot } from './run-snapshot.js';

type StartInput = z.infer<typeof creativePlanningStartInputSchema>;
type ReviseInput = z.infer<typeof creativePlanningReviseInputSchema>;
type PreviewInput = z.infer<typeof creativePreviewStartInputSchema>;
type CreativeRun = RunSnapshot & { creativePlanning: CreativePlanningSnapshot };
type RequestReceipt = { inputHash: string; runId: string };
type PreviewChoice = { assetId: string; visualHash: string };
type PreviewCandidate = { runId: string; asset: AssetRecord };
const draftShotsSchema = z.object({ shots: z.array(shotSchema).length(CREATIVE_SEGMENT_COUNT) });
const plannedShotsSchema = z.object({ shots: z.array(shotSchema) });
const previewAssetsSchema = z.object({ assets: z.array(assetSchema) });
const keyframeStep = workflowNodeSchema.parse({ id: 'assets', kind: 'assets', label: '预演关键镜头',
  prompt: '用一张静帧预演该镜头中最有代表性的画面，保留风格卡中的配色和光线。',
  config: { operation: 'prepare-references', referenceMode: 'generate' } });
const runIdInput = z.strictObject({ runId: z.string().min(1) });
const referenceFormats = new Map<string, string>([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp']]);

interface Options {
  database: Database.Database;
  store: DocumentStore;
  project: (id: string) => ProjectDocument;
  newProject: (input: { title: string; brief: string; originalText: string; skillIds: string[] }, styleOnly: boolean) => ProjectDocument;
  writeProject: (value: ProjectDocument, previous: ProjectDocument) => ProjectDocument;
  projectOccupied: (id: string) => boolean;
  model: (id: string) => ModelProfile | undefined;
  readPlan: (id: string) => CreativeObjectivePlan | undefined;
  readPreviewRecommendations: (runId: string, revision: string) => { shotId: string; reason: string }[] | undefined;
  canExecuteMedia: () => boolean;
  prepareSkills: (ids: string[]) => Promise<SkillPackage[]>;
  importImage: (path: string) => Promise<AssetRecord>;
  inspectRun: (id: string) => Promise<RunInspection>;
  runCreated: (id: string) => void;
  changed: () => void;
}

export function createCreativePlanning({ database, store, project, newProject, writeProject, projectOccupied, model, readPlan, readPreviewRecommendations, canExecuteMedia, prepareSkills, importImage, inspectRun, runCreated, changed }: Options) {
  const inFlight = new Map<string, { inputHash: string; result: Promise<CreativePlanningResult> }>();

  function requireRun(id: string) {
    const record = store.get<RunRecord>('run', id), saved = store.get<RunSnapshot>('run-snapshot', id);
    if (!record || record.purpose !== 'creative-planning' || !saved?.creativePlanning) throw new Error('未找到这次创作分镜。');
    return { record, saved: saved as CreativeRun };
  }

  function entry(record: RunRecord, saved: CreativeRun): CreativePlanningEntry {
    return creativePlanningEntrySchema.parse({ ...record, title: saved.project.title, goal: saved.creativePlanning.goal });
  }

  function plannedShots(runId: string, plan: CreativeObjectiveExecution, output: unknown) {
    if (plan.route === 'style-only') return;
    const parsed = plannedShotsSchema.safeParse(output);
    if (!parsed.success || parsed.data.shots.length !== plan.shotDurationsUs.length) return;
    const shots = parsed.data.shots;
    return shots.every((shot, index) => shot.id === `${runId}:shot:${index + 1}` && shot.durationUs === plan.shotDurationsUs[index]) ? shots : undefined;
  }

  function previewProject(runId: string, saved: RunSnapshot): ProjectDocument {
    if (saved.creativePlanning?.preview) return saved.project;
    const plan = saved.creativePlanning?.plan;
    if (plan?.route !== 'keyframe-preview') throw new Error('缺少已确认的关键镜头计划。');
    const shots = plannedShots(runId, plan, store.get('node-result', `${runId}:script`));
    const card = saved.creativePlanning?.styleCard ?? store.get<CreativeStyleCard>('creative-style-card', runId);
    if (!shots || !card) throw new Error('请先完成风格卡和分镜，再预演关键镜头。');
    return { ...saved.project, style: styleText(card), shots: shots.filter((_, index) => plan.keyframeShots.includes(index + 1)) };
  }

  function previewAssets(runId: string) {
    return previewAssetsSchema.safeParse(store.get('node-result', `${runId}:assets`)).data?.assets;
  }

  function withDraftFrames(sourceRunId: string, shots: ProjectDocument['shots']): ProjectDocument['shots'] {
    return shots.map(shot => {
      const choice = store.get<PreviewChoice>('creative-preview-selection', `${sourceRunId}:${shot.id}`);
      const asset = choice && store.get<AssetRecord>('asset', choice.assetId);
      return asset?.active ? { ...shot, assetId: asset.id } : shot;
    });
  }

  function previewBasis(record: RunRecord, saved: CreativeRun) {
    const { plan, previewFollowup } = saved.creativePlanning;
    if (!previewFollowup || !plan || record.status !== 'succeeded') return;
    if (!store.get('project', record.projectId)) return;
    const current = project(record.projectId);
    if (current.archived) return;
    const applied = Boolean(store.get('creative-planning-application', record.id));
    const shots = plannedShots(record.id, plan, store.get('node-result', `${record.id}:script`));
    const card = saved.creativePlanning.styleCard ?? store.get<CreativeStyleCard>('creative-style-card', record.id);
    let value = current;
    if (!applied) {
      if (current.revision !== record.projectRevision || !shots || !card) return;
      value = { ...current, style: styleText(card), shots: withDraftFrames(record.id, shots) };
    }
    const visuals = new Map(value.shots.map(shot => [shot.id, previewVisualInput(store, value, shot)]));
    const revision = previewStoryboardRevision(value, visuals);
    return { value, revision, visuals, applied };
  }

  function readPreviewBasis(runId: string) {
    const { record, saved } = requireRun(runId);
    const basis = previewBasis(record, saved);
    if (!basis) throw new Error('请先完成或恢复当前分镜。');
    return { ...basis, saved };
  }

  function previewSource(runId: string) {
    const { revision, value, saved } = readPreviewBasis(runId);
    if (!saved.models[0]) throw new Error('本次分镜缺少已保存的文本模型。');
    return { revision, projectId: value.id, goal: saved.creativePlanning.goal, shots: value.shots, model: saved.models[0] };
  }

  function previewState(runId: string, basis: NonNullable<ReturnType<typeof previewBasis>>) {
    const frames = basis.value.shots.map(shot => {
      const visualHash = basis.visuals.get(shot.id)?.visualHash;
      const index = `${runId}:${shot.id}`;
      const asset = shot.assetId ? store.get<AssetRecord>('asset', shot.assetId) : undefined;
      const placed = asset && store.get<{ visualHash: string }>('creative-preview-origin', asset.id);
      const saved = store.get<PreviewCandidate>('creative-preview-latest', index);
      const record = saved && store.get<RunRecord>('run', saved.runId);
      const child = saved && store.get<RunSnapshot>('run-snapshot', saved.runId);
      const input = child?.creativePlanning?.preview?.shots.find(value => value.shotId === shot.id);
      const candidate = saved && store.get<AssetRecord>('asset', saved.asset.id);
      const comparable = saved && record?.status === 'succeeded' && input && candidate?.active && candidate.id !== asset?.id
        && candidate.version === saved.asset.version && candidate.sha256 === saved.asset.sha256;
      return {
        shotId: shot.id,
        ...(asset?.active && asset.kind === 'image' ? { current: asset } : {}),
        stale: Boolean(placed && placed.visualHash !== visualHash),
        ...(comparable ? { candidate: { runId: record.id, asset: candidate,
          stale: input.visualHash !== visualHash || input.baseAssetHash !== previewAssetHash(store, shot.assetId) || shot.locked,
        } } : {}),
      };
    });
    return {
      revision: basis.revision, recommendations: readPreviewRecommendations(runId, basis.revision), frames,
      latestRunId: store.get<{ id: string }>('creative-preview-latest-run', runId)?.id,
    };
  }

  function capturePreviewAssets(runId: string, saved: RunSnapshot, assets: AssetRecord[]) {
    if (!saved.creativePlanning?.preview || !saved.creativePlanning.previewRootRunId) return;
    for (const asset of assets) {
      store.put('creative-preview-latest', `${saved.creativePlanning.previewRootRunId}:${asset.shotId}`, { runId, asset } satisfies PreviewCandidate);
    }
  }

  function result(id: string): CreativePlanningResult {
    const { record, saved } = requireRun(id);
    const styleCard = saved.creativePlanning.styleCard ?? store.get<CreativeStyleCard>('creative-style-card', id);
    const output = store.get('node-result', `${id}:script`);
    const revision = saved.creativePlanning.revision;
    const scope = revision?.scope;
    const target = scope && revision ? { ...scope, shotTitle: creativeRevisionTarget(revision.shots, scope).shot.title } : undefined;
    const revisionResult = scope ? z.object({ patch: creativeRevisionPatchSchema(scope) }).safeParse(output) : undefined;
    const preview = scope && revision && revisionResult?.success ? applyCreativeRevisionPatch(revision.shots, scope, revisionResult.data.patch) : undefined;
    const { plan, previewRootRunId } = saved.creativePlanning;
    const basis = previewBasis(record, saved);
    const keyframes = plan?.route === 'keyframe-preview' || saved.creativePlanning.preview ? previewAssets(id) : undefined;
    const assetsByShot = new Map(keyframes?.map(asset => [asset.shotId, asset.id]));
    const shots = basis?.value.shots ?? (scope ? undefined : plan ? plannedShots(id, plan, output)?.map(shot => {
      const assetId = assetsByShot.get(shot.id);
      return assetId ? { ...shot, assetId } : shot;
    }) : draftShotsSchema.safeParse(output).data?.shots);
    return creativePlanningResultSchema.parse({ ...entry(record, saved), currentNodeId: record.currentNodeId,
      retryCompleted: record.stepRetry?.status === 'completed' || undefined,
      reference: saved.creativePlanning.reference, styleCard, target, ...(shots?.length ? { shots } : {}), ...preview, previewRootRunId,
      ...(plan ? { route: plan.route } : {}), ...(keyframes ? { keyframes } : {}), ...(basis ? { preview: previewState(id, basis) } : {}),
      appliedRevision: store.get<{ revision: number }>('creative-planning-application', id)?.revision });
  }

  function page<T>(rows: { cursor: number; body: string }[], limit: number, read: (body: string) => T) {
    const visible = rows.slice(0, limit);
    return { items: visible.map(row => read(row.body)), nextCursor: rows.length > limit ? visible.at(-1)!.cursor : null };
  }

  function list(rawParams: unknown) {
    const { before, limit, projectId } = pageInputSchema.extend({ projectId: z.string().min(1).optional() }).parse(rawParams);
    const rows = database.prepare(`SELECT run.rowid AS cursor, json_patch(run.body, json_object(
      'title', json_extract(snapshot.body, '$.project.title'), 'goal', json_extract(snapshot.body, '$.creativePlanning.goal')
      )) AS body
      FROM documents run JOIN documents snapshot ON snapshot.kind = 'run-snapshot' AND snapshot.id = run.id
      WHERE run.kind = 'run' AND json_extract(run.body, '$.purpose') = 'creative-planning' AND run.rowid < @before
        AND json_type(snapshot.body, '$.creativePlanning.preview') IS NULL
        AND (@projectId IS NULL OR json_extract(run.body, '$.projectId') = @projectId)
      ORDER BY run.rowid DESC LIMIT @limit`).all({ before: before ?? Number.MAX_SAFE_INTEGER, limit: limit + 1, projectId: projectId ?? null }) as { cursor: number; body: string }[];
    return page(rows, limit, body => creativePlanningEntrySchema.parse(JSON.parse(body)));
  }

  function styleCards(rawParams: unknown) {
    const { before, limit } = pageInputSchema.parse(rawParams);
    const rows = database.prepare("SELECT rowid AS cursor, body FROM documents WHERE kind = 'creative-style-card' AND rowid < ? ORDER BY rowid DESC LIMIT ?")
      .all(before ?? Number.MAX_SAFE_INTEGER, limit + 1) as { cursor: number; body: string }[];
    return page(rows, limit, body => creativeStyleCardSchema.parse(JSON.parse(body)));
  }

  function captureStyleCard(runId: string, saved: RunSnapshot, output: unknown) {
    const reference = saved.creativePlanning?.reference;
    if (!reference || store.get('creative-style-card', runId)) return;
    const content = creativeStyleCardContentSchema.parse(z.object(creativeStyleCardContentSchema.shape).parse(output));
    store.put('creative-style-card', runId, creativeStyleCardSchema.parse({ ...content, id: runId, version: 1,
      title: saved.project.title, reference: { assetId: reference.id, version: reference.version }, createdAt: new Date().toISOString() }));
  }

  function requestReceipt(requestId: string, inputHash: string) {
    const receipt = store.get<RequestReceipt>('creative-planning-request', requestId);
    if (receipt && receipt.inputHash !== inputHash) throw new Error('这次创作的请求已用于其他内容，请重新提交。');
    return receipt;
  }

  function register(value: ProjectDocument, selected: ModelProfile, skills: SkillPackage[], creativePlanning: CreativePlanningSnapshot,
    requestId: string, inputHash: string, parentRunId?: string) {
    const route = creativePlanning.plan?.route;
    const skillIds = skills.map(skill => skill.id);
    const nodes = creativePlanning.revision?.scope ? [workflowNodeSchema.parse({ id: 'script', kind: 'script', label: '修改镜头', modelId: selected.id, skillIds })]
      : value.workflow.nodes.filter(node => node.id === 'script' && route !== 'style-only' || node.id === 'style' && !creativePlanning.styleCard)
        .map(node => {
          const label = node.id === 'style' ? '提取风格卡' : creativePlanning.revision ? '修改第二段' : route ? '生成分镜' : '生成三段分镜';
          return { ...node, label, modelId: selected.id, skillIds };
        });
    for (const node of nodes) validateExecutionModel(node, selected);
    return writeRun({ project: value, models: [selected], skills, nodes, handlerVersion: 1, creativePlanning,
      assets: creativePlanning.reference ? [creativePlanning.reference] : [] }, requestId, inputHash, parentRunId);
  }

  function writeRun(saved: CreativeRun, requestId: string, inputHash: string, parentRunId?: string) {
    const id = randomUUID(), createdAt = new Date().toISOString(), value = saved.project;
    const record: RunRecord = { id, projectId: value.id, projectRevision: value.revision, workflowVersion: value.workflow.version,
      snapshotDigest: fingerprint(saved), purpose: 'creative-planning', parentRunId,
      status: 'queued', stepCount: saved.nodes.length, createdAt, updatedAt: createdAt, events: [], activities: [] };
    store.put('run-snapshot', id, saved);
    store.put('run', id, record);
    store.put('creative-planning-request', requestId, { inputHash, runId: id } satisfies RequestReceipt);
    return id;
  }

  function executionPlan(input: StartInput): CreativeObjectiveExecution | undefined {
    const selection = input.plan;
    if (!selection) return;
    const plan = readPlan(selection.id);
    if (!plan || plan.goal !== input.goal || plan.modelId !== input.modelId) throw new Error('创作目标或模型已变更，请重新分析创作目标。');
    const choice = plan.options.find(option => option.id === selection.optionId);
    if (!choice) throw new Error('请选择并确认创作方案。');
    if (plan.route === 'style-only' && 'styleCardId' in input.reference) throw new Error('提取风格需要一张参考图，请选择图片。');
    const { shotDurationsUs, keyframeShots } = choice;
    return { planId: plan.id, optionId: choice.id, route: plan.route, shotDurationsUs, keyframeShots };
  }

  function previewModel(imageModelId: string) {
    if (!canExecuteMedia()) throw new Error('当前运行环境无法预演关键镜头。');
    const selected = model(imageModelId);
    if (!selected?.enabled) throw new Error('请选择可用的图片生成模型。');
    validateExecutionModel({ ...keyframeStep, modelId: selected.id }, selected);
    return selected;
  }

  function previewInputs(input: PreviewInput) {
    const basis = readPreviewBasis(input.runId);
    if (basis.revision !== input.revision) throw new Error('分镜已变更，请重新选择预演镜头。');
    if (projectOccupied(basis.value.id)) throw new Error('请先完成本项目的当前运行。');
    const ids = new Set(input.shotIds);
    const shots = basis.value.shots.filter(shot => ids.has(shot.id));
    if (shots.length !== ids.size || shots.some(shot => shot.locked)) throw new Error('请选择当前分镜中尚未锁定的镜头。');
    return { ...basis, shots, imageModel: previewModel(input.imageModelId) };
  }

  function previewQuote(input: PreviewInput) {
    return previewInputs(input).imageModel;
  }

  function startPreview(rawParams: unknown) {
    const input = creativePreviewStartInputSchema.parse(rawParams);
    const inputHash = fingerprint({ action: 'preview', input });
    const launch = database.transaction(() => {
      const existing = requestReceipt(input.requestId, inputHash);
      if (existing) return { id: existing.runId, created: false };
      const { value, visuals, shots, saved, imageModel } = previewInputs(input);
      const characters = projectCharacterIds({ shots }).map(id => {
        const profile = store.get<CharacterProfile>('character', id);
        if (!profile) throw new Error('预演引用的角色不可用，请重新选择角色。');
        return profile;
      });
      const frozenShots = shots.map(shot => {
        const visual = visuals.get(shot.id) ?? previewVisualInput(store, value, shot);
        return { shotId: shot.id, visualHash: visual.visualHash, baseAssetHash: previewAssetHash(store, shot.assetId) };
      });
      const assets = [...new Map(shots.flatMap(shot => visuals.get(shot.id)?.references ?? []).map(({ id, asset }) => {
        if (!asset?.active || asset.kind !== 'image') throw new Error('预演引用的参考图不可用，请先恢复参考图。');
        return [id, asset];
      })).values()];
      const node = { ...keyframeStep, modelId: imageModel.id, skillIds: saved.skills.map(skill => skill.id),
        prompt: input.instruction ? `${keyframeStep.prompt}\n本次调整要求：${input.instruction}` : keyframeStep.prompt };
      const id = writeRun({ project: { ...value, shots }, models: [imageModel], skills: saved.skills,
        nodes: [node], handlerVersion: 1, assets, characters,
        creativePlanning: { goal: saved.creativePlanning.goal, previewRootRunId: input.runId,
          preview: { revision: input.revision, shots: frozenShots } },
      }, input.requestId, inputHash, input.runId);
      store.put('creative-preview-latest-run', input.runId, { id });
      return { id, created: true };
    }).immediate();
    if (launch.created) runCreated(launch.id);
    return result(launch.id);
  }

  async function applyPreview(rawParams: unknown) {
    const { runId, shotId } = creativePreviewApplyInputSchema.parse(rawParams);
    const { record, saved } = requireRun(runId);
    const { previewRootRunId, preview } = saved.creativePlanning;
    const frozen = preview?.shots.find(input => input.shotId === shotId);
    if (record.status !== 'succeeded' || !previewRootRunId || !frozen) throw new Error('请先完成所选镜头的预演。');
    const receiptId = `${runId}:${shotId}`;
    if (store.get('creative-preview-application', receiptId)) return { runId: previewRootRunId, shotId };
    const frozenAsset = previewAssets(runId)?.find(asset => asset.shotId === shotId);
    function currentAsset() {
      const asset = frozenAsset && store.get<AssetRecord>('asset', frozenAsset.id);
      if (!frozenAsset || !asset?.active || asset.kind !== 'image' || asset.projectId !== record.projectId || asset.shotId !== shotId
        || asset.version !== frozenAsset.version || asset.sha256 !== frozenAsset.sha256) throw new Error('预演候选已变更或移除，请重新生成。');
      return asset;
    }
    const verified = currentAsset();
    await verifyPreviewImage(verified);
    const application = database.transaction(() => {
      if (store.get('creative-preview-application', receiptId)) return false;
      const { value, visuals, applied } = readPreviewBasis(previewRootRunId);
      if (projectOccupied(value.id)) throw new Error('请先完成本项目的当前运行。');
      const shot = value.shots.find(shot => shot.id === shotId);
      if (!shot || shot.locked || visuals.get(shotId)?.visualHash !== frozen.visualHash
        || previewAssetHash(store, shot.assetId) !== frozen.baseAssetHash) throw new Error('该镜头的画面或原图已变更，请重新生成候选。');
      const asset = currentAsset();
      if (asset.path !== verified.path || asset.size !== verified.size) throw new Error('预演候选已变更，请重新查看后应用。');
      const choice = { assetId: asset.id, visualHash: frozen.visualHash } satisfies PreviewChoice;
      if (applied) writeProject({ ...value, shots: value.shots.map(item => item.id === shotId ? { ...item, assetId: asset.id } : item) }, value);
      else store.put('creative-preview-selection', `${previewRootRunId}:${shotId}`, choice);
      store.put('creative-preview-origin', asset.id, choice);
      store.put('creative-preview-application', receiptId, { assetId: asset.id });
      return true;
    }).immediate();
    if (application) changed();
    return { runId: previewRootRunId, shotId };
  }

  function existingReference(assetId: string, version?: number) {
    const asset = store.get<AssetRecord>('asset', assetId);
    if (!asset?.active || asset.kind !== 'image' || asset.projectId || version !== undefined && asset.version !== version) throw new Error('参考图不可用，请重新选择素材库中的图片。');
    return asset;
  }

  async function referenceFor(input: StartInput['reference']): Promise<{ reference?: AssetRecord; styleCard?: CreativeStyleCard }> {
    if ('styleCardId' in input) {
      const styleCard = creativeStyleCardSchema.parse(store.get('creative-style-card', input.styleCardId));
      const asset = store.get<AssetRecord>('asset', styleCard.reference.assetId);
      return { styleCard, ...(asset?.active && asset.version === styleCard.reference.version ? { reference: asset } : {}) };
    }
    if ('assetId' in input) {
      const reference = existingReference(input.assetId);
      await readCreativeReferenceImage(reference);
      return { reference };
    }
    const mimeType = referenceFormats.get(extname(input.path).toLowerCase());
    if (!mimeType) throw new Error('请选择 PNG、JPEG 或 WebP 参考图。');
    await readCreativeReferenceImage({ path: input.path, mimeType });
    const reference = await importImage(input.path);
    await readCreativeReferenceImage(reference);
    return { reference };
  }

  async function begin(input: StartInput, inputHash: string) {
    const plan = executionPlan(input);
    const selected = model(input.modelId);
    if (!selected?.enabled || !selected.capabilities.includes('text')) throw new Error('请选择可用的文本模型。');
    if (!('styleCardId' in input.reference) && !selected.capabilities.includes('vision')) throw new Error('从参考图提取风格需要支持视觉输入的模型。');
    const ids = [...new Set(input.skillIds)], skills = await prepareSkills(ids);
    if (skills.length !== ids.length) throw new Error('选用的 Skill 不存在或已停用，请重新选择。');
    const references = await referenceFor(input.reference);
    const runId = database.transaction(() => {
      const value = newProject({ title: input.title, brief: input.goal, originalText: input.goal, skillIds: ids }, plan?.route === 'style-only');
      return register(value, selected, skills, { goal: input.goal, ...references, ...(plan ? { plan } : {}),
        ...(plan?.route === 'keyframe-preview' ? { previewFollowup: true } : {}),
      }, input.requestId, inputHash);
    }).immediate();
    runCreated(runId);
    return result(runId);
  }

  function start(rawParams: unknown): Promise<CreativePlanningResult> {
    const input = creativePlanningStartInputSchema.parse(rawParams), inputHash = fingerprint({ action: 'start', input });
    const receipt = requestReceipt(input.requestId, inputHash);
    if (receipt) return Promise.resolve(result(receipt.runId));
    const pending = inFlight.get(input.requestId);
    if (pending) {
      if (pending.inputHash !== inputHash) throw new Error('这次创作的请求已用于其他内容，请重新提交。');
      return pending.result;
    }
    const started = begin(input, inputHash).finally(() => inFlight.delete(input.requestId));
    inFlight.set(input.requestId, { inputHash, result: started });
    return started;
  }

  function revisionModel(input: ReviseInput) {
    return 'projectId' in input ? model(input.modelId) : requireRun(input.runId).saved.models[0];
  }

  function requireRevisionProject(projectId: string, revision?: number) {
    const current = project(projectId);
    if (current.archived || projectOccupied(current.id)) throw new Error('请先恢复项目或完成本项目的当前运行。');
    if (revision !== undefined && current.revision !== revision) throw new Error('项目已变更，请打开当前分镜。');
    return current;
  }

  async function beginRevision(input: ReviseInput, inputHash: string) {
    if ('projectId' in input) {
      const current = requireRevisionProject(input.projectId, input.revision);
      creativeRevisionTarget(current.shots, input.scope);
      const script = current.workflow.nodes.find(node => node.kind === 'script');
      const skills = await prepareSkills(script?.skillIds ?? []);
      const id = database.transaction(() => {
        const value = requireRevisionProject(input.projectId, input.revision);
        const selected = model(input.modelId);
        if (!selected?.enabled || !selected.capabilities.includes('text')) throw new Error('请选择可用的文本模型。');
        return register(value, selected, skills, { goal: value.brief || value.title,
          revision: { instruction: input.instruction, shots: value.shots, scope: input.scope, applyDraft: false, projectStyle: value.style },
        }, input.requestId, inputHash);
      }).immediate();
      runCreated(id);
      return result(id);
    }

    const id = database.transaction(() => {
      const { record, saved } = requireRun(input.runId), completed = result(input.runId);
      const previewRootRunId = saved.creativePlanning.previewFollowup ? input.runId : saved.creativePlanning.previewRootRunId;
      if ('scope' in input) {
        if (record.status !== 'succeeded' || !completed.shots) throw new Error('请先完成分镜，再修改镜头。');
        const applied = completed.appliedRevision !== undefined;
        if (!applied && saved.creativePlanning.revision?.scope) throw new Error('请先确认应用当前修改，再继续改稿。');
        const current = requireRevisionProject(record.projectId, applied ? undefined : record.projectRevision);
        const shots = applied ? current.shots : completed.shots;
        const target = creativeRevisionTarget(shots, input.scope);
        if (applied && input.scope.sentenceIndex !== undefined
          && completed.shots.find(shot => shot.id === input.scope.shotId)?.narration !== target.shot.narration) {
          throw new Error('所选镜头的旁白已变更，请在工作台重新选择要修改的句子。');
        }
        const selected = saved.models[0];
        if (!selected || !model(selected.id)?.enabled) throw new Error('原模型已停用，请恢复该连接。');
        const styleCard = completed.styleCard && (!applied || current.style === styleText(completed.styleCard)) ? completed.styleCard : undefined;
        return register(current, selected, saved.skills, { goal: completed.goal, reference: styleCard ? completed.reference : undefined, styleCard, previewRootRunId,
          revision: { instruction: input.instruction, shots, scope: input.scope, applyDraft: !applied, projectStyle: current.style },
        }, input.requestId, inputHash, input.runId);
      }
      if (record.status !== 'succeeded' || !completed.shots || !completed.styleCard) throw new Error('请先完成分镜，再修改第二段。');
      if (saved.creativePlanning.revision?.scope && completed.appliedRevision === undefined) throw new Error('请先确认应用当前修改，再继续改稿。');
      const current = project(record.projectId);
      if (current.archived || projectOccupied(current.id)) throw new Error('请先恢复项目或完成本项目的当前运行。');
      const applied = completed.appliedRevision !== undefined;
      if (applied && (current.style !== styleText(completed.styleCard) || current.shots.length !== CREATIVE_SEGMENT_COUNT
        || current.shots.some((shot, index) => shot.id !== completed.shots![index].id || shot.durationUs !== CREATIVE_SEGMENT_DURATION_US))) {
        throw new Error('分镜范围或风格已在编辑器变更，请在当前分镜中修改。');
      }
      if (!applied && current.revision !== record.projectRevision) throw new Error('项目已变更，请打开当前分镜。');
      const shots = applied ? current.shots : completed.shots;
      if (shots.length !== CREATIVE_SEGMENT_COUNT || shots[1].locked) throw new Error('请确认分镜仍包含三段，且第二段已解锁。');
      const selected = saved.models[0];
      if (!selected || !model(selected.id)?.enabled) throw new Error('原模型已停用，请恢复该连接。');
      return register(current, selected, saved.skills, { goal: completed.goal, reference: completed.reference, styleCard: completed.styleCard, previewRootRunId,
        revision: { instruction: input.instruction, shots } }, input.requestId, inputHash, input.runId);
    }).immediate();
    runCreated(id);
    return result(id);
  }

  function revise(rawParams: unknown): Promise<CreativePlanningResult> {
    const input = creativePlanningReviseInputSchema.parse(rawParams), inputHash = fingerprint({ action: 'revise', input });
    const receipt = requestReceipt(input.requestId, inputHash);
    if (receipt) return Promise.resolve(result(receipt.runId));
    const pending = inFlight.get(input.requestId);
    if (pending) {
      if (pending.inputHash !== inputHash) throw new Error('这次创作的请求已用于其他内容，请重新提交。');
      return pending.result;
    }
    const started = beginRevision(input, inputHash).finally(() => inFlight.delete(input.requestId));
    inFlight.set(input.requestId, { inputHash, result: started });
    return started;
  }

  function apply(rawParams: unknown) {
    const { runId } = runIdInput.parse(rawParams);
    const application = database.transaction(() => {
      const { record, saved } = requireRun(runId), draft = result(runId);
      if (saved.creativePlanning.plan?.route === 'style-only') throw new Error('请选择提取的风格卡来创建分镜。');
      const current = project(record.projectId);
      if (current.archived) throw new Error('请先恢复项目。');
      if (draft.appliedRevision !== undefined) return { project: current, applied: false };
      if (record.status !== 'succeeded' || !draft.shots) throw new Error('请先完成分镜。');
      if (projectOccupied(current.id) || current.revision !== record.projectRevision) throw new Error('项目已变更或正在制作，请打开当前分镜查看。');
      const revision = saved.creativePlanning.revision;
      const scope = revision?.scope;
      if (scope && !revision.applyDraft) {
        const output = z.object({ patch: creativeRevisionPatchSchema(scope) }).parse(store.get('node-result', `${runId}:script`));
        const { shots } = applyCreativeRevisionPatch(current.shots, scope, output.patch);
        const value = writeProject({ ...current, shots }, current);
        store.put('creative-planning-application', runId, { revision: value.revision });
        return { project: value, applied: true };
      }
      if (!draft.styleCard) throw new Error('本次分镜缺少风格卡，请打开创作记录核对。');
      const previewRootRunId = saved.creativePlanning.previewFollowup ? runId : saved.creativePlanning.previewRootRunId;
      const previewRunId = previewRootRunId ? undefined : saved.creativePlanning.plan ? runId : !current.shots.length ? record.parentRunId : undefined;
      if (previewRunId) {
        const plan = saved.creativePlanning.plan ?? store.get<RunSnapshot>('run-snapshot', previewRunId)?.creativePlanning?.plan;
        if (plan?.route === 'keyframe-preview') {
          const frames = previewAssets(previewRunId);
          if (frames?.length !== plan.keyframeShots.length || frames.some(frame => {
            const asset = store.get<AssetRecord>('asset', frame.id);
            return !asset?.active || asset.version !== frame.version || asset.sha256 !== frame.sha256;
          })) throw new Error('本次预演素材已变更或移除，请恢复素材后再应用。');
        }
      }
      const workflow = current.workflow, production = workflow.production;
      const shots = previewRootRunId ? withDraftFrames(previewRootRunId, draft.shots) : draft.shots;
      const next: ProjectDocument = record.parentRunId && !scope && current.shots.length ? { ...current, shots } : {
        ...current, shots, style: styleText(draft.styleCard), workflow: { ...workflow, production: { ...production,
          manualPlanningSteps: ['brief', 'style', 'script'],
          manualPlanningFields: { ...production.manualPlanningFields, style: styleFields(draft.styleCard) },
        } },
      };
      const value = writeProject(next, current);
      store.put('creative-planning-application', runId, { revision: value.revision });
      if (previewRootRunId && previewRootRunId !== runId && !store.get('creative-planning-application', previewRootRunId)) {
        store.put('creative-planning-application', previewRootRunId, { revision: value.revision });
      }
      return { project: value, applied: true };
    }).immediate();
    if (application.applied) changed();
    return application.project;
  }

  async function get(rawParams: unknown) {
    const { runId } = runIdInput.parse(rawParams);
    const draft = result(runId);
    if (!['needs_attention', 'failed', 'waiting_review'].includes(draft.status)) return draft;
    const inspection = await inspectRun(runId);
    return { ...result(runId), failedNodeId: inspection.steps.find(step => step.retry?.allowed)?.id,
      resumeAllowed: inspection.recovery.resume, recoveryReason: inspection.recovery.reason || undefined };
  }

  return { list, styleCards, captureStyleCard, capturePreviewAssets, executionPlan, previewQuote, previewProject, previewSource, revisionModel,
    hasRequest: (id: string) => Boolean(store.get('creative-planning-request', id)), get, start, startPreview, applyPreview, revise, apply };
}

function styleFields(card: CreativeStyleCard): CreativeStyleCard['fields'] {
  const swatches = card.swatches.map(({ label, hex }) => `${label} ${hex}`).join('、');
  return { ...card.fields, palette: [swatches, card.fields.palette].filter(Boolean).join('\n').slice(0, 2000) };
}

function styleText(card: CreativeStyleCard) { return formatPlanningDocument('style', styleFields(card)); }
