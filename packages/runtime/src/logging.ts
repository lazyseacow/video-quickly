import { createHash, randomUUID } from 'node:crypto';
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import electronLog from 'electron-log/node';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface DiagnosticLogger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): DiagnosticLogger;
}

const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const identifierFields = new Set(['requestId', 'projectId', 'runId', 'nodeId', 'activityId', 'shotId', 'modelId', 'assetId']);
const numberFields = new Set(['generation', 'durationMs', 'sequence', 'pendingCount', 'exitCode', 'statusCode', 'childPid', 'queueMs', 'byteSize', 'shotCount', 'pollCount', 'retryCount', 'retryDelayMs']);
const booleanFields = new Set(['packaged', 'cached', 'resumed', 'hasRemoteId']);
const tokenFields = new Set(['eventType', 'state', 'status', 'previousStatus', 'safety', 'reason', 'signal', 'platform', 'arch', 'component']);
const versionFields = new Set(['appVersion', 'nodeVersion', 'electronVersion']);
const enumFields: Record<string, ReadonlySet<string>> = {
  nodeKind: new Set(['brief', 'research', 'style', 'script', 'assets', 'animation', 'review', 'export', 'agent', 'condition', 'join', 'subflow']),
  provider: new Set(['openai-compatible', 'ollama', 'custom-http', 'comfyui', 'seedance', 'seedream']),
  phase: new Set(['queue', 'generate', 'submit', 'poll', 'download', 'validate', 'render']),
  requestPhase: new Set(['prepare', 'send', 'headers', 'read', 'parse', 'validate']),
};
const methodWords = new Set(('workspace snapshot summary project create get update archive restore backup importBackup saveShot shot candidate apply candidates regenerate ' +
  'run list start cancel resume review replay plan events activities diagnostics inspect step payload versions node result model save delete test discover ' +
  'skill import group resource toggle tool register cost task tasks character references workflow workflowTemplate seriesTemplate render batch export research search analyze source read ' +
  'asset select retain waveform caption system status runtime reconnect host secret set audio preview levels silence mix prepare edit history undo redo readiness recovery scan confirm').split(' '));
const builtinNodeIds = new Set(['brief', 'research', 'style', 'script', 'assets', 'video', 'animation', 'export', 'review', 'join', 'condition', 'subflow', 'agent']);
const errorNames = new Set(['Error', 'TypeError', 'SyntaxError', 'RangeError', 'ReferenceError', 'AggregateError', 'URIError', 'EvalError', 'AbortError', 'TimeoutError', 'ZodError', 'AmbiguousActivityError', 'ActivityInputChangedError', 'LockedShotChangeError', 'VideoGenerationError', 'ModelResponseValidationError', 'TextRequestRejectedError', 'MediaRequestRejectedError']);
const errorCodes = new Set([
  'EACCES', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EAGAIN', 'EAI_AGAIN', 'EBADF', 'EBUSY', 'ECANCELED', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET',
  'EEXIST', 'EHOSTDOWN', 'EHOSTUNREACH', 'EINTR', 'EINVAL', 'EIO', 'EISDIR', 'ELOOP', 'EMFILE', 'ENAMETOOLONG', 'ENETDOWN', 'ENETUNREACH',
  'ENFILE', 'ENOENT', 'ENOMEM', 'ENOSPC', 'ENOSYS', 'ENOTDIR', 'ENOTEMPTY', 'ENOTFOUND', 'ENOTSUP', 'EPERM', 'EPIPE', 'EPROTO', 'EROFS',
  'ESPIPE', 'ESRCH', 'ETIMEDOUT', 'EXDEV', 'ABORT_ERR', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_ABORTED', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

function frameLocation(file: string, line: string, column: string): string {
  // A provider can supply its own stack. Hash every basename rather than treating
  // filename syntax as proof that it contains no private content.
  const identity = /^sha256:[0-9a-f]{16}$/.test(file) ? file : `sha256:${createHash('sha256').update(file).digest('hex').slice(0, 16)}`;
  return `${identity}:${line}:${column}`;
}

export function safeLogMethod(value: unknown): string {
  if (value === 'skill.import.retry' || value === 'skill.uninstall' || value === 'skill.group.uninstall') return value;
  if (typeof value !== 'string' || value.length > 100) return 'unknown';
  const parts = value.split('.');
  return parts.length >= 2 && parts.length <= 4 && parts.every(part => methodWords.has(part)) ? value : 'unknown';
}

function identifier(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value !== 'string') return undefined;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) || /^sha256:[0-9a-f]{16}$/.test(value) || builtinNodeIds.has(value)) return value;
  // User-defined node/activity identifiers can contain arbitrary content.
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

/** Only allowlisted classifications and hashed locations survive, including nested causes. */
export function logError(error: unknown): Record<string, unknown> {
  return safeError(error, 0, new WeakSet());
}

