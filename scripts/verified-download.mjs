import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function verifiedDownload({ url, sha256 }, path) {
  if (!/^https:\/\//.test(url) || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('组件来源或固定摘要无效');
  await mkdir(dirname(path), { recursive: true });
  if (await stat(path).then(info => info.isFile(), () => false)) {
    if (await sha256File(path) !== sha256) throw new Error('组件缓存摘要不匹配，请移走不匹配的缓存后重试');
    return path;
  }
  const partial = `${path}.${process.pid}.partial`;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
        if (!response.ok || !response.body) throw new Error(`组件下载失败：HTTP ${response.status}`);
        await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
        break;
      } catch (error) {
        await rm(partial, { force: true });
        if (attempt >= 2) throw error;
        await delay(250 * (attempt + 1));
      }
    }
    if (await sha256File(partial) !== sha256) throw new Error('组件下载摘要不匹配，未解压或执行');
    await rename(partial, path);
    return path;
  } finally { await rm(partial, { force: true }); }
}
