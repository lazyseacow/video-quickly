import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const maximumBytes = 100_000_000;
const extensions: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/webp': '.webp', 'image/svg+xml': '.svg',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/mp4': '.m4a', 'audio/ogg': '.ogg',
};
function extensionFor(mimeType: string | undefined): string {
  const extension = mimeType && extensions[mimeType.split(';')[0].trim().toLowerCase()];
  if (!extension) throw new Error('工具素材需要受支持的图片、音频或视频 MIME 类型。');
  return extension;
}
function checkedUrl(raw: string): URL {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('工具素材地址需要不含用户名和密码的 HTTP(S) URL。');
  return url;
}

/** Turn tool-provided bytes into a local input for the existing asset importer. */
export async function materializeToolArtifact(input: { url?: string; data?: string; mimeType?: string }, directory: string, signal: AbortSignal): Promise<string> {
  if (Number(input.url !== undefined) + Number(input.data !== undefined) !== 1) throw new Error('工具素材需要在 url 和 data 中选择一种来源。');
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  boundedSignal.throwIfAborted();
  let response: Response | undefined, bytes: Buffer | undefined;
  if (input.data !== undefined) {
    const encoded = input.data;
    if (!encoded.length || encoded.length > Math.ceil(maximumBytes / 3) * 4 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('工具素材 data 需要不超过 100 MB 的有效 base64 内容。');
    bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > maximumBytes || bytes.toString('base64') !== encoded) throw new Error('工具素材 data 不是有效的标准 base64 内容。');
  } else {
    let url = checkedUrl(input.url!);
    for (let redirects = 0; ; redirects++) {
      // Tool and model credentials are deliberately absent from this request.
      response = await fetch(url, { signal: boundedSignal, redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || redirects >= 5) throw new Error('工具素材下载重定向无效或次数过多。');
      url = checkedUrl(new URL(location, url).href);
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`工具素材下载返回 HTTP ${response.status}。`); }
    const declared = response.headers.get('content-length');
    if (declared && Number(declared) > maximumBytes) { await response.body?.cancel(); throw new Error('工具素材超过 100 MB。'); }
  }
  let extension: string;
  try { extension = extensionFor(input.mimeType ?? response?.headers.get('content-type') ?? undefined); }
  catch (error) { await response?.body?.cancel(); throw error; }
  const root = resolve(directory);
  const path = join(root, `${randomUUID()}${extension}`), partial = `${path}.part`;
  let file: Awaited<ReturnType<typeof open>>;
  try { await mkdir(root, { recursive: true }); file = await open(partial, 'wx'); }
  catch (error) { await response?.body?.cancel(); throw error; }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (bytes) await file.writeFile(bytes);
    else {
      if (!response?.body) throw new Error('工具素材下载没有返回文件内容。');
      reader = response.body.getReader();
      let received = 0;
      for (;;) {
        boundedSignal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > maximumBytes) throw new Error('工具素材超过 100 MB。');
        await file.writeFile(chunk.value);
      }
      if (!received) throw new Error('工具素材文件为空。');
    }
    boundedSignal.throwIfAborted();
    await file.close();
    await rename(partial, path);
    return path;
  } catch (error) {
    await reader?.cancel().catch(() => undefined);
    await file.close();
    await rm(partial, { force: true });
    throw error;
  } finally { reader?.releaseLock(); }
}
