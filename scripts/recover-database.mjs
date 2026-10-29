import { createRequire } from 'node:module';
import { copyFile, mkdir, open, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'packages/runtime/package.json'));
const Database = require('better-sqlite3');
const args = process.argv.slice(2);
const argument = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const input = argument('--backup'); const output = argument('--destination');
if (!input || !output) throw new Error('用法：node scripts/recover-database.mjs --backup <快照文件> --destination <不存在的新目录>');
const source = resolve(input); const destination = resolve(output);
if (await stat(`${source}-wal`).then(value => value.size > 0, () => false)) throw new Error('请选择独立的迁移备份，不能直接复制仍有 WAL 日志的工作区数据库');
const backup = new Database(source, { readonly: true, fileMustExist: true });
try {
  if (backup.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('数据库快照未通过完整性检查');
  backup.prepare('SELECT COUNT(*) FROM documents').get();
} finally { backup.close(); }
// Requiring a new directory makes recovery non-destructive, even if the client is running.
await mkdir(destination);
const restored = join(destination, 'workspace.sqlite');
await copyFile(source, restored);
const file = await open(restored, 'r+'); try { await file.sync(); } finally { await file.close(); }
console.log(`数据库已恢复到新目录：${destination}。素材仍按数据库中的原路径读取。`);
