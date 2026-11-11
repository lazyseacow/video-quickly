import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { chargeActionRequestSchema, type ChargeAction, type ChargeEstimate, type VideoReferenceReview } from '@video-quickly/contracts';
import { fingerprint } from './activities.js';

const confirmationIdSchema = z.object({ chargeConfirmationId: z.string().uuid() });
const lifetimeMs = 10 * 60 * 1000;
const maximumPending = 32;

type ChargePrompt = { title: string; description: string; confirmLabel: string; estimate?: ChargeEstimate; videoReferences?: VideoReferenceReview };

export const chargePrompts = {
  'run.start': { title: '开始制作？', description: '将执行选定的制作范围。范围内的模型请求可能产生费用。', confirmLabel: '确认开始制作' },
  'run.resume': { title: '继续制作？', description: '将沿用原任务的配置和已有产物。后续需要发出的模型请求可能产生费用。', confirmLabel: '确认继续制作' },
  'run.step.retry': { title: '重试此步骤？', description: '将重新尝试选定步骤。若再次提交模型请求，可能产生费用。', confirmLabel: '确认重试' },
  'shot.regenerate': { title: '生成镜头候选？', description: '将使用所选模型重新生成当前镜头的候选内容，可能产生费用。', confirmLabel: '确认生成' },
  'character.generateImage': { title: '生成角色参考图？', description: '将使用所选图片模型生成一张参考图，可能产生费用。', confirmLabel: '确认生成' },
  'planning.prefill.start': { title: '使用 AI 填写？', description: '将使用所选文本模型填写当前策划内容，可能产生费用。', confirmLabel: '确认填写' },
  'promptTrial.start': { title: '开始试运行？', description: '将提交本次实验的模型请求，可能产生费用。', confirmLabel: '确认试运行' },
  'workflowAssistant.start': { title: '生成修改建议？', description: '将使用所选文本模型生成任务修改预览，可能产生费用。', confirmLabel: '确认生成' },
  'cost.update': { title: '保存费用记录？', description: '将更新此条费用记录中的金额、币种或备注。', confirmLabel: '确认保存费用' },
} satisfies Record<ChargeAction, ChargePrompt>;

export function createChargeConfirmations(describe: (method: ChargeAction, params: unknown) => ChargePrompt | null) {
  const pending = new Map<string, { digest: string; quoteDigest: string; expiresAt: number }>();
  return {
    prepare(raw: unknown) {
      const request = chargeActionRequestSchema.parse(raw);
      const prompt = describe(request.method, request.params);
      if (!prompt) return null;
      const now = Date.now();
      for (const [id, entry] of pending) if (entry.expiresAt <= now) pending.delete(id);
      if (pending.size >= maximumPending) throw new Error('待确认的费用操作过多，请稍后重试。');
      const confirmationId = randomUUID();
      pending.set(confirmationId, { digest: fingerprint(request), quoteDigest: fingerprint(prompt), expiresAt: now + lifetimeMs });
      return { ...prompt, confirmationId };
    },
    cancel(raw: unknown) {
      const { chargeConfirmationId } = confirmationIdSchema.parse(raw);
      pending.delete(chargeConfirmationId);
      return null;
    },
    consume(method: ChargeAction, raw: object) {
      const { chargeConfirmationId, ...params } = raw as Record<string, unknown>;
      const { chargeConfirmationId: id } = confirmationIdSchema.parse({ chargeConfirmationId });
      const entry = pending.get(id);
      if (!entry || entry.expiresAt <= Date.now() || entry.digest !== fingerprint({ method, params })) {
        throw new Error('费用确认已失效或操作范围已变化，请重新确认。');
      }
      pending.delete(id);
      if (entry.quoteDigest !== fingerprint(describe(method, params))) throw new Error('制作配置、参考素材或预估费用已变化，请重新确认。');
      return params;
    },
  };
}
