import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
function fixtureSecretCall(method, params, values) {
  if (method === 'host.secret.set') { values.set(params.key, params.value); return null; }
  if (method === 'host.secret.get') return values.get(params.key) ?? null;
  if (method === 'host.secret.delete') { values.delete(params.key); return null; }
  throw new Error('不支持的安装夹具系统调用');
}

// This fixture writes only to the fresh CI account's application data directory.
if (process.env.GITHUB_ACTIONS !== 'true' || !['Windows','macOS'].includes(process.env.RUNNER_OS)) throw new Error('安装验收只能在隔离的 Windows/macOS CI 环境执行');
const [mode, installDirectory, dataDirectory, evidence] = process.argv.slice(2);
if (!['prepare', 'verify', 'inspect'].includes(mode) || !installDirectory || !dataDirectory || !evidence) throw new Error('需要安装验收模式、安装目录、数据目录和证据文件路径');
const sidecar = process.platform === 'darwin' ? resolve(installDirectory, 'Contents/Resources/sidecar') : resolve(installDirectory, 'resources', 'sidecar');
const extension = process.platform === 'win32' ? '.exe' : '';
if (mode === 'inspect') {
  const { WORKSPACE_MIGRATIONS } = await import('../src/packages/runtime/src/database.ts');
  const expectedVersion = WORKSPACE_MIGRATIONS.at(-1)?.version;
  const require = createRequire(join(sidecar, 'package.json'));
  const Database = require('better-sqlite3');
  const db = new Database(join(dataDirectory, 'workspace.sqlite'), { readonly: true });
  try {
    assert.equal(db.pragma('user_version', { simple: true }), expectedVersion);
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
  } finally { db.close(); }
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
    if ((Array.isArray(status) ? status : [status]).includes(run?.status)) return run;
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
    let project = await rpc('project.create', { title: '中文路径 安装验收' });
    project = await rpc('project.update', { projectId: project.id, revision: project.revision, patch: { workflow: { ...project.workflow, id: 'installation-local-check', stages: undefined, nodes: [{ id: 'style', kind: 'style', label: '本地风格确认', config: {} }], edges: [] } } });
    const run = await rpc('run.start', { projectId: project.id, nodeId: 'style' });
    const prepared = await runAt(run.id, 'succeeded');
    assert.equal(prepared.activities.length, 1);
    const image = `${evidence}.png`;
    await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=', 'base64'));
    const asset = await rpc('asset.import', { projectId: project.id, path: image, kind: 'image' });
    await writeFile(evidence, JSON.stringify({ projectId: project.id, runId: run.id, runStatus: prepared.status, asset }));
  } else {
    const saved = JSON.parse(await readFile(evidence, 'utf8'));
      assert.equal(snapshot.projects.find(project => project.id === saved.projectId)?.title, '中文路径 安装验收');
      const original = snapshot.runs.find(run => run.id === saved.runId);
      assert.equal(original.status, 'succeeded'); assert.equal(original.activities.length, 1);
      assert.equal((await runAt(saved.runId, 'succeeded')).activities.length, 1);
    const exporter = await rpc('project.create', { title: '安装后导出', profile: { width: 320, height: 180, frameRate: { numerator: 30, denominator: 1 }, fitMode: 'contain', previewScale: .5 } });
    await rpc('project.update', { projectId: exporter.id, revision: exporter.revision, patch: { shots: [{ id: 'installed-shot', title: '安装后的实际画面', narration: '安装后的本地小样', visualPrompt: '', durationUs: 500_000 }] } });
    const exported = await rpc('render.export', { projectId: exporter.id });
    await runAt(exported.runId, 'succeeded');
  }
} finally {
  const exited = new Promise(resolve => child.once('exit', resolve));
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
}
console.log(mode === 'prepare' ? '安装夹具的已完成运行、项目和素材已保存。' : '覆盖安装后已完成运行及活动保留、实际导出验收通过。');
