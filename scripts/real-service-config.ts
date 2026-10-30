import { createHash } from 'node:crypto';
import { modelSchema, validateModelConnection, validateModelParameters, type ModelProfile } from '@video-quickly/contracts';

export const serviceRoles = ['text', 'image', 'tts', 'video', 'asr'] as const;
export type ServiceRole = typeof serviceRoles[number];
export interface ServiceConnection { model: ModelProfile; secretEnv?: string }
export interface RealServiceConfig { title: string; brief: string; roles: Record<ServiceRole, ServiceConnection> }

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function noInlineSecrets(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(noInlineSecrets); return; }
  if (!record(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:secret|api[-_]?key|authorization|access[-_]?token|credentialRef)$/i.test(key)) throw new Error('验收配置不能包含凭据，请只填写 secretEnv 环境变量名。');
    noInlineSecrets(item);
  }
}

export function parseRealServiceConfig(input: unknown): RealServiceConfig {
  if (!record(input) || !record(input.roles)) throw new Error('验收配置需要 roles。');
  noInlineSecrets(input);
  const configuredRoles = input.roles;
  const roles = Object.fromEntries(serviceRoles.map(role => {
    const entry = configuredRoles[role];
    if (!record(entry) || !record(entry.model)) throw new Error(`缺少 ${role} 模型。`);
    const secretEnv = entry.secretEnv;
    if (secretEnv !== undefined && (typeof secretEnv !== 'string' || !/^[A-Z][A-Z0-9_]{1,79}$/.test(secretEnv))) throw new Error(`${role} 的 secretEnv 须为环境变量名。`);
    const model = modelSchema.parse({ ...entry.model, id: `real-service-${role}`, name: `实际服务验收 ${role}`, createdAt: '', updatedAt: '', enabled: true });
    if (!model.capabilities.includes(role)) throw new Error(`${role} 连接缺少对应能力。`);
    const url = new URL(model.baseUrl);
    if (url.username || url.password || url.search || url.hash) throw new Error('服务地址不能嵌入凭据、查询参数或片段。');
    validateModelConnection(model); validateModelParameters(model);
    return [role, { model, ...(typeof secretEnv === 'string' ? { secretEnv } : {}) }];
  })) as Record<ServiceRole, ServiceConnection>;
  const title = typeof input.title === 'string' ? input.title.trim() : '真实模型三十秒成片验收';
  const brief = typeof input.brief === 'string' ? input.brief.trim() : '用三个镜头解释水的蒸发，每个镜头约十秒，科学表述准确，适合一般观众。';
  if (!title || title.length > 160 || !brief || brief.length > 30_000) throw new Error('验收标题或简报长度不合法。');
  return { title, brief, roles };
}

export function servicePreflight(config: RealServiceConfig, environment: Record<string, string | undefined>) {
  return serviceRoles.map(role => {
    const { model, secretEnv } = config.roles[role];
    const url = new URL(model.baseUrl);
    return { role, provider: model.provider, model: model.model, endpoint: `${url.origin}${url.pathname}`, credential: secretEnv ? (environment[secretEnv]?.trim() ? 'available' : 'missing') : 'not-configured' };
  });
}

export function configDigest(config: RealServiceConfig): string { return createHash('sha256').update(JSON.stringify(config)).digest('hex'); }

export function redactServiceFailure(error: unknown, secrets: readonly string[]): string {
  let message = error instanceof Error ? error.message : '实际服务验收失败。';
  for (const secret of secrets.filter(Boolean).toSorted((a, b) => b.length - a.length)) message = message.replaceAll(secret, '[redacted]');
  return message.replace(/(?:Bearer\s+|sk-)[\w.-]+/gi, '[redacted]');
}
