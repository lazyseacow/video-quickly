import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  creativeContextSchema, isCreativeReferenceAsset, MAX_DIRECTOR_SCREENPLAY_LENGTH, MAX_NOVEL_SOURCE_LENGTH,
  novelAdaptationStartInputSchema, novelAdaptationStepSchema, novelCharacterAssetsSchema, sameJsonContent,
  shotSchema, workflowNodeSchema, type AssetRecord, type CharacterProfile, type CreativeContext, type JsonValue,
  type ModelProfile, type NovelAdaptationState, type NovelAdaptationStep, type NovelCharacterAsset, type ProjectDocument,
  type RunRecord, type SkillPackage, type VoiceProfile, type WorkflowNode,
} from '@video-quickly/contracts';
import { fingerprint } from './activities.js';
import type { DocumentStore } from './database.js';
import type { RunSnapshot } from './run-snapshot.js';
import { STORYBOARD_BATCH_SIZE } from './storyboard-generation.js';
import { storyboardVideoModel } from './workflow-prompts.js';
import { WORKFLOW_OUTPUT_VERSION } from './workflow-outputs.js';

const projectInput = z.strictObject({ projectId: z.string().min(1) });
const editInput = projectInput.extend({ revision: z.number().int().nonnegative() });
const sourceInput = editInput.extend({ source: z.string().max(MAX_NOVEL_SOURCE_LENGTH) });
const approveInput = editInput.extend({ screenplay: z.string().trim().min(1).max(MAX_DIRECTOR_SCREENPLAY_LENGTH) });
const rolesInput = editInput.extend({ characters: novelCharacterAssetsSchema });
const documentKind = 'novel-adaptation';
const requestKind = 'novel-adaptation-request';
export const novelProductionBlockedMessage = '请在「小说改编」审核导演剧本、确认角色资产并应用分镜后再开始制作。';

const screenplayPrompt = [
  '将本集小说原文改写成可直接拍摄的中文导演剧本。以原文为叙事依据，保留人物关系、关键因果与时间线。把无法直接拍摄的心理活动转为具体动作、表情、对白或画外音。',
  '按场次写明场次编号、内景或外景、地点、时间、实际出镜人物、动作和对白。明确说话者、画外音与旁白，保持角色姓名一致。场次顺序应体现冲突和转折。',
  '输出供用户编辑和审核的导演剧本文字。仅返回包含 text 字段的 JSON，text 内保留可读的段落与场次标题。',
].join('\n');
const characterPrompt = [
  '从审核通过的导演剧本提取本集需要视觉资产的出镜角色。仅在旁白提及或只在画外发声的名字无需视觉资产。合并同一角色的别名和称谓。',
  '每个角色返回稳定的英文小写 key、剧本姓名 name、人物设定 description 和可直接用于定妆图的 visualPrompt。描述服装发型、体貌、可辨认特征、角色身份及本集画风，保持导演剧本设定。无出镜角色时返回空数组。',
].join('\n');
const storyboardPrompt = [
  '拆解审核通过的导演剧本。保持场次顺序、实际出镜人物、动作、对白、画外音与旁白的归属。将可拍摄的动作拆成有明确景别、机位、动作节拍、时长和声音要求的镜头。',
  '已确认的角色资产是本集出镜人物的来源。用 entityKeys 引用镜头实际出镜的角色，并保持原有角色设定。仅提及或在画外发声的角色不作为视觉引用。大纲可补充场景和道具设定。',
].join('\n');

interface AdaptationDraft {
  projectId: string;
  revision: number;
  source: string;
  approvedScreenplay?: string;
  appliedCharacters?: NovelCharacterAsset[];
  appliedStoryboard?: string;
  runs: Partial<Record<NovelAdaptationStep, string>>;
}

interface ProjectProfiles {
  characters: CharacterProfile[];
  assets: AssetRecord[];
  voices: VoiceProfile[];
  voiceAssets: AssetRecord[];
}

