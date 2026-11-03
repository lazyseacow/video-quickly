import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { serviceRoles } from './real-service-config';

// Explicit CLI self-test: the local HTTP boundary is a fixture, never evidence
// that an account or a real cloud supplier has passed validation.
const execute = promisify(execFile), output = process.argv[2];
if (!output) throw new Error('需要一个不存在的自测输出目录。此命令使用本地 HTTP 夹具，不验证云服务。');
const directory = resolve(output); await mkdir(directory);
const ffmpeg = process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg', videoPath = join(directory, 'fixture.mp4'), imagePath = join(directory, 'fixture.png');
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=10', '-t', '10', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', videoPath]);
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath, '-frames:v', '1', imagePath]);
const image = await readFile(imagePath), video = await readFile(videoPath), posts: string[] = [];
let origin = '';
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const path = request.url ?? '';
  if (request.method === 'POST') posts.push(path);
  response.setHeader('Content-Type', 'application/json');
  if (path === '/v1/chat/completions') {
    const content = Buffer.concat(chunks).toString().includes('自动视频制作步骤：旁白与分镜') ? JSON.stringify({ shots: Array.from({ length: 3 }, (_, index) => ({ id: `service-shot-${index + 1}`, title: `本地回归镜头 ${index + 1}`, narration: '这是本地 CLI 视频回归。', visualPrompt: '红色测试画面', durationUs: 10_000_000 })) }) : '红色测试画面，三个镜头，中文自然讲述。';
    response.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }));
  }
  else if (path === '/v1/images/generations') response.end(JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }));
  else if (path === '/v1/videos' && request.method === 'POST') { assert.match(Buffer.concat(chunks).toString(), /name="generate_audio"\r\n\r\ntrue\r\n/); response.end(JSON.stringify({ id: `fixture-video-${posts.length}` })); }
  else if (path.startsWith('/v1/videos/')) response.end(JSON.stringify({ status: 'completed', url: `${origin}/fixture.mp4` }));
  else if (path === '/fixture.mp4') { response.setHeader('Content-Type', 'video/mp4'); response.end(video); }
  else { response.statusCode = 404; response.end(JSON.stringify({ error: 'Unexpected fixture endpoint' })); }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address(); if (!address || typeof address === 'string') throw new Error('本地夹具没有监听地址。'); origin = `http://127.0.0.1:${address.port}`;
const config = join(directory, 'connections.json'), resultDirectory = join(directory, 'run');
await writeFile(config, JSON.stringify({ title: 'CLI 自测：不代表云服务验收', roles: Object.fromEntries(serviceRoles.map(role => [role, { model: { provider: 'openai-compatible', baseUrl: `${origin}/v1`, model: `fixture-${role}`, connectionType: role, capabilities: [role], parameters: {} } }])) }));
const command = ['--import', 'tsx', resolve('scripts/real-service-smoke.ts'), '--config', config, '--execute', '--output', resultDirectory];
try {
  const first = await execute(process.execPath, [...command, '--stop-after', 'script'], { maxBuffer: 1024 * 1024 });
  assert.equal(JSON.parse(first.stdout).status, 'paused'); assert.deepEqual(posts, Array(3).fill('/v1/chat/completions'));
  const path = join(resultDirectory, 'evidence.json'), before = JSON.parse(await readFile(path, 'utf8'));
  const last = before.runs.at(-1), originalRun = last.id;
  // Recreate a lost application acknowledgement, after the real database commit.
  last.applied = false; before.projectDigest = '0'.repeat(64); await writeFile(path, JSON.stringify(before));
  const resumed = await execute(process.execPath, [...command, '--resume'], { maxBuffer: 1024 * 1024 });
  assert.equal(JSON.parse(resumed.stdout).status, 'passed');
  const final = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(final.runs.find((run: { phase: string; id: string }) => run.phase === 'script')?.id, originalRun); assert.equal(final.runs.length, 6); assert.equal(final.artifacts.length, 3); assert.equal(posts.length, 9); assert.equal(posts.filter(path => path === '/v1/chat/completions').length, 3);
  const counts = Object.fromEntries([...new Set(posts)].map(path => [path, posts.filter(value => value === path).length]));
  await writeFile(join(directory, 'fixture-check.json'), JSON.stringify({ status: 'passed', evidenceKind: 'local-http-cli-regression', cloudServicesVerified: false, originalRunRetained: true, applicationAcknowledgementRecovered: true, requests: counts, outputs: final.artifacts }, null, 2));
  console.log(JSON.stringify({ status: 'passed', evidenceKind: 'local-http-cli-regression', cloudServicesVerified: false, report: join(directory, 'fixture-check.json') }));
} finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
