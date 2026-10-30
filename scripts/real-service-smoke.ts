import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { exportBatchSchema, modelSchema, projectDetailSchema, projectSchema, recordPageSchema, assetSchema, runInspectionSchema, runStepPayloadSchema, runSummarySchema, runSchema, workspaceSummarySchema, type ModelProfile } from '@video-quickly/contracts';
import { createRuntime } from '../packages/runtime/src/index';
import { createActivityExecutor, createWaveformReader, validateMediaActivity } from '../packages/integrations/src/index';
import { audioMixProjectionKey, prepareAudioMix, readAudioLevelWindow, detectAudioSilence } from '../packages/video/src/audio-mix';
import { probeMedia } from '../packages/video/src/media-process';
import { configDigest, parseRealServiceConfig, redactServiceFailure, servicePreflight, serviceRoles, type ServiceRole } from './real-service-config';
import { committedPhaseRun, resumePhaseRun } from './real-service-progress';

interface RunEvidence { id?: string; phase: string; nodeId: string; revision: number; applicationId: string; applied: boolean; status?: string; activities?: number }

interface Evidence {
  version: 1; status: 'running' | 'awaiting_review' | 'passed' | 'failed'; configDigest: string; startedAt: string; completedAt?: string;
  projectId?: string; projectDigest?: string; phase?: string; runs: RunEvidence[]; models?: Record<ServiceRole, ModelProfile>;
  connections: ReturnType<typeof servicePreflight>; batchId?: string; artifacts?: Array<{ id: string; sha256: string; duration: number; width?: number; height?: number }>;
  automatedChecksOnly: true; error?: string;
}

