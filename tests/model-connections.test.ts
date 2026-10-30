import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { getModelConnectionType, getModelCapabilities, modelConnectionTypes, modelSchema, validateModelConnection, type ModelConnectionType, type ModelProfile } from '@video-quickly/contracts';
import { createRuntime } from '../packages/runtime/src/index';
import { DocumentStore, openDatabase } from '../packages/runtime/src/database';

it('infers existing connection types without rewriting stored capabilities', () => {
  for (const [capabilities, kind] of [[['text'], 'text'], [['text', 'vision', 'tools'], 'text'], [['image'], 'image'], [['video'], 'video'], [['tts'], 'audio'], [['asr'], 'audio'], [['tts', 'asr'], 'audio'], [['text', 'image'], 'text'], [['image', 'video'], 'video'], [['vision'], 'text'], [[], 'text']] as const) {
    const model = { capabilities: [...capabilities] }; expect(getModelConnectionType(model)).toBe(kind); expect(model).not.toHaveProperty('connectionType');
  }
  expect(getModelConnectionType({ provider: 'seedream', capabilities: ['text', 'image'] })).toBe('image');
  expect(getModelConnectionType({ provider: 'seedance', capabilities: ['text', 'video'] })).toBe('video');
  expect(getModelConnectionType({ provider: 'qwen-tts', capabilities: ['text', 'tts'] })).toBe('audio');
  expect(getModelConnectionType({ provider: 'ollama', capabilities: ['image', 'video'] })).toBe('text');
  expect(getModelConnectionType({ connectionType: 'image', capabilities: ['text', 'image'] })).toBe('image');
  expect(modelConnectionTypes.map(type => type.id)).toEqual(['text', 'image', 'video', 'audio']);
});

it('opens text abilities for stored connections while retaining their media roles and original database records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-model-abilities-'));
  const original = modelSchema.parse({ id: 'stored', name: '旧连接', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture', capabilities: ['text', 'image', 'video'], createdAt: '', updatedAt: '' });
  const database = openDatabase(directory); new DocumentStore(database).put('model', original.id, original); database.close();
  const runtime = createRuntime({ dataDirectory: directory });
  try {
    const workspace = await runtime.dispatch('workspace.summary') as { models: ModelProfile[] };
    expect(workspace.models[0].capabilities).toEqual(['text', 'image', 'video', 'vision', 'tools', 'structured-output']);
    expect(getModelCapabilities({ provider: 'volcengine-tts', capabilities: ['tts'] })).toEqual(['tts']);
    expect(getModelCapabilities({ provider: 'openai-compatible', capabilities: ['image'] })).toEqual(['image']);
  } finally { await runtime.close(); }
  try {
    const database = openDatabase(directory);
    try { expect(new DocumentStore(database).get<ModelProfile>('model', original.id)?.capabilities).toEqual(original.capabilities); } finally { database.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('enforces a single generation role or audio endpoint while keeping existing mixed connections readable', () => {
  const model = { provider: 'openai-compatible' as const, capabilities: ['text', 'image', 'video', 'tts', 'asr'] as ModelProfile['capabilities'] };
  expect(() => validateModelConnection(model)).not.toThrow();
  for (const kind of ['text', 'image', 'video', 'audio'] as ModelConnectionType[]) expect(() => validateModelConnection({ ...model, connectionType: kind })).toThrow();
  for (const [kind, capability, provider] of [['text', 'text', 'openai-compatible'], ['text', 'text', 'ollama'], ['image', 'image', 'seedream'], ['video', 'video', 'seedance'], ['audio', 'tts', 'qwen-tts'], ['audio', 'asr', 'openai-compatible']] as const) expect(() => validateModelConnection({ connectionType: kind, capabilities: [capability], provider })).not.toThrow();
  expect(() => validateModelConnection({ connectionType: 'audio', capabilities: ['asr'], provider: 'qwen-tts' })).toThrow();
  expect(modelSchema.safeParse({ ...model, id: 'invalid', name: 'invalid', baseUrl: 'http://localhost', model: 'test', createdAt: '', updatedAt: '', connectionType: 'unknown' }).success).toBe(false);
});

it('persists separate connections and rejects cross-type capabilities at model.save without affecting legacy records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-model-connections-')); const runtime = createRuntime({ dataDirectory: directory });
  try {
    const base = { name: '分类测试', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture' };
    const legacy = await runtime.dispatch('model.save', { model: { ...base, capabilities: ['text', 'image', 'video', 'tts', 'asr'] } }) as ModelProfile;
    expect(legacy.connectionType).toBeUndefined();
    for (const [connectionType, capability] of [['text', 'text'], ['image', 'image'], ['video', 'video'], ['audio', 'tts'], ['audio', 'asr']] as const) {
      const saved = await runtime.dispatch('model.save', { model: { ...base, connectionType, capabilities: [capability] } }) as ModelProfile;
      expect(saved.connectionType).toBe(connectionType); expect(saved.capabilities).toEqual(connectionType === 'text' ? ['text', 'vision', 'tools', 'structured-output'] : [capability]);
      await expect(runtime.dispatch('model.save', { model: { ...saved, capabilities: ['text', 'image'] } })).rejects.toThrow();
    }
    const workspace = await runtime.dispatch('workspace.summary') as { models: ModelProfile[] };
    expect(workspace.models.find(model => model.id === legacy.id)?.capabilities).toEqual(legacy.capabilities); expect(workspace.models).toHaveLength(6);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});
