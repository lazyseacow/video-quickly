import { createActivityExecutor, createWaveformReader, validateMediaActivity } from '@video-quickly/integrations';
import { audioMixProjectionKey, detectAudioSilence, prepareAudioMix, readAudioLevelWindow } from '@video-quickly/video/audio-mix';
import type { RuntimeOptions } from './index.js';

export { createLogger, logError } from './logging.js';
export { generateText } from './providers.js';
export { readStoryboardWebResearch } from './storyboard-research.js';

export function createRuntimeMediaServices({ dataDirectory, ffmpegPath }: { dataDirectory: string; ffmpegPath?: string }) {
  const waveforms = createWaveformReader({ dataDirectory, ffmpegPath });
  const options = {
    ffmpegPath,
    readAudioWaveform: asset => waveforms.read(asset),
    audioMix: {
      projectionKey: audioMixProjectionKey,
      prepare: options => prepareAudioMix({ ...options, ffmpegPath }),
      levels: readAudioLevelWindow,
      silence: options => detectAudioSilence({ ...options, ffmpegPath }),
    },
    preflightActivity: validateMediaActivity,
    executeActivity: createActivityExecutor({ ffmpegPath }),
  } satisfies Pick<RuntimeOptions, 'ffmpegPath' | 'readAudioWaveform' | 'audioMix' | 'preflightActivity' | 'executeActivity'>;

  return { options, close: () => waveforms.close() };
}
