import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// A fixture value, never an account credential and never written to evidence.
export const upgradeFixtureSecret = 'video-quickly-synthetic-upgrade-fixture-not-a-real-key';

export function fixtureSecretCall(method, params, values) {
  assert.match(params?.key ?? '', /^model:/, '凭据夹具只支持模型引用');
  if (method === 'host.secret.set') { assert.equal(params.value, upgradeFixtureSecret); values.set(params.key, params.value); return null; }
  if (method === 'host.secret.get') return values.get(params.key) ?? null;
  if (method === 'host.secret.delete') { values.delete(params.key); return null; }
  throw new Error('不支持的安装夹具系统调用');
}

export async function prepareInstalledUpgrade(rpc, directory, waitRun) {
  let project = await rpc('project.create', { title: '真实旧版本 中文路径升级验收' });
  await rpc('project.saveShot', { projectId: project.id, shot: { id: 'upgrade-shot', title: '旧版本真实素材', narration: '保留旧版本旁白', visualPrompt: '', durationUs: 500_000 } });
  const sourcePath = join(directory, 'upgrade-source.png');
  await writeFile(sourcePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  const asset = await rpc('asset.import', { projectId: project.id, shotId: 'upgrade-shot', path: sourcePath, kind: 'image' });
  const model = await rpc('model.save', { model: { name: '升级夹具：不发起网络请求', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'unused-upgrade-fixture', capabilities: ['image'] }, secret: upgradeFixtureSecret });
  assert.equal(model.hasSecret, true); assert.ok(model.credentialRef);
  project = (await rpc('project.get', { projectId: project.id })).project;
  await rpc('workflow.save', { projectId: project.id, revision: project.revision, workflow: { ...project.workflow, nodes: project.workflow.nodes.map(node => node.kind === 'assets' ? { ...node, modelId: model.id } : node) } });
  project = (await rpc('project.get', { projectId: project.id })).project;
  const run = await rpc('run.start', { projectId: project.id, nodeId: 'style' }), review = await waitRun(run.id, 'waiting_review');
  assert.equal(review.activities.length, 1);
  return { version: 1, projectId: project.id, runId: run.id, project, asset, model, activity: review.activities[0] };
}

export async function verifyInstalledUpgrade(rpc, saved, waitRun) {
  const snapshot = await rpc('workspace.snapshot');
  assert.deepEqual(snapshot.projects.find(project => project.id === saved.projectId), saved.project, '升级改变了原项目或修订');
  assert.deepEqual(snapshot.assets.find(asset => asset.id === saved.asset.id), saved.asset, '素材身份或引用改变');
  assert.equal(createHash('sha256').update(await readFile(saved.asset.path)).digest('hex'), saved.asset.sha256, '原素材文件损坏');
  assert.deepEqual(snapshot.models.find(model => model.id === saved.model.id), saved.model, '模型或凭据引用改变');
  const review = snapshot.runs.find(run => run.id === saved.runId);
  assert.equal(review?.status, 'waiting_review'); assert.equal(review.activities.length, 1);
  for (const key of ['id', 'nodeId', 'inputHash', 'result']) assert.deepEqual(review.activities[0][key], saved.activity[key], `旧活动 ${key} 改变`);
  assert.equal((await rpc('run.replay', { runId: saved.runId })).matchesSnapshot, true);
  await rpc('run.review', { runId: saved.runId, approved: true });
  const completed = await waitRun(saved.runId, 'succeeded'); assert.equal(completed.activities.length, 1);
  for (const key of ['id', 'nodeId', 'inputHash', 'result']) assert.deepEqual(completed.activities[0][key], saved.activity[key], `恢复重做了旧活动 ${key}`);
  return { projectRetained: true, assetReferenceRetained: true, modelCredentialReferenceRetained: true, originalRunRetained: true, completedActivityReused: true, nativeCredentialStoreRoundTrip: 'not-tested' };
}

export async function verifyUpgradeBackup(dataDirectory, saved, Database) {
  const directory = join(dataDirectory, 'database-backups');
  const names = (await readdir(directory)).filter(name => /^workspace-v6-to-v7-[a-f0-9-]+\.sqlite$/.test(name));
  assert.equal(names.length, 1, '真实升级必须恰有一份 Schema 6 到 7 的迁移前快照');
  const path = join(directory, names[0]);
  assert.ok((await lstat(path)).isFile(), '迁移快照须为普通文件');
  const backup = new Database(path, { readonly: true, fileMustExist: true });
  let schemaVersion, quickCheck;
  try {
    schemaVersion = backup.pragma('user_version', { simple: true }); quickCheck = backup.pragma('quick_check', { simple: true });
    assert.equal(schemaVersion, saved.schemaVersion); assert.equal(schemaVersion, 6); assert.equal(quickCheck, 'ok');
    const document = (kind, id) => {
      const row = backup.prepare('SELECT body FROM documents WHERE kind = ? AND id = ?').get(kind, id);
      assert.ok(row, `迁移快照缺少 ${kind} 记录`); return JSON.parse(row.body);
    };
    assert.deepEqual(document('project', saved.projectId), saved.project, '快照未保留原项目与修订');
    assert.deepEqual(document('asset', saved.asset.id), saved.asset, '快照未保留原素材引用');
    assert.deepEqual(document('model', saved.model.id), saved.model, '快照未保留模型凭据引用');
    const run = document('run', saved.runId); assert.equal(run.status, 'waiting_review'); assert.equal(run.projectId, saved.projectId);
    const activity = backup.prepare('SELECT * FROM activities WHERE run_id = ? AND activity_id = ?').get(saved.runId, saved.activity.id);
    assert.equal(activity?.status, 'completed'); assert.equal(activity.input_hash, saved.activity.inputHash); assert.deepEqual(JSON.parse(activity.result), saved.activity.result);
    assert.ok(backup.prepare("SELECT 1 FROM writes WHERE thread_id = ? AND channel = '__interrupt__' LIMIT 1").get(saved.runId), '快照缺少原生待审检查点');
  } finally { backup.close(); }
  return { path, sha256: createHash('sha256').update(await readFile(path)).digest('hex'), schemaVersion, quickCheck, projectRetained: true, assetReferenceRetained: true, modelCredentialReferenceRetained: true, originalRunRetained: true, completedActivityRetained: true, nativeReviewCheckpointRetained: true };
}
