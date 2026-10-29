import { useEffect, useState } from 'react';
import type { MCPServer, WorkflowNode } from '@video-quickly/contracts';
import { rpc } from '../lib/client';

export default function ToolBindings({ node, onChange }: { node: WorkflowNode; onChange: (node: WorkflowNode) => void }) {
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void rpc<MCPServer[]>('tool.list').then(value => { if (active) setServers(value); }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, []);
  const selected = Array.isArray(node.config.mcpServerIds) ? node.config.mcpServerIds.filter((value): value is string => typeof value === 'string') : [];
  return <fieldset className="capability-fieldset"><legend>使用工具连接</legend>{error ? <p role="alert" className="field-error">{error}</p> : servers.some(server => server.enabled) ? servers.filter(server => server.enabled).map(server => <label className="field-inline" key={server.id}><input type="checkbox" checked={selected.includes(server.id)} onChange={event => onChange({ ...node, config: { ...node.config, mcpServerIds: event.target.checked ? [...selected, server.id] : selected.filter(id => id !== server.id) } })} />{server.name}</label>) : <p className="tiny-meta">在 Skill 工作室添加并启用工具连接，再选择这个 Agent 可以使用的工具。</p>}</fieldset>;
}
