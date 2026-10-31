import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { expect, it } from 'vitest';
import { researchSourceSchema } from '@video-quickly/contracts';
import { chineseResearchPdf, researchPdf } from './research-fixtures.js';

// Supply a directory produced by prepare-sidecar; this also accepts its complete
// runtime stage when the host lacks the separate Windows media distribution.
const stage = process.env.VIDEO_QUICKLY_RESEARCH_RUNTIME_STAGE;
it.skipIf(!stage).each([
  { label: 'English Helvetica', createPdf: researchPdf, firstPage: 'First page evidence about paper.', secondPage: 'Second page evidence about printing.' },
  { label: 'Chinese CID/ToUnicode', createPdf: chineseResearchPdf, firstPage: '中文资料🙂：纸张由植物纤维构成。', secondPage: '第二页证据：核对原文，不冒充已核验。' },
])('parses a real two-page $label PDF using the built runtime and copied packages outside the repository', async fixture => {
  const isolated = await mkdtemp(join(tmpdir(), 'video-quickly-isolated-research-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    for (const filename of ['runtime.mjs', 'pdf-process.mjs', process.platform === 'win32' ? 'node.exe' : 'node', 'node_modules']) await cp(join(stage!, filename), join(isolated, filename), { recursive: true });
    const pdf = join(isolated, 'two-pages.pdf'); await writeFile(pdf, fixture.createPdf());
    const environment = { ...process.env }; delete environment.NODE_PATH; delete environment.NODE_OPTIONS;
    child = spawn(join(isolated, process.platform === 'win32' ? 'node.exe' : 'node'), ['runtime.mjs', '--data-dir', join(isolated, 'data'), '--ffmpeg', join(isolated, 'no-media-needed')], { cwd: isolated, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = createInterface({ input: child.stdout! }), runtimeProcess = child;
    let stderr = ''; child.stderr!.on('data', bytes => { stderr += bytes.toString(); });
    const completed = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`隔离解析超时：${stderr.slice(0, 1_000)}`)), 20_000);
      output.on('line', line => {
        let message: { method?: string; id?: number; error?: { message: string }; result?: unknown };
        try { message = JSON.parse(line); } catch { return; }
        if (message.method === 'runtime.ready') runtimeProcess.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'research.source.read', params: { path: pdf } })}\n`);
        if (message.method === 'runtime.failed') { clearTimeout(timeout); reject(new Error(line)); }
        if (message.id === 7) { clearTimeout(timeout); if (message.error) reject(new Error(message.error.message)); else resolve(message.result); }
      });
      runtimeProcess.once('error', error => { clearTimeout(timeout); reject(error); });
      runtimeProcess.once('exit', code => { clearTimeout(timeout); if (code !== 0) reject(new Error(`隔离运行失败 ${code}: ${stderr.slice(0, 1_000)}`)); });
    });
    const source = researchSourceSchema.parse(await completed);
    expect(source.content).toContain(`【第 1 页】\n${fixture.firstPage}`); expect(source.content).toContain(`【第 2 页】\n${fixture.secondPage}`); expect(source.sha256).toBe(createHash('sha256').update(source.content).digest('hex'));
    child.stdin!.end(); await new Promise<void>((resolve, reject) => child!.once('exit', code => code === 0 ? resolve() : reject(new Error(`隔离运行退出 ${code}`))));
  } finally { if (child?.exitCode === null) child.kill('SIGKILL'); await rm(isolated, { recursive: true, force: true }); }
}, 30_000);