interface Options {
  database: Database.Database;
  store: DocumentStore;
  project(id: string): ProjectDocument;
  writeProject(value: ProjectDocument, baseline: ProjectDocument): ProjectDocument;
  run(id: string): RunRecord;
  projectOccupied(id: string): boolean;
  availableModels(): ModelProfile[];
  prepareSkills(ids: string[]): Promise<SkillPackage[]>;
  profilesFor(project: ProjectDocument): ProjectProfiles;
  validateReferences(assets: AssetRecord[]): void;
  validateReferenceFiles(assets: AssetRecord[]): Promise<void>;
  onRunCreated(id: string): void;
  changed(): void;
}

export function createNovelAdaptation(options: Options) {
  const { database, store, project, writeProject, run, projectOccupied, availableModels, prepareSkills, profilesFor, validateReferences, validateReferenceFiles, onRunCreated, changed } = options;
  const runInstruction = database.prepare<[string], { instruction: string | null }>(
    "SELECT json_extract(body, '$.novelAdaptation.instruction') AS instruction FROM documents WHERE kind = 'run-snapshot' AND id = ?",
  );

  function empty(value: ProjectDocument, source = ''): AdaptationDraft {
    return { projectId: value.id, revision: 0, source, runs: {} };
  }

  function draftFor(value: ProjectDocument) {
    return store.get<AdaptationDraft>(documentKind, value.id)
      ?? (value.workflow.production.novelAdaptation ? empty(value) : undefined);
  }

  function read(projectId: string) {
    const value = project(projectId), draft = draftFor(value);
    if (!draft) throw new Error('这集未使用小说改编流程。');
    return { value, draft };
  }

  function initialize(value: ProjectDocument, source = '') {
    const input = sourceInput.shape.source.parse(source);
    if (value.workflow.production.novelAdaptation) store.put(documentKind, value.id, empty(value, input));
  }

  function loadOutput(draft: AdaptationDraft, step: NovelAdaptationStep) {
    const id = draft.runs[step];
    const record = id ? run(id) : undefined;
    if (record?.status !== 'succeeded') return;
    return store.get<JsonValue>('node-result', `${id}:${stepNodeId[step]}`);
  }

  function approved(value: ProjectDocument, draft: AdaptationDraft) {
    return Boolean(draft.approvedScreenplay && draft.approvedScreenplay === value.originalText);
  }

  function hasAppliedStoryboard(value: ProjectDocument, draft: AdaptationDraft) {
    return approved(value, draft) && Boolean(draft.appliedCharacters && draft.appliedStoryboard && value.shots.length
      && value.workflow.production.manualPlanningSteps?.includes('script'));
  }

  function state(value: ProjectDocument, draft: AdaptationDraft): NovelAdaptationState {
    const runs: NovelAdaptationState['runs'] = {};
    for (const step of novelAdaptationStepSchema.options) {
      const id = draft.runs[step];
      if (!id) continue;
      const { status, error } = run(id);
      const instruction = runInstruction.get(id)?.instruction;
      runs[step] = { id, nodeId: stepNodeId[step], status, error, ...(instruction ? { instruction } : {}) };
    }
    const screenplay = screenplayOutput.safeParse(loadOutput(draft, 'screenplay'));
    const extracted = characterOutput.safeParse(loadOutput(draft, 'characters'));
    const approvedScreenplay = approved(value, draft), appliedStoryboard = hasAppliedStoryboard(value, draft);
    const storyboard = appliedStoryboard ? undefined : storyboardOutput.safeParse(loadOutput(draft, 'storyboard'));
    return { projectId: value.id, projectRevision: value.revision, revision: draft.revision, source: draft.source, runs,
      screenplay: { text: draft.approvedScreenplay ?? (screenplay.success ? screenplay.data.text : ''), approved: approvedScreenplay },
      characters: { items: draft.appliedCharacters ?? (extracted.success ? extracted.data.characters : []), applied: approvedScreenplay && draft.appliedCharacters !== undefined },
      storyboard: { shots: appliedStoryboard ? value.shots : storyboard?.success ? storyboard.data.shots : [], applied: appliedStoryboard },
    };
  }

  function get(raw: unknown) {
    const { value, draft } = read(projectInput.parse(raw).projectId);
    return state(value, draft);
  }

  function edit(data: z.infer<typeof editInput>) {
    const { value, draft } = read(data.projectId);
    if (value.archived) throw new Error('请先恢复项目。');
    if (draft.revision !== data.revision) throw new Error('本集改编内容已更新，请重新打开后继续。');
    if (projectOccupied(value.id)) throw new Error('该项目有任务正在执行，请等待完成或停止后继续。');
    return { value, draft };
  }

  function update<Result>(perform: () => Result) {
    const result = database.transaction(perform).immediate();
    changed();
    return result;
  }

  function save(value: ProjectDocument, draft: AdaptationDraft) {
    const next = { ...draft, revision: draft.revision + 1 };
    store.put(documentKind, value.id, next);
    return state(value, next);
  }

  function saveSource(raw: unknown) {
    const input = sourceInput.parse(raw);
    return update(() => {
      const { value, draft } = edit(input);
      return input.source === draft.source ? state(value, draft)
        : save(value, { ...empty(value, input.source), revision: draft.revision });
    });
  }

  function approve(raw: unknown) {
    const input = approveInput.parse(raw);
    return update(() => {
      const { value, draft } = edit(input);
      if (!screenplayOutput.safeParse(loadOutput(draft, 'screenplay')).success) throw new Error('请先生成导演剧本。');
      if (approved(value, draft) && draft.approvedScreenplay === input.screenplay) return state(value, draft);
      const saved = value.originalText === input.screenplay ? value : writeProject({ ...value, originalText: input.screenplay }, value);
      const next = { ...draft, approvedScreenplay: input.screenplay, appliedCharacters: undefined, appliedStoryboard: undefined,
        runs: { screenplay: draft.runs.screenplay } };
      return save(saved, next);
    });
  }

  async function applyCharacters(raw: unknown) {
    const input = rolesInput.parse(raw);
    const initial = edit(input);
    if (!approved(initial.value, initial.draft) || !loadOutput(initial.draft, 'characters')) throw new Error('请先审核导演剧本并提取角色资产。');
    const references = roleImages(initial.value, input.characters);
    if (references.length) await validateReferenceFiles(references);
    return update(() => {
      const { value, draft } = edit(input);
      if (!approved(value, draft) || !loadOutput(draft, 'characters')) throw new Error('请先审核导演剧本并提取角色资产。');
      validateReferences(references);
      if (sameJsonContent(draft.appliedCharacters, input.characters)) return state(value, draft);
      return save(value, { ...draft, appliedCharacters: input.characters, appliedStoryboard: undefined,
        runs: { screenplay: draft.runs.screenplay, characters: draft.runs.characters } });
    });
  }

  function roleImages(value: ProjectDocument, roles: NovelCharacterAsset[]) {
    const creativeContext = roleContext(value, roles);
    const ids = new Set(roles.flatMap(role => role.referenceAssetIds ?? []));
    const assets = Array.from(ids, id => store.get<AssetRecord>('asset', id));
    if (!assets.every(asset => isCreativeReferenceAsset({ ...value, creativeContext }, asset))) {
      throw new Error('角色参考图缺失或不可用于本集，请重新选择。');
    }
    return assets;
  }

  async function applyStoryboard(raw: unknown) {
    const input = editInput.parse(raw);
    const initial = edit(input);
    if (!approved(initial.value, initial.draft) || !initial.draft.appliedCharacters) throw new Error('请先审核导演剧本并确认角色资产。');
    const references = roleImages(initial.value, initial.draft.appliedCharacters);
    if (references.length) await validateReferenceFiles(references);
    return update(() => {
      const { value, draft } = edit(input);
      if (!approved(value, draft) || !draft.appliedCharacters) throw new Error('请先审核导演剧本并确认角色资产。');
      const output = storyboardOutput.safeParse(loadOutput(draft, 'storyboard'));
      const id = draft.runs.storyboard;
      if (!id || !output.success) throw new Error('请先生成分镜。');
      if (draft.appliedStoryboard === id && hasAppliedStoryboard(value, draft)) return state(value, draft);
      if (run(id).projectRevision !== value.revision) throw new Error('生成后项目已修改，请基于最新项目重新生成分镜。');
      const { workflow } = value;
      const manualPlanningSteps = [...new Set([...(workflow.production.manualPlanningSteps ?? []), 'script' as const])];
      validateReferences(references);
      const saved = writeProject({ ...value, shots: output.data.shots,
        creativeContext: output.data.creativeContext ?? roleContext(value, draft.appliedCharacters),
        workflow: { ...workflow, production: { ...workflow.production, manualPlanningSteps } },
      }, value);
      return save(saved, { ...draft, appliedStoryboard: id });
    });
  }

  function modelFor(input: z.infer<typeof novelAdaptationStartInputSchema>) {
    const models = availableModels(), model = models.find(item => item.id === input.modelId);
    if (!model?.enabled || !model.capabilities.includes('text')) throw new Error('请选择可用的文本模型。');
    return { model, models };
  }

  function validateStep(value: ProjectDocument, draft: AdaptationDraft, step: NovelAdaptationStep) {
    if (!draft.source.trim()) throw new Error('请输入本集小说原文。');
    if (step !== 'screenplay' && !approved(value, draft)) throw new Error('请先审核通过导演剧本。');
    if (step === 'storyboard' && !draft.appliedCharacters) throw new Error('请先确认本集角色资产。');
  }

  function quote(input: z.infer<typeof novelAdaptationStartInputSchema>) {
    const { value, draft } = edit(input);
    validateStep(value, draft, input.step);
    return modelFor(input).model;
  }

  function previousRequest(input: z.infer<typeof novelAdaptationStartInputSchema>, inputHash: string) {
    const receipt = store.get<{ inputHash: string }>(requestKind, input.requestId);
    if (!receipt) return;
    if (receipt.inputHash !== inputHash) throw new Error('改编请求标识已用于其他输入，请重新提交。');
    return get({ projectId: input.projectId });
  }

  function revisionReference(value: ProjectDocument, draft: AdaptationDraft, step: NovelAdaptationStep) {
    if (step === 'screenplay') {
      const previous = screenplayOutput.safeParse(loadOutput(draft, step));
      return draft.approvedScreenplay ?? previous.data?.text;
    }
    if (step === 'characters') {
      const previous = characterOutput.safeParse(loadOutput(draft, step));
      const characters = draft.appliedCharacters ?? previous.data?.characters;
      return characters?.map(({ key, name, description, visualPrompt }) =>
        `${name}（${key}）｜人物设定：${excerpt(description, 240)}｜定妆提示：${excerpt(visualPrompt, 360)}`,
      ).join('\n');
    }
    const previous = storyboardOutput.safeParse(loadOutput(draft, step));
    const shots = hasAppliedStoryboard(value, draft) ? value.shots : previous.data?.shots;
    return shots?.map(({ title, narration, visualPrompt, soundPrompt, durationUs }, index) =>
      `第 ${index + 1} 镜 ${title}（${durationUs / 1_000_000} 秒）｜台词：${excerpt(narration, 160)}｜画面：${excerpt(visualPrompt, 320)}${soundPrompt ? `｜声音：${excerpt(soundPrompt, 120)}` : ''}`,
    ).join('\n');
  }

  async function start(raw: unknown) {
    const input = novelAdaptationStartInputSchema.parse(raw), inputHash = fingerprint(input);
    const previous = previousRequest(input, inputHash);
    if (previous) return previous;
    const quoted = quote(input);
    const skillIds = input.skillIds ? [...new Set(input.skillIds)] : undefined;
    const { value, draft: baseline } = read(input.projectId);
    const screenplayNode = value.workflow.nodes.find(node => node.config.documentRole === 'screenplay');
    const roleNode = value.workflow.nodes.find(node => node.config.documentRole === 'novel-characters');
    const scriptNode = value.workflow.nodes.find(node => node.id === 'script' && node.kind === 'script');
    const stepSkills = input.step === 'storyboard' ? scriptNode?.skillIds
      : input.step === 'characters' && roleNode?.skillIds.length ? roleNode.skillIds : screenplayNode?.skillIds;
    const selected = skillIds ?? stepSkills ?? [];
    const references = input.step === 'storyboard' ? roleImages(value, baseline.appliedCharacters ?? []) : [];
    const [skills] = await Promise.all([prepareSkills(selected), references.length ? validateReferenceFiles(references) : undefined]);
    if (skills.length !== selected.length) throw new Error('选用的 Skill 不存在或已停用，请重新选择。');
    const repeated = previousRequest(input, inputHash);
    if (repeated) return repeated;
    const result = update(() => {
      const { value: current, draft } = edit(input);
      validateStep(current, draft, input.step);
      const { model, models } = modelFor(input);
      if (value.revision !== current.revision || !sameJsonContent(quoted, model)) throw new Error('制作设置或文本模型已修改，请重新确认生成。');
      const revision = input.instruction ? {
        instruction: input.instruction, previous: revisionReference(current, draft, input.step),
      } : undefined;
      const node = generationNode(input.step, model, selected, revision);
      const storyboard = input.step === 'storyboard';
      const frozen = storyboard ? { ...current, creativeContext: roleContext(current, draft.appliedCharacters ?? []) } : current;
      validateReferences(references);
      const profiles = profilesFor(frozen);
      const videoModel = storyboard ? storyboardVideoModel(frozen, models) : undefined;
      const snapshot: RunSnapshot = {
        project: frozen, nodes: [node], models: [model, ...(videoModel && videoModel.id !== model.id ? [videoModel] : [])],
        skills, handlerVersion: 2, outputContractVersion: WORKFLOW_OUTPUT_VERSION, includeProjectOriginalText: true, unifiedShotProfile: true,
        characters: profiles.characters, characterAssets: profiles.assets, voices: profiles.voices, voiceAssets: profiles.voiceAssets,
        novelAdaptation: { step: input.step, ...(input.step === 'screenplay' ? { source: draft.source } : {}),
          ...(input.instruction ? { instruction: input.instruction } : {}) },
        selection: { nodeId: node.id, mode: 'node' }, ...(storyboard ? { storyboardBatchSize: STORYBOARD_BATCH_SIZE } : {}),
      };
      const id = randomUUID(), timestamp = new Date().toISOString();
      const record: RunRecord = {
        id, projectId: current.id, projectRevision: current.revision, workflowVersion: current.workflow.version, snapshotDigest: fingerprint(snapshot),
        purpose: 'novel-adaptation', selection: snapshot.selection, stepCount: 1, status: 'queued', createdAt: timestamp, updatedAt: timestamp, events: [], activities: [],
      };
      const next = input.step === 'screenplay'
        ? { ...empty(current, draft.source), revision: draft.revision, runs: { screenplay: id } }
        : input.step === 'characters' ? { ...draft, appliedCharacters: undefined, appliedStoryboard: undefined, runs: { screenplay: draft.runs.screenplay, characters: id } }
          : { ...draft, appliedStoryboard: undefined, runs: { ...draft.runs, storyboard: id } };
      store.put('run-snapshot', id, snapshot);
      store.put('run', id, record);
      store.put(requestKind, input.requestId, { inputHash, runId: id });
      return { id, state: save(current, next) };
    });
    onRunCreated(result.id);
    return result.state;
  }

  function blockProduction(value: ProjectDocument) {
    const draft = draftFor(value);
    return Boolean(draft && !hasAppliedStoryboard(value, draft));
  }

  function forBackup(value: ProjectDocument) {
    const draft = draftFor(value);
    if (!draft) return;
    const { source, screenplay, characters, storyboard } = state(value, draft);
    return { source, screenplay, characters, storyboard };
  }

  function assetsInUse(ids: readonly string[]) {
    if (!ids.length) return new Set<string>();
    const rows = database.prepare<[string, string], { id: string }>(`
      SELECT DISTINCT reference.value AS id
      FROM documents AS adaptation, json_each(adaptation.body, '$.appliedCharacters') AS role, json_each(role.value, '$.referenceAssetIds') AS reference
      WHERE adaptation.kind = ? AND reference.value IN (SELECT value FROM json_each(?))
    `).all(documentKind, JSON.stringify(ids));
    return new Set(rows.map(row => row.id));
  }

  function assertCurrentRun(record: RunRecord, snapshot: RunSnapshot | undefined) {
    const step = snapshot?.novelAdaptation?.step;
    if (!step) return;
    const { value, draft } = read(record.projectId);
    if (value.archived || draft.runs[step] !== record.id) throw new Error('这次改编已失效，请从当前步骤重新生成。');
    validateStep(value, draft, step);
  }

  return { initialize, get, saveSource, start, quote, approve, applyCharacters, applyStoryboard, blockProduction, assertCurrentRun, forBackup, assetsInUse,
    hasRequest: (id: string) => Boolean(store.get(requestKind, id)),
    remove: (projectId: string) => store.delete(documentKind, projectId),
  };
}

