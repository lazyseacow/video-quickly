import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { assertDarwinNodeSelfContained } from './node-portability.mjs';
import { sha256File, verifiedDownload } from './verified-download.mjs';

export async function preparePortableNode(root) {
  const manifest = JSON.parse(await readFile(join(root, 'scripts/node-manifest.json'), 'utf8'));
  const build = manifest[process.platform]?.[process.arch];
  if (!build) throw new Error('没有当前平台架构的固定便携 Node 构建');
  const required = (await readFile(join(root, '.node-version'), 'utf8')).trim().replace(/^v/, '');
  if (manifest.version !== `v${required}` || process.versions.node.split('.')[0] !== required.split('.')[0]) throw new Error('Node 构建清单与项目工具链不一致');
  const tools = join(root, '.tools');
  const archive = await verifiedDownload(build, join(tools, `${build.directory}.tar.gz`));
  const directory = join(tools, build.directory);
  execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', tools], { stdio: 'pipe' });
  const executable = join(directory, 'bin/node');
  await stat(executable); await stat(join(directory, 'LICENSE'));
  if (await sha256File(executable) !== build.binarySha256) throw new Error('Node 实际二进制摘要不匹配');
  assertDarwinNodeSelfContained(execFileSync('/usr/bin/otool', ['-L', executable], { encoding: 'utf8' }));
  const actual = JSON.parse(execFileSync(executable, ['-p', 'JSON.stringify({version:process.version,architecture:process.arch})'], { encoding: 'utf8' }));
  if (actual.version !== manifest.version || actual.architecture !== process.arch) throw new Error('便携 Node 的实际版本或架构不匹配');
  return { executable, license: join(directory, 'LICENSE'), version: actual.version, provenance: { ...build, version: manifest.version, source: manifest.source, checksums: manifest.checksums, verified: true } };
}
