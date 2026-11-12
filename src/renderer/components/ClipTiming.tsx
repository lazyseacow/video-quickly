import { useState } from 'react';
import type { FrameRate, Shot } from '@video-quickly/contracts';
import { minimumSourceInUs, trimShot } from '@video-quickly/video/editing';
import { trimShotInContext } from '@video-quickly/video/editing';
import type { ClipEditContext } from '@video-quickly/video/clip-edits';
import type { SourceDurationStatus } from '../lib/source-duration';
import { Button, Field } from './Primitives';
import { previewClipIds } from '../lib/clip-preview';

export default function ClipTiming({ shot, rate, sourceStatus, sourceDurationUs, sourceError, disabled, onTrim, context = {} }: {
  shot: Shot; rate: FrameRate; sourceStatus: SourceDurationStatus; sourceDurationUs?: number; sourceError?: string; disabled: boolean;
  context?: ClipEditContext;
  onTrim: (shotId: string, inUs: number, outUs: number) => Promise<void>;
}) {
  const clipInUs = shot.clipEdit?.inUs ?? shot.sourceInUs ?? 0;
  const source = { shotId: shot.id, planId: shot.clipEdit?.planId, inUs: clipInUs, durationUs: shot.durationUs };
  const [timing, setTiming] = useState({ source, inPoint: clipInUs / 1_000_000, outPoint: (clipInUs + shot.durationUs) / 1_000_000 });
  if (timing.source.shotId !== source.shotId || timing.source.planId !== source.planId || timing.source.inUs !== source.inUs || timing.source.durationUs !== source.durationUs) {
    // Reset before committing the new shot. A passive effect can overwrite an
    // input after the user has selected its text and started typing.
    setTiming({ source, inPoint: clipInUs / 1_000_000, outPoint: (clipInUs + shot.durationUs) / 1_000_000 });
  }
  const { inPoint, outPoint } = timing;
  const inUs = Math.round(inPoint * 1_000_000), outUs = Math.round(outPoint * 1_000_000);
  const minimumInUs = minimumSourceInUs(shot);
  let error = '', trimmed: Shot | undefined;
  if (!Number.isFinite(inUs) || !Number.isFinite(outUs)) error = '请填写入点和出点。';
  else {
    try { trimmed = shot.clipEdit ? trimShotInContext({ ...context, shots: [shot] }, shot.id, { inUs, outUs }, rate, sourceDurationUs, previewClipIds(context)).shots[0] : trimShot(shot, { inUs, outUs }, rate, sourceDurationUs, context); }
    catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
  }
  const waitingForSource = sourceStatus !== 'none' && (sourceStatus !== 'ready' || sourceDurationUs === undefined);
  const sourceFailure = sourceStatus === 'error' ? sourceError || '素材时长读取失败，请重新选择或导入素材。' : '';
  const changed = trimmed && ((trimmed.clipEdit?.inUs ?? trimmed.sourceInUs) !== clipInUs || trimmed.durationUs !== shot.durationUs);
  return <div className="clip-timing"><div className="field-row"><Field label="素材入点（秒）"><input type="number" min={minimumInUs / 1_000_000} step="0.001" value={Number.isFinite(inPoint) ? inPoint : ''} onChange={event => { const inPoint = event.target.valueAsNumber; setTiming(current => ({ ...current, inPoint })); }} /></Field><Field label="素材出点（秒）"><input type="number" min={(minimumInUs + 500_000) / 1_000_000} step="0.001" max={sourceDurationUs === undefined ? undefined : sourceDurationUs / 1_000_000} value={Number.isFinite(outPoint) ? outPoint : ''} onChange={event => { const outPoint = event.target.valueAsNumber; setTiming(current => ({ ...current, outPoint })); }} /></Field></div>
    {sourceStatus === 'ready' && sourceDurationUs !== undefined && <p className="tiny-meta">可用素材出点上限 {(sourceDurationUs / 1_000_000).toFixed(3)} 秒 · 入出点按项目帧率对齐</p>}
    {sourceStatus === 'loading' && <p className="tiny-meta" role="status">正在读取素材时长，读取完成后可应用入出点。</p>}
    {sourceStatus === 'none' && <p className="tiny-meta">未关联音视频素材，可延长二维场景。</p>}
    {shot.clipEdit && <p className="tiny-meta">入出点使用剪后计划时间；扩展末尾保留已删除的内部缺口。</p>}
    {(sourceFailure || error) && <p className="field-error" role="alert">{sourceFailure || error}</p>}
    <Button aria-label="应用入出点" disabled={disabled || waitingForSource || Boolean(error) || !changed} onClick={() => void onTrim(shot.id, inUs, outUs)}>应用</Button>
  </div>;
}
