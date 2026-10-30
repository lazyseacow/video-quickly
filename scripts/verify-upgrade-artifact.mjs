import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const upgradeBaseline = Object.freeze({
  repository: 'lazyseacow/video-quickly', runId: 41037906003, artifactId: 12969229961,
  commit: '85507a1718f16f197a1dd510707cdbd9b6936181', version: '0.1.0', schemaVersion: 6,
  artifactName: 'video-quickly-windows-x64-85507a1718f16f197a1dd510707cdbd9b6936181',
  artifactDigest: 'sha256:04cf6cea4cb32d19ad09b247598244c40659caf77c5745d8e505ee17f5832a7e',
});

export function verifyBaselineMetadata(artifact, run) {
  assert.equal(artifact.id, upgradeBaseline.artifactId, '旧产物 ID 不匹配');
  assert.equal(artifact.name, upgradeBaseline.artifactName, '旧产物名称不匹配');
  assert.equal(artifact.expired, false, '固定旧产物已过期；需要审核并保留新的真实升级基线');
  assert.equal(artifact.digest, upgradeBaseline.artifactDigest, '旧产物完整 SHA-256 不匹配');
  assert.equal(artifact.workflow_run?.id, upgradeBaseline.runId, '旧产物运行 ID 不匹配');
  assert.equal(artifact.workflow_run?.head_sha, upgradeBaseline.commit, '旧产物提交不匹配');
  assert.equal(run.id, upgradeBaseline.runId, '旧运行 ID 不匹配');
  assert.equal(run.head_sha, upgradeBaseline.commit, '旧运行完整提交不匹配');
  assert.equal(run.head_repository?.full_name, upgradeBaseline.repository, '旧运行仓库不匹配');
  assert.equal(run.conclusion, 'success', '旧运行未成功');
  return { artifact, run };
}

export async function verifyInstallerManifest(directory, expected) {
  const root = await realpath(directory), manifestPath = join(root, 'release', 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.platform, 'windows-x64', '安装包平台不匹配');
  assert.equal(manifest.version, expected.version, '安装包产品版本不匹配');
  assert.equal(manifest.commit, expected.commit, '安装包完整提交不匹配');
  assert.equal(manifest.installer?.name, `Video-Quickly-${expected.version}-windows-x64-setup.exe`, '安装包文件名不匹配');
  assert.equal(basename(manifest.installer.name), manifest.installer.name, '安装包不能跨目录');
  const path = join(root, 'release', manifest.installer.name), actual = await realpath(path), inside = relative(root, actual);
  assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside), '安装包超出下载目录');
  const info = await lstat(path); assert.ok(info.isFile() && !info.isSymbolicLink(), '安装包须为普通文件');
  assert.equal(info.size, manifest.installer.bytes, '安装包字节数不匹配');
  const sha256 = createHash('sha256').update(await readFile(path)).digest('hex');
  assert.equal(sha256, manifest.installer.sha256, '安装包 SHA-256 不匹配');
  return { path, manifestPath, version: manifest.version, commit: manifest.commit, sha256, bytes: info.size };
}

async function main() {
  const [mode, directory, metadataFile, output] = process.argv.slice(2);
  let result, destination;
  if (mode === 'metadata') {
    if (!directory || !process.env.GITHUB_TOKEN) throw new Error('需要证据输出路径与具有 actions:read 的 GitHub token');
    const get = async path => {
      const response = await fetch(`https://api.github.com/repos/${upgradeBaseline.repository}/${path}`, { headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`读取固定升级基线失败：HTTP ${response.status}`);
      return response.json();
    };
    const [artifact, run] = await Promise.all([get(`actions/artifacts/${upgradeBaseline.artifactId}`), get(`actions/runs/${upgradeBaseline.runId}`)]);
    result = verifyBaselineMetadata(artifact, run); destination = directory;
  } else if (mode === 'legacy') {
    if (!directory || !metadataFile || !output) throw new Error('需要旧产物目录、已固定的元数据与输出路径');
    const metadata = JSON.parse(await readFile(metadataFile, 'utf8')); verifyBaselineMetadata(metadata.artifact, metadata.run);
    result = { ...await verifyInstallerManifest(directory, upgradeBaseline), artifactId: upgradeBaseline.artifactId, runId: upgradeBaseline.runId, artifactDigest: upgradeBaseline.artifactDigest }; destination = output;
  } else if (mode === 'current') {
    if (!directory || !metadataFile || !output) throw new Error('需要当前产物目录、预期完整提交与输出路径');
    const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    assert.match(metadataFile, /^[a-f0-9]{40}$/, '当前提交须为完整 SHA');
    assert.notEqual(version, upgradeBaseline.version, '新旧产品版本不能相同');
    result = await verifyInstallerManifest(directory, { version, commit: metadataFile }); destination = output;
  } else throw new Error('需要 metadata、legacy 或 current 验证模式');
  await mkdir(dirname(resolve(destination)), { recursive: true }); await writeFile(destination, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ status: 'verified', mode, evidence: resolve(destination) }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
