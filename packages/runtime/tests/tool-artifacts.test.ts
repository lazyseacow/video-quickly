import { createServer, type IncomingMessage, type RequestListener, type RequestOptions, type Server } from 'node:http';
import { spawnSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { agentToolOutputDirectory, materializeToolArtifact } from '../src/tool-artifacts.js';
import { openPublicHttp } from '../src/public-tool-download.js';

const { checkedAddresses, lookups, race } = vi.hoisted(() => ({
  checkedAddresses: [] as unknown[], lookups: [] as string[],
  race: {} as { afterRealpath?: (path: string) => Promise<void>; afterOpen?: (path: string) => Promise<void> },
}));
vi.mock('node:fs/promises', async importOriginal => {
  const files = await importOriginal<typeof import('node:fs/promises')>();
  return { ...files,
    async realpath(path: string) {
      const result = await files.realpath(path);
      await race.afterRealpath?.(path);
      return result;
    },
    async open(path: string, flags?: string | number) {
      const file = await files.open(path, flags);
      await race.afterOpen?.(path);
      return file;
    },
  };
});
vi.mock('node:os', async importOriginal => {
  const os = await importOriginal<typeof import('node:os')>();
  return { ...os, networkInterfaces: () => ({ fixture: [{ address: '1.2.3.4', family: 'IPv4' }] }) };
});
vi.mock('node:dns', () => ({
  lookup(host: string, options: { all: boolean }, callback: (error: null, addresses: { address: string; family: number }[]) => void) {
    lookups.push(host);
    expect(options.all).toBe(true);
    const address = host === 'local.fixture' ? '1.2.3.4' : host.endsWith('.proxy.fixture') ? '198.18.0.3' : '93.184.216.34';
    callback(null, [{ address, family: 4 }, ...(host === 'mixed.fixture' ? [{ address: '192.168.0.4', family: 4 }] : [])]);
  },
}));
vi.mock('node:http', async importOriginal => {
  const http = await importOriginal<typeof import('node:http')>();
  return { ...http, get(url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) {
    // Route fixture hostnames to the test listener only after the production
    // lookup has supplied the addresses the real socket would consume.
    return http.get(url, { ...options, lookup(host, lookupOptions, done) {
      options.lookup!(host, lookupOptions, (error, addresses) => {
        if (error) { done(error, '', 0); return; }
        checkedAddresses.push(addresses);
        done(null, lookupOptions.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4);
      });
    } }, callback);
  } };
});

const directories: string[] = [], servers: Server[] = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=', 'base64');
afterEach(async () => {
  checkedAddresses.length = 0; lookups.length = 0;
  race.afterRealpath = undefined; race.afterOpen = undefined;
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function directory() { const path = await mkdtemp(join(tmpdir(), 'vq-tool-artifact-')); directories.push(path); return path; }
async function listen(handler: RequestListener) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试服务未启动。');
  return `http://media.fixture:${address.port}`;
}

it('downloads an HTTP tool artifact through redirects with no tool credentials and commits complete bytes', async () => {
  const headers: Array<{ authorization?: string; cookie?: string }> = [];
  const base = await listen((request, response) => {
    headers.push({ authorization: request.headers.authorization, cookie: request.headers.cookie });
    if (request.url === '/redirect?signature=fixture') { response.writeHead(302, { location: '/image' }); response.end(); return; }
    response.writeHead(200, { 'content-type': 'image/png; charset=binary' });
    response.write(png.subarray(0, 20)); response.end(png.subarray(20));
  });
  const target = await directory();
  const path = await materializeToolArtifact({ url: `${base}/redirect?signature=fixture` }, target, new AbortController().signal);
  expect(path.endsWith('.png')).toBe(true); expect(await readFile(path)).toEqual(png);
  expect(await readdir(target)).toEqual([path.slice(target.length + 1)]);
  expect(headers).toEqual([{ authorization: undefined, cookie: undefined }, { authorization: undefined, cookie: undefined }]);
  expect(lookups).toEqual(['media.fixture', 'media.fixture']);
  expect(checkedAddresses).toHaveLength(2);
});

it('materializes canonical embedded MCP image bytes and rejects invalid encoding, source combinations and MIME types', async () => {
  const target = await directory(), signal = new AbortController().signal;
  const path = await materializeToolArtifact({ data: png.toString('base64'), mimeType: 'image/png' }, target, signal);
  expect(await readFile(path)).toEqual(png);
  await expect(materializeToolArtifact({ data: '%%%=', mimeType: 'image/png' }, target, signal)).rejects.toThrow('base64');
  await expect(materializeToolArtifact({ data: 'AB==', mimeType: 'image/png' }, target, signal)).rejects.toThrow('base64');
  await expect(materializeToolArtifact({ data: png.toString('base64'), mimeType: 'text/html' }, target, signal)).rejects.toThrow('格式');
  await expect(materializeToolArtifact({ data: Buffer.from('plain text').toString('base64'), mimeType: 'image/png' }, target, signal)).rejects.toThrow('格式');
  await expect(materializeToolArtifact({ data: png.toString('base64'), url: 'https://example.invalid/image' }, target, signal)).rejects.toThrow('一种');
  await expect(materializeToolArtifact({ url: 'file:///tmp/image.png' }, target, signal)).rejects.toThrow('HTTP');
  await expect(materializeToolArtifact({ url: 'http://user:password@example.invalid/image' }, target, signal)).rejects.toThrow('HTTP');
  expect(await readdir(target)).toHaveLength(1);
});

it('blocks private literals, mixed DNS answers and redirects to local services before connecting', async () => {
  let requests = 0;
  const base = await listen((_request, response) => {
    requests++;
    response.writeHead(302, { location: 'http://127.0.0.1:' + new URL(base).port + '/secret' }); response.end();
  });
  const target = await directory(), signal = new AbortController().signal;
  for (const address of ['127.1', '0x7f000001', '169.254.169.254', '100.64.0.1', '1.2.3.4', '[::1]', '[::ffff:127.0.0.1]', '[fc00::1]', '[2002:7f00:1::]']) {
    await expect(materializeToolArtifact({ url: 'http://' + address }, target, signal)).rejects.toThrow('公网');
  }
  await expect(materializeToolArtifact({ url: base.replace('media.fixture', 'mixed.fixture') }, target, signal)).rejects.toThrow('公网');
  await expect(materializeToolArtifact({ url: base.replace('media.fixture', 'local.fixture') }, target, signal)).rejects.toThrow('公网');
  expect(requests).toBe(0);
  await expect(materializeToolArtifact({ url: base }, target, signal)).rejects.toThrow('公网');
  expect(requests).toBe(1);
  expect(await readdir(target)).toEqual([]);
});

it('resolves synthetic proxy addresses for webpage reads and connects only to the vetted public answer', async () => {
  let requests = 0;
  const base = await listen((_request, response) => { requests++; response.end('Public source text'); });
  const signal = new AbortController().signal;
  const proxyUrl = (host: string) => base.replace('media.fixture', host + '.proxy.fixture');
  const dns = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = new URL(String(input));
    expect(url.hostname).toBe('cloudflare-dns.com');
    const address = url.searchParams.get('name') === 'open.proxy.fixture' ? '93.184.216.34' : '192.168.0.4';
    return Response.json({ Status: 0, Answer: url.searchParams.get('type') === '1' ? [{ type: 1, data: address }] : [] });
  });
  try {
    const { response } = await openPublicHttp(proxyUrl('open'), signal, { publicDnsFallback: true });
    response.resume();
    await expect(openPublicHttp(proxyUrl('internal'), signal, { publicDnsFallback: true })).rejects.toThrow('公网');
    await expect(openPublicHttp(proxyUrl('open'), signal)).rejects.toThrow('公网');
    expect(checkedAddresses).toEqual([[{ address: '93.184.216.34', family: 4 }]]);
    expect(requests).toBe(1);
  } finally { dns.mockRestore(); }
});

