import { useRef, useState } from 'react';
import { LockKeyhole, Save } from 'lucide-react';
import { type CreativeContext } from '@video-quickly/contracts';
import { planningLabels, type PlanningChange, type PlanningProject, type PlanningSection, type PlanningShot } from '../lib/planning-edits';
import CreativeContextEditor from './CreativeContextEditor';
import { Button, Dialog, Field, Notice } from './Primitives';
import './planning-result-editor.css';

export default function PlanningResultEditor({ section, baseline, version, onSave, onClose }: {
  section: PlanningSection; baseline: PlanningProject; version: number;
  onSave(change: PlanningChange): Promise<boolean>; onClose(): void;
}) {
  const [text, setText] = useState(section === 'brief' ? baseline.brief : baseline.style);
  const [context, setContext] = useState<CreativeContext | null>(baseline.creativeContext ?? null);
  const [shots, setShots] = useState<PlanningShot[]>(() => baseline.shots.map(({ id, title, narration, visualPrompt, soundPrompt }) => ({ id, title, narration, visualPrompt, soundPrompt })));
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [attempted, setAttempted] = useState(false);
  const inFlight = useRef(false);
  function updateShot(id: string, patch: Partial<PlanningShot>) { setShots(current => current.map(shot => shot.id === id ? { ...shot, ...patch } : shot)); }
  async function submit() {
    if (inFlight.current) return;
    inFlight.current = true; setPending(true); setError('');
    try {
      const change: PlanningChange = section === 'brief' ? { kind: 'brief', text } : section === 'style' ? { kind: 'style', text, creativeContext: context } : { kind: 'script', shots };
      setAttempted(true);
      if (await onSave(change)) onClose();
      else setError('保存未完成，修改已保留为项目草稿，可以重试保存。');
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { inFlight.current = false; setPending(false); }
  }
  return <Dialog title={`编辑${planningLabels[section]}`} onClose={onClose} className="planning-result-editor">
    <form onSubmit={event => { event.preventDefault(); void submit(); }} onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.currentTarget.requestSubmit(); }
    }}>
      <div className="dialog__body planning-result-editor__body">
        <p className="planning-result-editor__hint">保存到当前项目，用于后续制作；已生成的视频需重新制作以更新。</p>
        {error && <Notice kind="error">{error}</Notice>}
        <fieldset disabled={pending} className="planning-result-editor__fields">
          {section !== 'script' ? <>
            <Field label={section === 'brief' ? '创意简报' : '视觉风格'}><textarea rows={section === 'brief' ? 14 : 8} value={text} onChange={event => setText(event.target.value)} /></Field>
            {section === 'style' && <CreativeContextEditor value={context} version={version} usedEntityKeys={baseline.shots.flatMap(shot => shot.creativeEntityKeys ?? [])} onChange={setContext} />}
          </> : <ol className="planning-result-editor__shots">{shots.map((shot, index) => {
            const original = baseline.shots.find(item => item.id === shot.id)!;
            return <li key={shot.id}><header><strong>镜头 {String(index + 1).padStart(2, '0')}</strong><span>{(original.durationUs / 1_000_000).toFixed(1)} 秒</span>{original.locked && <span><LockKeyhole size={14} />已锁定</span>}</header><fieldset disabled={original.locked} className="planning-result-editor__fields" aria-label={`镜头 ${index + 1} 内容`}>
              <Field label="镜头标题"><input required value={shot.title} onChange={event => updateShot(shot.id, { title: event.target.value })} /></Field>
              <Field label="旁白"><textarea rows={3} value={shot.narration} onChange={event => updateShot(shot.id, { narration: event.target.value })} /></Field>
              <details><summary>画面与声音要求</summary><Field label="画面要求"><textarea rows={3} value={shot.visualPrompt} onChange={event => updateShot(shot.id, { visualPrompt: event.target.value })} /></Field><Field label="声音要求"><textarea rows={2} value={shot.soundPrompt ?? ''} onChange={event => updateShot(shot.id, { soundPrompt: event.target.value })} /></Field></details>
            </fieldset></li>;
          })}</ol>}
          {section === 'script' && !shots.length && <p className="planning-result-editor__hint">当前项目还没有分镜，可先在工作台添加镜头或执行分镜制作。</p>}
        </fieldset>
      </div>
      <div className="dialog__footer"><Button disabled={pending} onClick={onClose}>{attempted && error ? '关闭' : '取消'}</Button><Button type="submit" variant="primary" busy={pending} disabled={section === 'script' && !shots.length}><Save size={16} />保存到项目</Button></div>
    </form>
  </Dialog>;
}
