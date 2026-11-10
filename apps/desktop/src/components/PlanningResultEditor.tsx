import { useRef, useState } from 'react';
import { LockKeyhole, Plus, Save } from 'lucide-react';
import { formatFrameRate, formatPlanningDocument, MAX_STORYBOARD_SHOTS, planningDocumentSchemas, shotSchema, type CreativeContext } from '@video-quickly/contracts';
import { CharacterPickerLibrary, CharacterPickerOptions } from '../features/CharactersPage';
import { planningLabels, type PlanningChange, type PlanningProject, type PlanningSection, type PlanningShot, type StoryboardDraft } from '../lib/planning-edits';
import CreativeContextEditor, { CreativeEntityPicker } from './CreativeContextEditor';
import PlanningDocumentFields, { initialPlanningDocument } from './PlanningDocumentFields';
import { Button, Dialog, Field, Notice } from './Primitives';
import './planning-result-editor.css';

type DraftShot = PlanningShot & { seconds: string };
const microseconds = 1_000_000;
const duration = shotSchema.shape.durationUs;

export default function PlanningResultEditor({ section, baseline, storyboard, structuredDocument, version, onSave, onClose }: {
  section: PlanningSection; baseline: PlanningProject; storyboard?: StoryboardDraft; structuredDocument?: boolean; version: number;
  onSave(change: PlanningChange): Promise<boolean>; onClose(): void;
}) {
  const [text, setText] = useState(section === 'brief' ? baseline.brief : baseline.style);
  const [document, setDocument] = useState<Record<string, string>>(() => section === 'script' ? {} : initialPlanningDocument(section, baseline.manualPlanningFields?.[section], baseline[section], baseline.title));
  const [context, setContext] = useState<CreativeContext | null>(storyboard?.creativeContext ?? baseline.creativeContext ?? null);
  const [shots, setShots] = useState<DraftShot[]>(() => {
    const proposed = new Map(storyboard?.shots.map(shot => [shot.id, shot]));
    const merged = baseline.shots.map(shot => {
      const next = proposed.get(shot.id);
      proposed.delete(shot.id);
      return shot.locked ? shot : next ?? shot;
    });
    return [...merged, ...proposed.values()].map(({ id, title, narration, visualPrompt, soundPrompt, durationUs, characterIds, creativeEntityKeys }) => ({
      id, title, narration, visualPrompt, soundPrompt, seconds: String(durationUs / microseconds), characterIds, creativeEntityKeys,
    }));
  });
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [attempted, setAttempted] = useState(false);
  const [staged, setStaged] = useState<ReadonlySet<string>>(() => new Set());
  const form = useRef<HTMLFormElement>(null);
  const inFlight = useRef(false);
  const originals = new Map(baseline.shots.map(shot => [shot.id, shot]));
  function updateShot(id: string, patch: Partial<DraftShot>) {
    setShots(current => current.map(shot => shot.id === id ? { ...shot, ...patch } : shot));
    setError('');
  }
  function addShot() {
    const id = crypto.randomUUID();
    setShots(current => current.length >= MAX_STORYBOARD_SHOTS ? current : [...current, { id, title: '', narration: '', visualPrompt: '', seconds: '6' }]);
    requestAnimationFrame(() => form.current?.querySelector<HTMLInputElement>(`[data-shot-title="${CSS.escape(id)}"]`)?.focus());
  }
  function collectChange(): PlanningChange {
    if (section === 'brief') {
      const fields = structuredDocument ? planningDocumentSchemas.brief.parse(document) : undefined;
      return { kind: 'brief', text: fields ? formatPlanningDocument('brief', fields) : text, fields };
    }
    if (section === 'style') {
      const fields = structuredDocument ? planningDocumentSchemas.style.parse(document) : undefined;
      return { kind: 'style', text: fields ? formatPlanningDocument('style', fields) : text, fields, creativeContext: context };
    }
    const edited: PlanningShot[] = [], newShots: PlanningShot[] = [];
    for (const { seconds, ...shot } of shots) {
      const original = originals.get(shot.id);
      const durationUs = original?.clipEdit ? original.durationUs : duration.parse(Math.round(Number(seconds) * microseconds));
      const input = { ...shot, title: shotSchema.shape.title.parse(shot.title), durationUs };
      (original ? edited : newShots).push(input);
    }
    return { kind: 'script', shots: edited, newShots, ...(storyboard ? { creativeContext: context } : {}) };
  }
  async function submit() {
    if (inFlight.current) return;
    if (structuredDocument && section !== 'script') {
      const checked = planningDocumentSchemas[section].safeParse(document);
      if (!checked.success) {
        const issue = checked.error.issues[0];
        setError(issue.message);
        form.current?.querySelector<HTMLElement>(`[data-planning-field="${CSS.escape(`${section}-${String(issue.path[0])}`)}"]`)?.focus();
        return;
      }
    }
    const invalid = form.current?.querySelector<HTMLInputElement>('input[data-validation-message]:invalid');
    if (invalid) {
      setError(invalid.dataset.validationMessage ?? '请核对分镜字段。');
      invalid.focus();
      return;
    }
    inFlight.current = true; setPending(true); setError('');
    try {
      const change = collectChange();
      setAttempted(true);
      if (await onSave(change)) onClose();
      else {
        if (change.kind === 'script' && change.newShots?.length) setStaged(new Set(change.newShots.map(shot => shot.id)));
        setError('保存未完成，修改已保留为项目草稿，可以重试保存。');
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { inFlight.current = false; setPending(false); }
  }
  return <Dialog title={`编辑${planningLabels[section]}`} onClose={onClose} className="planning-result-editor">
    <form ref={form} noValidate onSubmit={event => { event.preventDefault(); void submit(); }} onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.currentTarget.requestSubmit(); }
    }}>
      <div className="dialog__body planning-result-editor__body">
        {section === 'script' && <p className="planning-result-editor__hint"><strong>分镜全局参数</strong> · {baseline.profile.width} × {baseline.profile.height} · {formatFrameRate(baseline.profile.frameRate)} fps</p>}
        <p className="planning-result-editor__hint">{storyboard ? '已填入分镜草稿。保存到项目后，下次开始制作将使用这些镜头。' : '保存到当前项目，供后续制作使用。'}</p>
        {error && <Notice kind="error">{error}</Notice>}
        <fieldset disabled={pending} className="planning-result-editor__fields">
          {section !== 'script' ? <>
            {structuredDocument ? <PlanningDocumentFields kind={section} value={document} onChange={(key, text) => { setDocument(current => ({ ...current, [key]: text })); setError(''); }} />
              : <Field label={section === 'brief' ? '创意简报' : '视觉风格'}><textarea rows={section === 'brief' ? 14 : 8} value={text} onChange={event => setText(event.target.value)} /></Field>}
            {section === 'style' && <CreativeContextEditor value={context} version={version} usedEntityKeys={baseline.shots.flatMap(shot => shot.creativeEntityKeys ?? [])} onChange={setContext} />}
          </> : <>
            {storyboard && <CreativeContextEditor value={context} version={version} usedEntityKeys={shots.flatMap(shot => shot.creativeEntityKeys ?? [])} onChange={setContext} />}
            {shots.length ? <CharacterPickerLibrary version={version}>{library => <ol className="planning-result-editor__shots">{shots.map((shot, index) => {
              const original = originals.get(shot.id);
              return <li key={shot.id}>
                <header>
                  <strong>镜头 {String(index + 1).padStart(2, '0')}</strong>
                  {original?.locked && <span><LockKeyhole size={14} />已锁定</span>}
                  {!original && <Button static variant="ghost" disabled={staged.has(shot.id)} aria-label={`移除新增镜头 ${index + 1}`} onClick={() => setShots(current => current.filter(item => item.id !== shot.id))}>移除</Button>}
                </header>
                <fieldset disabled={original?.locked || staged.has(shot.id)} className="planning-result-editor__fields" aria-label={`镜头 ${index + 1} 内容`}>
                  <div className="planning-result-editor__shot-basics">
                    <Field label="镜头标题" hint="最多 160 个字符" required><input required maxLength={shotSchema.shape.title.maxLength ?? undefined} data-shot-title={shot.id} data-validation-message="请填写镜头标题，最多 160 个字符。" value={shot.title} onChange={event => updateShot(shot.id, { title: event.target.value })} /></Field>
                    <Field label="镜头时长（秒）" hint={original?.clipEdit ? '在时间轴调整' : '0.5 至 600 秒'} required={!original?.clipEdit}><input type="number" min={(duration.minValue ?? 0) / microseconds} max={(duration.maxValue ?? 600 * microseconds) / microseconds} step={1 / microseconds} required={!original?.clipEdit} disabled={Boolean(original?.clipEdit)} data-validation-message="镜头时长须在 0.5 至 600 秒之间，最多 6 位小数。" value={shot.seconds} onChange={event => updateShot(shot.id, { seconds: event.target.value })} /></Field>
                  </div>
                  <div className="planning-result-editor__shot-content">
                    <Field label="旁白"><textarea rows={3} maxLength={shotSchema.shape.narration.maxLength ?? undefined} value={shot.narration} onChange={event => updateShot(shot.id, { narration: event.target.value })} /></Field>
                    <details className="form-disclosure" open>
                      <summary>画面与声音要求</summary>
                      <Field label="画面要求"><textarea rows={3} maxLength={shotSchema.shape.visualPrompt.maxLength ?? undefined} value={shot.visualPrompt} onChange={event => updateShot(shot.id, { visualPrompt: event.target.value })} /></Field>
                      <Field label="声音要求"><textarea rows={2} maxLength={shotSchema.shape.soundPrompt.unwrap().maxLength ?? undefined} value={shot.soundPrompt ?? ''} onChange={event => updateShot(shot.id, { soundPrompt: event.target.value })} /></Field>
                    </details>
                    <details className="form-disclosure" open>
                      <summary>角色与创作设定</summary>
                      <div className="planning-result-editor__references">
                        <CharacterPickerOptions library={library} value={shot.characterIds} version={version} onChange={characterIds => updateShot(shot.id, { characterIds })} />
                        <CreativeEntityPicker value={shot.creativeEntityKeys} context={context} onChange={creativeEntityKeys => updateShot(shot.id, { creativeEntityKeys })} />
                      </div>
                    </details>
                  </div>
                </fieldset>
              </li>;
            })}</ol>}</CharacterPickerLibrary> : <p className="planning-result-editor__hint">添加镜头后，可逐项填写标题、时长、旁白和画面要求。</p>}
            <Button static className="planning-result-editor__add" disabled={shots.length >= MAX_STORYBOARD_SHOTS} onClick={addShot}><Plus size={16} />添加镜头</Button>
          </>}
        </fieldset>
      </div>
      <div className="dialog__footer"><Button disabled={pending} onClick={onClose}>{attempted && error ? '关闭' : '取消'}</Button><Button type="submit" variant="primary" busy={pending} disabled={section === 'script' && !shots.length}><Save size={16} />保存到项目</Button></div>
    </form>
  </Dialog>;
}
