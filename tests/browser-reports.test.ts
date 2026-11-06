import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JSONReport, JSONReportSuite } from '@playwright/test/reporter';
import { mergeBrowserReports, recordBrowserShard, verifyBrowserCoverage } from '../scripts/browser-reports';

const require = createRequire(import.meta.url), identity = { commit: 'a'.repeat(40), platform: process.platform, architecture: process.arch };
describe.each([1, 2, 4])('official reports across %i browser shards', shardCount => {
  const names = ['first', 'second', 'third', 'fourth'].slice(0, Math.max(2, shardCount)), testCount = names.length * 2;
  let directory: string, discovered: JSONReport, merged: JSONReport;
  // Four shards launch four official test runs plus discovery and report merge.
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'vq-browser-reports-'));
    await mkdir(join(directory, 'cases'));
    await writeFile(join(directory, 'playwright.config.ts'), `export default ${JSON.stringify({ testDir: './cases', workers: 1, fullyParallel: false, outputDir: join(directory, '.generated/browser-artifacts') })};`);
    for (const name of names) {
      await writeFile(join(directory, 'cases', `${name}.spec.ts`), `
        import { test, expect } from ${JSON.stringify(require.resolve('@playwright/test'))};
        import { writeFile } from 'node:fs/promises';
        test.describe('nested ${name}', () => {
          for (const index of [1, 2]) test('case ' + index, async ({}, info) => {
            const proof = info.outputPath('proof.txt'); await writeFile(proof, '${name} ' + index);
            await info.attach('proof', { path: proof, contentType: 'text/plain' });
            expect(index).toBeGreaterThan(0);
          });
        });
      `);
    }
    for (let shard = 1; shard <= shardCount; shard++) {
      const output = join(directory, '.generated/browser-artifacts', `shard-${shard}`);
      await recordBrowserShard(output, shard, shardCount, identity);
      await writeFile(join(output, 'browser-rpc-diagnostics.jsonl'), JSON.stringify({ shard }) + '\n');
      // No page fixture or webServer: these exercise official blobs without launching a browser.
      execFileSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--config', join(directory, 'playwright.config.ts'), `--shard=${shard}/${shardCount}`, '--reporter=blob', '--output', join(output, 'artifacts')], {
        cwd: directory, env: { ...process.env, PLAYWRIGHT_BLOB_OUTPUT_DIR: join(output, 'blob') }, stdio: 'pipe', windowsHide: true,
      });
    }
    expect(await mergeBrowserReports(directory, shardCount, identity)).toBe(testCount);
    discovered = JSON.parse(await readFile(join(directory, '.generated/browser-discovery.json'), 'utf8'));
    merged = JSON.parse(await readFile(join(directory, '.generated/browser-results.json'), 'utf8'));
  }, 60_000);
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

  it('merges actual Playwright blobs, preserves attachments and diagnostics, and verifies every discovered case', async () => {
    expect(verifyBrowserCoverage(discovered, merged)).toBe(testCount);
    const attachments: string[] = [];
    function visit(suites: JSONReportSuite[]) {
      for (const suite of suites) {
        for (const spec of suite.specs) for (const test of spec.tests) for (const result of test.results) {
          for (const attachment of result.attachments) if (attachment.path) attachments.push(attachment.path);
        }
        visit(suite.suites ?? []);
      }
    }
    visit(merged.suites); expect(attachments).toHaveLength(testCount);
    for (const path of attachments) expect(await readFile(path, 'utf8')).toMatch(/first|second|third|fourth/);
    expect(await readFile(join(directory, '.generated/browser-rpc-diagnostics.jsonl'), 'utf8')).toBe(Array.from({ length: shardCount }, (_, index) => JSON.stringify({ shard: index + 1 }) + '\n').join(''));
    expect(JSON.parse(await readFile(join(directory, '.generated/browser-coverage.json'), 'utf8'))).toMatchObject({ ...identity, shards: shardCount, tests: testCount, status: 'passed' });
  });

  it('rejects missing, duplicate and substituted tests even if a report claims a passing count', () => {
    const missing = structuredClone(merged); missing.suites.pop(); missing.stats.expected = testCount - 2;
    expect(() => verifyBrowserCoverage(discovered, missing)).toThrow('exactly cover');
    const duplicate = structuredClone(merged); duplicate.suites.push(structuredClone(duplicate.suites[0]));
    expect(() => verifyBrowserCoverage(discovered, duplicate)).toThrow('Duplicate browser test');
    const substituted = structuredClone(merged);
    function replace(suite: JSONReportSuite): boolean {
      if (suite.specs[0]) { suite.specs[0].id += '-different'; return true; }
      return (suite.suites ?? []).some(replace);
    }
    substituted.suites.some(replace);
    expect(() => verifyBrowserCoverage(discovered, substituted)).toThrow('exactly cover');
    const skipped = structuredClone(merged); skipped.stats.skipped = 1;
    expect(() => verifyBrowserCoverage(discovered, skipped)).toThrow('skipped');
    const globalError = structuredClone(merged); globalError.errors.push({ message: 'fixture global error' });
    expect(() => verifyBrowserCoverage(discovered, globalError)).toThrow('global errors');
  });

  it('rejects missing shard identity, wrong commit and wrong total before merging', async () => {
    const shard = join(directory, `.generated/browser-artifacts/shard-${shardCount}`);
    await recordBrowserShard(shard, shardCount, shardCount, { ...identity, commit: 'b'.repeat(40) });
    await expect(mergeBrowserReports(directory, shardCount, identity)).rejects.toThrow('another commit');
    await recordBrowserShard(shard, shardCount, shardCount + 1, identity);
    await expect(mergeBrowserReports(directory, shardCount, identity)).rejects.toThrow('total');
    await recordBrowserShard(shard, shardCount, shardCount, identity);
    const path = join(shard, 'identity.json'), bytes = await readFile(path); await rm(path);
    try { await expect(mergeBrowserReports(directory, shardCount, identity)).rejects.toThrow('ENOENT'); }
    finally { await writeFile(path, bytes); }
  });

  it('rejects missing or duplicate blob files before merging', async () => {
    const shard = join(directory, `.generated/browser-artifacts/shard-${shardCount}`);
    const blobs = join(shard, 'blob'), name = (await readdir(blobs)).find(name => name.endsWith('.zip'))!;
    const bytes = await readFile(join(blobs, name)); await rm(join(blobs, name));
    try { await expect(mergeBrowserReports(directory, shardCount, identity)).rejects.toThrow('Expected one blob report'); }
    finally { await writeFile(join(blobs, name), bytes); }
    const duplicate = join(blobs, 'duplicate.zip'); await copyFile(join(blobs, name), duplicate);
    try { await expect(mergeBrowserReports(directory, shardCount, identity)).rejects.toThrow('Expected one blob report'); }
    finally { await rm(duplicate); }
  });

  it('rejects a missing shard directory before merging', async () => {
    const shard = join(directory, `.generated/browser-artifacts/shard-${shardCount}`), held = join(directory, 'held-shard');
    await rename(shard, held);
    try { await expect(mergeBrowserReports(directory, shardCount, identity)).rejects.toThrow('ENOENT'); }
    finally { await rename(held, shard); }
  });
});

it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid shard total %s before reading or writing reports', async total => {
  await expect(recordBrowserShard('unused', 1, total, identity)).rejects.toThrow('Invalid browser shard total');
  await expect(mergeBrowserReports('unused', total, identity)).rejects.toThrow('Invalid browser shard total');
});

it.each([0, -1, 1.5, 5])('rejects shard index %s outside the four-shard matrix', async shard => {
  await expect(recordBrowserShard('unused', shard, 4, identity)).rejects.toThrow('Invalid browser shard');
});
