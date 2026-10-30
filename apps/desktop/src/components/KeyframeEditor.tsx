import { useState } from 'react';
import { Plus, Trash2, Diamond } from 'lucide-react';
import { shotSchema, type AssetRecord, type MotionEasing, type MotionKeyframe, type ProjectDocument, type Shot } from '@video-quickly/contracts';
import { clipEditSource, motionLocalTimeUs, motionSceneTimeUs, sampleMotion } from '@video-quickly/video';
import { Button, Dialog, Field, IconButton, Notice, Select } from './Primitives';
import { ScenePreview } from './ScenePreview';
import { assertKeyframeAssets, assertKeyframePreviewWindow, keyframeAssetIds, keyframePreviewWindow } from '../lib/keyframe-edits';
import './keyframe-editor.css';

const easings: readonly { value: MotionEasing; label: string }[] = [{ value: 'linear', label: '线性' }, { value: 'smoothstep', label: '平滑起止' }, { value: 'ease-in', label: '缓入' }, { value: 'ease-out', label: '缓出' }, { value: 'hold', label: '保持到下一帧' }, { value: 'cubic-bezier', label: '自定义贝塞尔曲线' }];

export default function KeyframeEditor({ project, shot, assets, initialTimeUs, disabled, onClose, onApply }: {
  project: ProjectDocument; shot: Shot; assets: AssetRecord[]; initialTimeUs: number; disabled: boolean;
  onClose: () => void; onApply: (animation: Shot['animation'], baseline: Shot, context: ProjectDocument) => void;
}) {
  const [baseline] = useState(() => ({ project: structuredClone(project), shot: structuredClone(shot), assets: structuredClone(assets.filter(asset => keyframeAssetIds(shot).includes(asset.id))) }));
  const presentation = baseline.project.shots.find(value => value.id === shot.id) ?? baseline.shot;
  const [window] = useState(() => keyframePreviewWindow(baseline.project, baseline.shot.id));
  const [animation, setAnimation] = useState(() => structuredClone(shot.animation));
  const [selectedId, setSelectedId] = useState(shot.animation.keyframes?.[0]?.id);
  const [timeUs, setTimeUs] = useState(() => window.align(initialTimeUs));
  const [error, setError] = useState('');
  const source = clipEditSource(baseline.shot, baseline.project);
  const durationUs = presentation.sceneDurationUs ?? source?.original.sceneDurationUs ?? source?.original.durationUs ?? presentation.durationUs;
  const frames = animation.keyframes ?? [], selected = frames.find(frame => frame.id === selectedId) ?? frames[0];
  const sceneUs = motionSceneTimeUs(presentation, baseline.project, timeUs);
  const validation = shotSchema.shape.animation.safeParse(animation);
  const valid = validation.success;
  const preview = { ...presentation, animation: valid ? validation.data : baseline.shot.animation };
  const pose = sampleMotion(preview.animation, sceneUs, durationUs);
  const sampleCurve = selected ? Array.from({ length: 33 }, (_, index) => {
    const fake = { ...animation, keyframes: [{ ...selected, timeUs: 0, panX: 0, panY: 0, zoom: 1 }, { ...selected, id: 'curve-end', timeUs: 1_000_000, zoom: 2 }] };
    return `${8 + index * 4.5},${104 - (sampleMotion(fake, index * 1_000_000 / 32, 1_000_000).zoom - 1) * 96}`;
  }).join(' ') : '';
  function change(frame: MotionKeyframe) {
    setError(''); setAnimation(value => ({ ...value, keyframes: (value.keyframes ?? []).map(item => item.id === frame.id ? frame : item).toSorted((a, b) => a.timeUs - b.timeUs) }));
  }
  function enable(enabled: boolean) {
    setError('');
    if (!enabled) { const { keyframes: _, ...legacy } = animation; setAnimation(legacy); return; }
    const first = crypto.randomUUID(), last = crypto.randomUUID();
    setAnimation(value => ({ ...value, keyframes: [{ id: first, timeUs: 0, panX: 0, panY: 0, zoom: 1, easing: 'smoothstep' }, { id: last, timeUs: durationUs, panX: value.panX, panY: value.panY, zoom: value.zoom, easing: 'smoothstep' }] }));
    setSelectedId(first);
  }
  function add() {
    const current = frames.find(frame => frame.timeUs === sceneUs);
    if (current) { setSelectedId(current.id); return; }
    const id = crypto.randomUUID();
    const frame: MotionKeyframe = { id, timeUs: sceneUs, ...pose, easing: 'smoothstep' };
    setAnimation(value => ({ ...value, keyframes: [...frames, frame].toSorted((a, b) => a.timeUs - b.timeUs) })); setSelectedId(id);
  }
  function seek(localUs: number) { setTimeUs(window.align(localUs)); }
  return <Dialog title="关键帧与曲线" onClose={onClose} className="keyframe-dialog">
    <div className="dialog__body keyframe-editor">
      <div className="keyframe-editor__controls">
        <label className="field-inline"><input type="checkbox" checked={Boolean(animation.keyframes)} disabled={disabled} onChange={event => enable(event.target.checked)} />使用关键帧运镜</label>
        <p className="tiny-meta">位置按画面宽高比例保存。关键帧使用原场景时间，分割和裁剪保留原动画进度。</p>
        {animation.keyframes ? <>
          <div className="keyframe-editor__toolbar"><strong>{frames.length} 个关键帧</strong><Button disabled={disabled || frames.length >= 200 || !valid} onClick={add}><Plus size={14} />添加当前时刻</Button></div>
          <div className="keyframe-editor__list" aria-label="运镜关键帧">{frames.map((frame, index) => {
            const local = motionLocalTimeUs(presentation, baseline.project, frame.timeUs);
            return <button type="button" key={frame.id} aria-label={`编辑关键帧 ${index + 1}`} aria-pressed={selected?.id === frame.id} onClick={() => { setSelectedId(frame.id); if (local !== undefined) seek(local); }}><Diamond size={13} /><span>{Number.isFinite(frame.timeUs) ? (frame.timeUs / 1e6).toFixed(3) : '—'} 秒</span><small>{local === undefined ? '窗口外' : '当前窗口'}</small></button>;
          })}</div>
          {selected && <div className="keyframe-editor__fields">
            <div className="section-heading"><strong>关键帧 {frames.indexOf(selected) + 1}</strong><IconButton label="删除所选关键帧" disabled={disabled || frames.length <= 1} onClick={() => { setAnimation(value => ({ ...value, keyframes: frames.filter(frame => frame.id !== selected.id) })); setSelectedId(frames.find(frame => frame.id !== selected.id)?.id); }}><Trash2 size={15} /></IconButton></div>
            <Field label="原场景时间（秒）"><input type="number" min={0} step={.001} value={Number.isFinite(selected.timeUs) ? selected.timeUs / 1e6 : ''} disabled={disabled} onChange={event => change({ ...selected, timeUs: Math.round(event.target.valueAsNumber * 1e6) })} /></Field>
            <div className="field-row"><Field label="水平位置（%）"><input type="number" min={-200} max={200} step={.1} value={Number.isFinite(selected.panX) ? Number((selected.panX * 100).toFixed(4)) : ''} disabled={disabled} onChange={event => change({ ...selected, panX: event.target.valueAsNumber / 100 })} /></Field><Field label="垂直位置（%）"><input type="number" min={-200} max={200} step={.1} value={Number.isFinite(selected.panY) ? Number((selected.panY * 100).toFixed(4)) : ''} disabled={disabled} onChange={event => change({ ...selected, panY: event.target.valueAsNumber / 100 })} /></Field></div>
            <Field label="关键帧缩放（倍）"><input type="number" min={.1} max={5} step={.01} value={Number.isFinite(selected.zoom) ? selected.zoom : ''} disabled={disabled} onChange={event => change({ ...selected, zoom: event.target.valueAsNumber })} /></Field>
            <Field label="到下一关键帧的曲线"><Select value={selected.easing} disabled={disabled} onChange={event => change({ ...selected, easing: event.target.value as MotionEasing, ...(event.target.value === 'cubic-bezier' ? { curve: selected.curve ?? [.42, 0, .58, 1] } : {}) })}>{easings.map(value => <option key={value.value} value={value.value}>{value.label}</option>)}</Select></Field>
            {selected.easing === 'cubic-bezier' && <div className="keyframe-editor__curve-fields">{(['控制点 1 X', '控制点 1 Y', '控制点 2 X', '控制点 2 Y'] as const).map((label, index) => <Field key={label} label={label}><input type="number" min={0} max={1} step={.01} value={Number.isFinite(selected.curve?.[index]) ? selected.curve![index] : ''} disabled={disabled} onChange={event => { const curve: [number, number, number, number] = [...(selected.curve ?? [.42, 0, .58, 1])]; curve[index] = event.target.valueAsNumber; change({ ...selected, curve }); }} /></Field>)}</div>}
            <svg viewBox="0 0 160 112" className="keyframe-editor__curve" role="img" aria-label="所选关键帧的时间曲线"><path d="M8 8V104H152" fill="none" stroke="currentColor" opacity=".25" />{valid && <polyline points={sampleCurve} fill="none" stroke="currentColor" strokeWidth="2" />}</svg>
          </div>}
        </> : <p className="tiny-meta">当前使用原有整镜头平移与缩放。</p>}
        {!valid && <Notice kind="error">{validation.error.issues[0]?.message ?? '请核对关键帧参数。'}</Notice>}{error && <Notice kind="error">{error}</Notice>}
      </div>
      <div className="keyframe-editor__preview">
        <ScenePreview project={baseline.project} shot={preview} shotIndex={Math.max(0, baseline.project.shots.findIndex(value => value.id === shot.id))} assets={baseline.assets} timeUs={timeUs} />
        <Field label="关键帧预览时间（秒）"><input type="range" min={window.minimumUs / 1e6} max={window.maximumUs / 1e6} step={baseline.project.profile.frameRate.denominator / baseline.project.profile.frameRate.numerator} value={timeUs / 1e6} onChange={event => seek(event.target.valueAsNumber * 1e6)} /></Field>
        <output aria-label="关键帧预览位置">镜头内 {(timeUs / 1e6).toFixed(3)} 秒 · 原场景 {(sceneUs / 1e6).toFixed(3)} 秒</output>
      </div>
    </div>
    <div className="dialog__footer"><Button onClick={onClose}>取消</Button><Button variant="primary" aria-label="应用关键帧" disabled={disabled || !valid} onClick={() => { if (!validation.success) return; try { assertKeyframeAssets(baseline.shot, baseline.assets, assets); assertKeyframePreviewWindow(presentation, project.shots.find(value => value.id === baseline.shot.id)); onApply(validation.data, baseline.shot, baseline.project); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); } }}>应用</Button></div>
  </Dialog>;
}
