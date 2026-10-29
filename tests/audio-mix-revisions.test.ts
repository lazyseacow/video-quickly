import { afterEach, expect, it, vi } from 'vitest';
import { createHistoryWorkflow, DEFAULT_VIDEO_PROFILE, projectSchema, type AudioMixJob, type PreparedAudioMix } from '@video-quickly/contracts';
import { rpc } from '../apps/desktop/src/lib/client';
import { prepareAudioMixPreview, prepareLatestAudioMixPreview } from '../apps/desktop/src/lib/audio-mix';

vi.mock('../apps/desktop/src/lib/client', () => ({ rpc: vi.fn() }));
const request = vi.mocked(rpc), key = 'd'.repeat(64);
const project = () => projectSchema.parse({ id: 'revision-preview', title: '版本同步试听', revision: 3, brief: '', profile: DEFAULT_VIDEO_PROFILE, workflow: createHistoryWorkflow(), createdAt: '', updatedAt: '', shots: [{ id: 'voice-shot', title: '旁白', narration: '', visualPrompt: '', durationUs: 1_000_000, sourceInUs: 0, audioAssetId: 'voice' }] });
const mix = (): PreparedAudioMix => ({ version: 1, key, path: '/derived/revision.wav', sha256: 'e'.repeat(64), durationUs: 1_000_000, shotDurations: [{ shotId: 'voice-shot', durationUs: 1_000_000 }], analysis: { sampleRate: 48000, channels: 2 }, warnings: [] });
const ready = (): AudioMixJob => ({ id: 'revision-job', key, status: 'succeeded', progress: 1, result: mix() });
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

it('reports a revision observation separately from a job and never polls or publishes it as processing progress', async () => {
  request.mockResolvedValue({ status: 'revision_changed', revision: 4 });
  const progress = vi.fn();
  await expect(prepareAudioMixPreview(project(), new AbortController().signal, progress)).rejects.toMatchObject({ name: 'AudioMixRevisionChangedError', expectedRevision: 4, message: expect.stringContaining('合并') });
  expect(request.mock.calls.map(call => call[0])).toEqual(['audio.mix.prepare']);
  expect(progress).not.toHaveBeenCalled();
});

it('keeps the caller draft untouched and permits a subsequent explicit audition with the synchronized revision', async () => {
  const draft = project(), original = structuredClone(draft);
  request.mockResolvedValueOnce({ status: 'revision_changed', revision: 4 }).mockResolvedValueOnce(ready());
  await expect(prepareAudioMixPreview(draft, new AbortController().signal)).rejects.toMatchObject({ name: 'AudioMixRevisionChangedError' });
  expect(draft).toEqual(original);
  const latest = { ...draft, revision: 4, title: '外部更新的标题' };
  expect(await prepareAudioMixPreview(latest, new AbortController().signal)).toEqual(mix());
  expect(request.mock.calls.map(call => (call[1] as { project: { revision: number } }).project.revision)).toEqual([3, 4]);
});