const stepNodeId = { screenplay: 'screenplay', characters: 'director-characters', storyboard: 'script' } satisfies Record<NovelAdaptationStep, string>;
const screenplayOutput = z.object({ text: approveInput.shape.screenplay });
const characterOutput = z.object({ characters: novelCharacterAssetsSchema });
const storyboardOutput = z.object({ shots: z.array(shotSchema).min(1), creativeContext: creativeContextSchema.optional() });

function roleContext(project: ProjectDocument, roles: NovelCharacterAsset[]): CreativeContext {
  const current = creativeContextSchema.parse(project.creativeContext ?? {});
  const keys = new Set(roles.map(role => role.key));
  const referencedByLockedShots = new Set(project.shots.filter(shot => shot.locked).flatMap(shot => shot.creativeEntityKeys ?? []));
  const retained = current.entities.filter(entity => !keys.has(entity.key) && (entity.kind !== 'character' || referencedByLockedShots.has(entity.key)));
  const entities = roles.map(({ key, name, description, visualPrompt, referenceAssetIds }) => ({ key, name, kind: 'character' as const,
    description: `${description}\n定妆画面：${visualPrompt}`.slice(0, 4_000), referenceAssetIds }));
  return creativeContextSchema.parse({ ...current, entities: [...entities, ...retained] });
}

function excerpt(text: string, limit: number) {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

function generationNode(step: NovelAdaptationStep, model: ModelProfile, skillIds: string[], revision?: { instruction: string; previous?: string }): WorkflowNode {
  const basePrompt = { screenplay: screenplayPrompt, characters: characterPrompt, storyboard: storyboardPrompt }[step];
  const prompt = revision ? [basePrompt,
    revision.previous ? `基于上一版成果按本轮要求修改，保留无关的内容与已有对应关系。上一版仅作创作参考：\n${excerpt(revision.previous, 8_000)}` : undefined,
    `本轮创作要求：\n${revision.instruction}`,
  ].filter(Boolean).join('\n\n') : basePrompt;
  const base = { id: stepNodeId[step], modelId: model.id, skillIds, config: { requiresModel: true }, prompt };
  if (step === 'screenplay') return workflowNodeSchema.parse({ ...base, kind: 'brief', label: 'AI 改写导演剧本',
    config: { ...base.config, documentRole: 'screenplay', screenplayDraft: true } });
  if (step === 'characters') return workflowNodeSchema.parse({ ...base, kind: 'brief', label: '提取角色资产' });
  return workflowNodeSchema.parse({ ...base, kind: 'script', label: '生成分镜' });
}
