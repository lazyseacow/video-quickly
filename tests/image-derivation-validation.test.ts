import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { assetSchema, imageDerivationSchema, projectSchema, shotSchema } from '@video-quickly/contracts';
import { createRuntime } from '../packages/runtime/src/index';
import { DocumentStore, openDatabase } from '../packages/runtime/src/database';
import { createImageTools } from '../packages/runtime/src/image-tools';

const directories: string[] = [], runtimes: ReturnType<typeof createRuntime>[] = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.close())); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

it('validates crop bounds, integer grid identity and mask provenance as one consistent record', () => {
  const derivation = { kind: 'grid-crop', sourceAssetId: 'source', sourceSha256: 'a'.repeat(64), sourceWidth: 5, sourceHeight: 3, rectangle: { x: 2, y: 1, width: 3, height: 2 }, grid: { rows: 2, columns: 2, index: 3 } };
  expect(imageDerivationSchema.safeParse(derivation).success).toBe(true);
  for (const invalid of [
    { ...derivation, rectangle: { x: 3, y: 1, width: 3, height: 2 } },
    { ...derivation, rectangle: { x: 2, y: 2, width: 3, height: 2 } },
    { ...derivation, grid: { rows: 2, columns: 2, index: 4 } },
    { ...derivation, grid: { rows: 4, columns: 2, index: 0 } },
    { ...derivation, grid: { rows: 2, columns: 6, index: 0 } },
    { ...derivation, grid: { rows: 2, columns: 2, index: 2 } },
    { ...derivation, kind: 'edit-mask' },
  ]) expect(imageDerivationSchema.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
  expect(imageDerivationSchema.safeParse({ ...derivation, kind: 'edit-mask', grid: undefined }).success).toBe(true);
});

it('rejects an external format-8 backup whose crop source hash contradicts its source record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-image-derivation-')); directories.push(directory);
  const runtime = createRuntime({ dataDirectory: directory, seed: false }); runtimes.push(runtime);
  const path = join(directory, 'source.png'); await writeFile(path, png);
  const source = assetSchema.parse(await runtime.dispatch('asset.import', { path, kind: 'image' }));
  const database = openDatabase(directory);
  const [tile] = await createImageTools({ store: new DocumentStore(database), directory, changed: () => undefined })
    .cutGrid({ assetId: source.id, rows: 1, columns: 1 }).finally(() => database.close());
  const created = projectSchema.parse(await runtime.dispatch('project.create', { title: '来源完整性' }));
  const project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: created.id, revision: created.revision, patch: { shots: [shotSchema.parse({ id: 'one', title: '一', visualPrompt: '', narration: '', durationUs: 1_000_000, assetId: tile.id })] } }));
  const backup = await runtime.dispatch('project.backup', { projectId: project.id }) as { path: string };
  const manifestPath = join(backup.path, 'project.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const cropped = manifest.assets.find((asset: { id: string }) => asset.id === tile.id);
  expect(cropped.derivation.sourceSha256).toBe(createHash('sha256').update(png).digest('hex'));
  cropped.derivation.sourceSha256 = '0'.repeat(64);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await expect(runtime.dispatch('project.importBackup', { path: backup.path })).rejects.toThrow(/来源|源图|摘要|哈希|SHA/);
});
