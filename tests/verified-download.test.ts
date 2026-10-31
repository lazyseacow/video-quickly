import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { verifiedDownload } from '../scripts/verified-download.mjs';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
it('reuses only verified cached bytes and rejects changed content without replacing it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-component-cache-')); directories.push(directory);
  const path = join(directory, 'component.tar.gz'), bytes = Buffer.from('immutable component fixture');
  const specification = { url: 'https://components.invalid/component.tar.gz', sha256: createHash('sha256').update(bytes).digest('hex') };
  await writeFile(path, bytes);
  expect(await verifiedDownload(specification, path)).toBe(path);
  await writeFile(path, 'tampered');
  await expect(verifiedDownload(specification, path)).rejects.toThrow('缓存摘要不匹配');
  expect(await readFile(path, 'utf8')).toBe('tampered');
});
it('rejects non-HTTPS sources and malformed digests before any network or extraction', async () => {
  await expect(verifiedDownload({ url: 'http://components.invalid/tool', sha256: '0'.repeat(64) }, '/not-used')).rejects.toThrow('来源或固定摘要');
  await expect(verifiedDownload({ url: 'https://components.invalid/tool', sha256: 'not-a-digest' }, '/not-used')).rejects.toThrow('来源或固定摘要');
});
