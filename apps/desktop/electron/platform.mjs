import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';

export const applicationId = 'net.lazyseacow.video-quickly';
export const applicationOrigin = 'video-quickly://app';
export const workspaceName = 'VideoQuickly-Electron';

export function workspaceDirectory({ platform = process.platform, home = homedir(), environment = process.env } = {}) {
  if (environment.VIDEO_QUICKLY_DATA_DIR) return resolve(environment.VIDEO_QUICKLY_DATA_DIR);
  // The new desktop owns a separate workspace; do not read or rewrite old data.
  if (platform === 'win32') return join(environment.APPDATA ?? join(home, 'AppData', 'Roaming'), workspaceName);
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', workspaceName);
  return join(environment.XDG_DATA_HOME ?? join(home, '.local', 'share'), workspaceName);
}

export function validPath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0') || value.length > 32_768) throw new Error('文件路径无效。');
  return value;
}

export async function fileInside(root, requested) {
  const directory = await realpath(root), path = await realpath(validPath(requested));
  const difference = relative(directory, path);
  if (!difference || difference === '..' || difference.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(difference)) throw new Error('文件不在工作区内。');
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error('文件不存在。');
  return { path, metadata };
}

const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.zip': 'application/zip', '.srt': 'application/x-subrip', '.vtt': 'text/vtt' };
export const contentSecurityPolicy = "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self' data:; script-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

export async function serveFile(root, requested, request) {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  let file;
  try { file = await fileInside(root, requested); } catch { return new Response(null, { status: 404 }); }
  const { path, metadata: { size } } = file;
  const headers = new Headers({ 'Content-Type': contentTypes[extname(path).toLowerCase()] ?? 'application/octet-stream', 'Content-Security-Policy': contentSecurityPolicy, 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
  let start = 0, end = size - 1, status = 200;
  const range = request.headers.get('Range');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] || match[2])) {
      start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(end, Number(match[2])) : end;
    }
    if (!match || !match[1] && !match[2] || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
      headers.set('Content-Range', `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    status = 206;
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  headers.set('Content-Length', String(Math.max(0, end - start + 1)));
  if (request.method === 'HEAD' || !size) return new Response(null, { status, headers });
  const stream = createReadStream(path, { start, end });
  if (request.signal.aborted) stream.destroy();
  const abort = () => stream.destroy();
  request.signal.addEventListener('abort', abort, { once: true });
  stream.once('close', () => request.signal.removeEventListener('abort', abort));
  return new Response(Readable.toWeb(stream), { status, headers });
}

export function rendererIsTrusted(event, contents, developmentUrl) {
  if (event.sender !== contents || !event.senderFrame || event.senderFrame !== contents.mainFrame) return false;
  try {
    const url = new URL(event.senderFrame.url);
    return developmentUrl ? url.origin === new URL(developmentUrl).origin : url.protocol === 'video-quickly:' && url.hostname === 'app';
  } catch { return false; }
}

export function pathDialogOptions(input) {
  if (!input || typeof input !== 'object' || !['file', 'directory', 'save'].includes(input.mode)) throw new Error('文件选择参数无效。');
  if (typeof input.title !== 'string' || input.title.length > 200) throw new Error('文件选择标题无效。');
  const options = { title: input.title };
  if (input.defaultPath) {
    if (typeof input.defaultPath !== 'string' || input.defaultPath.includes('\0') || input.defaultPath.length > 32_768) throw new Error('默认文件路径无效。');
    options.defaultPath = input.defaultPath;
  }
  if (input.extensions !== undefined) {
    if (!Array.isArray(input.extensions) || input.extensions.length > 30 || input.extensions.some(extension => typeof extension !== 'string' || !/^[a-zA-Z0-9]+$/.test(extension))) throw new Error('文件类型无效。');
    if (input.extensions.length) options.filters = [{ name: input.mode === 'save' ? '导出文件' : '素材文件', extensions: input.extensions }];
  }
  return { mode: input.mode, options };
}

export function validRuntimeRequest(input) {
  if (!input || typeof input !== 'object' || typeof input.method !== 'string' || !/^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+$/.test(input.method) || input.method.length > 150 || input.method.startsWith('host.')) throw new Error('桌面请求无效。');
  return { method: input.method, params: input.params ?? {} };
}

export function externalWebUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return undefined;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) return undefined;
    return url.href;
  } catch { return undefined; }
}
