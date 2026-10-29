import { useEffect, useRef, useState } from 'react';
import { effectiveCaptionStyle, type AssetRecord, type CaptionStyle, type ProjectDocument } from '@video-quickly/contracts';
import { applyBulkShotEdit, type BulkShotChanges } from '../lib/bulk-shot-edits';
import { editContent, type EditContent } from '../lib/project-edits';
import { useBulkSourceDurations } from '../lib/source-duration';
import { Button, Dialog, Field, Notice } from './Primitives';
import CaptionStyleEditor from './CaptionStyleEditor';
import { ScenePreview } from './ScenePreview';
import './bulk-shot-dialog.css';

export interface BulkShotRequest {
  baseline: EditContent; ids: readonly string[]; changes: BulkShotChanges;
  sourceDurations: Readonly<Record<string, number>>; sourceKey: string;
}

export default function BulkShotDialog({ project, ids, primaryId, assets, disabled, onClose, onApply, onRetry }: {
  project: ProjectDocument; ids: readonly string[]; primaryId?: string; assets: AssetRecord[]; disabled?: boolean;
  onClose: () => void; onApply: (request: BulkShotRequest) => Promise<boolean>; onRetry: () => Promise<boolean>;
}) {
  const [baseline] = useState(() => structuredClone(project));
  const [targets] = useState(() => baseline.shots.filter(shot => ids.includes(shot.id)));
  const first = targets.find(shot => shot.id === primaryId) ?? targets[0];
  const [durationEnabled, setDurationEnabled] = useState(false), [duration, setDuration] = useState(String((first?.durationUs ?? 6_000_000) / 1_000_000));
  const [animationEnabled, setAnimationEnabled] = useState(false), [animation, setAnimation] = useState(first?.animation ?? { panX: 0, panY: 0, zoom: 1.05, transition: 'fade' as const });
  const [captionEnabled, setCaptionEnabled] = useState(false), [captionStyle, setCaptionStyle] = useState<CaptionStyle | null>(effectiveCaptionStyle(baseline, first) ?? null);
  const [copyEnabled, setCopyEnabled] = useState(false), [copyFromId, setCopyFromId] = useState(first?.id ?? '');
  const [busy, setBusy] = useState(false), [applied, setApplied] = useState(false), [failure, setFailure] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const source = useBulkSourceDurations(targets, assets, durationEnabled);
  const changes: BulkShotChanges = {
    ...(durationEnabled ? { durationUs: duration.trim() ? Math.round(Number(duration) * 1_000_000) : NaN } : {}),
    ...(copyEnabled ? { copyStyleFromId: copyFromId } : {
      ...(animationEnabled ? { animation } : {}), ...(captionEnabled ? { captionStyle } : {}),
    }),
  };
  let preview: EditContent | undefined, validation = '';
  if (durationEnabled && (!duration.trim() || !Number.isFinite(Number(duration)) || Number(duration) < .5 || Number(duration) > 600)) validation = '镜头时长须为 0.5 至 600 秒。';
  else if (Object.keys(changes).length && !(durationEnabled && (source.status === 'loading' || source.status === 'error'))) {
    try { preview = applyBulkShotEdit(editContent(baseline), editContent(baseline), targets.map(shot => shot.id), changes, source.durations); }
    catch (error) { validation = error instanceof Error ? error.message : String(error); }
  }
  const frozen = Boolean(disabled || busy || applied);
  const targetIds = new Set(targets.map(shot => shot.id));
  const shown = preview?.shots.filter(shot => targetIds.has(shot.id)) ?? targets;
  async function submit() {
    setBusy(true); setFailure('');
    try {
      const saved = applied ? await onRetry() : await onApply({ baseline: editContent(baseline), ids: targets.map(shot => shot.id), changes, sourceDurations: source.durations, sourceKey: source.key });
      if (!alive.current) return;
      if (saved) onClose();
      else { setApplied(true); setFailure('批量修改已加入当前草稿，尚未保存。重试只保存同一份修改，不新增撤销步骤。'); }
    } catch (error) { if (alive.current) setFailure(error instanceof Error ? error.message : String(error)); }
    finally { if (alive.current) setBusy(false); }
  }
  return <Dialog title="批量编辑镜头" className="bulk-shot-dialog" onClose={onClose}>
    <div className="dialog__body"><p className="bulk-shot-dialog__scope">已选 {targets.length} 个镜头。应用为一步撤销；包含锁定镜头时整批保留原样。</p>
      <div className="bulk-shot-dialog__workspace"><div>
        <fieldset className="bulk-shot-group" disabled={frozen}><legend>时长</legend><label className="field-inline"><input type="checkbox" checked={durationEnabled} onChange={event => setDurationEnabled(event.target.checked)} />批量修改时长</label>
          {durationEnabled && <><Field label="批量镜头时长（秒）"><input type="number" value={duration} min={.5} max={600} step={.001} onChange={event => setDuration(event.target.value)} /></Field><p className="tiny-meta">沿用各镜头入点并按项目帧率对齐；较短的音视频保持末帧或补齐静音。</p>{source.status === 'loading' && <p role="status" className="tiny-meta">正在读取所选镜头的真实素材时长…</p>}{source.error && <Notice kind="error">{source.error}</Notice>}</>}
        </fieldset>
        <fieldset className="bulk-shot-group" disabled={frozen}><legend>样式</legend>
          <label className="field-inline"><input type="checkbox" checked={copyEnabled} onChange={event => setCopyEnabled(event.target.checked)} />从镜头复制样式</label>
          {copyEnabled ? <><Field label="复制样式来源镜头"><select value={copyFromId} onChange={event => setCopyFromId(event.target.value)}>{baseline.shots.map((shot, index) => <option value={shot.id} key={shot.id}>{index + 1}. {shot.title}</option>)}</select></Field><p className="tiny-meta">复制运镜、当前有效字幕样式及已有画面模板的配色与动效；各镜头的内容和素材保留。</p></> : <>
            <label className="field-inline"><input type="checkbox" checked={animationEnabled} onChange={event => setAnimationEnabled(event.target.checked)} />批量修改运镜</label>
            {animationEnabled && <div className="bulk-shot-fields">{([{ key: 'panX', label: '批量水平移动', min: -1, max: 1 }, { key: 'panY', label: '批量垂直移动', min: -1, max: 1 }, { key: 'zoom', label: '批量缩放', min: .1, max: 5 }] as const).map(field => <Field key={field.key} label={field.label}><input type="number" min={field.min} max={field.max} step={.01} value={Number.isFinite(animation[field.key]) ? animation[field.key] : ''} onChange={event => setAnimation({ ...animation, [field.key]: event.target.valueAsNumber })} /></Field>)}<Field label="批量转场"><select value={animation.transition} onChange={event => setAnimation({ ...animation, transition: event.target.value as typeof animation.transition })}><option value="cut">直接切换</option><option value="fade">柔和叠化</option><option value="wipe">擦除切换</option></select></Field></div>}
            <label className="field-inline"><input type="checkbox" checked={captionEnabled} onChange={event => setCaptionEnabled(event.target.checked)} />批量修改字幕样式</label>
            {captionEnabled && <CaptionStyleEditor value={captionStyle} inheritedStyle={baseline.captionStyle} onChange={setCaptionStyle} disabled={frozen} inheritLabel="恢复各镜头的项目默认" />}
          </>}
        </fieldset>
      </div><div className="bulk-shot-preview"><h3>应用预览</h3><div className="bulk-shot-preview__list" aria-label="批量编辑目标镜头">{shown.map(shot => {
        const before = targets.find(value => value.id === shot.id)!;
        return <article key={shot.id}><div><strong>{shot.title}</strong><span>{shot.locked ? '已锁定' : `${(before.durationUs / 1_000_000).toFixed(3)} → ${(shot.durationUs / 1_000_000).toFixed(3)} 秒`}</span></div></article>;
      })}</div>{first && <div className="bulk-shot-preview__canvas"><ScenePreview project={{ ...baseline, ...(preview ?? {}) }} shot={shown.find(shot => shot.id === first.id) ?? first} shotIndex={baseline.shots.findIndex(shot => shot.id === first.id)} assets={assets} /></div>}</div></div>
      {validation && !applied && <Notice kind="error">{validation}</Notice>}{failure && <Notice kind="error">{failure}</Notice>}
    </div><div className="dialog__footer"><Button onClick={onClose}>{busy ? '关闭并继续保存' : applied ? '关闭并保留草稿' : '取消'}</Button><Button variant="primary" busy={busy} disabled={disabled || !applied && (!preview || Boolean(validation) || source.status === 'loading' || source.status === 'error')} onClick={() => void submit()}>{applied ? '重试保存批量修改' : '应用批量修改'}</Button></div>
  </Dialog>;
}
