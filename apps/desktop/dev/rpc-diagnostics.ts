import { createWriteStream, mkdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';

// This is a diagnostic label allowlist, not an RPC dispatch contract. Never log
// unknown method strings, request parameters, headers or business responses.
const diagnosticMethods = new Set(['runtime.status', 'runtime.reconnect', 'workspace.summary', 'project.get', 'model.save', 'model.discover', 'run.plan', 'run.start', 'run.get', 'shot.regenerate']);
const providerErrorCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_ABORTED', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH', 'ABORT_ERR']);

function providerErrorCode(error: unknown): string {
  try {
    const cause: unknown = error instanceof Error ? error.cause : undefined;
    const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
    return typeof code === 'string' && providerErrorCodes.has(code) ? code : 'other';
  } catch { return 'other'; }
}

export function createRpcDiagnostics(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const output = createWriteStream(path, { flags: 'w' });
  const started = performance.now(), pending = new Set<() => void>();
  let requestId = 0, active = 0, providerId = 0, providersActive = 0, entries = 0, omitted = 0, closed = false, failed = false;
  let closing: Promise<void> | undefined;
  output.on('error', () => { failed = true; console.warn('浏览器 RPC 诊断写入失败。'); });
  function write(event: string, fields: Record<string, string | number> = {}, final = false) {
    if (failed || closed) return;
    if (!final && entries >= 100_000) { omitted++; return; }
    entries++;
    output.write(JSON.stringify({ event, wallTimeMs: Date.now(), elapsedMs: performance.now() - started, ...fields }) + '\n');
  }
  write('diagnostics.started');
  let previous = performance.now(), heartbeat = previous;
  const timer = setInterval(() => {
    const current = performance.now(), delayMs = current - previous - 100;
    previous = current;
    if (delayMs > 250) write('event-loop.delayed', { delayMs, active });
    if (current - heartbeat >= 5_000) { heartbeat = current; write('diagnostics.heartbeat', { active, received: requestId, omitted }); }
  }, 100);
  timer.unref();

  return {
    textProvider<Request extends { operationId: string }, Result>(provider: (request: Request) => Promise<Result>) {
      return async (request: Request): Promise<Result> => {
        const id = ++providerId, received = performance.now();
        // The suffix is a user-defined node identity; retain only a valid run UUID.
        const runId = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):/i.exec(request.operationId)?.[1].toLowerCase();
        providersActive++;
        const fields = () => ({ providerId: id, ...(runId ? { runId } : {}), durationMs: performance.now() - received, providersActive });
        write('provider.started', fields());
        try {
          const result = await provider(request);
          providersActive--; write('provider.completed', fields());
          return result;
        } catch (error) {
          providersActive--; write('provider.failed', { ...fields(), code: providerErrorCode(error) });
          throw error;
        }
      };
    },
    request(request: IncomingMessage, response: ServerResponse) {
      const id = ++requestId, received = performance.now();
      let method: string | undefined, phase = 'reading';
      active++;
      const fields = () => ({ requestId: id, ...(method ? { method } : {}), durationMs: performance.now() - received, active });
      const bodyReceived = () => write('body.received', fields());
      const aborted = () => write('request.aborted', fields());
      function cleanup() {
        request.removeListener('end', bodyReceived); request.removeListener('aborted', aborted);
        response.removeListener('finish', finished); response.removeListener('close', interrupted);
        pending.delete(cleanup);
      }
      function finish(event: string) {
        active--; write(event, { ...fields(), status: response.statusCode }); cleanup();
      }
      const finished = () => finish('response.finished'), interrupted = () => finish('response.closed');
      request.once('end', bodyReceived); request.once('aborted', aborted);
      response.once('finish', finished); response.once('close', interrupted);
      pending.add(cleanup); write('request.received', fields());
      return {
        bodyDecoded(value: unknown) { method = typeof value === 'string' && diagnosticMethods.has(value) ? value : 'other'; phase = 'parsed'; write('body.decoded', fields()); },
        dispatchStarted() { phase = 'dispatching'; write('dispatch.started', fields()); },
        dispatchCompleted() { phase = 'serializing'; write('dispatch.completed', fields()); },
        failed() { write('request.failed', { ...fields(), phase }); },
      };
    },
    close() {
      if (closing) return closing;
      clearInterval(timer);
      for (const cleanup of pending) cleanup();
      write('diagnostics.closed', { active, received: requestId, providersActive, providersReceived: providerId, omitted }, true); closed = true;
      closing = new Promise<void>(resolve => output.end(() => resolve()));
      return closing;
    },
  };
}
