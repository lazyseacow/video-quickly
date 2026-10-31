import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const windowsPath = path => win32.normalize(path).toLowerCase();

function runtimeCommand(command, workspace, platform) {
  if (typeof command !== 'string') return false;
  const line = platform === 'win32' ? command.toLowerCase() : command;
  if (!/(?:^|[\\/])runtime\.mjs(?="|\s|$)/.test(line)) return false;
  if (platform === 'win32') {
    const argument = /(?:^|\s)--data-dir\s+(?:"([^"]+)"|(\S+))/.exec(command);
    return Boolean(argument && windowsPath(argument[1] ?? argument[2]) === windowsPath(workspace));
  }
  const marker = `--data-dir ${workspace}`, index = command.indexOf(marker);
  return index !== -1 && /^(?:\s+--|$)/.test(command.slice(index + marker.length));
}

// Test infrastructure only: query the fixture's owned children, never expose
// host process details through the production renderer bridge.
export async function findElectronRuntime(application, workspace, { platform = process.platform, run = execute, timeoutMs = 10_000, intervalMs = 200, onDiagnostics } = {}) {
  const launcherPid = application.process().pid;
  const mainPid = await application.evaluate(() => process.pid);
  if (!Number.isSafeInteger(mainPid) || mainPid <= 0) throw new Error('Electron main process has no valid PID');
  const startedAt = performance.now(), attempts = [];
  let candidates = [];
  for (;;) {
    const attempt = { elapsedMs: Math.round(performance.now() - startedAt), stdout: '', stderr: '', ownedRows: [] };
    try {
      const options = { timeout: Math.max(1, Math.min(5_000, timeoutMs - attempt.elapsedMs)), windowsHide: true, maxBuffer: 1024 * 1024 };
      const result = platform === 'win32'
        ? await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${mainPid}' -ErrorAction Stop | Where-Object { $_.Name -eq 'node.exe' } | Select-Object ProcessId,ParentProcessId,Name,CommandLine) | ConvertTo-Json -Compress`], options)
        : await run('ps', ['-ax', '-o', 'pid=,ppid=,command='], options);
      attempt.stdout = String(result.stdout); attempt.stderr = String(result.stderr ?? '');
      let rows;
      if (platform === 'win32') {
        const parsed = JSON.parse(attempt.stdout.replace(/^\uFEFF/, '').trim() || '[]');
        rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
      } else {
        rows = attempt.stdout.split('\n').flatMap(line => {
          const row = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
          return row ? [{ ProcessId: Number(row[1]), ParentProcessId: Number(row[2]), CommandLine: row[3] }] : [];
        });
        // ps has no parent filter; retain only this fixture's rows in diagnostics.
        attempt.stdout = rows.filter(row => row.ParentProcessId === mainPid).map(row => `${row.ProcessId} ${row.ParentProcessId} ${row.CommandLine}`).join('\n');
      }
      attempt.ownedRows = rows.filter(row => row && row.ParentProcessId === mainPid);
      candidates = attempt.ownedRows.filter(row => Number.isSafeInteger(row.ProcessId) && row.ProcessId > 0 && (platform !== 'win32' || row.Name?.toLowerCase() === 'node.exe') && runtimeCommand(row.CommandLine, workspace, platform));
      attempt.matchingPids = candidates.map(row => row.ProcessId);
    } catch (error) {
      attempt.error = error instanceof Error ? error.message : String(error);
      attempt.stdout = platform === 'win32' ? String(error.stdout ?? attempt.stdout) : ''; attempt.stderr = String(error.stderr ?? attempt.stderr);
      candidates = [];
    }
    attempts.push(attempt);
    if (candidates.length || performance.now() - startedAt >= timeoutMs) break;
    await delay(Math.min(intervalMs, Math.max(0, timeoutMs - (performance.now() - startedAt))));
  }
  const diagnostics = { platform, launcherPid, mainPid, expectedWorkspace: workspace, elapsedMs: Math.round(performance.now() - startedAt), attempts };
  await onDiagnostics?.(diagnostics);
  if (candidates.length !== 1) throw new Error(`Electron must own exactly one fixture runtime; found ${candidates.length}. See runtime-process diagnostics.`);
  return candidates[0].ProcessId;
}
