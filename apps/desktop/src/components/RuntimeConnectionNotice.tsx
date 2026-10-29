import { RefreshCw } from 'lucide-react';
import type { RuntimeConnection } from '@video-quickly/contracts';
import { Button, Notice } from './Primitives';

export default function RuntimeConnectionNotice({ connection, onReconnect }: { connection: RuntimeConnection; onReconnect: () => void }) {
  if (connection.state === 'ready') return null;
  const reconnecting = connection.state === 'reconnecting';
  return <div className="runtime-connection-notice"><Notice kind={reconnecting ? 'info' : 'error'}><span><strong>{reconnecting ? '正在重新连接本地执行组件' : '本地执行组件已断开'}</strong><span>{reconnecting ? '连接后会刷新已保存的任务状态。' : connection.message || '编辑草稿已保留，连接后可核对任务是否完成。'}</span></span><Button busy={reconnecting} onClick={onReconnect}><RefreshCw size={15} />重新连接</Button></Notice></div>;
}
