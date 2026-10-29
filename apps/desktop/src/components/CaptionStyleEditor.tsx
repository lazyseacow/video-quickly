import { useEffect, useRef, useState } from 'react';
import { captionStyleSchema, DEFAULT_CAPTION_STYLE, shotSchema, type AssetRecord, type CaptionStyle, type ProjectDocument, type Shot } from '@video-quickly/contracts';
import { Button, Dialog, Field, Notice } from './Primitives';
import { ScenePreview } from './ScenePreview';
import './caption-style-editor.css';

export interface CaptionStyleEditorProps {
  value: CaptionStyle | null; onChange: (value: CaptionStyle | null) => void; disabled?: boolean;
  inheritLabel?: string; inheritedStyle?: CaptionStyle | null;
}
export default function CaptionStyleEditor({ value, onChange, disabled = false, inheritLabel = '使用默认字幕样式', inheritedStyle }: CaptionStyleEditorProps) {
  const validation = value ? captionStyleSchema.safeParse(value) : undefined;
  function change(patch: Partial<CaptionStyle>) { if (value) onChange({ ...value, ...patch }); }
  return <div className="caption-style-editor"><label className="field-inline"><input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={event => onChange(event.target.checked ? structuredClone(inheritedStyle ?? DEFAULT_CAPTION_STYLE) : null)} />自定义字幕样式</label>
    {!value ? <p className="tiny-meta">{inheritLabel}。字幕文字和时间段保持原样。</p> : <>
      <div className="caption-style__fields"><Field label="字幕字体"><select value={value.fontId} disabled={disabled} onChange={event => change({ fontId: event.target.value as CaptionStyle['fontId'] })}><option value="sans">无衬线体</option><option value="serif">衬线体</option></select></Field><Field label="字幕字重"><select value={value.fontWeight} disabled={disabled} onChange={event => change({ fontWeight: event.target.value === '700' ? 700 : 400 })}><option value={400}>常规</option><option value={700}>粗体</option></select></Field>
        <Field label="字号（短边百分比）"><input type="number" min={1.8} max={9} step={.1} value={Number((value.fontSizeRatio * 100).toFixed(3))} disabled={disabled} onChange={event => change({ fontSizeRatio: Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber / 100 : 0 })} /></Field><Field label="字幕位置"><select value={value.position} disabled={disabled} onChange={event => change({ position: event.target.value as CaptionStyle['position'] })}><option value="bottom">下部</option><option value="top">上部（标题下方）</option></select></Field>
        <ColorField label="文字颜色" value={value.textColor} disabled={disabled} onChange={textColor => change({ textColor })} /><ColorField label="字幕背景颜色" value={value.backgroundColor} disabled={disabled} onChange={backgroundColor => change({ backgroundColor })} />
        <Field label="背景不透明度（%）"><input type="number" min={0} max={100} step={1} value={Number((value.backgroundOpacity * 100).toFixed(2))} disabled={disabled} onChange={event => change({ backgroundOpacity: Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber / 100 : 0 })} /></Field><Field label="最大字幕行数"><select value={value.maxLines} disabled={disabled} onChange={event => change({ maxLines: Number(event.target.value) })}>{[1, 2, 3].map(lines => <option value={lines} key={lines}>{lines} 行</option>)}</select></Field>
      </div>
      <Button variant="ghost" disabled={disabled} onClick={() => onChange(null)}>{inheritLabel}</Button>
    </>}
    {validation && !validation.success && <p role="alert" className="field-error">{validation.error.issues[0]?.message}</p>}
  </div>;
}
function ColorField({ label, value, disabled, onChange }: { label: string; value: string; disabled: boolean; onChange: (value: string) => void }) {
  return <Field label={label}><span className="caption-style__color"><input aria-label={`选择${label}`} type="color" disabled={disabled} value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'} onChange={event => onChange(event.target.value)} /><input aria-label={label} value={value} maxLength={7} disabled={disabled} spellCheck={false} onChange={event => onChange(event.target.value)} /></span></Field>;
}

