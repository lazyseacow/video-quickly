import { createWriteStream, mkdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';

// This is a diagnostic label allowlist, not an RPC dispatch contract. Never log
// unknown method strings, request parameters, headers or business responses.
const diagnosticMethods = new Set(['runtime.status', 'runtime.reconnect', 'workspace.summary', 'project.get', 'model.save', 'model.discover', 'run.plan', 'run.start', 'run.get', 'shot.regenerate']);

export function createRpcDiagnostics(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const output = createWriteStream(path, { flags: 'w' });
  const started = performance.now(), pending = new Set<() => void>();
  let requestId = 0, active = 0, entries = 0, omitted = 0, closed = false, failed = false;
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
      write('diagnostics.closed', { active, received: requestId, omitted }, true); closed = true;
      closing = new Promise<void>(resolve => output.end(() => resolve()));
      return closing;
    },
  };
}
