import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform === 'darwin') {
  const { prepareMacosMedia } = await import('./prepare-macos-media.mjs');
  await prepareMacosMedia(root);
  process.exit(0);
}
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('固定媒体构建适用于 Windows x64 和 macOS arm64/x64');
const manifest = JSON.parse(await readFile(join(root, 'scripts/media-manifest.json'), 'utf8'));
const tools = join(root, '.tools');
const archive = join(tools, `${manifest.directory}.zip`);
const media = join(tools, manifest.directory);
await mkdir(tools, { recursive: true });
async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
if (!await stat(archive).then(() => true, () => false)) {
  const partial = `${archive}.partial`;
  try {
    const response = await fetch(manifest.url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok || !response.body) throw new Error(`媒体组件下载失败：${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
    if (await digest(partial) !== manifest.sha256) throw new Error('媒体组件校验失败');
    await rename(partial, archive);
  } finally { await rm(partial, { force: true }); }
}
if (await digest(archive) !== manifest.sha256) throw new Error('媒体组件校验失败，请移走不匹配的缓存后重试');
// Expand a verified archive into a fixed workspace directory. No user paths are removed.
const expanded = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:VQ_MEDIA_ARCHIVE -DestinationPath $env:VQ_MEDIA_TOOLS -Force'], { windowsHide: true, encoding: 'utf8', env: { ...process.env, VQ_MEDIA_ARCHIVE: archive, VQ_MEDIA_TOOLS: tools } });
if (expanded.status !== 0) throw new Error(`媒体组件解压失败：${expanded.stderr}`);
for (const file of ['bin/ffmpeg.exe', 'bin/ffprobe.exe', 'LICENSE.txt']) await stat(join(media, file));
const provenance = { ...manifest, verified: true };
await writeFile(join(media, 'provenance.json'), JSON.stringify(provenance, null, 2));
await writeFile(join(tools, 'ffmpeg-provenance.json'), JSON.stringify(provenance, null, 2));
// CI uses exactly this directory even when an older development build is present.
if (process.env.GITHUB_ENV) {
  const { appendFile } = await import('node:fs/promises');
  await appendFile(process.env.GITHUB_ENV, `VIDEO_QUICKLY_MEDIA_DIR=${media}\nVIDEO_QUICKLY_FFMPEG=${join(media, 'bin/ffmpeg.exe')}\nVIDEO_QUICKLY_FFPROBE=${join(media, 'bin/ffprobe.exe')}\n`);
}
console.log(`已校验媒体组件：${media}`);
