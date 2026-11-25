import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

export async function agentToolOutputDirectory(dataDirectory: string, runId: string) {
  const root = join(await realpath(dataDirectory), 'tool-artifacts');
  await mkdir(root, { recursive: true });
  if (await realpath(root) !== root) throw new Error('工具产物目录不能使用符号链接。');
  const path = join(root, runId);
  await mkdir(path, { recursive: true });
  if (await realpath(path) !== path) throw new Error('本次工具产物目录不能使用符号链接。');
  return path;
}
