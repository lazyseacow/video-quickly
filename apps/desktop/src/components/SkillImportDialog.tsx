import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Download } from 'lucide-react';
import { skillImportJobSchema } from '@video-quickly/contracts';
import { rpc } from '../lib/client';
import { pathExample } from '../lib/desktop';
import { Button, Dialog, Field, Notice } from './Primitives';
import PathPicker from './PathPicker';

export default function SkillImportDialog({ onClose }: { onClose(): void }) {
  const [source, setSource] = useState('');
  const [groupName, setGroupName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const closed = useRef(false);
  useEffect(() => { closed.current = false; return () => { closed.current = true; }; }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    const value = source.trim();
    try {
      skillImportJobSchema.parse(await rpc('skill.import.start', {
        source: /^https?:\/\//i.test(value) ? { url: value } : { path: value },
        ...(groupName.trim() ? { groupName: groupName.trim() } : {}), requestId: crypto.randomUUID(),
      }));
      if (!closed.current) onClose();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (!closed.current) setError(message.replace(/^Error invoking remote method 'vq:runtime': (?:Error: )?/, ''));
    } finally {
      inFlight.current = false;
      if (!closed.current) setBusy(false);
    }
  }

  return <Dialog title="导入 Skill" onClose={onClose} onDismissStart={() => { closed.current = true; }}><form onSubmit={event => void submit(event)}>
    <div className="dialog__body">
      <Field label="目录路径或 GitHub 链接" hint="支持本地目录、ZIP 文件和 GitHub 仓库，自动导入其中的全部 Skill。">
        <PathPicker label="目录路径或 GitHub 链接" mode="directory" autoFocus required disabled={busy} value={source} onChange={value => { setSource(value); setError(''); }} placeholder={pathExample('skill')} />
      </Field>
      <Field label="分组名称（可选）" hint="留空使用仓库或文件夹名称。"><input disabled={busy} maxLength={120} value={groupName} onChange={event => setGroupName(event.target.value)} placeholder="例如：短剧创作" /></Field>
      <p className="field__hint">提交后在后台继续导入，可关闭窗口或切换页面。在 Skill 工作室查看进度与结果。</p>
      {error && <Notice kind="error">{error}</Notice>}
    </div>
    <div className="dialog__footer"><Button onClick={onClose}>关闭</Button><Button variant="primary" type="submit" busy={busy} disabled={!source.trim()}><Download size={15} />导入</Button></div>
  </form></Dialog>;
}
