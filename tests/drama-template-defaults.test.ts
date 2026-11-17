import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { dramaStudioCreateResultSchema, dramaWorkSchema, projectSchema, seriesTemplateSchema } from '@video-quickly/contracts';
import { createRuntime } from '../src/packages/runtime/src';
import { DocumentStore, openDatabase } from '../src/packages/runtime/src/database';

const directories: string[] = [], runtimes = new Set<ReturnType<typeof createRuntime>>();
afterEach(async () => { await Promise.all([...runtimes].map(runtime => runtime.close())); runtimes.clear(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function open(directory: string) { const runtime = createRuntime({ dataDirectory: directory, seed: false, seedBuiltInTemplates: true, ffmpegPath: '/unused' }); runtimes.add(runtime); return runtime; }
async function fixture() { const directory = await mkdtemp(join(tmpdir(), 'vq-drama-template-')); directories.push(directory); return { directory, runtime: open(directory) }; }

it('creates animation works and episodes from explicit comic and ink template defaults while retaining captions', async () => {
  const { runtime } = await fixture();
  for (const [key, visualStyle] of [['live-action-drama', 'live-action'], ['motion-comic', 'animation'], ['ink-wash-drama', 'animation']] as const) {
    const template = seriesTemplateSchema.parse(await runtime.dispatch('seriesTemplate.get', { templateId: `builtin-series-${key}` }));
    expect(template.creationDefaults?.visualStyle).toBe(visualStyle);
    const { work, project } = dramaStudioCreateResultSchema.parse(await runtime.dispatch('dramaStudio.create', { mode: 'write',
      work: { title: template.name, visualStyle: template.creationDefaults!.visualStyle, narrativeMode: 'mixed' },
      seriesTemplateId: template.id, seriesTemplateRevision: template.revision }));
    expect(work.visualStyle).toBe(visualStyle); expect(project.drama?.visualStyle).toBe(visualStyle);
    expect(project.style).toBe(template.settings.style); expect(project.captionStyle).toEqual(template.settings.captionStyle);
    expect(project.profile).toEqual(template.creationDefaults!.profile);
    const quick = projectSchema.parse(await runtime.dispatch('project.create', { title: `模板快建 ${key}`, seriesTemplateId: template.id, seriesTemplateRevision: template.revision }));
    expect(quick.drama?.visualStyle).toBe(visualStyle);
    expect(dramaWorkSchema.parse(await runtime.dispatch('dramaWork.get', { workId: quick.drama!.workId })).visualStyle).toBe(visualStyle);
  }
});

it('backfills only missing built-in visual metadata in an existing seeded workspace without replacing user settings', async () => {
  const { runtime, directory } = await fixture();
  const template = seriesTemplateSchema.parse(await runtime.dispatch('seriesTemplate.get', { templateId: 'builtin-series-motion-comic' }));
  await runtime.close(); runtimes.delete(runtime);
  const { visualStyle: _visualStyle, ...defaults } = template.creationDefaults!;
  const previous = { ...template, name: '工作区定制条漫', revision: 7, settings: { ...template.settings, style: '用户自行修改的画风正文' },
    creationDefaults: { ...defaults, profile: { ...defaults.profile, width: 720, height: 1280 }, skillIds: ['user-preserved-skill'] } };
  const database = openDatabase(directory);
  try { const store = new DocumentStore(database); store.put('series-template', template.id, previous); store.put('metadata', 'builtin-drama-templates', { version: 1 }); }
  finally { database.close(); }
  const upgraded = open(directory);
  const result = seriesTemplateSchema.parse(await upgraded.dispatch('seriesTemplate.get', { templateId: template.id }));
  expect(result).toEqual({ ...previous, revision: 8, updatedAt: expect.any(String), creationDefaults: { ...previous.creationDefaults, visualStyle: 'animation' } });
  await upgraded.close(); runtimes.delete(upgraded);
  const reopened = open(directory);
  expect(await reopened.dispatch('seriesTemplate.get', { templateId: template.id })).toEqual(result);
});
