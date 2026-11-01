import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test, vi } from 'vitest';
import { createRpcDiagnostics } from '../apps/desktop/dev/rpc-diagnostics';
import { readRpcRequest } from '../apps/desktop/dev/read-rpc-request';

type Entry = { event: string; requestId?: number; method?: string; phase?: string; status?: number; active?: number; elapsedMs: number; wallTimeMs: number };

async function capture(body: string, outcome: 'succeed' | 'drop' | 'fail' = 'succeed') {
  const directory = await mkdtemp(join(tmpdir(), 'vq-rpc-diagnostics-')), path = join(directory, 'rpc.jsonl');
  const diagnostics = createRpcDiagnostics(path);
  const server = createServer((request, response) => { void (async () => {
    const diagnostic = diagnostics.request(request, response);
    try {
      const input = await readRpcRequest(request);
      diagnostic.bodyDecoded(input && typeof input === 'object' && 'method' in input ? input.method : undefined);
      diagnostic.dispatchStarted();
      if (outcome === 'drop') { response.destroy(); return; }
      if (outcome === 'fail') throw new Error('method-sensitive-fixture body-sensitive-fixture');
      diagnostic.dispatchCompleted();
      response.end(JSON.stringify({ result: 'response-sensitive-fixture' }));
    } catch {
      diagnostic.failed(); response.statusCode = 400; response.end(JSON.stringify({ error: 'response-sensitive-fixture' }));
    }
  })(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('RPC fixture did not listen');
  try {
    const result = fetch(`http://127.0.0.1:${address.port}/`, { method: 'POST', body, headers: { authorization: 'header-sensitive-fixture' } });
    if (outcome === 'drop') await expect(result).rejects.toThrow(); else await (await result).text();
    await diagnostics.close(); await diagnostics.close();
    const text = await readFile(path, 'utf8');
    expect(text).not.toMatch(/body-sensitive-fixture|header-sensitive-fixture|response-sensitive-fixture|method-sensitive-fixture/);
    return text.trim().split('\n').map(line => JSON.parse(line) as Entry);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await diagnostics.close(); await rm(directory, { recursive: true, force: true });
  }
}

test('records actual RPC request, body, dispatch and response phases without business input or output', async () => {
  const entries = await capture(JSON.stringify({ method: 'model.save', params: { secret: 'body-sensitive-fixture' } }));
  expect(entries.map(entry => entry.event)).toEqual(['diagnostics.started', 'request.received', 'body.received', 'body.decoded', 'dispatch.started', 'dispatch.completed', 'response.finished', 'diagnostics.closed']);
  const request = entries.filter(entry => entry.requestId === 1);
  expect(request.filter(entry => entry.method).map(entry => entry.method)).toEqual(['model.save', 'model.save', 'model.save', 'model.save']);
  expect(request.at(-1)).toMatchObject({ event: 'response.finished', status: 200, active: 0 });
  expect(request.every((entry, index) => entry.elapsedMs >= (request[index - 1]?.elapsedMs ?? 0) && Number.isFinite(entry.wallTimeMs))).toBe(true);
});

test('records malformed JSON as a read failure without retaining raw bytes or exception messages', async () => {
  const entries = await capture('{"method":"method-sensitive-fixture","secret":"body-sensitive-fixture",');
  expect(entries.map(entry => entry.event)).toEqual(['diagnostics.started', 'request.received', 'body.received', 'request.failed', 'response.finished', 'diagnostics.closed']);
  expect(entries.find(entry => entry.event === 'request.failed')).toMatchObject({ phase: 'reading' });
  expect(entries.find(entry => entry.event === 'response.finished')).toMatchObject({ status: 400, active: 0 });
});

test('redacts unrecognized methods and dispatch exception details', async () => {
  const entries = await capture(JSON.stringify({ method: 'method-sensitive-fixture', params: { secret: 'body-sensitive-fixture' } }), 'fail');
  expect(entries.filter(entry => entry.method).every(entry => entry.method === 'other')).toBe(true);
  expect(entries.find(entry => entry.event === 'request.failed')).toMatchObject({ method: 'other', phase: 'dispatching' });
  expect(entries.find(entry => entry.event === 'response.finished')).toMatchObject({ status: 400, active: 0 });
});

test('distinguishes an interrupted response from a finished one', async () => {
  const entries = await capture(JSON.stringify({ method: 'model.save' }), 'drop');
  expect(entries.some(entry => entry.event === 'response.finished')).toBe(false);
  expect(entries.find(entry => entry.event === 'response.closed')).toMatchObject({ requestId: 1, method: 'model.save', active: 0 });
  expect(entries.at(-1)).toMatchObject({ event: 'diagnostics.closed', active: 0 });
});

test('clears the diagnostic timer on close', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-rpc-diagnostic-close-'));
  vi.useFakeTimers();
  try {
    const diagnostics = createRpcDiagnostics(join(directory, 'rpc.jsonl'));
    expect(vi.getTimerCount()).toBe(1);
    await diagnostics.close(); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); await rm(directory, { recursive: true, force: true }); }
});
