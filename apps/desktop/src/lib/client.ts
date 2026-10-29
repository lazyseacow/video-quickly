import { Channel, convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import type { RuntimeEvent } from '@video-quickly/contracts';

const listeners = new Set<(event: RuntimeEvent) => void>();

export async function rpc<T = unknown>(method: string, params: unknown = {}): Promise<T> {
  if (isTauri()) {
    if (method === 'runtime.status') return invoke<T>('runtime_status');
    if (method === 'runtime.reconnect') return invoke<T>('runtime_reconnect');
    return invoke<T>('runtime_request', { method, params });
  }
  if (!import.meta.env.DEV) throw new Error('请使用桌面客户端打开此项目');
  let response: Response;
  try { response = await fetch('/__desktop_rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) }); }
  catch (error) { listeners.forEach(listener => listener({ type: 'runtime.connection', data: { state: 'disconnected', generation: 0, message: '本地执行服务连接中断，请重新连接后核对任务状态。' } })); throw new Error('连接已中断，请重新连接后核对操作是否完成。', { cause: error }); }
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== 'object') throw new Error('执行进程返回了无效响应');
  if ('error' in payload) throw new Error(String(payload.error));
  if (!('result' in payload)) throw new Error('执行进程未返回操作结果');
  return payload.result as T;
}

export function subscribe(listener: (event: RuntimeEvent) => void): () => void {
  listeners.add(listener);
  if (isTauri()) {
    const channel = new Channel<RuntimeEvent>();
    let active = true;
    channel.onmessage = event => { if (active) listener(event); };
    void invoke('runtime_subscribe', { channel }).catch(() => listener({ type: 'runtime.connection', data: { state: 'disconnected', generation: 0, message: '执行组件订阅失败，请重新连接。' } }));
    return () => { active = false; listeners.delete(listener); };
  }
  import.meta.hot?.on('workspace-event', listener);
  return () => { import.meta.hot?.off('workspace-event', listener); listeners.delete(listener); };
}

export async function getAssetUrl(path: string): Promise<string> {
  return isTauri() ? convertFileSrc(path) : `/__desktop_asset?path=${encodeURIComponent(path)}`;
}
