import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** Owns one stdio generation. Failed requests are never replayed on reconnect. */
export class RuntimeController {
  #options; #session; #generation = 0; #sequence = 0; #closing = false;
  #operation = Promise.resolve(); #listeners = new Set();
  #status = { state: 'disconnected', generation: 0 };

  constructor(options) {
    this.#options = options;
    if (options.onEvent) this.#listeners.add(options.onEvent);
  }
  #log(level, event, fields = {}) {
    this.#options.logger?.[level](event, { generation: this.#generation, ...fields });
  }
  status() { return { ...this.#status }; }
  subscribe(listener) {
    this.#listeners.add(listener);
    listener({ type: 'runtime.connection', data: this.status() });
    return () => this.#listeners.delete(listener);
  }
  #emit(event) { for (const listener of this.#listeners) listener(event); }
  #state(state, message) {
    this.#status = { state, generation: this.#generation, ...(message ? { message } : {}) };
    this.#log('info', 'runtime.connection_changed', { state });
    this.#emit({ type: 'runtime.connection', data: this.status() });
  }
  #serialize(action) {
    const result = this.#operation.then(action);
    this.#operation = result.catch(() => {});
    return result;
  }
  start() { return this.reconnect(); }
  reconnect() {
    return this.#serialize(async () => {
      if (this.#closing) throw new Error('应用正在退出。');
      if (this.#status.state === 'ready' && this.#session && this.#session.child.exitCode === null && !this.#session.exited) return this.status();
      await this.#stop();
      this.#generation++;
      this.#state('reconnecting');
      try { await this.#spawn(); return this.status(); }
      catch (error) {
        this.#log('error', 'runtime.reconnect_failed', { reason: 'startup_failed' });
        await this.#stop();
        this.#state('disconnected', error.message);
        throw error;
      }
    });
  }
  async #spawn() {
    const { command, args = [], cwd, env, readyTimeoutMs = 60_000 } = this.#options;
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env, VIDEO_QUICKLY_MODE: 'desktop' },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    let readyResolve, readyReject, exitResolve;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const exited = new Promise(resolve => { exitResolve = resolve; });
    const session = { child, pending: new Map(), generation: this.#generation, exited: false, terminal: false, stopping: false, exit: exited };
    this.#session = session;
    this.#log('info', 'runtime.spawned', { childPid: child.pid });
    const timeout = setTimeout(() => session.fail('执行组件启动未完成，请检查组件后重新连接。', 'startup_timeout'), readyTimeoutMs);
    const disconnect = (message, reason) => {
      if (session.terminal) return;
      session.terminal = true;
      // Freeze the order of shutdown and failure: callers may begin cleanup as
      // soon as stdout closes, before Node delivers the process exit event.
      session.stopRequestedBeforeDisconnect = session.stopping;
      this.#log(session.stopping ? 'info' : 'warn', 'runtime.disconnected', { generation: session.generation, reason, pendingCount: session.pending.size });
      readyReject(new Error(message));
      for (const [id, { reject, timer, method, started }] of session.pending) {
        this.#log('warn', 'rpc.aborted', { generation: session.generation, requestId: id, method, durationMs: Math.round(performance.now() - started), reason });
        clearTimeout(timer); reject(new Error(message));
      }
      session.pending.clear();
      if (this.#session === session) this.#state('disconnected', message);
    };
    session.fail = disconnect;
    child.once('error', () => { this.#log('error', 'runtime.spawn_failed', { generation: session.generation, reason: 'spawn_error' }); disconnect('无法启动本地执行组件，请检查安装内容。', 'spawn_error'); });
    child.once('exit', (code, signal) => {
      session.exited = true;
      const failed = code !== null && code !== 0;
      const requestedStop = session.stopping && session.stopRequestedBeforeDisconnect !== false;
      this.#log(failed || !requestedStop ? 'error' : 'info', 'runtime.exited', { generation: session.generation, exitCode: code, signal, reason: failed ? 'nonzero_exit' : requestedStop ? 'requested_stop' : 'unexpected_exit' });
      disconnect('本地执行组件已退出，请重新连接后核对任务状态。', 'process_exit'); exitResolve();
    });
    child.stdin.on('error', () => disconnect('执行通道已关闭，请核对操作是否完成。', 'stdin_error'));
    // Drain diagnostics without forwarding arbitrary provider output or credentials.
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('close', () => disconnect('本地执行组件已失联，请重新连接后核对操作是否完成。', 'stdout_closed'));
    lines.on('line', line => {
      if (this.#session !== session || session.exited || session.terminal) return;
      let message;
      try { message = JSON.parse(line); } catch { disconnect('执行组件返回了无效消息。', 'invalid_json'); return; }
      if (!message || typeof message !== 'object') return;
      if (message.method === 'runtime.ready') { this.#state('ready'); readyResolve(); this.#emit({ type: 'runtime.ready' }); }
      else if (message.method === 'runtime.failed') disconnect('本地工作区无法打开，请检查数据目录及安装内容。', 'workspace_unavailable');
      else if (message.method === 'runtime.event') this.#emit(message.params);
      else if (typeof message.method === 'string' && message.method.startsWith('host.')) {
        void Promise.resolve().then(() => {
          if (!['host.secret.get', 'host.secret.set', 'host.secret.delete'].includes(message.method)) throw new Error('不支持的系统操作。');
          return this.#options.hostRequest(message.method, message.params);
        }).then(result => this.#write(session, { jsonrpc: '2.0', id: message.id, result: result ?? null }),
          () => {
            this.#log('warn', 'runtime.host_request_failed', { generation: session.generation, reason: 'credential_operation_failed' });
            return this.#write(session, { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: '系统凭据操作失败。' } });
          })
          .catch(() => disconnect('执行通道已关闭，请核对操作是否完成。', 'host_response_write_failed'));
      } else if (typeof message.id === 'number') {
        const pending = session.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer); session.pending.delete(message.id);
        this.#log(message.error ? 'warn' : 'debug', message.error ? 'rpc.failed' : 'rpc.completed', {
          generation: session.generation, requestId: message.id, method: pending.method, durationMs: Math.round(performance.now() - pending.started), ...(message.error ? { reason: 'runtime_error' } : {}),
        });
        if (message.error) pending.reject(new Error(typeof message.error.message === 'string' ? message.error.message : '操作失败。'));
        else pending.resolve(message.result);
      }
    });
    try {
      if (child.pid) {
        try { session.container = this.#options.onSpawn?.(child); }
        catch (error) { session.fail(error instanceof Error ? error.message : '无法设置本地任务退出规则。', 'containment_failed'); }
      }
      await ready;
    } finally { clearTimeout(timeout); }
  }
  #write(session, message) {
    if (this.#session !== session || session.exited || session.terminal || session.child.stdin.destroyed) return Promise.reject(new Error('执行通道已关闭。'));
    return new Promise((resolve, reject) => session.child.stdin.write(`${JSON.stringify(message)}\n`, error => error ? reject(error) : resolve()));
  }
  async request(method, params = {}) {
    if (typeof method !== 'string' || method.startsWith('host.')) {
      this.#log('warn', 'rpc.rejected', { method: 'unknown', reason: 'invalid_method' });
      return Promise.reject(new Error('该操作不能由界面调用。'));
    }
    // The window can invoke RPC before an explicit start/reconnect is ready.
    await this.#operation;
    const session = this.#session;
    if (this.#closing || this.#status.state !== 'ready' || !session) {
      this.#log('warn', 'rpc.rejected', { method, reason: 'not_connected' });
      return Promise.reject(new Error('本地执行组件未连接，请先重新连接。'));
    }
    const id = ++this.#sequence;
    const started = performance.now();
    this.#log('debug', 'rpc.started', { requestId: id, method });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#log('error', 'rpc.timeout', { generation: session.generation, requestId: id, method, durationMs: Math.round(performance.now() - started) });
        session.fail('执行组件请求超时，请重新连接后核对操作是否完成。', 'request_timeout');
      }, this.#options.requestTimeoutMs ?? 180_000);
      session.pending.set(id, { resolve, reject, timer, method, started });
      void this.#write(session, { jsonrpc: '2.0', id, method, params }).catch(() => {
        session.fail('执行通道写入失败，请核对操作是否完成。', 'request_write_failed');
      });
    });
  }
  async #stop() {
    const session = this.#session;
    if (!session) return;
    session.stopping = true;
    this.#log('info', 'runtime.stopping', { generation: session.generation, pendingCount: session.pending.size });
    for (const [id, { reject, timer, method, started }] of session.pending) {
      this.#log('warn', 'rpc.aborted', { generation: session.generation, requestId: id, method, durationMs: Math.round(performance.now() - started), reason: 'requested_stop' });
      clearTimeout(timer); reject(new Error('执行组件已停止，请核对操作是否完成。'));
    }
    session.pending.clear();
    if (!session.exited) {
      session.child.stdin.end();
      let timer;
      try { await Promise.race([session.exit, new Promise(resolve => { timer = setTimeout(() => { this.#log('warn', 'runtime.shutdown_timeout', { generation: session.generation }); resolve(); }, this.#options.shutdownTimeoutMs ?? 15_000); })]); }
      finally { clearTimeout(timer); }
    }
    // Reap the whole process group, including an encoder whose parent already exited.
    if (session.container) {
      session.container.close(); session.container = undefined;
    } else if (process.platform !== 'win32' && session.child.pid) {
      try { process.kill(-session.child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    } else if (!session.exited && session.child.pid) {
      await new Promise((resolve, reject) => {
        const killer = spawn('taskkill.exe', ['/PID', String(session.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', reject); killer.once('exit', resolve);
      });
    }
    if (!session.exited && session.child.pid) {
      let timer;
      try { await Promise.race([session.exit, new Promise((_, reject) => { timer = setTimeout(() => { this.#log('error', 'runtime.shutdown_failed', { generation: session.generation, reason: 'process_still_running' }); reject(new Error('原执行组件尚未退出，未启动新的执行组件。')); }, 5_000); })]); }
      finally { clearTimeout(timer); }
    }
    if (this.#session === session) this.#session = undefined;
  }
  close() {
    this.#closing = true;
    return this.#serialize(async () => { await this.#stop(); this.#state('disconnected', '执行组件已停止。'); this.#listeners.clear(); });
  }
}
