import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { fixtureSecretCall } from './installed-upgrade-fixture.mjs';

// This fixture writes only to the fresh CI account's application data directory.
if (process.env.GITHUB_ACTIONS !== 'true' || !['Windows','macOS'].includes(process.env.RUNNER_OS)) throw new Error('安装验收只能在隔离的 Windows/macOS CI 环境执行');
const [mode, installDirectory, dataDirectory, evidence] = process.argv.slice(2);
if (!['prepare', 'verify', 'inspect'].includes(mode) || !installDirectory || !dataDirectory || !evidence) throw new Error('需要安装验收模式、安装目录、数据目录和证据文件路径');
const sidecar = process.platform === 'darwin' ? resolve(installDirectory, 'Contents/Resources/sidecar') : resolve(installDirectory, 'resources', 'sidecar');
const extension = process.platform === 'win32' ? '.exe' : '';
if (mode === 'inspect') {
  const require = createRequire(join(sidecar, 'package.json'));
  const Database = require('better-sqlite3');
  const db = new Database(join(dataDirectory, 'workspace.sqlite'), { readonly: true });
  try { assert.equal(db.pragma('user_version', { simple: true }), 7); assert.equal(db.pragma('quick_check', { simple: true }), 'ok'); } finally { db.close(); }
  console.log('原生客户端已完成数据库迁移');
  process.exit(0);
}
const child = spawn(join(sidecar, `node${extension}`), [join(sidecar, 'runtime.mjs'), '--data-dir', dataDirectory], { cwd: sidecar, windowsHide: true, env: { ...process.env, VIDEO_QUICKLY_FFMPEG: join(sidecar, 'media', `ffmpeg${extension}`), VIDEO_QUICKLY_FFPROBE: join(sidecar, 'media', `ffprobe${extension}`) } });
let sequence = 0;
const pending = new Map();
const fixtureSecrets = new Map();
const input = createInterface({ input: child.stdout });
input.on('line', line => {
  const message = JSON.parse(line);
  if (typeof message.id === 'string' && typeof message.method === 'string' && message.method.startsWith('host.secret.')) {
    try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: fixtureSecretCall(message.method, message.params, fixtureSecrets) })}\n`); }
    catch { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { message: '不支持的安装凭据夹具请求' } })}\n`); }
    return;
  }
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
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const snapshot = await rpc('workspace.snapshot');
    const run = snapshot.runs.find(run => run.id === id);
    if (run?.status === status) return run;
    if (run?.status === 'failed') throw new Error(run.error);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`安装验收运行未达到 ${status}`);
}
try {
  const summary = await rpc('workspace.summary');
  assert.equal(summary.system.mode, 'desktop');
  assert.ok(summary.projects.every(project => Number.isInteger(project.shotCount) && !('shots' in project)));
  const snapshot = await rpc('workspace.snapshot');
  assert.equal(snapshot.system.ffmpegAvailable, true);
  if (mode === 'prepare') {
    const project = await rpc('project.create', { title: '中文路径 安装升级验收' });
    const run = await rpc('run.start', { projectId: project.id, nodeId: 'style' });
    const review = await runAt(run.id, 'waiting_review');
    assert.equal(review.activities.length, 1);
    // waiting_review is visible before LangGraph necessarily commits its native
    // interrupt. Observe the durable row before terminating this fixture process.
    const fromSidecar = createRequire(join(sidecar, 'package.json'));
    const Database = fromSidecar('better-sqlite3'), checkpoint = new Database(join(dataDirectory, 'workspace.sqlite'), { readonly: true });
    try {
      const deadline = Date.now() + 20_000;
      while (!checkpoint.prepare("SELECT 1 FROM writes WHERE thread_id = ? AND channel = '__interrupt__' LIMIT 1").get(run.id)) {
        if (Date.now() >= deadline) throw new Error('安装夹具的原生审阅检查点尚未提交');
        await new Promise(resolveWait => setTimeout(resolveWait, 30));
      }
    } finally { checkpoint.close(); }
    const image = `${evidence}.png`;
    await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=', 'base64'));
    const asset = await rpc('asset.import', { projectId: project.id, path: image, kind: 'image' });
    await writeFile(evidence, JSON.stringify({ projectId: project.id, runId: run.id, asset }));
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
console.log(`安装后的执行组件验收通过：${mode}`);
