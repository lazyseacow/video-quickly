import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, copyFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { parse } from 'yaml';
import { unzipSync } from 'fflate';
import { skillSchema, type SkillImportSource, type SkillPackage } from '@video-quickly/contracts';

export async function importSkills(source: SkillImportSource, dataDirectory: string, options: { signal?: AbortSignal; onProgress?(completed: number, total: number): void } = {}): Promise<SkillPackage[]> {
  options.signal?.throwIfAborted();
  if (source.path && !source.path.toLowerCase().endsWith('.zip')) {
    const directories = await discoverSkillDirectories(resolve(source.path));
    if (!directories.length) throw new Error('目录中没有找到 SKILL.md。');
    const result: SkillPackage[] = [];
    options.onProgress?.(0, directories.length);
    for (const directory of directories) {
      options.signal?.throwIfAborted();
      result.push(await importSkillDirectory(directory, dataDirectory));
      options.onProgress?.(result.length, directories.length);
    }
    return result;
  }
  let bytes: Uint8Array;
  let sourceLabel: string;
  let repositorySource: string | undefined;
  let requestedPath = '';
  if (source.url) {
    const url = new URL(source.url);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password) throw new Error('请输入 HTTPS GitHub 仓库链接。');
    const parts = url.pathname.replace(/\.git\/?$/, '').split('/').filter(Boolean);
    const [owner, repository] = parts;
    if (!owner || !repository || !/^[a-z\d_.-]+$/i.test(owner) || !/^[a-z\d_.-]+$/i.test(repository)) throw new Error('GitHub 仓库链接无效。');
    let branch = parts[2] === 'tree' ? parts[3] : undefined;
    if (parts.length > 2 && parts[2] !== 'tree') throw new Error('请提供仓库或 Skill 目录链接。');
    requestedPath = parts[2] === 'tree' ? parts.slice(4).map(decodeURIComponent).join('/') : '';
    if (!branch) {
      const metadata = await fetch(`https://api.github.com/repos/${owner}/${repository}`, { signal: AbortSignal.any([AbortSignal.timeout(20_000), ...options.signal ? [options.signal] : []]), headers: { Accept: 'application/vnd.github+json' } });
      if (!metadata.ok) throw new Error(`无法读取 GitHub 仓库（HTTP ${metadata.status}）。`);
      const info: unknown = await metadata.json();
      branch = info && typeof info === 'object' && 'default_branch' in info && typeof info.default_branch === 'string' ? info.default_branch : undefined;
    }
    if (!branch) throw new Error('未找到仓库默认分支。');
    const response = await fetch(`https://codeload.github.com/${owner}/${repository}/zip/refs/heads/${encodeURIComponent(branch)}`, { signal: AbortSignal.any([AbortSignal.timeout(60_000), ...options.signal ? [options.signal] : []]) });
    if (!response.ok) throw new Error(`下载 Skill 仓库失败（HTTP ${response.status}）。`);
    if (Number(response.headers.get('content-length')) > 50_000_000) throw new Error('Skill 压缩包超过 50 MB。');
    const chunks: Uint8Array[] = []; let size = 0;
    if (!response.body) throw new Error('Skill 仓库没有返回文件。');
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 50_000_000) { await reader.cancel(); throw new Error('Skill 压缩包超过 50 MB。'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    sourceLabel = source.url;
    repositorySource = `https://github.com/${owner}/${repository}/tree/${encodeURIComponent(branch)}`;
  } else if (source.path) {
    const info = await lstat(source.path); if (!info.isFile() || info.size > 50_000_000) throw new Error('请选择不超过 50 MB 的 ZIP 文件。');
    bytes = new Uint8Array(await readFile(source.path)); sourceLabel = resolve(source.path);
  } else throw new Error('请选择 Skill 目录、ZIP 文件或 GitHub 链接。');
  const names: string[] = [];
  // Index first: repository examples and other Skills do not count toward one Skill's limits.
  unzipSync(bytes, { filter(file) { if (!file.name.endsWith('/')) names.push(file.name); return false; } });
  for (const name of names) if (name.startsWith('/') || name.includes('\\') || name.split('/').some(part => part === '..' || part.includes(':'))) throw new Error('Skill ZIP 包含不安全路径。');
  const candidates = names.filter(name => name === 'SKILL.md' || name.endsWith('/SKILL.md'));
  const firstDirectory = names[0]?.split('/')[0];
  const archivePrefix = firstDirectory && names.every(name => name.startsWith(`${firstDirectory}/`)) ? `${firstDirectory}/` : '';
  const selectedPath = source.skillPath ?? requestedPath;
  const selected = selectedPath
    ? candidates.filter(name => name === `${archivePrefix}${selectedPath}/SKILL.md`)
    : candidates.sort();
  if (!selected.length) {
    if (selectedPath) throw new Error('所选 Skill 目录中没有找到 SKILL.md，请重新选择。');
    throw new Error('ZIP 或仓库中没有找到 SKILL.md。');
  }
  const result: SkillPackage[] = [];
  options.onProgress?.(0, selected.length);
  for (const selectedSkill of selected) {
    options.signal?.throwIfAborted();
    const prefix = selectedSkill.slice(0, -'SKILL.md'.length);
    let total = 0;
    let fileCount = 0;
    const entries = unzipSync(bytes, { filter(file) {
      if (!file.name.startsWith(prefix) || file.name.endsWith('/')) return false;
      if (++fileCount > 500) throw new Error('Skill 文件数超过 500。');
      total += file.originalSize;
      if (total > 50_000_000) throw new Error('Skill 解压后超过 50 MB。');
      return true;
    } });
    const importsRoot = resolve(dataDirectory, 'imports');
    const temporary = resolve(importsRoot, randomUUID());
    if (relative(importsRoot, temporary).startsWith('..')) throw new Error('导入目录无效。');
    await mkdir(temporary, { recursive: true });
    try {
      for (const [name, content] of Object.entries(entries)) {
        if (!name.startsWith(prefix)) continue;
        const destination = resolve(temporary, name.slice(prefix.length));
        if (relative(temporary, destination).startsWith('..')) throw new Error('Skill 文件路径越界。');
        await mkdir(resolve(destination, '..'), { recursive: true });
        await writeFile(destination, content);
      }
      const value = await importSkillDirectory(temporary, dataDirectory);
      const path = prefix.slice(archivePrefix.length).replace(/\/$/, '');
      result.push({ ...value, source: repositorySource ? `${repositorySource}${path ? `/${path}` : ''}` : `${sourceLabel}${path ? `#${path}` : ''}` });
      options.onProgress?.(result.length, selected.length);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  return result;
}

async function discoverSkillDirectories(root: string, depth = 0): Promise<string[]> {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('请选择包含 Skill 的本地目录。');
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.some(entry => entry.name === 'SKILL.md' && entry.isFile())) return [root];
  if (depth >= 5) return [];
  const result: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (['.git', 'node_modules'].includes(entry.name) || entry.name.startsWith('.env')) continue;
    if (entry.isSymbolicLink()) throw new Error('Skill 目录包含符号链接，请移除后再导入。');
    if (entry.isDirectory()) result.push(...await discoverSkillDirectories(join(root, entry.name), depth + 1));
  }
  return result;
}

export async function importSkillDirectory(source: string, dataDirectory: string): Promise<SkillPackage> {
  const sourceRoot = resolve(source);
  const sourceInfo = await lstat(sourceRoot);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('请选择包含 SKILL.md 的本地目录。');
  const sourceBody = await readFile(join(sourceRoot, 'SKILL.md'), 'utf8');
  if (Buffer.byteLength(sourceBody) > 2_000_000) throw new Error('SKILL.md 超过 2 MB，无法导入。');
  const match = sourceBody.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error('SKILL.md 缺少 YAML 元数据。');
  const metadata: unknown = parse(match[1]);
  if (!metadata || typeof metadata !== 'object') throw new Error('Skill 元数据格式无效。');
  const { name, description } = metadata as Record<string, unknown>;
  if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) throw new Error('Skill 名称须使用小写字母、数字与连字符，长度不超过 64。');
  if (typeof description !== 'string' || !description.trim()) throw new Error('Skill 缺少说明。');
  const files: string[] = [];
  let totalBytes = 0;
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.startsWith('.env')) continue;
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error('Skill 内包含符号链接，请移除后再导入。');
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        totalBytes += info.size;
        if (totalBytes > 50_000_000 || files.length >= 500) throw new Error('Skill 资源超过导入上限（50 MB 或 500 个文件）。');
        files.push(relative(sourceRoot, path).replaceAll('\\', '/'));
      }
    }
  }
  await walk(sourceRoot);
  const hash = createHash('sha256');
  for (const file of files.sort()) hash.update(file).update(await readFile(join(sourceRoot, file)));
  const digest = hash.digest('hex');
  const id = `skill-${digest.slice(0, 20)}`;
  const skillRoot = join(dataDirectory, 'skills');
  const temporary = join(skillRoot, `.import-${randomUUID()}`);
  await mkdir(temporary, { recursive: true });
  try {
    for (const file of files) {
      const destination = join(temporary, file);
      await mkdir(resolve(destination, '..'), { recursive: true });
      await copyFile(join(sourceRoot, file), destination);
    }
    try { await rename(temporary, join(skillRoot, id)); }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || !['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(String(error.code)) || !(await lstat(join(skillRoot, id)).catch(() => undefined))?.isDirectory()) throw error;
      await rm(temporary, { recursive: true, force: true });
    }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return skillSchema.parse({ id, name, description, source: sourceRoot, version: digest.slice(0, 12), enabled: true, instructions: sourceBody.slice(match[0].length).trim(), resources: files.filter(file => file !== 'SKILL.md'), tools: files.filter(file => file.startsWith('scripts/')).map(file => ({ id: file, label: file, enabled: false, permissions: ['execute', 'project-files'] })), contentHash: digest, importedAt: new Date().toISOString() });
}