export async function main(args = process.argv.slice(2)) {
  const argument = (name: string) => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
  const configPath = argument('--config');
  if (!configPath) throw new Error('需要 --config 配置文件；仅加 --execute 才会调用真实模型。');
  const stopAfter = argument('--stop-after');
  if (stopAfter !== undefined && !['script', 'assets', 'voice', 'animation', 'asr'].includes(stopAfter)) throw new Error('--stop-after 仅接受 script、assets、voice、animation 或 asr。');
  const config = parseRealServiceConfig(JSON.parse(await readFile(resolve(configPath), 'utf8')));
  const connections = servicePreflight(config, process.env);
  if (!args.includes('--execute')) { console.log(JSON.stringify({ status: 'preflight', connections, calls: '3 镜头：1 次脚本、每镜头图片／配音／视频／识别，另三比例本地导出；不会自动再次 POST', humanReview: '技术验收不代替成片人工审阅和 Windows 原生验收' }, null, 2)); return; }
  if (connections.some(value => value.credential === 'missing')) throw new Error('缺少配置声明的凭据环境变量，未提交模型请求。');
  const outputArgument = argument('--output');
  if (!outputArgument) throw new Error('执行需要 --output 指定全新的隔离验收目录。');
  const output = resolve(outputArgument), resume = args.includes('--resume');
  let previous: Evidence | undefined;
  if (resume) {
    const stored: unknown = JSON.parse(await readFile(join(output, 'evidence.json'), 'utf8'));
    if (!stored || typeof stored !== 'object' || !('version' in stored) || stored.version !== 1 || !('configDigest' in stored) || stored.configDigest !== configDigest(config) || !('runs' in stored) || !Array.isArray(stored.runs)) throw new Error('原验收记录不匹配配置，未重新提交。');
    for (const item of stored.runs) if (!item || typeof item !== 'object' || typeof item.phase !== 'string' || typeof item.nodeId !== 'string' || !Number.isInteger(item.revision) || item.revision < 1 || typeof item.applicationId !== 'string' || typeof item.applied !== 'boolean' || (item.id !== undefined && typeof item.id !== 'string')) throw new Error('原运行证据不完整，需人工核对，未重新提交。');
    previous = stored as Evidence;
    if (previous.runs.length && !previous.models) throw new Error('原验收缺少模型快照，未重新提交。');
    if (previous.models) for (const role of serviceRoles) previous.models[role] = modelSchema.parse(previous.models[role]);
    if (!previous.projectId && previous.runs.length) throw new Error('原验收缺少项目归属，未重新提交。');
  } else await mkdir(output); // An existing directory requires an explicit resume.
  const directory = join(output, 'workspace');
  const ffmpegPath = process.env.VIDEO_QUICKLY_FFMPEG, ffprobePath = process.env.VIDEO_QUICKLY_FFPROBE;
  const secrets = new Map<string, string>(), values = serviceRoles.flatMap(role => { const key = config.roles[role].secretEnv; return key && process.env[key] ? [process.env[key]!] : []; });
  const evidence: Evidence = previous ?? { version: 1, status: 'running', configDigest: configDigest(config), startedAt: new Date().toISOString(), runs: [], connections, automatedChecksOnly: true };
  evidence.status = 'running'; delete evidence.error; delete evidence.completedAt;
  if (evidence.models) for (const role of serviceRoles) { const reference = evidence.models[role].credentialRef, env = config.roles[role].secretEnv; if (reference && env && process.env[env]) secrets.set(reference, process.env[env]!); }
  const persist = async () => { const path = join(output, 'evidence.json'); await writeFile(`${path}.tmp`, JSON.stringify(evidence, null, 2)); await rename(`${path}.tmp`, path); };
  const waveforms = createWaveformReader({ dataDirectory: directory, ffmpegPath });
  const runtime = createRuntime({ dataDirectory: directory, seed: false, mode: 'development', ffmpegPath,
    secretStore: { persistent: false, async get(key) { return secrets.get(key); }, async set(key, value) { secrets.set(key, value); }, async delete(key) { secrets.delete(key); } },
    readAudioWaveform: asset => waveforms.read(asset), preflightActivity: validateMediaActivity, executeActivity: createActivityExecutor({ ffmpegPath }),
    audioMix: { projectionKey: audioMixProjectionKey, prepare: options => prepareAudioMix({ ...options, ffmpegPath, ffprobePath }), levels: readAudioLevelWindow, silence: options => detectAudioSilence({ ...options, ffmpegPath }) },
  });
  const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60_000)]);
  const interrupt = () => controller.abort(new Error('验收被用户中断；保留原运行与外部回执。'));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const current = async () => projectDetailSchema.parse(await runtime.dispatch('project.get', { projectId: evidence.projectId })).project!;
  const projectDigest = (project: unknown) => createHash('sha256').update(JSON.stringify(project)).digest('hex');
  const stopForReview = async () => { evidence.status = 'awaiting_review'; await persist(); console.log(JSON.stringify({ status: evidence.status, evidence: join(output, 'evidence.json'), projectId: evidence.projectId, phase: evidence.phase })); };
  const waitRun = async (id: string) => {
    for (;;) {
      signal.throwIfAborted(); const run = runSummarySchema.parse(await runtime.dispatch('run.get', { runId: id }));
      if (run.status === 'succeeded') return run;
      if (['failed', 'canceled', 'needs_attention', 'waiting_external', 'waiting_review', 'retry_scheduled'].includes(run.status)) throw new Error(`运行 ${id} 停在 ${run.status}；保留工作区核对，不自动重试。`);
      await delay(250, undefined, { signal });
    }
  };
  const execute = async (phase: string, start: (revision: number) => Promise<unknown>, nodeId: string) => {
    evidence.phase = phase; await persist();
    let item = evidence.runs.find(item => item.phase === phase);
    let newlyStarted = false;
    if (item?.applied) return;
    if (!item) { const project = await current(); item = { phase, nodeId, revision: project.revision, applicationId: createHash('sha256').update(`${project.id}:${phase}`).digest('hex'), applied: false }; evidence.runs.push(item); await persist(); }
    if (item.nodeId !== nodeId) throw new Error('原步骤与当前验收阶段不匹配，未重新提交。');
    if (!item.id) {
      // A hard exit after run.start committed but before its return was recorded
      // must recover that run, not create another billable operation.
      const committed = await committedPhaseRun(runtime.dispatch, evidence.projectId!, phase, nodeId, item.revision);
      if (committed) item.id = committed;
      else { item.id = runSchema.parse(await start(item.revision)).id; newlyStarted = true; }
      await persist();
    }
    const id = item.id;
    const before = runSummarySchema.parse(await runtime.dispatch('run.get', { runId: id }));
    if (before.status !== 'succeeded' && (await current()).revision !== item.revision) throw new Error('验收项目在原运行期间已修改，停止后续提交并保留人工内容。');
    if (resume && !newlyStarted) await resumePhaseRun(runtime.dispatch, id);
    await waitRun(id);
    const inspection = runInspectionSchema.parse(await runtime.dispatch('run.inspect', { runId: id }));
    item.status = inspection.run.status; item.activities = inspection.steps.reduce((sum, step) => sum + step.activityCount, 0);
    const payload = runStepPayloadSchema.parse(await runtime.dispatch('run.step.payload', { runId: id, nodeId, kind: 'output' }));
    if (!payload.available) throw new Error(`${phase} 未保存实际产物。`);
    const applied = projectSchema.parse(await runtime.dispatch('node.apply', { runId: id, nodeId, revision: item.revision, applicationId: item.applicationId }));
    const latest = await current();
    if (latest.revision !== applied.revision || JSON.stringify(latest) !== JSON.stringify(applied)) throw new Error('应用后项目有其他修改，保留原结果等待人工核对。');
    item.applied = true; evidence.projectDigest = projectDigest(latest); await persist();
  };
  try {
    await persist();
    // Verify both local tools before the first billable model operation.
    for (const executable of [ffmpegPath ?? 'ffmpeg', ffprobePath ?? 'ffprobe']) execFileSync(executable, ['-version'], { windowsHide: true, stdio: 'ignore' });
    const models = evidence.models ?? Object.fromEntries(await Promise.all(serviceRoles.map(async role => {
      const entry = config.roles[role], secret = entry.secretEnv ? process.env[entry.secretEnv] : undefined;
      return [role, modelSchema.parse(await runtime.dispatch('model.save', { model: entry.model, ...(secret ? { secret } : {}) }))] as const;
    }))) as Record<ServiceRole, ModelProfile>;
    evidence.models = models; await persist();
    const workspace = workspaceSummarySchema.parse(await runtime.dispatch('workspace.summary'));
    for (const role of serviceRoles) if (JSON.stringify(workspace.models.find(model => model.id === models[role].id)) !== JSON.stringify(models[role])) throw new Error('原模型连接已改变，停止提交并保留原运行。');
    const created = evidence.projectId ? await current() : projectSchema.parse(await runtime.dispatch('project.create', { title: config.title })); evidence.projectId = created.id; await persist();
    if (evidence.runs.length && created.workflow.id !== 'real-service-validation') throw new Error('原验收流程已被修改，保留人工内容并停止提交。');
    if (evidence.projectDigest && !evidence.runs.some(item => !item.applied) && evidence.projectDigest !== projectDigest(created)) throw new Error('原验收项目已有后续人工修改，未继续提交。');
    const kinds = ['script', 'assets', 'voice', 'animation'] as const;
    const roles = ['text', 'image', 'tts', 'video'] as const;
    const project = created.workflow.id === 'real-service-validation' ? created : projectSchema.parse(await runtime.dispatch('project.update', { projectId: created.id, revision: created.revision, patch: {
      brief: config.brief, profile: { width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 }, fitMode: 'contain', previewScale: .5 },
      shots: Array.from({ length: 3 }, (_, index) => ({ id: `service-shot-${index + 1}`, title: `镜头 ${index + 1}`, narration: '这是一份等待真实模型生成的验收稿。', visualPrompt: config.brief, durationUs: 10_000_000 })),
      workflow: { id: 'real-service-validation', name: '真实服务隔离验收', version: 1,
        nodes: kinds.map((kind, index) => ({ id: kind, kind, label: kind, modelId: models[roles[index]].id, prompt: kind === 'script' ? '只返回三个镜头的 JSON，保留镜头编号，每个 durationUs 为 10000000；合计三十秒。旁白适合十秒内自然朗读。' : '' })),
        edges: kinds.slice(1).map((kind, index) => ({ id: `${kinds[index]}-${kind}`, source: kinds[index], target: kind })),
      },
    } }));
    if (!evidence.projectDigest) evidence.projectDigest = projectDigest(project);
    await persist();
    for (const kind of kinds) {
      await execute(kind, revision => runtime.dispatch('run.start', { projectId: project.id, revision, nodeId: kind }), kind);
      const generated = await current();
      if (generated.shots.length !== 3 || Math.abs(generated.shots.reduce((sum, shot) => sum + shot.durationUs, 0) - 30_000_000) > 1_000_000) throw new Error('实际脚本没有生成约三十秒、三个镜头；停止后续模型提交并保留产物。');
      if (stopAfter === kind) { await stopForReview(); return; }
    }
    const spoken = await current();
    if (spoken.shots.length !== 3 || Math.abs(spoken.shots.reduce((sum, shot) => sum + shot.durationUs, 0) - 30_000_000) > 1_000_000) throw new Error('实际脚本没有生成约三十秒、三个镜头，保留产物供审阅。');
    for (const shot of spoken.shots) {
      if (!shot.assetId || !shot.videoAssetId || !shot.audioAssetId) throw new Error('真实图片、视频或配音未全部绑定，拒绝以样例补齐。');
      await execute(`asr:${shot.id}`, revision => runtime.dispatch('caption.transcribe', { projectId: project.id, revision, shotId: shot.id, modelId: models.asr.id }), 'caption');
    }
    if (stopAfter === 'asr') { await stopForReview(); return; }
    const ready = await current();
    if (ready.shots.some(shot => shot.captionTrack?.alignment !== 'speech' || !shot.captionTrack.cues.length)) throw new Error('未取得实际语音时间戳字幕。');
    evidence.phase = 'export';
    if (!evidence.batchId) {
      const batches: unknown = await runtime.dispatch('render.batch.list', { projectId: ready.id, limit: 100 });
      if (!batches || typeof batches !== 'object' || !('items' in batches) || !Array.isArray(batches.items) || batches.items.length > 1) throw new Error('无法唯一核对原导出批次。');
      const batch = batches.items[0] ? exportBatchSchema.parse(batches.items[0]) : exportBatchSchema.parse(await runtime.dispatch('render.batch.start', { projectId: ready.id, revision: ready.revision, destinationDirectory: join(output, 'exports'), targets: [[640, 360], [360, 640], [480, 480]].map(([width, height]) => ({ id: `${width}x${height}`, label: `${width}x${height}`, profile: { ...ready.profile, width, height } })) })); evidence.batchId = batch.id; await persist();
    }
    const batch = exportBatchSchema.parse(await runtime.dispatch('render.batch.get', { batchId: evidence.batchId }));
    if (resume && !['succeeded', 'running', 'queued'].includes(batch.status)) await runtime.dispatch('render.batch.resume', { batchId: batch.id });
    let complete;
    for (;;) {
      signal.throwIfAborted(); complete = exportBatchSchema.parse(await runtime.dispatch('render.batch.get', { batchId: batch.id }));
      if (complete.status === 'succeeded') break;
      if (!['queued', 'running'].includes(complete.status)) throw new Error(`批量导出停在 ${complete.status}；保留完成项，不自动重新生成。`);
      await delay(250, undefined, { signal });
    }
    const previousArtifacts = evidence.artifacts; evidence.artifacts = [];
    for (const target of complete.targets) {
      if (!target.videoPath) throw new Error('导出未提供实际视频文件。');
      const media = await probeMedia(target.videoPath, ffprobePath ?? 'ffprobe');
      if (!media.audio || media.width !== target.profile.width || media.height !== target.profile.height || media.duration < 29 || media.duration > 35) throw new Error('实际成片尺寸、音轨或时长不符合验收。');
      const sha256 = createHash('sha256').update(await readFile(target.videoPath)).digest('hex'), previous = previousArtifacts?.find(artifact => artifact.id === target.id);
      if (previous && previous.sha256 !== sha256) throw new Error('已核对成片的校验值发生变化，保留证据等待人工核对。');
      evidence.artifacts.push({ id: target.id, sha256, duration: media.duration, width: media.width, height: media.height });
    }
    const assets = recordPageSchema(assetSchema).parse(await runtime.dispatch('asset.list', { projectId: ready.id, limit: 100 }));
    if (!['image', 'audio', 'video'].every(kind => assets.items.some(asset => asset.kind === kind && asset.provenance !== '本地示例'))) throw new Error('缺少实际生成的媒体种类。');
    evidence.status = 'passed'; evidence.completedAt = new Date().toISOString(); await persist();
    console.log(JSON.stringify({ status: evidence.status, evidence: join(output, 'evidence.json'), projectId: ready.id, batchId: batch.id, humanReviewRequired: true }));
  } catch (error) {
    evidence.status = 'failed'; evidence.completedAt = new Date().toISOString(); evidence.error = redactServiceFailure(error, values); await persist();
    throw new Error(evidence.error);
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    await waveforms.close(); await runtime.close(); secrets.clear();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error instanceof Error ? error.message : '真实服务验收失败。'); process.exitCode = 1; });
