import { afterEach, expect, it, vi } from 'vitest';
import { createHistoryWorkflow, DEFAULT_VIDEO_PROFILE, projectSchema, type AudioMixJob, type PreparedAudioMix } from '@video-quickly/contracts';
import { rpc } from '../apps/desktop/src/lib/client';
import { prepareAudioMixPreview, readAudioLevels } from '../apps/desktop/src/lib/audio-mix';

vi.mock('../apps/desktop/src/lib/client', () => ({ rpc: vi.fn() }));
const request = vi.mocked(rpc), key = 'a'.repeat(64);
const project = () => projectSchema.parse({ id: 'mix-project', title: '试听', revision: 1, brief: '', profile: DEFAULT_VIDEO_PROFILE, workflow: createHistoryWorkflow(), createdAt: '', updatedAt: '', shots: [1, 2].map(index => ({ id: `shot-${index}`, title: '镜头', narration: '', visualPrompt: '', durationUs: 1_000_000, sourceInUs: 0, audioAssetId: 'voice' })) });
const result = (): PreparedAudioMix => ({ version: 1, key, path: '/derived/mix.wav', sha256: 'b'.repeat(64), durationUs: 2_000_000, shotDurations: [{ shotId: 'shot-1', durationUs: 1_000_000 }, { shotId: 'shot-2', durationUs: 1_000_000 }], analysis: { sampleRate: 48000, channels: 2 }, warnings: [] });
const job = (status: AudioMixJob['status'], mix = result()): AudioMixJob => ({ id: 'job', key, status, progress: status === 'succeeded' ? 1 : .5, ...(status === 'succeeded' ? { result: mix } : {}) });
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

it('observes one shared job until ready and validates its complete shot duration mapping', async () => {
  vi.useFakeTimers();
  request.mockResolvedValueOnce(job('queued')).mockResolvedValueOnce(job('running')).mockResolvedValueOnce(job('succeeded'));
  const statuses: string[] = [], work = prepareAudioMixPreview(project(), new AbortController().signal, value => statuses.push(value.status));
  await vi.runAllTimersAsync();
  expect(await work).toEqual(result()); expect(statuses).toEqual(['queued', 'running', 'succeeded']);
  expect(request.mock.calls.map(call => call[0])).toEqual(['audio.mix.prepare', 'audio.mix.get', 'audio.mix.get']);
});

it('stops an aborted observer immediately without cancelling the backend shared job', async () => {
  let finish: ((value: unknown) => void) | undefined;
  request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController(), pending = prepareAudioMixPreview(project(), controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' }); controller.abort(); await rejected;
  finish?.(job('succeeded')); await Promise.resolve();
  expect(request).toHaveBeenCalledTimes(1); expect(request.mock.calls[0][0]).toBe('audio.mix.prepare');
});

it('does not keep polling after aborting a queued job and rejects a different job identity', async () => {
  vi.useFakeTimers(); request.mockResolvedValue(job('queued'));
  const controller = new AbortController(), pending = prepareAudioMixPreview(project(), controller.signal);
  await Promise.resolve(); await Promise.resolve();
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' }); controller.abort(); await rejected; await vi.runAllTimersAsync(); expect(request).toHaveBeenCalledTimes(1);
  request.mockReset(); request.mockResolvedValueOnce(job('queued')).mockResolvedValueOnce({ ...job('succeeded'), id: 'another-job' });
  const wrong = expect(prepareAudioMixPreview(project(), new AbortController().signal)).rejects.toThrow('其他混音'); await vi.runAllTimersAsync(); await wrong;
});

it.each([
  ['missing duration mapping', { ...result(), shotDurations: undefined }],
  ['reordered shot mapping', { ...result(), shotDurations: result().shotDurations!.toReversed() }],
  ['incorrect total duration', { ...result(), durationUs: 2_500_000 }],
  ['extended explicit range', { ...result(), durationUs: 2_500_000, shotDurations: [{ shotId: 'shot-1', durationUs: 1_500_000 }, result().shotDurations![1]] }],
  ['foreign result key', { ...result(), key: 'c'.repeat(64) }],
] as const)('rejects %s before handing a mix to playback', async (_label, mix) => {
  request.mockResolvedValue(job('succeeded', mix));
  await expect(prepareAudioMixPreview(project(), new AbortController().signal)).rejects.toThrow('不匹配');
});

it('allows complete legacy narration to extend and rejects a shorter legacy result', async () => {
  const legacy = project(); delete legacy.shots[0].sourceInUs;
  const longer = { ...result(), durationUs: 2_500_000, shotDurations: [{ shotId: 'shot-1', durationUs: 1_500_000 }, result().shotDurations![1]] };
  request.mockResolvedValueOnce(job('succeeded', longer)); expect(await prepareAudioMixPreview(legacy, new AbortController().signal)).toEqual(longer);
  request.mockResolvedValueOnce(job('succeeded', { ...result(), durationUs: 1_500_000, shotDurations: [{ shotId: 'shot-1', durationUs: 500_000 }, result().shotDurations![1]] }));
  await expect(prepareAudioMixPreview(legacy, new AbortController().signal)).rejects.toThrow('时长不匹配');
  delete legacy.shots[0].audioAssetId;
  request.mockResolvedValueOnce(job('succeeded', longer));
  await expect(prepareAudioMixPreview(legacy, new AbortController().signal)).rejects.toThrow('时长不匹配');
});

it('surfaces processing failures and refuses a stale level window', async () => {
  request.mockResolvedValueOnce({ ...job('failed'), error: '素材无法读取' });
  await expect(prepareAudioMixPreview(project(), new AbortController().signal)).rejects.toThrow('素材无法读取');
  request.mockResolvedValueOnce({ key: 'c'.repeat(64), startUs: 10_000, periodUs: 10_000, samples: [] });
  await expect(readAudioLevels(result(), 12_345, 100_000)).rejects.toThrow('不匹配');
  request.mockResolvedValueOnce({ key, startUs: 10_000, periodUs: 10_000, samples: [{ peakLeft: .5, peakRight: .25, rmsLeft: .3, rmsRight: .1 }] });
  expect((await readAudioLevels(result(), 12_345, 100_000)).samples).toHaveLength(1);
  await expect(readAudioLevels(result(), 0, 60_000_001)).rejects.toThrow('60 秒');
});
