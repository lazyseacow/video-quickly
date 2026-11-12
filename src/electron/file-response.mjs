// @ts-check
import { extname } from 'node:path';

/** @type {Record<string, string>} */
const mediaContentTypes = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
};

/** @type {Record<string, string>} */
const applicationContentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.zip': 'application/zip',
  '.srt': 'application/x-subrip',
  '.vtt': 'text/vtt',
};

/**
 * @param {string} filePath
 * @param {'media' | 'application'} [scope]
 */
export function fileContentType(filePath, scope = 'media') {
  const extension = extname(filePath).toLowerCase();
  return mediaContentTypes[extension]
    ?? (scope === 'application' ? applicationContentTypes[extension] : undefined)
    ?? 'application/octet-stream';
}

/**
 * Resolve the single inclusive byte range supported by both file transports.
 * @param {number} size
 * @param {string | null} [requestedRange]
 */
export function resolveByteRange(size, requestedRange) {
  const lastByte = size - 1;
  if (!requestedRange) return { start: 0, end: lastByte, length: Math.max(0, lastByte + 1) };

  const match = /^bytes=(\d*)-(\d*)$/.exec(requestedRange);
  if (!match || (!match[1] && !match[2])) return undefined;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(lastByte, Number(match[2])) : lastByte;
  if (start < 0 || start > end || start >= size) return undefined;

  return { start, end, length: Math.max(0, end - start + 1), contentRange: `bytes ${start}-${end}/${size}` };
}
