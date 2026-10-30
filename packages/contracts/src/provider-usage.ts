import type { ProviderUsage } from './index.js';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Only explicit provider counters are recorded; absent counters remain unknown. */
export function providerReportedUsage(value: Record<string, unknown>, ollama = false): ProviderUsage | undefined {
  const raw = object(value.usage);
  const input = object(raw.prompt_tokens_details ?? raw.input_tokens_details);
  const output = object(raw.completion_tokens_details ?? raw.output_tokens_details);
  const anthropicCache = raw.prompt_tokens === undefined && (raw.cache_read_input_tokens !== undefined || raw.cache_creation_input_tokens !== undefined);
  const inputParts = [count(raw.input_tokens), count(raw.cache_read_input_tokens), count(raw.cache_creation_input_tokens)];
  const measured = {
    inputTokens: anthropicCache ? inputParts.every(part => part !== undefined) ? inputParts.reduce<number>((sum, part) => sum + part!, 0) : undefined : count(ollama ? value.prompt_eval_count : raw.prompt_tokens ?? raw.input_tokens),
    outputTokens: count(ollama ? value.eval_count : raw.completion_tokens ?? raw.output_tokens),
    totalTokens: count(raw.total_tokens),
    cachedInputTokens: count(ollama ? value.prompt_eval_cached_count : input.cached_tokens) ?? count(raw.prompt_cache_hit_tokens) ?? count(raw.cached_input_tokens) ?? count(raw.cache_read_input_tokens),
    cachedOutputTokens: count(output.cached_tokens) ?? count(raw.cached_output_tokens),
  };
  return Object.values(measured).some(value => value !== undefined) ? { source: 'provider', ...measured } : undefined;
}

/** A batch total is known only when every submitted call reported that counter. */
export function sumProviderUsage(values: readonly (ProviderUsage | undefined)[]): ProviderUsage | undefined {
  const metrics = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'cachedOutputTokens', 'characters', 'audioSeconds', 'images', 'videoSeconds'] as const;
  const totals = Object.fromEntries(metrics.flatMap(metric => values.length && values.every(value => value?.[metric] !== undefined) ? [[metric, values.reduce((sum, value) => sum + value![metric]!, 0)]] : []));
  return Object.keys(totals).length ? { source: 'provider', ...totals } : undefined;
}
