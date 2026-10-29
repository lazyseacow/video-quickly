import { Channel, convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import type { RuntimeEvent } from '@video-quickly/contracts';

export async function rpc<T = unknown>(method: string, params: unknown = {}): Promise<T> {
  if (isTauri()) return invoke<T>('runtime_request', { method, params });
  if (!import.meta.env.DEV) throw new Error('请使用桌面客户端打开此项目');
  const response = await fetch('/__desktop_rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== 'object') throw new Error('执行进程返回了无效响应');
  if ('error' in payload) throw new Error(String(payload.error));
  if (!('result' in payload)) throw new Error('执行进程未返回操作结果');
  return payload.result as T;
}

export function subscribe(listener: (event: RuntimeEvent) => void): () => void {
  if (isTauri()) {
    const channel = new Channel<RuntimeEvent>();
    let active = true;
    channel.onmessage = event => { if (active) listener(event); };
    void invoke('runtime_subscribe', { channel }).catch(() => listener({ type: 'workspace.changed' }));
    return () => { active = false; };
  }
  import.meta.hot?.on('workspace-event', listener);
  return () => { import.meta.hot?.off('workspace-event', listener); };
}

export async function getAssetUrl(path: string): Promise<string> {
  return isTauri() ? convertFileSrc(path) : `/__desktop_asset?path=${encodeURIComponent(path)}`;
}