export function CaptionStylePreview({ project, shot, assets, value, mode = 'project' }: {
  project: ProjectDocument; shot?: Shot; assets: AssetRecord[]; value: CaptionStyle | null; mode?: 'project' | 'shot';
}) {
  const original = shot ?? project.shots[0] ?? shotSchema.parse({ id: 'caption-style-preview', title: '字幕样式示例', narration: '', visualPrompt: '', durationUs: 4_000_000 });
  const valid = value === null || captionStyleSchema.safeParse(value).success;
  const lastValid = useRef<CaptionStyle | null>(value === null ? null : DEFAULT_CAPTION_STYLE);
  useEffect(() => { if (valid) lastValid.current = value; }, [valid, value]);
  const displayedStyle = valid ? value : lastValid.current;
  const previewProject: ProjectDocument = mode === 'project' ? { ...project, captionStyle: displayedStyle } : project;
  const sceneIn = original.clipEdit?.inUs ?? original.sceneInUs ?? 0;
  const previewShot: Shot = { ...original, captionStyle: mode === 'shot' ? displayedStyle : null, captionTrack: { timeBase: original.clipEdit ? 'clip' : 'scene', alignment: 'manual', cues: [{ id: 'caption-style-sample', startUs: sceneIn, endUs: sceneIn + original.durationUs, text: '这是一段字幕样式示例。\n实际字幕内容保持原样。' }] } };
  return <figure className="caption-style-preview"><div style={{ aspectRatio: `${project.profile.width}/${project.profile.height}` }}><ScenePreview project={previewProject} shot={previewShot} shotIndex={Math.max(0, project.shots.findIndex(item => item.id === original.id))} timeUs={Math.round(original.durationUs * .35)} assets={assets} /></div><figcaption>字幕样式示例 · 不修改原字幕文字与时间</figcaption></figure>;
}

export interface CaptionStyleDialogProps {
  project: ProjectDocument; shot?: Shot; assets: AssetRecord[]; mode: 'project' | 'shot'; disabled?: boolean;
  onClose: () => void; onApply: (value: CaptionStyle | null, baseline: ProjectDocument) => Promise<boolean>;
}
export function CaptionStyleDialog({ project, shot, assets, mode, disabled = false, onClose, onApply }: CaptionStyleDialogProps) {
  const [baseline] = useState(() => structuredClone(project));
  const [target] = useState(() => shot ? structuredClone(shot) : project.shots[0] ? structuredClone(project.shots[0]) : undefined);
  const [value, setValue] = useState<CaptionStyle | null>(() => (mode === 'shot' ? shot?.captionStyle : project.captionStyle) ?? null);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState(''); const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const valid = value === null || captionStyleSchema.safeParse(value).success;
  async function apply() { setBusy(true); setFailure(''); try { if (await onApply(value, baseline)) { if (alive.current) onClose(); } else if (alive.current) setFailure('字幕样式尚未保存，当前输入已保留，可重试。'); } catch (reason) { if (alive.current) setFailure(reason instanceof Error ? reason.message : String(reason)); } finally { if (alive.current) setBusy(false); } }
  return <Dialog title={mode === 'shot' ? '镜头字幕样式' : '项目字幕样式'} onClose={onClose} className="caption-style-dialog"><div className="dialog__body"><p className="caption-style-dialog__scope">{mode === 'shot' ? `${target?.title ?? '当前镜头'}：自定义后覆盖项目默认；恢复后跟随项目设置。` : '项目默认样式用于未单独设置的镜头，已有的镜头覆盖保持原样。'}</p><div className="caption-style-dialog__workspace"><CaptionStylePreview project={baseline} shot={target} assets={assets} value={value} mode={mode} /><CaptionStyleEditor value={value} inheritedStyle={mode === 'shot' ? baseline.captionStyle : undefined} inheritLabel={mode === 'shot' ? '恢复项目默认' : '恢复默认字幕表现'} disabled={disabled || busy} onChange={next => { setValue(next); setFailure(''); }} /></div>{mode === 'shot' && target?.locked && <Notice>当前镜头已锁定，请先解锁后应用单独字幕样式。</Notice>}{failure && <Notice kind="error">{failure}</Notice>}</div><div className="dialog__footer"><Button onClick={onClose}>取消</Button><Button variant="primary" busy={busy} disabled={disabled || !valid || mode === 'shot' && Boolean(target?.locked)} onClick={() => void apply()}>应用字幕样式</Button></div></Dialog>;
}
