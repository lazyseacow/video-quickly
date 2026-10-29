import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { hashMediaFile } from '../src/media-process.js';

it('verifies large media in a stream and respects cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-media-hash-'));
  try {
    const bytes = Buffer.alloc(3_000_001, 137), path = join(directory, 'mix.wav'); await writeFile(path, bytes);
    expect(await hashMediaFile(path)).toBe(createHash('sha256').update(bytes).digest('hex'));
    const controller = new AbortController(); controller.abort(); await expect(hashMediaFile(path, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
