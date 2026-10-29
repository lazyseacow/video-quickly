import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { audioWaveformSchema, type AssetRecord, type AudioWaveform } from '@video-quickly/contracts';

const ALGORITHM = 'v1-mono-16000-peak-100hz';
const SAMPLE_RATE = 16_000;
const SAMPLES_PER_PEAK = 160;

async function sourceHash(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  signal.throwIfAborted();
  return hash.digest('hex');
}

async function decode(asset: AssetRecord, ffmpeg: string, signal: AbortSignal): Promise<AudioWaveform> {
  signal.throwIfAborted();
  const peaks: number[] = [];
  let samples = 0, peak = 0, remainder = Buffer.alloc(0), stderr = '';
  const child = spawn(ffmpeg, ['-nostdin', '-v', 'error', '-i', asset.path, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-acodec', 'pcm_f32le', '-f', 'f32le', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    child.kill('SIGTERM');
    forceKill = setTimeout(() => child.kill('SIGKILL'), 2_000);
    forceKill.unref();
  };
  signal.addEventListener('abort', abort, { once: true });
  child.stdout.on('data', (chunk: Buffer) => {
    const bytes = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
    const end = bytes.length - bytes.length % 4;
    for (let offset = 0; offset < end; offset += 4) {
      const amplitude = Math.abs(bytes.readFloatLE(offset));
      if (Number.isFinite(amplitude)) peak = Math.max(peak, Math.min(1, amplitude));
      samples++;
      if (samples % SAMPLES_PER_PEAK === 0) { peaks.push(peak); peak = 0; }
    }
    remainder = Buffer.from(bytes.subarray(end));
  });
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8_000); });
  try {
    await new Promise<void>((resolve, reject) => {
      let failure: Error | undefined;
      child.once('error', error => { failure = error; });
      child.once('close', code => {
        if (signal.aborted) { reject(signal.reason); return; }
        if (failure) { reject(new Error('无法启动音频解码器，请检查 FFmpeg 配置。', { cause: failure })); return; }
        if (code !== 0) { reject(new Error(`无法读取音频波形${stderr.trim() ? `：${stderr.trim()}` : '，素材未包含可解码音轨。'}`)); return; }
        resolve();
      });
    });
  } finally {
    signal.removeEventListener('abort', abort);
    if (forceKill !== undefined) clearTimeout(forceKill);
  }
  if (samples % SAMPLES_PER_PEAK) peaks.push(peak);
  if (!samples || remainder.length) throw new Error('素材未包含有效的音频采样，无法生成波形。');
  return audioWaveformSchema.parse({ version: 1, assetId: asset.id, sha256: asset.sha256, durationUs: Math.round(samples * 1_000_000 / SAMPLE_RATE), peaksPerSecond: 100, peaks });
}

/** Derived audio data is content addressed and never enters project documents or edit history. */
export function createWaveformReader(options: { dataDirectory: string; ffmpegPath?: string; maxConcurrent?: number }) {
  const cacheDirectory = resolve(options.dataDirectory, 'derived', 'waveforms', ALGORITHM);
  const maximum = options.maxConcurrent ?? 2;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 4) throw new RangeError('波形并发数须介于 1 和 4。');
  type Job = { controller: AbortController; promise: Promise<AudioWaveform>; consumers: number };
  const jobs = new Map<string, Job>();
  const allJobs = new Set<Job>();
  const waiting: Array<() => void> = [];
  let active = 0, closed = false;

  async function withSlot<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    if (active >= maximum) await new Promise<void>((resolve, reject) => {
      const proceed = () => { active++; signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => { const index = waiting.indexOf(proceed); if (index !== -1) waiting.splice(index, 1); reject(signal.reason); };
      waiting.push(proceed);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    else active++;
    try { signal.throwIfAborted(); return await work(); }
    finally { active--; waiting.shift()?.(); }
  }

  async function readOrDecode(asset: AssetRecord, signal: AbortSignal): Promise<AudioWaveform> {
    const actualHash = await sourceHash(asset.path, signal);
    if (actualHash !== asset.sha256) throw new Error('音频素材校验失败，请重新导入后生成波形。');
    const cachePath = join(cacheDirectory, `${actualHash}.json`);
    try {
      const cached = audioWaveformSchema.safeParse(JSON.parse(await readFile(cachePath, 'utf8')));
      if (cached.success && cached.data.sha256 === actualHash) return { ...cached.data, assetId: asset.id };
      await rm(cachePath, { force: true });
    } catch (error) {
      if (error instanceof SyntaxError) await rm(cachePath, { force: true });
      else if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const result = await decode(asset, options.ffmpegPath ?? process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg', signal);
    if (await sourceHash(asset.path, signal) !== actualHash) throw new Error('读取期间音频素材已变化，请重新导入后重试。');
    signal.throwIfAborted();
    await mkdir(cacheDirectory, { recursive: true });
    const temporary = `${cachePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(result), { signal });
      signal.throwIfAborted();
      await rename(temporary, cachePath);
    } finally { await rm(temporary, { force: true }); }
    return result;
  }

  return {
    read(asset: AssetRecord, request: { signal?: AbortSignal } = {}): Promise<AudioWaveform> {
      if (closed) return Promise.reject(new Error('音频波形读取器已关闭。'));
      if (asset.kind !== 'audio' && asset.kind !== 'video') return Promise.reject(new Error('此素材不包含音频波形。'));
      if (request.signal?.aborted) return Promise.reject(request.signal.reason);
      const key = JSON.stringify([resolve(asset.path), asset.sha256]);
      let job = jobs.get(key);
      if (!job) {
        const controller = new AbortController();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5 * 60_000)]);
        const entry: Job = { controller, consumers: 0, promise: withSlot(signal, () => readOrDecode(asset, signal)).finally(() => { if (jobs.get(key) === entry) jobs.delete(key); allJobs.delete(entry); }) };
        jobs.set(key, entry);
        allJobs.add(entry);
        job = entry;
      }
      const shared = job;
      shared.consumers++;
      return new Promise<AudioWaveform>((resolve, reject) => {
        let settled = false;
        const finish = () => {
          if (settled) return false;
          settled = true;
          request.signal?.removeEventListener('abort', abort);
          shared.consumers--;
          return true;
        };
        const abort = () => {
          if (!finish()) return;
          if (!shared.consumers) { jobs.delete(key); shared.controller.abort(); }
          reject(request.signal?.reason);
        };
        request.signal?.addEventListener('abort', abort, { once: true });
        shared.promise.then(value => { if (finish()) resolve({ ...value, assetId: asset.id }); }, error => { if (finish()) reject(error); });
      });
    },
    async close() {
      closed = true;
      const pending = [...allJobs];
      pending.forEach(job => job.controller.abort());
      await Promise.allSettled(pending.map(job => job.promise));
    },
  };
}
