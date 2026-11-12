import { z } from 'zod';
import { creativeCharacterBindings, MAX_STORYBOARD_SHOTS, projectCharacterIds, shotSchema, stripVisualPromptOutputSpecs, sumProviderUsage, type CharacterProfile, type ProjectDocument, type ProviderUsage, type Shot, type StoryboardPart } from '@video-quickly/contracts';
import type { GithubTrendingRanking } from '@video-quickly/integrations/research';
import type Database from 'better-sqlite3';
import { fingerprint, type ActivityJournal, type ActivitySafety } from './activities.js';
import { validateGithubTrendingStoryboard } from './github-trending.js';
import { ModelResponseValidationError, parseModelJson, responseIssues, type createModelResponses } from './model-responses.js';
import { textIncompleteMessage, type TextGenerationResult } from './providers.js';
import type { createRunProgress } from './run-progress.js';
import { storyboardOutputContract, storyboardOutputSchema, type WorkflowOutputVersion } from './workflow-outputs.js';
import { materializeStoryboardBatch, mergeStoryboardEntities, storyboardPlacements, UNKNOWN_CHARACTER_KEY_MESSAGE, type StoryboardPromptStage } from './workflow-prompts.js';

export const STORYBOARD_BATCH_SIZE = 5;
const outlineShotSchema = z.strictObject({
  id: z.string().min(1).optional(), title: shotSchema.shape.title, beat: z.string().trim().min(1).max(160),
  repositories: z.array(z.string().min(1).max(240)).max(MAX_STORYBOARD_SHOTS).optional(),
});
const outlineSchema = z.strictObject({
  outline: z.string().trim().min(1).max(1200),
  shots: z.array(outlineShotSchema).min(1).max(MAX_STORYBOARD_SHOTS),
  entities: storyboardOutputSchema.shape.entities,
});
const outlineJsonSchema = z.toJSONSchema(outlineSchema, { io: 'input' });
type Outline = z.infer<typeof outlineSchema>;

function partActivityId(nodeId: string, part: StoryboardPart) {
  return `${nodeId}:storyboard:${part.kind === 'outline' ? 'outline' : part.index}`;
}

export function storyboardResponseId(runId: string, nodeId: string, part?: StoryboardPart) {
  return `${runId}:${part ? partActivityId(nodeId, part) : nodeId}`;
}

export function canRevalidateStoryboardBatch(project: ProjectDocument, responses: ReturnType<typeof createModelResponses>, responseId: string): boolean {
  if (projectCharacterIds(project).length) return false;
  const receipt = responses.current(responseId);
  const issue = receipt?.issues?.length === 1 ? receipt.issues[0] : undefined;
  return receipt?.status === 'received' && !!receipt.response && !receipt.response.incomplete
    && issue?.message === UNKNOWN_CHARACTER_KEY_MESSAGE && /^shots\[\d+\]\.characterKeys\[\d+\]$/.test(issue.path);
}

export function storyboardOutlineStage(project: ProjectDocument, hasRanking: boolean, automaticCasting = false): StoryboardPromptStage {
  return {
    shots: project.shots.map(shot => ({ ...shot, narration: shot.narration.slice(0, 160), visualPrompt: shot.visualPrompt.slice(0, 160), soundPrompt: undefined })),
    contract: [
      '分镜生成阶段：全片大纲。',
      '只返回合法 JSON 对象。outline 写全片的叙事主线、起承转合和连续性。shots 按最终播放顺序列出 1–100 个镜头。明确指定镜头数时按要求列出，每项只写 title 和简短的叙事要点 beat，详细旁白与画面在下一阶段填写。',
      '沿用已有镜头可填写其原 id，未填则按原位置匹配。新镜头省略 id。锁定镜头必须留在原位置。entities 只列全片需要新增的人物、场景或道具设定，后续各批共同使用。',
      ...(automaticCasting ? ['根据完整剧本识别反复出镜的人物。角色白名单中已有的人物沿用对应角色；其他人物在 entities 中以 kind=character 建立统一设定。把名字、别名和称谓指向同一个人物 key，name 优先用剧本中的明确姓名，description 固定面貌、发型、体型和代表服装。只在画面中实际出现的人物才算出镜。'] : []),
      hasRanking ? '将榜单中的完整仓库名按原榜单顺序各分配一次到相应镜头的 repositories 数组。过渡镜头可以省略 repositories。' : '常规大纲省略 repositories。',
      `机器校验的 JSON Schema：${JSON.stringify(outlineJsonSchema)}`,
    ].join('\n'),
  };
}

