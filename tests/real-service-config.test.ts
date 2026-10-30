import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { configDigest, parseRealServiceConfig, redactServiceFailure, servicePreflight, serviceRoles } from '../scripts/real-service-config';

const configured = () => ({ roles: Object.fromEntries(serviceRoles.map(role => [role, { secretEnv: `VQ_${role.toUpperCase()}_KEY`, model: { provider: 'openai-compatible', baseUrl: 'https://example.invalid/v1', model: `configured-${role}`, capabilities: [role] } }])) });

describe('real service validation configuration', () => {
  it('uses production model validation and exposes only credential availability in preflight', () => {
    const parsed = parseRealServiceConfig(configured());
    const preflight = servicePreflight(parsed, { VQ_TEXT_KEY: 'private-value' });
    expect(preflight.find(value => value.role === 'text')).toMatchObject({ credential: 'available', endpoint: 'https://example.invalid/v1' });
    expect(preflight.find(value => value.role === 'video')?.credential).toBe('missing');
    expect(JSON.stringify(preflight)).not.toContain('private-value');
    expect(configDigest(parsed)).toMatch(/^[a-f0-9]{64}$/);
    expect(configDigest(parsed)).toBe(configDigest(parseRealServiceConfig(configured())));
  });

  it('rejects missing capabilities and credential values embedded in the configuration', () => {
    const wrong = configured(); wrong.roles.image.model.capabilities = ['text'];
    expect(() => parseRealServiceConfig(wrong)).toThrow('对应能力');
    const secret = configured(); Object.assign(secret.roles.text.model, { parameters: { Authorization: 'private-value' } });
    expect(() => parseRealServiceConfig(secret)).toThrow('凭据');
    const query = configured(); query.roles.text.model.baseUrl += '?key=private-value';
    expect(() => parseRealServiceConfig(query)).toThrow('服务地址');
    const incomplete = configured(); Reflect.deleteProperty(incomplete.roles, 'asr');
    expect(() => parseRealServiceConfig(incomplete)).toThrow('asr');
  });

  it('redacts configured secrets from failures without hiding the HTTP failure category', () => {
    expect(redactServiceFailure(new Error('HTTP 429 token private-value'), ['private-value'])).toBe('HTTP 429 token [redacted]');
    expect(redactServiceFailure(new Error('Bearer token-123'), [])).toBe('[redacted]');
  });

  it('runs the real CLI preflight without media tools, paid calls or an output workspace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vq-service-preflight-'));
    try {
      const path = join(directory, 'config.json'); await writeFile(path, JSON.stringify(configured()));
      const output = execFileSync(process.execPath, ['--import', 'tsx', resolve('scripts/real-service-smoke.ts'), '--config', path], { encoding: 'utf8', env: { ...process.env, VQ_TEXT_KEY: 'test-only-memory-value', VIDEO_QUICKLY_FFMPEG: join(directory, 'must-not-run') } });
      expect(JSON.parse(output)).toMatchObject({ status: 'preflight', connections: expect.arrayContaining([{ role: 'text', provider: 'openai-compatible', model: 'configured-text', endpoint: 'https://example.invalid/v1', credential: 'available' }]) });
      expect(output).not.toContain('test-only-memory-value'); expect(await readdir(directory)).toEqual(['config.json']);
      expect(await readFile(path, 'utf8')).not.toContain('test-only-memory-value');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
