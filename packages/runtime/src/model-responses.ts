import { z } from 'zod';
import { providerUsageSchema, type ModelResponseIssue } from '@video-quickly/contracts';
import type { DocumentStore } from './database.js';
import { TextRequestRejectedError, type TextGenerationResult } from './providers.js';

/** Only safe, locally generated field descriptions cross the checkpoint boundary. */
export class ModelResponseValidationError extends Error {
  constructor(readonly issues: ModelResponseIssue[]) {
    super(`分镜结果校验失败：${issues.map(issue => `${issue.path}：${issue.message}`).join('；')}`);
    this.name = 'ModelResponseValidationError';
  }
}

export function responseIssues(error: z.ZodError): ModelResponseIssue[] {
  return error.issues.slice(0, 20).map(issue => ({
    path: issue.path.reduce<string>((path, part) => typeof part === 'number' ? `${path}[${part}]` : `${path ? `${path}.` : ''}${String(part)}`, '') || '$',
    message: issue.code === 'invalid_type' ? `应为${({ string: '字符串', number: '数字', int: '整数', array: '数组', object: '对象' } as Record<string, string>)[issue.expected] ?? '规定类型'}`
      : issue.code === 'too_small' ? `不得小于 ${issue.minimum}${issue.origin === 'string' ? ' 个字符' : issue.origin === 'array' ? ' 项' : ''}`
      : issue.code === 'too_big' ? `不得超过 ${issue.maximum}${issue.origin === 'string' ? ' 个字符' : issue.origin === 'array' ? ' 项' : ''}`
      : issue.code === 'invalid_value' ? '值不在允许的选项中'
      : issue.code === 'invalid_format' ? '格式不符合要求'
      : '不符合字段约束（检查重复项和编号格式）',
  }));
}

const receiptSchema = z.object({
  attempt: z.number().int().positive(), inputHash: z.string(), submittedAt: z.string(),
  status: z.enum(['submitted', 'received', 'rejected']), receivedAt: z.string().optional(),
  rejectedAt: z.string().optional(), rejection: z.object({ status: z.number().int(), unsupportedOutputFormat: z.boolean() }).optional(),
  response: z.object({ text: z.string(), usage: providerUsageSchema.optional(), incomplete: z.boolean().optional() }).optional(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
type Receipt = z.infer<typeof receiptSchema>;

/** A response receipt is local evidence, not a provider task identifier. */
export function createModelResponses(store: DocumentStore) {
  function current(operationId: string, attempt?: number): Receipt | undefined {
    const head = store.get<{ attempt: number }>('model-response-head', operationId);
    const value = head && (!attempt || attempt <= head.attempt) && store.get<Receipt>('model-response', `${operationId}:${attempt ?? head.attempt}`);
    return value ? receiptSchema.parse(value) : undefined;
  }
  function save(operationId: string, receipt: Receipt) { store.put('model-response', `${operationId}:${receipt.attempt}`, receipt); }
  return {
    current,
    promptFormat(operationId: string) { return store.get<{ promptFormat: boolean }>('model-response-options', operationId)?.promptFormat ?? false; },
    usePromptFormat(operationId: string) { store.put('model-response-options', operationId, { promptFormat: true }); },
    history(operationId: string) {
      return store.database.prepare("SELECT json_extract(body, '$.attempt') AS attempt, json_extract(body, '$.receivedAt') AS receivedAt, CASE WHEN coalesce(json_array_length(body, '$.issues'), 0) > 0 THEN 1 ELSE 0 END AS invalid FROM documents WHERE kind = 'model-response' AND substr(id, 1, length(@operationId) + 1) = @operationId || ':' AND json_extract(body, '$.status') = 'received' ORDER BY attempt DESC").all({ operationId }) as { attempt: number; receivedAt: string; invalid: number }[];
    },
    attempt(operationId: string) { return store.get<{ attempt: number }>('model-response-head', operationId)?.attempt ?? 1; },
    retryIssues(operationId: string) {
      const head = store.get<{ attempt: number }>('model-response-head', operationId);
      for (let attempt = (head?.attempt ?? 1) - 1; attempt > 0; attempt--) {
        const receipt = store.get<Receipt>('model-response', `${operationId}:${attempt}`);
        if (receipt?.status === 'received') return receipt.issues;
      }
      return undefined;
    },
    async generate(options: { operationId: string; inputHash: string; recordReceipt(id: string): void; generate(): Promise<string | TextGenerationResult> }): Promise<TextGenerationResult> {
      const receipt = current(options.operationId);
      if (receipt && receipt.inputHash !== options.inputHash) throw new Error('已保存的模型返回与本次固定输入不一致。');
      if (receipt?.status === 'received' && receipt.response) return receipt.response;
      if (receipt?.status === 'rejected' && receipt.rejection) throw new TextRequestRejectedError(receipt.rejection.status, receipt.rejection.unsupportedOutputFormat);
      if (receipt) throw new Error('模型请求已提交，尚未保存完整返回；请先核对原请求。');
      const head = store.get<{ attempt: number }>('model-response-head', options.operationId);
      const submitted: Receipt = { attempt: head?.attempt ?? 1, inputHash: options.inputHash, status: 'submitted', submittedAt: new Date().toISOString() };
      store.database.transaction(() => {
        store.put('model-response-head', options.operationId, { attempt: submitted.attempt });
        save(options.operationId, submitted);
      })();
      options.recordReceipt(`model-response:${options.operationId}:${submitted.attempt}`);
      try {
        const generated = await options.generate(), response = typeof generated === 'string' ? { text: generated } : generated;
        save(options.operationId, { ...submitted, status: 'received', receivedAt: new Date().toISOString(), response });
        return response;
      } catch (error) {
        if (error instanceof TextRequestRejectedError) save(options.operationId, { ...submitted, status: 'rejected', rejectedAt: new Date().toISOString(), rejection: { status: error.status, unsupportedOutputFormat: error.unsupportedOutputFormat } });
        throw error;
      }
    },
    validationFailed(operationId: string, issues: ModelResponseIssue[]) {
      const receipt = current(operationId);
      if (receipt?.status === 'received') save(operationId, { ...receipt, issues });
    },
    // Only an explicit retry advances the attempt. Resume reuses the received
    // text after a crash, and an unresolved submission never opens a new attempt.
    prepareRetry(operationId: string): (() => void) | undefined {
      const receipt = current(operationId);
      if (!receipt || !(receipt.status === 'rejected' || receipt.status === 'received' && receipt.issues?.length)) return undefined;
      store.put('model-response-head', operationId, { attempt: receipt.attempt + 1 });
      return () => store.put('model-response-head', operationId, { attempt: receipt.attempt });
    },
  };
}