function checkOutline(outline: Outline, project: ProjectDocument, ranking?: GithubTrendingRanking) {
  storyboardPlacements(project.shots, outline.shots);
  const creativeContext = mergeStoryboardEntities(project.creativeContext, outline.entities);
  const repositories = outline.shots.flatMap(shot => shot.repositories ?? []);
  const expected = ranking?.repositories ?? [];
  if (repositories.length !== expected.length || repositories.some((name, index) => name.toLowerCase() !== expected[index].name.toLowerCase())) {
    throw new ModelResponseValidationError([{ path: 'shots', message: '请按榜单顺序将每个完整仓库名分配到一个镜头。' }]);
  }
  return { ...outline, creativeContext };
}

function batchStage(plan: Outline, offset: number, count: number, part: Extract<StoryboardPart, { kind: 'batch' }>, shots: StoryboardPromptStage['shots'], jsonSchema: Record<string, unknown>, options: { structured: boolean; previousVisual?: string; automaticCasting?: boolean }): StoryboardPromptStage {
  const { structured, previousVisual, automaticCasting } = options;
  return {
    shots,
    contract: [
      `分镜生成阶段：第 ${part.index}/${part.batches} 批镜头。`,
      `全片大纲（共 ${plan.shots.length} 个镜头）：${plan.outline}`,
      offset > 0 ? `上一个镜头要点：${plan.shots[offset - 1].beat}` : '',
      previousVisual ? `前一镜已校验的画面资料：${JSON.stringify(previousVisual)}` : '',
      `本批镜头计划：${JSON.stringify(plan.shots.slice(offset, offset + count).map((shot, index) => ({ ...shot, number: offset + index + 1 })))}`,
      offset + count < plan.shots.length ? `下一个镜头要点：${plan.shots[offset + count].beat}` : '',
      `只返回合法 JSON 对象 {"shots":[…]}，严格按给定顺序返回这 ${count} 个镜头。每个镜头沿用计划的 number，只填写本批。已有镜头可使用对应 id，新镜头省略 id。`,
      `每项包含 title、narration、${structured ? 'initialFrame、characterPositions、actionTimeline' : 'visualPrompt'}、durationUs，可提供 soundPrompt。时长用整数微秒，台词匹配单镜头时长。画面描述明确主体、动作、景别、构图和光线，沿用全片风格。用 characterKeys 引用角色白名单，无人出镜时用 []；用 entityKeys 引用已定稿的文字设定。按本批分配的 repositories 在对应旁白写出完整仓库名。`,
      automaticCasting ? '每个实际出镜的反复出现人物都要绑定。已选角色填写 characterKeys，其余人物填写全片大纲中对应的 entityKeys。即使镜头使用别名或只拍侧脸、背影，也引用同一人物；旁白提及但未出镜的人物省略。' : '',
      `机器校验的 JSON Schema：${JSON.stringify(jsonSchema)}`,
    ].filter(Boolean).join('\n'),
  };
}

type StoryboardPromptBuilder = (legacyPlanningProfile?: boolean) => string;

interface PartRequest {
  operationId: string;
  attempt: number;
  prompt: string;
  outputSchema: Record<string, unknown>;
  outputSchemaName: string;
}

interface StoryboardExecution {
  journal: ActivityJournal;
  responses: ReturnType<typeof createModelResponses>;
  progress: ReturnType<typeof createRunProgress>;
  runId: string;
  nodeId: string;
  inputHash: string;
  batchSize: number;
  project: ProjectDocument;
  characters: CharacterProfile[];
  ranking?: GithubTrendingRanking;
  signal: AbortSignal;
  safety: ActivitySafety;
  outlinePrompt: StoryboardPromptBuilder;
  outputContractVersion?: WorkflowOutputVersion;
  automaticCasting?: boolean;
  batchPrompt: (stage: StoryboardPromptStage, context: ProjectDocument['creativeContext'], repositories: GithubTrendingRanking['repositories']) => StoryboardPromptBuilder;
  canRetryWithPromptFormat: (response: TextGenerationResult) => boolean;
  request: (request: PartRequest) => Promise<string | TextGenerationResult>;
}