it.each([0, -1, 4.5, '4'])('rejects invalid observed revision %s instead of treating it as a retryable state', async revision => {
  request.mockResolvedValue({ status: 'revision_changed', revision });
  let failure: unknown;
  try { await prepareAudioMixPreview(project(), new AbortController().signal); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toMatchObject({ name: 'AudioMixRevisionChangedError' });
  expect(request).toHaveBeenCalledTimes(1);
});

it('discards a late revision observation when its local observer has already aborted', async () => {
  let finish!: (value: unknown) => void;
  request.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController(), pending = prepareAudioMixPreview(project(), controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort(); await rejected;
  finish({ status: 'revision_changed', revision: 4 }); await Promise.resolve();
  expect(request).toHaveBeenCalledTimes(1);
});

it('preserves a real processing failure as an explicit failure without an automatic retry', async () => {
  request.mockResolvedValue({ ...ready(), status: 'failed', result: undefined, error: '声音文件校验失败' });
  await expect(prepareAudioMixPreview(project(), new AbortController().signal)).rejects.toThrow('声音文件校验失败');
  expect(request.mock.calls.map(call => call[0])).toEqual(['audio.mix.prepare']);
});

it('waits for the observed revision before retrying once with the latest complete draft', async () => {
  vi.useFakeTimers();
  let latest = { project: project(), projection: 'current-projection' };
  request.mockResolvedValueOnce({ status: 'revision_changed', revision: 4 }).mockResolvedValueOnce(ready());
  const work = prepareLatestAudioMixPreview(() => latest, latest.projection, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(100);
  expect(request).toHaveBeenCalledTimes(1);
  latest = { ...latest, project: { ...latest.project, revision: 4, title: '同步后的无关标题' } };
  await vi.advanceTimersByTimeAsync(100);
  expect(await work).toEqual(mix());
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1]).toEqual(['audio.mix.prepare', { project: latest.project }]);
});

it('bounds an unresolved conflict to three seconds and preserves the original revision for an explicit merge', async () => {
  vi.useFakeTimers();
  const draft = project(), latest = { project: draft, projection: 'conflicted-projection' };
  request.mockResolvedValue({ status: 'revision_changed', revision: 4 });
  const work = prepareLatestAudioMixPreview(() => latest, latest.projection, new AbortController().signal);
  const rejected = expect(work).rejects.toMatchObject({ name: 'AudioMixRevisionChangedError', expectedRevision: 4, message: expect.stringContaining('合并') });
  await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(2_999);
  expect(request).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); await rejected;
  expect(latest.project).toBe(draft); expect(latest.project.revision).toBe(3);
  expect(request).toHaveBeenCalledTimes(1);
});

it('does not chase a second revision observation after its single synchronized retry', async () => {
  const latest = { project: project(), projection: 'changing-projection' };
  request.mockImplementationOnce(async () => { latest.project = { ...latest.project, revision: 4 }; return { status: 'revision_changed', revision: 4 }; })
    .mockResolvedValueOnce({ status: 'revision_changed', revision: 5 });
  await expect(prepareLatestAudioMixPreview(() => latest, latest.projection, new AbortController().signal)).rejects.toMatchObject({ name: 'AudioMixRevisionChangedError', expectedRevision: 5 });
  expect(request).toHaveBeenCalledTimes(2);
});

it('discards the obsolete observation when audio inputs change while waiting for revision synchronization', async () => {
  vi.useFakeTimers();
  const latest = { project: project(), projection: 'old-projection' };
  request.mockResolvedValue({ status: 'revision_changed', revision: 4 });
  const work = prepareLatestAudioMixPreview(() => latest, latest.projection, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(0);
  latest.projection = 'new-projection';
  await vi.advanceTimersByTimeAsync(100);
  expect(await work).toBeUndefined(); expect(request).toHaveBeenCalledTimes(1);
});

it('aborts revision waiting immediately and never starts a replacement backend job', async () => {
  vi.useFakeTimers();
  const latest = { project: project(), projection: 'aborted-projection' }, controller = new AbortController();
  request.mockResolvedValue({ status: 'revision_changed', revision: 4 });
  const work = prepareLatestAudioMixPreview(() => latest, latest.projection, controller.signal);
  const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(0); controller.abort(); await rejected;
  await vi.runAllTimersAsync(); expect(request.mock.calls.map(call => call[0])).toEqual(['audio.mix.prepare']);
});

it.each(['network', 'job'])('does not retry a real %s failure merely because an unrelated revision arrived', async kind => {
  const latest = { project: project(), projection: 'failed-projection' };
  request.mockImplementation(async () => {
    latest.project = { ...latest.project, revision: 4, title: '更新后的标题' };
    if (kind === 'network') throw new Error('连接中断');
    return { ...ready(), status: 'failed', result: undefined, error: '音频解码失败' };
  });
  await expect(prepareLatestAudioMixPreview(() => latest, latest.projection, new AbortController().signal)).rejects.toThrow(kind === 'network' ? '连接中断' : '音频解码失败');
  expect(request).toHaveBeenCalledTimes(1);
});
