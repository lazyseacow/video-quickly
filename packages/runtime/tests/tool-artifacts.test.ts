import { createServer, type RequestListener, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { materializeToolArtifact } from '../src/tool-artifacts.js';

const directories: string[] = [], servers: Server[] = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function directory() { const path = await mkdtemp(join(tmpdir(), 'vq-tool-artifact-')); directories.push(path); return path; }
async function listen(handler: RequestListener) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试服务未启动。');
  return `http://127.0.0.1:${address.port}`;
}

it('downloads an HTTP tool artifact through redirects with no tool credentials and commits complete bytes', async () => {
  const headers: Array<{ authorization?: string; cookie?: string }> = [];
  const base = await listen((request, response) => {
    headers.push({ authorization: request.headers.authorization, cookie: request.headers.cookie });
    if (request.url === '/redirect') { response.writeHead(302, { location: '/image' }); response.end(); return; }
    response.writeHead(200, { 'content-type': 'image/png; charset=binary' });
    response.write(png.subarray(0, 20)); response.end(png.subarray(20));
  });
  const target = await directory();
  const path = await materializeToolArtifact({ url: `${base}/redirect` }, target, new AbortController().signal);
  expect(path.endsWith('.png')).toBe(true); expect(await readFile(path)).toEqual(png);
  expect(await readdir(target)).toEqual([path.slice(target.length + 1)]);
  expect(headers).toEqual([{ authorization: undefined, cookie: undefined }, { authorization: undefined, cookie: undefined }]);
});

it('materializes canonical embedded MCP image bytes and rejects invalid encoding, source combinations and MIME types', async () => {
  const target = await directory(), signal = new AbortController().signal;
  const path = await materializeToolArtifact({ data: png.toString('base64'), mimeType: 'image/png' }, target, signal);
  expect(await readFile(path)).toEqual(png);
  await expect(materializeToolArtifact({ data: '%%%=', mimeType: 'image/png' }, target, signal)).rejects.toThrow('base64');
  await expect(materializeToolArtifact({ data: 'AB==', mimeType: 'image/png' }, target, signal)).rejects.toThrow('base64');
  await expect(materializeToolArtifact({ data: png.toString('base64'), mimeType: 'text/html' }, target, signal)).rejects.toThrow('MIME');
  await expect(materializeToolArtifact({ data: png.toString('base64'), url: 'https://example.invalid/image' }, target, signal)).rejects.toThrow('一种');
  await expect(materializeToolArtifact({ url: 'file:///tmp/image.png' }, target, signal)).rejects.toThrow('HTTP');
  await expect(materializeToolArtifact({ url: 'http://user:password@example.invalid/image' }, target, signal)).rejects.toThrow('HTTP');
  expect(await readdir(target)).toHaveLength(1);
});

it('rejects oversized HTTP responses before saving a partial file', async () => {
  const base = await listen((_request, response) => { response.writeHead(200, { 'content-type': 'image/png', 'content-length': '100000001' }); response.end('x'); });
  const target = await directory();
  await expect(materializeToolArtifact({ url: base }, target, new AbortController().signal)).rejects.toThrow('100 MB');
  expect(await readdir(target)).toEqual([]);
});

it('cancels an active download and removes its partial output', async () => {
  const controller = new AbortController();
  const base = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'video/mp4' }); response.write(png);
    setTimeout(() => controller.abort(), 30);
  });
  const target = await directory();
  await expect(materializeToolArtifact({ url: base }, target, controller.signal)).rejects.toThrow();
  expect(await readdir(target)).toEqual([]);
});