type PartResult<T> = { data: T; usage?: ProviderUsage };

export async function executeStoryboard(options: StoryboardExecution) {
  const { journal, responses, progress, runId, nodeId, project, characters, ranking, batchSize } = options;
  const progressId = `${runId}:${nodeId}`;
  const hasCharacterBindings = projectCharacterIds(project).length > 0;
  async function executePart<P, T>(part: StoryboardPart, label: string, buildPrompt: StoryboardPromptBuilder, request: Pick<PartRequest, 'outputSchema' | 'outputSchemaName'>, schema: z.ZodType<P>, validate: (payload: P) => T, batch?: { completed: number; total: number; count: number }) {
    options.signal.throwIfAborted();
    const id = partActivityId(nodeId, part);
    const previous = journal.get(runId, id);
    if (previous?.status !== 'completed') progress.storyboard(progressId, part, batch?.completed, batch?.total);
    const prompt = buildPrompt();
    const currentInput = { parent: options.inputHash, prompt, outputSchema: request.outputSchema };
    // Older batch receipts hashed the prompt with project output settings attached.
    const input = previous && previous.input_hash !== fingerprint(currentInput) ? { ...currentInput, prompt: buildPrompt(true) } : currentInput;
    return journal.execute<PartResult<T>>(runId, id, input, options.safety, async ({ operationId, recordRemoteId }) => {
      // Apply the guidance only at dispatch so existing activity and response hashes still match.
      const characterGuidance = part.kind === 'batch' && !hasCharacterBindings
        ? '\n\n本次角色库白名单为空，每个镜头的 characterKeys 都填 []。剧情人物的外观与动作写在画面描述中。引用已定稿的文字人物设定时，将对应 key 填入 entityKeys。' : '';
      const inputHash = fingerprint(input);
      const generate = () => responses.generate({
        operationId, inputHash, recordReceipt: recordRemoteId,
        generate: () => {
          const issues = responses.retryIssues(operationId);
          const correction = issues?.length ? `\n\n上次${label}返回的字段校验错误：${JSON.stringify(issues)}\n请修正并返回本部分的完整 JSON 对象。` : '';
          return options.request({ ...request, operationId, attempt: responses.attempt(operationId), prompt: prompt + correction + characterGuidance });
        },
      });
      let generated = await generate();
      if (options.canRetryWithPromptFormat(generated)) {
        options.signal.throwIfAborted();
        const retry = journal.database.transaction(() => {
          const receipt = responses.current(operationId);
          // A saved failure is handled by the explicit retry path.
          if (receipt?.status !== 'received' || receipt.issues?.length) return false;
          responses.validationFailed(operationId, [{ path: '$', message: '结构化请求未返回正文，已安排使用提示词约束重试。' }]);
          return Boolean(responses.prepareRetry(operationId));
        })();
        if (retry) generated = await generate();
      }
      progress.phase(progressId, 'validating', true);
      try {
        if (generated.incomplete) {
          const reason = generated.incompleteReason ?? 'unknown';
          const message = part.kind === 'batch' && reason === 'max_output_tokens'
            ? '本批已达到 Token 上限，请重试此批。'
            : textIncompleteMessage(reason, 'storyboard');
          throw new ModelResponseValidationError([{ path: '$', message }], label);
        }
        return { data: validate(schema.parse(parseModelJson(generated.text, label))), usage: generated.usage };
      } catch (error) {
        const issues = error instanceof z.ZodError ? responseIssues(error) : error instanceof ModelResponseValidationError ? error.issues : undefined;
        if (!issues) throw error;
        responses.validationFailed(operationId, issues);
        throw new ModelResponseValidationError(issues, label);
      }
    }, batch ? () => progress.storyboard(progressId, part, batch.completed + batch.count, batch.total) : undefined);
  }

  const { data: plan, usage: outlineUsage } = await executePart(
    { kind: 'outline' }, '全片大纲', options.outlinePrompt, { outputSchema: outlineJsonSchema, outputSchemaName: 'video_storyboard_outline' }, outlineSchema,
    outline => checkOutline(outline, project, ranking),
  );
  const placements = storyboardPlacements(project.shots, plan.shots);
  const batchProject = { ...project, creativeContext: plan.creativeContext };
  const batchContract = storyboardOutputContract(options.outputContractVersion ?? 1);
  const numberedShotSchema = batchContract.schema.shape.shots.element.extend({ number: z.number().int().min(1).max(MAX_STORYBOARD_SHOTS) });
  const batches = Math.ceil(placements.length / batchSize);
  const shots: Shot[] = [], usages = [outlineUsage];
  for (let index = 1; index <= batches; index++) {
    const offset = (index - 1) * batchSize;
    const positions = placements.slice(offset, offset + batchSize);
    const part = { kind: 'batch', index, batches } as const;
    const schema = z.strictObject({ shots: z.array(numberedShotSchema).length(positions.length) });
    const outputSchema = z.toJSONSchema(schema, { io: 'input' });
    const existing = positions.flatMap(position => position.before ? [position.before] : []);
    const names = new Set(plan.shots.slice(offset, offset + positions.length).flatMap(shot => shot.repositories ?? []).map(name => name.toLowerCase()));
    const repositories = ranking?.repositories.filter(repo => names.has(repo.name.toLowerCase())) ?? [];
    const stage = batchStage(plan, offset, positions.length, part, existing, outputSchema, {
      structured: batchContract.structured, automaticCasting: options.automaticCasting,
      previousVisual: batchContract.structured ? stripVisualPromptOutputSpecs(shots.at(-1)?.visualPrompt ?? '') : undefined,
    });
    const buildPrompt = options.batchPrompt(stage, plan.creativeContext, repositories);
    const batch = await executePart(part, `第 ${index}/${batches} 批分镜`, buildPrompt, { outputSchema, outputSchemaName: 'video_storyboard_batch' }, schema, output => {
      const generated = output.shots.map(({ number, ...shot }, slot) => {
        if (number !== offset + slot + 1) throw new ModelResponseValidationError([{ path: `shots[${slot}].number`, message: '请按本批计划的镜头序号依次返回。' }]);
        if (shot.id !== undefined && shot.id !== positions[slot].before?.id) throw new ModelResponseValidationError([{ path: `shots[${slot}].id`, message: '请沿用本镜头已有编号，新镜头省略 id。' }]);
        return shot;
      });
      const validated = materializeStoryboardBatch(generated, batchProject, characters, positions);
      if (ranking && repositories.length) validateGithubTrendingStoryboard(validated, { ...ranking, repositories });
      return validated;
    }, { completed: shots.length, total: placements.length, count: positions.length });
    shots.push(...batch.data);
    usages.push(batch.usage);
  }
  const providerUsage = sumProviderUsage(usages);
  // Keep the whole-script text field available to existing downstream bindings.
  const characterKeys = new Map(creativeCharacterBindings(project, characters).map(({ key, profile }) => [profile.id, key]));
  const text = JSON.stringify({
    shots: shots.map(({ title, narration, visualPrompt, soundPrompt, durationUs, characterIds, creativeEntityKeys }, index) => ({
      id: placements[index].before?.id, title, narration, visualPrompt, soundPrompt, durationUs,
      characterKeys: characterIds?.flatMap(id => characterKeys.get(id) ?? []), entityKeys: creativeEntityKeys,
    })),
    entities: plan.entities,
  });
  return { text, shots, outline: plan.outline, ...(plan.creativeContext ? { creativeContext: plan.creativeContext } : {}), ...(providerUsage ? { providerUsage } : {}) };
}

export function readPartialStoryboard(database: Database.Database, runId: string, nodeId: string, part: StoryboardPart) {
  const read = database.prepare("SELECT result FROM activities WHERE run_id = ? AND activity_id = ? AND status = 'completed'");
  const outline = read.get(runId, partActivityId(nodeId, { kind: 'outline' })) as { result: string } | undefined;
  if (!outline) return;
  const { data } = JSON.parse(outline.result) as PartResult<Outline>;
  const shots: Shot[] = [];
  if (part.kind === 'batch') {
    for (let index = 1; index <= part.index; index++) {
      const batch = read.get(runId, partActivityId(nodeId, { ...part, index })) as { result: string } | undefined;
      if (!batch) break;
      shots.push(...(JSON.parse(batch.result) as PartResult<Shot[]>).data);
    }
  }
  return { outline: data.outline, shots };
}