function safeError(error: unknown, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  try {
    if (!error || typeof error !== 'object') return { name: 'Error' };
    seen.add(error);
    const record = error as Record<string, unknown>;
    const result: Record<string, unknown> = { name: typeof record.name === 'string' && errorNames.has(record.name) ? record.name : 'Error' };
    if (typeof record.code === 'string' && errorCodes.has(record.code)) result.code = record.code;
    const status = record.status ?? record.statusCode;
    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) result.statusCode = status;
    if (typeof record.stack === 'string') {
      // A provider error message can itself span lines that resemble call sites.
      // Strip the complete exception header before accepting V8's "at" frames.
      const header = Error.prototype.toString.call(error);
      const body = record.stack.startsWith(`${header}\n`) ? record.stack.slice(header.length + 1) : '';
      const frames = body.split('\n').slice(0, 8).flatMap(line => {
        const match = /^\s+at .*[/\\]([a-zA-Z0-9_.-]{1,80}):(\d+):(\d+)\)?$/.exec(line);
        return match ? [frameLocation(match[1], match[2], match[3])] : [];
      });
      if (frames.length) result.frames = frames;
    } else if (Array.isArray(record.frames)) {
      result.frames = record.frames.slice(0, 8).flatMap(frame => {
        const match = typeof frame === 'string' && /^((?:sha256:[0-9a-f]{16})|[a-zA-Z0-9_.-]{1,80}):(\d+):(\d+)$/.exec(frame);
        return match ? [frameLocation(match[1], match[2], match[3])] : [];
      });
    }
    if (depth < 3) {
      if (record.cause && typeof record.cause === 'object' && !seen.has(record.cause)) result.cause = safeError(record.cause, depth + 1, seen);
      if (Array.isArray(record.errors)) {
        const errors = record.errors.slice(0, 3).flatMap(item => item && typeof item === 'object' && !seen.has(item) ? [safeError(item, depth + 1, seen)] : []);
        if (errors.length) result.errors = errors;
      }
    }
    return result;
  } catch { return { name: 'Error' }; }
}

function safeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (identifierFields.has(key)) {
      const safe = identifier(value); if (safe !== undefined) result[key] = safe;
    } else if (numberFields.has(key) && typeof value === 'number' && Number.isFinite(value)) result[key] = Math.round(value * 100) / 100;
    else if (booleanFields.has(key) && typeof value === 'boolean') result[key] = value;
    else if (tokenFields.has(key) && typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(value)) result[key] = value;
    else if (versionFields.has(key) && typeof value === 'string' && /^v?\d+(?:\.\d+){0,3}(?:-[a-zA-Z0-9.]+)?$/.test(value)) result[key] = value;
    else if (Object.hasOwn(enumFields, key) && typeof value === 'string' && enumFields[key].has(value)) result[key] = value;
    else if (key === 'method') result[key] = safeLogMethod(value);
    else if (key === 'error') result[key] = logError(value);
  }
  return result;
}

let warnedAboutFile = false;
function reportFileFailure() {
  if (warnedAboutFile) return;
  warnedAboutFile = true;
  // The library's registry reports filesystem failures directly via its default
  // console transport. Replace that writer too: never forward a path or error body.
  process.stderr.write(`${JSON.stringify({ schemaVersion: 1, time: new Date().toISOString(), level: 'warn', component: 'logging', pid: process.pid, event: 'logging.file_unavailable' })}\n`);
}
electronLog.transports.console.level = false;
electronLog.transports.console.writeFn = reportFileFailure;

export function createLogger(options: { dataDirectory: string; component: 'runtime' | 'desktop'; level?: LogLevel; maxSize?: number }): DiagnosticLogger {
  const configured = options.level ?? process.env.VIDEO_QUICKLY_LOG_LEVEL;
  const threshold = levels.includes(configured as LogLevel) ? configured as LogLevel : 'info';
  const runtimeSessionId = randomUUID();
  const backend = electronLog.create({ logId: `video-quickly-${options.component}` });
  backend.transports.console.level = false;
  backend.transports.console.writeFn = reportFileFailure;
  backend.transports.file.setAppName('Video Quickly');
  backend.transports.file.resolvePathFn = () => join(options.dataDirectory, 'logs', `${options.component}.log`);
  backend.transports.file.maxSize = options.maxSize ?? 5 * 1024 * 1024;
  backend.transports.file.level = 'debug';
  backend.transports.file.sync = true;
  backend.transports.file.writeOptions = { flag: 'a', encoding: 'utf8', mode: 0o600 };
  backend.transports.file.format = '{text}';
  backend.transports.file.archiveLogFn = file => {
    try { renameSync(file.toString(), join(options.dataDirectory, 'logs', `${options.component}.old.log`)); }
    catch {
      // The library's crop fallback can leave half a JSON line. Preserve the
      // existing complete records and stop this sink until the next launch.
      backend.transports.file.level = false;
      reportFileFailure();
      throw new Error('Log file rotation unavailable');
    }
  };

  function child(context: Record<string, unknown>): DiagnosticLogger {
    function write(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
      if (levels.indexOf(level) < levels.indexOf(threshold)) return;
      try {
        const record = { ...safeFields({ ...context, ...fields }), schemaVersion: 1, time: new Date().toISOString(), level,
          component: typeof context.component === 'string' && /^[a-z-]{1,40}$/.test(context.component) ? context.component : options.component,
          runtimeSessionId, pid: process.pid, event: /^[a-z][a-z0-9_.]{0,99}$/.test(event) ? event : 'logging.invalid_event' };
        backend[level](JSON.stringify(record));
      } catch { reportFileFailure(); }
    }
    return { debug: (event, fields) => write('debug', event, fields), info: (event, fields) => write('info', event, fields),
      warn: (event, fields) => write('warn', event, fields), error: (event, fields) => write('error', event, fields),
      child: fields => child({ ...context, ...safeFields(fields) }) };
  }
  return child({});
}
