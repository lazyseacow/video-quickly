import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const playwright = createRequire(import.meta.url).resolve('@playwright/test/cli');
const shardCount = 2;
type Identity = { commit: string; platform: string; architecture: string };

function object(value: unknown): Record<string, unknown> {
  const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
  assert.ok(isObject(value), 'Invalid browser report object');
  return value;
}
function array(value: unknown): unknown[] { assert.ok(Array.isArray(value), 'Invalid browser report array'); return value; }
function text(value: unknown, field: string): string { assert.ok(typeof value === 'string', `Invalid browser test ${field}`); return value; }
async function json(path: string): Promise<unknown> { return JSON.parse(await readFile(path, 'utf8')); }

/** Compare Playwright's discovered tests with the official merged report, including nested suites. */
export function verifyBrowserCoverage(discovered: unknown, merged: unknown): number {
  function keys(input: unknown, completed: boolean) {
    const report = object(input), identities = new Set<string>();
    assert.equal(array(report.errors).length, 0, 'Browser report contains global errors');
    function visit(suites: unknown) {
      for (const value of array(suites)) {
        const suite = object(value);
        for (const value of array(suite.specs)) {
          const spec = object(value);
          for (const value of array(spec.tests)) {
            const test = object(value), key = JSON.stringify([text(spec.file, 'file').replaceAll('\\', '/'), text(spec.id, 'id'), text(test.projectName, 'projectName')]);
            assert.ok(!identities.has(key), `Duplicate browser test: ${key}`); identities.add(key);
            if (completed) {
              assert.equal(test.status, 'expected', `Browser test did not pass: ${key}`);
              assert.equal(test.expectedStatus, 'passed', `Browser test was not expected to pass: ${key}`);
              const results = array(test.results); assert.ok(results.length, `Browser test did not run: ${key}`);
              for (const result of results) assert.equal(object(result).status, 'passed', `Browser attempt did not pass: ${key}`);
            }
          }
        }
        if (suite.suites !== undefined) visit(suite.suites);
      }
    }
    visit(report.suites); assert.ok(identities.size, 'Browser report is empty');
    if (completed) {
      const stats = object(report.stats);
      assert.equal(stats.expected, identities.size, 'Browser count does not match its test records');
      for (const name of ['unexpected', 'flaky', 'skipped']) assert.equal(stats[name], 0, `Browser report has ${name} tests`);
    }
    return [...identities].sort();
  }
  const expected = keys(discovered, false), actual = keys(merged, true);
  assert.deepEqual(actual, expected, 'Merged browser tests do not exactly cover the current test discovery');
  return actual.length;
}

export async function recordBrowserShard(directory: string, shard: number, identity: Identity) {
  assert.ok(Number.isInteger(shard) && shard >= 1 && shard <= shardCount, 'Invalid browser shard');
  assert.match(identity.commit, /^[a-f0-9]{40}$/, 'A browser shard must identify its exact commit');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'identity.json'), JSON.stringify({ ...identity, shard, total: shardCount }));
}

export async function mergeBrowserReports(root: string, identity: Identity): Promise<number> {
  const generated = join(root, '.generated'), artifacts = join(generated, 'browser-artifacts');
  await mkdir(artifacts, { recursive: true });
  // Playwright extracts attachments next to its input blobs, inside the archived evidence directory.
  const blobs = await mkdtemp(join(artifacts, 'merged-'));
  const diagnostics: Buffer[] = [];
  for (let shard = 1; shard <= shardCount; shard++) {
    const directory = join(artifacts, `shard-${shard}`);
    assert.deepEqual(await json(join(directory, 'identity.json')), { ...identity, shard, total: shardCount }, 'Browser shard belongs to another commit, platform, architecture or index');
    const reports = (await readdir(join(directory, 'blob'))).filter(name => name.endsWith('.zip'));
    assert.equal(reports.length, 1, `Expected one blob report for browser shard ${shard}`);
    await copyFile(join(directory, 'blob', reports[0]), join(blobs, `shard-${shard}.zip`));
    const diagnosticPath = join(directory, 'browser-rpc-diagnostics.jsonl');
    try { diagnostics.push(await readFile(diagnosticPath)); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  }
  const discovery = join(generated, 'browser-discovery.json'), output = join(generated, 'browser-results.json');
  function run(args: string[], destination: string) {
    execFileSync(process.execPath, [playwright, ...args], { cwd: root, env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: destination }, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  }
  const config = join(root, 'playwright.config.ts');
  run(['test', '--config', config, '--list', '--reporter=json'], discovery);
  run(['merge-reports', '--config', config, '--reporter=json', blobs], output);
  const count = verifyBrowserCoverage(await json(discovery), await json(output));
  await writeFile(join(generated, 'browser-rpc-diagnostics.jsonl'), Buffer.concat(diagnostics));
  await writeFile(join(generated, 'browser-coverage.json'), JSON.stringify({ ...identity, shards: shardCount, tests: count, status: 'passed' }, null, 2));
  return count;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const identity = { commit: process.env.GITHUB_SHA ?? '', platform: process.platform, architecture: process.arch };
  if (process.argv[2] === 'record') await recordBrowserShard(resolve('.generated/browser-shard'), Number(process.argv[3]), identity);
  else if (process.argv[2] === 'merge') console.log(`Verified all ${await mergeBrowserReports(process.cwd(), identity)} browser tests across both shards.`);
  else throw new Error('Use browser-reports.ts record <1|2> or merge');
}
