import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { JSONReport, JSONReportSuite } from '@playwright/test/reporter';
import { mergeBrowserReports, recordBrowserShard, verifyBrowserCoverage } from '../scripts/browser-reports';

const require = createRequire(import.meta.url), identity = { commit: 'a'.repeat(40), platform: process.platform, architecture: process.arch };
let directory: string, discovered: JSONReport, merged: JSONReport;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'vq-browser-reports-'));
  await mkdir(join(directory, 'cases'));
  await writeFile(join(directory, 'playwright.config.ts'), `export default ${JSON.stringify({ testDir: './cases', workers: 1, fullyParallel: false, outputDir: join(directory, '.generated/browser-artifacts') })};`);
  for (const name of ['first', 'second']) {
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
  for (const shard of [1, 2]) {
    const output = join(directory, '.generated/browser-artifacts', `shard-${shard}`);
    await recordBrowserShard(output, shard, identity);
    await writeFile(join(output, 'browser-rpc-diagnostics.jsonl'), JSON.stringify({ shard }) + '\n');
    // No page fixture or webServer: these exercise official blobs without launching a browser.
    execFileSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--config', join(directory, 'playwright.config.ts'), `--shard=${shard}/2`, '--reporter=blob', '--output', join(output, 'artifacts')], {
      cwd: directory, env: { ...process.env, PLAYWRIGHT_BLOB_OUTPUT_DIR: join(output, 'blob') }, stdio: 'pipe', windowsHide: true,
    });
  }
  expect(await mergeBrowserReports(directory, identity)).toBe(4);
  discovered = JSON.parse(await readFile(join(directory, '.generated/browser-discovery.json'), 'utf8'));
  merged = JSON.parse(await readFile(join(directory, '.generated/browser-results.json'), 'utf8'));
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

it('merges actual Playwright blobs, preserves attachments and diagnostics, and verifies every discovered case', async () => {
  expect(verifyBrowserCoverage(discovered, merged)).toBe(4);
  const attachments: string[] = [];
  function visit(suites: JSONReportSuite[]) {
    for (const suite of suites) {
      for (const spec of suite.specs) for (const test of spec.tests) for (const result of test.results) {
        for (const attachment of result.attachments) if (attachment.path) attachments.push(attachment.path);
      }
      visit(suite.suites ?? []);
    }
  }
  visit(merged.suites); expect(attachments).toHaveLength(4);
  for (const path of attachments) expect(await readFile(path, 'utf8')).toMatch(/first|second/);
  expect(await readFile(join(directory, '.generated/browser-rpc-diagnostics.jsonl'), 'utf8')).toBe('{"shard":1}\n{"shard":2}\n');
  expect(JSON.parse(await readFile(join(directory, '.generated/browser-coverage.json'), 'utf8'))).toMatchObject({ ...identity, shards: 2, tests: 4, status: 'passed' });
});

it('rejects missing, duplicate and substituted tests even if a report claims a passing count', () => {
  const missing = structuredClone(merged); missing.suites.pop(); missing.stats.expected = 2;
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

it('rejects a missing blob and a shard from another commit before merging', async () => {
  const shard = join(directory, '.generated/browser-artifacts/shard-2');
  await recordBrowserShard(shard, 2, { ...identity, commit: 'b'.repeat(40) });
  await expect(mergeBrowserReports(directory, identity)).rejects.toThrow('another commit');
  await recordBrowserShard(shard, 2, identity);
  const blobs = join(shard, 'blob'), name = (await readdir(blobs)).find(name => name.endsWith('.zip'))!;
  const bytes = await readFile(join(blobs, name)); await rm(join(blobs, name));
  try { await expect(mergeBrowserReports(directory, identity)).rejects.toThrow('Expected one blob report'); }
  finally { await writeFile(join(blobs, name), bytes); }
});
