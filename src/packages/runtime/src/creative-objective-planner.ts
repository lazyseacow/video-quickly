import { z } from 'zod';
import {
  creativeObjectiveAnalysisSchema, creativeObjectiveInputSchema, creativeObjectivePlanSchema,
  type CreativeObjectivePlan, type ModelProfile,
} from '@video-quickly/contracts';
import { fingerprint } from './activities.js';
import { creativeObjectivePrompt, resolveCreativeObjective } from './creative-objective.js';
import type { createCostLedger } from './costs.js';
import type { DocumentStore } from './database.js';
import { validateExecutionModel } from './execution-model.js';
import { ModelResponseValidationError, parseModelJson, responseIssues, type createModelResponses } from './model-responses.js';
import { textModelWithTaskSchema, TextRequestRejectedError, type TextProvider } from './providers.js';

type ObjectiveInput = z.infer<typeof creativeObjectiveInputSchema>;
type ObjectiveRequest = { inputHash: string; model: ModelProfile; goal: string; prompt: string };
const outputSchema = z.toJSONSchema(creativeObjectiveAnalysisSchema);
const outputSchemaName = 'creative_objective';
const operationId = (id: string) => `creative-objective:${id}`;

interface Options {
  store: DocumentStore;
  responses: ReturnType<typeof createModelResponses>;
  costs: ReturnType<typeof createCostLedger>;
  model: (id: string) => ModelProfile | undefined;
  provider: TextProvider;
  resolveSecret: (model: ModelProfile) => Promise<string | undefined>;
}

export function createCreativeObjectivePlanner({ store, responses, costs, model, provider, resolveSecret }: Options) {
  const inFlight = new Map<string, { inputHash: string; promise: Promise<CreativeObjectivePlan>; controller: AbortController }>();

  function get(id: string) {
    const value = store.get('creative-objective-plan', id);
    return value ? creativeObjectivePlanSchema.parse(value) : undefined;
  }

  function request(input: ObjectiveInput, inputHash: string): ObjectiveRequest {
    const saved = store.get<ObjectiveRequest>('creative-objective-request', input.requestId);
    if (saved) {
      if (saved.inputHash !== inputHash) throw new Error('此分析请求已用于其他目标，请重新提交。');
      return saved;
    }
    const selected = model(input.modelId);
    if (!selected?.enabled || !selected.capabilities.includes('text')) throw new Error('请选择可用的文本模型。');
    validateExecutionModel({ id: 'creative-objective', kind: 'brief', label: '分析创作目标', description: '', prompt: '', modelId: selected.id,
      skillIds: [], config: { requiresModel: true }, position: { x: 0, y: 0 }, requiresReview: false }, selected);
    const value = { inputHash, model: selected, goal: input.goal, prompt: creativeObjectivePrompt(input.goal) };
    store.put('creative-objective-request', input.requestId, value);
    return value;
  }

  async function analyze(input: ObjectiveInput, saved: ObjectiveRequest, signal: AbortSignal) {
    const id = operationId(input.requestId), received = responses.current(id);
    const secret = received ? undefined : await resolveSecret(saved.model);
    if (!received && saved.model.hasSecret && !secret) throw new Error('模型凭据不可用，请重新保存密钥。');
    signal.throwIfAborted();
    const analyzed = await responses.generate({ operationId: id, inputHash: fingerprint(saved), recordReceipt() {},
      async generate() {
        costs.begin({ operationId: id, runId: input.requestId, projectId: input.requestId, nodeId: 'creative-objective',
          model: saved.model, capability: 'text', requestMetrics: { source: 'request', requestCount: 1 } });
        try {
          return await provider({ model: textModelWithTaskSchema(saved.model, outputSchema, outputSchemaName), secret, operationId: id,
            signal, prompt: saved.prompt, outputSchema, outputSchemaName });
        } catch (error) {
          costs.status(id, error instanceof TextRequestRejectedError ? 'failed' : 'unknown');
          throw error;
        }
      },
    });
    costs.status(id, 'completed', analyzed.usage);
    try {
      if (analyzed.incomplete) throw new ModelResponseValidationError([{ path: '$', message: '分析返回不完整。' }], '创作目标分析');
      const parsed = creativeObjectiveAnalysisSchema.safeParse(parseModelJson(analyzed.text, '创作目标分析'));
      if (!parsed.success) throw new ModelResponseValidationError(responseIssues(parsed.error), '创作目标分析');
      const plan = creativeObjectivePlanSchema.parse(resolveCreativeObjective({ id: input.requestId, goal: saved.goal, modelId: saved.model.id, analysis: parsed.data }));
      store.put('creative-objective-plan', plan.id, plan);
      return plan;
    } catch (error) {
      if (error instanceof ModelResponseValidationError) responses.validationFailed(id, error.issues);
      throw error;
    }
  }

  function plan(rawParams: unknown): Promise<CreativeObjectivePlan> {
    const input = creativeObjectiveInputSchema.parse(rawParams), inputHash = fingerprint(input);
    const active = inFlight.get(input.requestId);
    if (active) {
      if (active.inputHash !== inputHash) throw new Error('此分析请求已用于其他目标，请重新提交。');
      return active.promise;
    }
    const saved = request(input, inputHash), previous = get(input.requestId);
    if (previous) return Promise.resolve(previous);
    const controller = new AbortController();
    const promise = analyze(input, saved, controller.signal).finally(() => inFlight.delete(input.requestId));
    inFlight.set(input.requestId, { inputHash, promise, controller });
    return promise;
  }

  return { plan, get, hasSubmission: (id: string) => Boolean(responses.current(operationId(id))),
    cancelActive() { for (const entry of inFlight.values()) entry.controller.abort(); } };
}
