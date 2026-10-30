import { useState } from 'react';
import { ASPECT_RATIO_PRESETS, FRAME_RATE_PRESETS, formatFrameRate, videoProfileSchema, type VideoProfile } from '@video-quickly/contracts';
import { ArrowLeftRight, LockKeyhole, Maximize2, UnlockKeyhole } from 'lucide-react';
import { Field, IconButton, Select } from './Primitives';

const even = (value: number) => Math.max(64, Math.round(value / 2) * 2);
const frameRateOptions = FRAME_RATE_PRESETS.filter(rate => rate.label === '30' || rate.label === '60');

export default function VideoSettings({ profile, onChange, compact = false }: { profile: VideoProfile; onChange: (profile: VideoProfile) => void; compact?: boolean }) {
  const [locked, setLocked] = useState(true);
  const ratio = profile.width / profile.height;
  const ratioPreset = ASPECT_RATIO_PRESETS.find(item => Math.abs(item.width / item.height - ratio) < .005)?.label ?? 'custom';
  const shortSide = Math.min(profile.width, profile.height);
  const resolutionPreset = [720, 1080, 1440, 2160].includes(shortSide) ? shortSide.toString() : 'custom';
  const fpsPreset = frameRateOptions.find(item => item.numerator === profile.frameRate.numerator && item.denominator === profile.frameRate.denominator);
  const validation = videoProfileSchema.safeParse(profile);
  function setDimension(key: 'width' | 'height', value: number) {
    const updated = { ...profile, [key]: value };
    if (locked && value > 0) {
      if (key === 'width') updated.height = even(value / ratio);
      else updated.width = even(value * ratio);
    }
    onChange(updated);
  }
  function setResolution(value: number, selectedRatio = ratio) {
    onChange({ ...profile, width: even(selectedRatio >= 1 ? value * selectedRatio : value), height: even(selectedRatio >= 1 ? value : value / selectedRatio) });
  }
  return <div className={compact ? 'video-settings video-settings--compact' : 'video-settings'}>
    <div className="field-row">
      <Field label="画面比例"><Select aria-label="画面比例" value={ratioPreset} onChange={event => { const selected = ASPECT_RATIO_PRESETS.find(item => item.label === event.target.value); if (selected) setResolution(shortSide, selected.width / selected.height); }}><option value="custom">自定义</option>{ASPECT_RATIO_PRESETS.map(item => <option key={item.label} value={item.label}>{item.label}{item.label === '9:16' ? ' · 竖屏' : item.label === '16:9' ? ' · 横屏' : ''}</option>)}</Select></Field>
      <Field label="分辨率"><Select aria-label="分辨率" value={resolutionPreset} onChange={event => { if (event.target.value !== 'custom') setResolution(Number(event.target.value)); }}><option value="custom">自定义</option><option value="720">720p</option><option value="1080">1080p</option><option value="1440">1440p</option><option value="2160">2160p · 4K</option></Select></Field>
    </div>
    <div className="dimension-row">
      <Field label="宽度"><input aria-label="视频宽度" type="number" min="64" max="7680" step="2" value={profile.width || ''} onChange={event => setDimension('width', event.target.valueAsNumber || 0)} /></Field>
      <IconButton label={locked ? '解锁宽高比例' : '锁定宽高比例'} aria-pressed={locked} onClick={() => setLocked(!locked)}>{locked ? <LockKeyhole size={14} /> : <UnlockKeyhole size={14} />}</IconButton>
      <Field label="高度"><input aria-label="视频高度" type="number" min="64" max="7680" step="2" value={profile.height || ''} onChange={event => setDimension('height', event.target.valueAsNumber || 0)} /></Field>
      <IconButton label="交换宽高" onClick={() => onChange({ ...profile, width: profile.height, height: profile.width })}><ArrowLeftRight size={15} /></IconButton>
    </div>
    <Field label="帧率"><Select aria-label="视频帧率" value={fpsPreset?.label ?? 'current'} onChange={event => { const selected = frameRateOptions.find(item => item.label === event.target.value); if (selected) onChange({ ...profile, frameRate: { numerator: selected.numerator, denominator: selected.denominator } }); }}>{!fpsPreset && <option value="current" disabled>{formatFrameRate(profile.frameRate)} fps · 当前</option>}{frameRateOptions.map(item => <option key={item.label} value={item.label}>{item.label} fps</option>)}</Select></Field>
    <Field label="素材适配"><Select aria-label="素材适配" value={profile.fitMode} onChange={event => onChange({ ...profile, fitMode: event.target.value as VideoProfile['fitMode'] })}><option value="contain">完整显示 · 等比留边</option><option value="cover">裁剪填满</option><option value="blur">模糊背景填充</option></Select></Field>
    {!compact && <Field label="预览质量"><Select aria-label="预览质量" value={profile.previewScale} onChange={event => onChange({ ...profile, previewScale: Number(event.target.value) })}><option value="0.25">1/4 · 流畅</option><option value="0.5">1/2 · 平衡</option><option value="1">原始分辨率</option></Select></Field>}
    {!validation.success && <p role="alert" className="field-error">{validation.error.issues[0]?.message}</p>}
    <div className="spec-summary"><Maximize2 size={17} /><div><strong>{profile.width} × {profile.height}</strong><small>{formatFrameRate(profile.frameRate)} fps · {ratioPreset === 'custom' ? '自定义比例' : ratioPreset}</small></div></div>
  </div>;
}
