import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { researchPdf } from './research-fixtures.js';

it('serves persisted run history while a cold PDF is being parsed and drains that read before closing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'video-quickly-research-responsive-'));
  try {
    const pdf = join(directory, 'two-pages.pdf'); await writeFile(pdf, researchPdf());
    // A separate process keeps PDF.js and its native font initialization cold.
    // Assert completion order rather than a maximum elapsed-time threshold.
    const probe = `
      import { createRuntime } from ${JSON.stringify(pathToFileURL(resolve('packages/runtime/src/index.ts')).href)};
      import { setTimeout as delay } from 'node:timers/promises';
      const runtime = createRuntime({ dataDirectory: ${JSON.stringify(join(directory, 'data'))}, seed: false, ffmpegPath: '/unused-by-research' });
      let interval;
      try {
        const project = await runtime.dispatch('project.create', { title: '并发 PDF 与记录读取' });
        await runtime.dispatch('workflow.save', { projectId: project.id, workflow: { id: 'review', name: '只核对', version: 1, nodes: [{ id: 'review', kind: 'review', label: '人工核对', requiresReview: true }], edges: [] } });
        const run = await runtime.dispatch('run.start', { projectId: project.id });
        await runtime.waitForIdle();
        const order = []; let previous = performance.now(), maximumMainThreadDelayMs = 0;
        interval = setInterval(() => { const now = performance.now(); maximumMainThreadDelayMs = Math.max(maximumMainThreadDelayMs, now - previous - 10); previous = now; }, 10);
        await delay(30);
        const reading = runtime.dispatch('research.source.read', { path: ${JSON.stringify(pdf)} }).then(source => { order.push('pdf'); return source; });
        const listing = delay(20).then(() => runtime.dispatch('run.list', { projectId: project.id })).then(page => { order.push('history'); return page; });
        const [source, page] = await Promise.all([reading, listing]);
        // Start another real read and close immediately: runtime.close must
        // drain the process-backed dispatch rather than abandon its result.
        const finalRead = runtime.dispatch('research.source.read', { path: ${JSON.stringify(pdf)} });
        const closed = runtime.close();
        const finalSource = await finalRead; await closed;
        console.log(JSON.stringify({ order, maximumMainThreadDelayMs, source, finalSource, runId: run.id, runs: page.items }));
      } finally { clearInterval(interval); await runtime.close(); }
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', probe], { cwd: resolve('.'), timeout: 20_000, maxBuffer: 256 * 1024 });
    const result = JSON.parse(stdout.trim());
    expect(result.order).toEqual(['history', 'pdf']);
    expect(result.runs).toEqual([expect.objectContaining({ id: result.runId, status: 'waiting_review' })]);
    expect(result.source.content).toContain('【第 1 页】\nFirst page evidence about paper.');
    expect(result.source.content).toContain('【第 2 页】\nSecond page evidence about printing.');
    expect(result.finalSource.content).toBe(result.source.content);
    expect(result.finalSource.sha256).toBe(result.source.sha256);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 25_000);
