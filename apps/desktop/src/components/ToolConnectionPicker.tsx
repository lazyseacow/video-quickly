import { useEffect, useState } from 'react';
import type { MCPServer } from '@video-quickly/contracts';
import { rpc } from '../lib/client';

export default function ToolConnectionPicker({ value, onChange, label = '使用工具连接' }: { value: string[]; onChange(ids: string[]): void; label?: string }) {
  const [servers, setServers] = useState<MCPServer[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void rpc<MCPServer[]>('tool.list').then(servers => { if (active) { setServers(servers); setLoading(false); } }).catch(reason => { if (active) { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false); } });
    return () => { active = false; };
  }, []);
  const missing = value.filter(id => !servers.some(server => server.id === id));
  return <fieldset className="capability-fieldset" aria-label={label}><legend>{label}</legend><p className="field__hint">可多选；留空由 Agent 按任务自动选择，选定后仅使用勾选的连接。</p>{error ? <p role="alert" className="field-error">{error}</p> : loading ? <p role="status" className="tiny-meta">正在读取工具连接…</p> : <>
    {servers.filter(server => server.enabled || value.includes(server.id)).map(server => <label className="field-inline" key={server.id}><input type="checkbox" checked={value.includes(server.id)} onChange={event => onChange(event.target.checked ? [...new Set([...value, server.id])] : value.filter(id => id !== server.id))} />{server.name}{!server.enabled && '（已停用）'}</label>)}
    {missing.map(id => <label className="field-inline" key={id}><input type="checkbox" checked onChange={() => onChange(value.filter(selected => selected !== id))} />不可用的工具连接</label>)}
    {!servers.some(server => server.enabled) && !value.length && <p className="tiny-meta">在“工具连接”中启用连接后，可为本任务勾选。</p>}
  </>}</fieldset>;
}
