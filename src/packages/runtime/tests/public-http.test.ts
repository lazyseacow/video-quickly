import { createServer, type IncomingMessage, type RequestListener, type RequestOptions, type Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { openPublicHttp } from '../src/public-tool-download.js';

const { checkedAddresses, lookups } = vi.hoisted(() => ({ checkedAddresses: [] as unknown[], lookups: [] as string[] }));
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

const servers: Server[] = [];
afterEach(async () => {
  checkedAddresses.length = 0; lookups.length = 0;
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
async function listen(handler: RequestListener) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试服务未启动。');
  return `http://media.fixture:${address.port}`;
}

it('pins the vetted address on each public redirect and reads the final response', async () => {
  const headers: Array<{ authorization?: string; cookie?: string }> = [];
  const base = await listen((request, response) => {
    headers.push({ authorization: request.headers.authorization, cookie: request.headers.cookie });
    if (request.url === '/redirect') { response.writeHead(302, { location: '/source' }); response.end(); return; }
    response.end('Public source text');
  });
  const { response, url } = await openPublicHttp(`${base}/redirect`, new AbortController().signal);
  response.setEncoding('utf8');
  let body = '';
  for await (const chunk of response) body += chunk;
  expect(body).toBe('Public source text');
  expect(url).toBe(`${base}/source`);
  expect(headers).toEqual([{ authorization: undefined, cookie: undefined }, { authorization: undefined, cookie: undefined }]);
  expect(lookups).toEqual(['media.fixture', 'media.fixture']);
  expect(checkedAddresses).toEqual(Array.from({ length: 2 }, () => [{ address: '93.184.216.34', family: 4 }]));
});

it('blocks private literals, mixed DNS answers and redirects to local services before connecting', async () => {
  let requests = 0;
  const base = await listen((_request, response) => {
    requests++;
    response.writeHead(302, { location: 'http://127.0.0.1:' + new URL(base).port + '/secret' }); response.end();
  });
  const signal = new AbortController().signal;
  for (const address of ['127.1', '0x7f000001', '169.254.169.254', '100.64.0.1', '1.2.3.4', '[::1]', '[::ffff:127.0.0.1]', '[fc00::1]', '[2002:7f00:1::]']) {
    await expect(openPublicHttp('http://' + address, signal)).rejects.toThrow('公网');
  }
  await expect(openPublicHttp(base.replace('media.fixture', 'mixed.fixture'), signal)).rejects.toThrow('公网');
  await expect(openPublicHttp(base.replace('media.fixture', 'local.fixture'), signal)).rejects.toThrow('公网');
  expect(requests).toBe(0);
  await expect(openPublicHttp(base, signal)).rejects.toThrow('公网');
  expect(requests).toBe(1);
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
