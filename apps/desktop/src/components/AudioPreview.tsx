import { useEffect, useRef } from 'react';
import type { AssetRecord } from '@video-quickly/contracts';
import { getAssetUrl } from '../lib/client';

export default function AudioPreview({ asset, playing, timeUs, muted, onError }: { asset?: AssetRecord; playing: boolean; timeUs: number; muted: boolean; onError: (message: string, error?: boolean) => void }) {
  const element = useRef<HTMLAudioElement>(null);
  const latest = useRef({ playing, timeUs, muted, onError });
  const synchronize = useRef<(() => void) | undefined>(undefined);
  latest.current = { playing, timeUs, muted, onError };
  useEffect(() => {
    const audio = element.current;
    if (!audio || !asset) return;
    let active = true;
    let failed = false;
    let pendingPlay = false;
    function fail(message: string) { if (active && !failed) { failed = true; latest.current.onError(message, true); } }
    function sync() {
      if (!audio || !active) return;
      const state = latest.current;
      audio.muted = state.muted;
      if (!state.playing) { audio.pause(); failed = false; }
      if (!Number.isFinite(audio.duration)) return;
      const target = Math.max(0, state.timeUs / 1_000_000);
      if (target >= audio.duration) { audio.pause(); return; }
      if (Math.abs(audio.currentTime - target) > (state.playing ? .2 : .001)) audio.currentTime = target;
      if (state.playing && !failed && !pendingPlay && audio.paused) {
        pendingPlay = true;
        void audio.play().catch(error => { if (latest.current.playing && error instanceof Error && error.name !== 'AbortError') fail('旁白暂时无法播放，可暂停后重试或检查音频格式。'); }).finally(() => { pendingPlay = false; });
      }
    }
    const mediaError = () => fail('旁白音频无法解码，请更换素材。');
    synchronize.current = sync;
    audio.addEventListener('loadedmetadata', sync); audio.addEventListener('error', mediaError);
    void getAssetUrl(asset.path).then(url => { if (active) { audio.src = url; audio.load(); } }).catch(() => fail('旁白音频无法读取，请检查素材文件。'));
    return () => {
      active = false; synchronize.current = undefined;
      audio.removeEventListener('loadedmetadata', sync); audio.removeEventListener('error', mediaError);
      audio.pause(); audio.removeAttribute('src'); audio.load();
    };
  }, [asset?.path, asset?.sha256]);
  useEffect(() => { synchronize.current?.(); }, [playing, timeUs, muted]);
  return <audio ref={element} preload="metadata" hidden />;
}
