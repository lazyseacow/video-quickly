import { useEffect, useState } from 'react';
import type { AssetRecord } from '@video-quickly/contracts';
import { getAssetUrl } from '../lib/client';

export default function ReferenceImage({ asset, context = 'creative' }: {
  asset: Pick<AssetRecord, 'id' | 'path' | 'name'>;
  context?: 'creative' | 'character';
}) {
  const character = context === 'character';
  const { id, name, path } = asset;
  const identity = character ? id : path;
  const failureMessage = character ? '参考图无法读取' : '图片无法读取';
  const [source, setSource] = useState<{ identity: string; url?: string; error?: string }>();
  useEffect(() => {
    let active = true;
    void getAssetUrl(path).then(url => {
      if (active) setSource({ identity, url });
    }).catch(error => {
      if (active) setSource({ identity, error: character ? (error instanceof Error ? error.message : String(error)) : failureMessage });
    });
    return () => { active = false; };
  }, [character, failureMessage, identity, path]);

  const current = source?.identity === identity ? source : undefined;
  return current?.url
    ? <img src={current.url} alt={character ? name : ''} loading="lazy" onError={() => setSource({ identity, error: failureMessage })} />
    : <span className="tiny-meta">{current?.error || '读取中…'}</span>;
}
