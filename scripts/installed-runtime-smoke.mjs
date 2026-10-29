import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

// This fixture writes only to the fresh CI account's application data directory.
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_OS !== 'Windows') throw new Error('安装验收只能在隔离的 Windows CI 环境执行');
const [mode, installDirectory, dataDirectory, evidence] = process.argv.slice(2);
if (!['prepare', 'verify', 'inspect'].includes(mode) || !installDirectory || !dataDirectory || !evidence) throw new Error('需要 prepare|verify|inspect、安装目录、数据目录和证据文件路径');
const sidecar = resolve(installDirectory, 'sidecar');
if (mode === 'inspect') {
  const require = createRequire(join(sidecar, 'package.json'));
  const Database = require('better-sqlite3');
  const db = new Database(join(dataDirectory, 'workspace.sqlite'), { readonly: true });
  try { assert.equal(db.pragma('user_version', { simple: true }), 2); assert.equal(db.pragma('quick_check', { simple: true }), 'ok'); } finally { db.close(); }
  console.log('原生客户端已完成数据库迁移');
  process.exit(0);
}
const child = spawn(join(sidecar, 'node.exe'), [join(sidecar, 'runtime.mjs'), '--data-dir', dataDirectory], { cwd: sidecar, windowsHide: true });
let sequence = 0;
const pending = new Map();
const input = createInterface({ input: child.stdout });
input.on('line', line => {
  const message = JSON.parse(line);
  const call = pending.get(message.id);
  if (!call) return;
  pending.delete(message.id); clearTimeout(call.timer);
  if (message.error) call.reject(new Error(message.error.message)); else call.resolve(message.result);
});
child.stderr.resume();
child.on('exit', () => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('安装后的执行组件提前退出')); } pending.clear(); });
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`安装验收请求超时：${method}`)); }, 20_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
async function runAt(id, status) {
  for (let i = 0; i < 100; i++) {
    const snapshot = await rpc('workspace.snapshot');
    const run = snapshot.runs.find(run => run.id === id);
    if (run?.status === status) return run;
    if (run?.status === 'failed') throw new Error(run.error);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`安装验收运行未达到 ${status}`);
}
try {
  const snapshot = await rpc('workspace.snapshot');
  assert.equal(snapshot.system.ffmpegAvailable, true);
  if (mode === 'prepare') {
    const project = await rpc('project.create', { title: '中文路径 安装升级验收' });
    const run = await rpc('run.start', { projectId: project.id, nodeId: 'style' });
    const review = await runAt(run.id, 'waiting_review');
    assert.equal(review.activities.length, 1);
    await writeFile(evidence, JSON.stringify({ projectId: project.id, runId: run.id }));
  } else {
    const saved = JSON.parse(await readFile(evidence, 'utf8'));
    assert.equal(snapshot.projects.find(project => project.id === saved.projectId)?.title, '中文路径 安装升级验收');
    const review = snapshot.runs.find(run => run.id === saved.runId);
    assert.equal(review.status, 'waiting_review'); assert.equal(review.activities.length, 1);
    await rpc('run.review', { runId: saved.runId, approved: true });
    assert.equal((await runAt(saved.runId, 'succeeded')).activities.length, 1);
    const exporter = await rpc('project.create', { title: '安装后导出', profile: { width: 320, height: 180, frameRate: { numerator: 30, denominator: 1 }, fitMode: 'contain', previewScale: .5 } });
    await rpc('project.saveShot', { projectId: exporter.id, shot: { id: 'installed-shot', title: '安装后的实际画面', narration: '安装后的本地小样', visualPrompt: '', durationUs: 500_000 } });
    const exported = await rpc('render.export', { projectId: exporter.id });
    await runAt(exported.runId, 'succeeded');
  }
} finally {
  const exited = new Promise(resolve => child.once('exit', resolve));
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
}
if (mode === 'prepare') {
  const require = createRequire(join(sidecar, 'package.json'));
  const Database = require('better-sqlite3');
  const db = new Database(join(dataDirectory, 'workspace.sqlite'));
  // Recreate the shipped unversioned baseline while keeping an actual graph checkpoint.
  try { db.exec('DROP INDEX execution_events_run_sequence; DROP TABLE schema_migrations; PRAGMA user_version = 0;'); } finally { db.close(); }
}
console.log(`安装后的执行组件验收通过：${mode}`);