it('rejects a misleading HTTP MIME declaration and validates generic signed-download content', async () => {
  const base = await listen((request, response) => {
    if (request.url === '/image') { response.writeHead(200, { 'content-type': 'application/octet-stream' }); response.end(png); return; }
    response.writeHead(200, { 'content-type': request.url === '/text' ? 'text/plain' : 'image/png' }); response.end('fake image');
  });
  const target = await directory(), signal = new AbortController().signal;
  for (const route of ['/text', '/fake']) await expect(materializeToolArtifact({ url: base + route, mimeType: 'image/png' }, target, signal)).rejects.toThrow('格式');
  const path = await materializeToolArtifact({ url: base + '/image', mimeType: 'image/png' }, target, signal);
  expect(await readFile(path)).toEqual(png);
  expect(await readdir(target)).toHaveLength(1);
});

it('accepts a local run output while rejecting another run, hard links and directory junctions', async () => {
  const workspace = await realpath(await directory()), root = await agentToolOutputDirectory(workspace, 'current-run');
  const other = await agentToolOutputDirectory(workspace, 'other-run'), target = await directory();
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested', 'source.png'), png);
  await writeFile(join(other, 'private.png'), png);
  await link(join(other, 'private.png'), join(root, 'hardlink.png'));
  await symlink(other, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const options = { localOutputDirectory: root }, signal = new AbortController().signal;
  for (const path of [join(other, 'private.png'), '../other-run/private.png', 'hardlink.png', 'alias/private.png']) {
    await expect(materializeToolArtifact({ path }, target, signal, options)).rejects.toThrow('产物目录');
  }
  const path = await materializeToolArtifact({ path: 'nested/source.png' }, target, signal, options);
  expect(await readFile(path)).toEqual(png);
});

it('rejects a directory switched to another run between path validation and open', async () => {
  const workspace = await realpath(await directory()), root = await agentToolOutputDirectory(workspace, 'active-run');
  const other = await agentToolOutputDirectory(workspace, 'another-run');
  const folder = join(root, 'nested'), held = join(root, 'held');
  const file = join(folder, 'picture.png'); await mkdir(folder);
  await writeFile(file, png); await writeFile(join(other, 'picture.png'), png);
  race.afterRealpath = async path => {
    if (path !== file) return;
    race.afterRealpath = undefined;
    await rename(folder, held);
    await symlink(other, folder, process.platform === 'win32' ? 'junction' : 'dir');
  };
  race.afterOpen = async path => {
    if (path !== file) return;
    race.afterOpen = undefined;
    await unlink(folder); await rename(held, folder);
  };
  const target = await directory();
  await expect(materializeToolArtifact({ path: file }, target, new AbortController().signal, { localOutputDirectory: root })).rejects.toThrow('产物目录');
  expect(await readdir(target)).toEqual([]);
});

const ffmpeg = process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
it.skipIf(spawnSync(ffmpeg, ['-version'], { windowsHide: true }).status !== 0)('rejects a video container with a track header but no decodable frames', async () => {
  const empty = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=size=32x32:rate=1',
    '-frames:v', '0', '-c:v', 'libx264', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'], { windowsHide: true });
  expect(empty.status, empty.stderr.toString()).toBe(0);
  const target = await directory();
  await expect(materializeToolArtifact({ data: empty.stdout.toString('base64'), mimeType: 'video/mp4' }, target, new AbortController().signal)).rejects.toThrow('格式');
  expect(await readdir(target)).toEqual([]);
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
