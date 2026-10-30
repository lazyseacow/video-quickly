import { useState } from 'react';
import { getModelParameterFields, modelParameterValue, withModelParameter, type JsonValue, type ModelCapability, type ModelProfile, type VoiceDiscovery } from '@video-quickly/contracts';
import { Field, Select } from './Primitives';
import './model-editors.css';
import VoicePicker from './VoicePicker';

export const modelParameterSections = [
  { id: 'text', label: '文本参数' }, { id: 'image', label: '图片参数' }, { id: 'video', label: '视频参数' },
  { id: 'tts', label: '配音参数' }, { id: 'asr', label: '识别参数' },
] as const;

export default function ModelParameters({ provider, capabilities, textProtocol, value, disabled = false, operation, voices, voiceContextKey, voicesLoading, onReloadVoices, onChange }: {
  provider: ModelProfile['provider']; textProtocol?: ModelProfile['textProtocol']; capabilities: ModelCapability[]; value: Record<string, JsonValue>; disabled?: boolean; operation?: typeof modelParameterSections[number]['id'];
  voices?: VoiceDiscovery; voiceContextKey?: string; voicesLoading?: boolean; onReloadVoices?: () => void;
  onChange: (value: Record<string, JsonValue>) => void;
}) {
  const fields = getModelParameterFields({ provider, capabilities, textProtocol });
  return <div className="model-parameters">
    {modelParameterSections.filter(section => !operation || section.id === operation).map(({ id, label }) => {
      const group = fields.filter(field => field.operation === id);
      return group.length ? <fieldset key={id}><legend>{label}</legend><div className="model-editor__grid">{group.map(field => {
        const current = modelParameterValue(value, field.key);
        const text = typeof current === 'string' || typeof current === 'number' ? String(current) : '';
        if (field.key === 'voice' && voices) return <VoicePicker key={`${field.key}:${voiceContextKey}`} value={text} required={field.required} disabled={disabled} catalog={voices} loading={voicesLoading} onReload={onReloadVoices} onChange={voice => onChange(withModelParameter(value, field.key, voice || undefined))} />;
        if (field.customSize) return <ImageSizeField key={field.key} label={field.label} hint={field.hint} value={text} options={field.options ?? []} disabled={disabled} onChange={size => onChange(withModelParameter(value, field.key, size || undefined))} />;
        return <Field key={field.key} label={field.label} hint={field.hint}>{field.type === 'select' ? <Select value={text} disabled={disabled} onChange={event => onChange(withModelParameter(value, field.key, event.target.value || undefined))}><option value="">使用默认值</option>{field.options?.map(option => <option key={option} value={option}>{option}</option>)}{text && !field.options?.includes(text) && <option value={text}>无效值：{text}</option>}</Select> : <input type={field.type === 'number' ? 'number' : 'text'} value={text} required={field.required} min={field.min} max={field.max} step={field.integer ? '1' : 'any'} disabled={disabled} onChange={event => {
          const raw = event.target.value;
          const next = !raw ? undefined : field.type === 'number' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
          onChange(withModelParameter(value, field.key, next));
        }} />}</Field>;
      })}</div></fieldset> : null;
    })}
    {!fields.length && <p className="tiny-meta">此协议使用高级 JSON 配置工作流或请求映射。</p>}
    {fields.length > 0 && <p className="tiny-meta">留空使用默认值；尺寸、时长和音色以模型支持范围为准。</p>}
  </div>;
}

function ImageSizeField({ label, hint, value, options, disabled, onChange }: {
  label: string; hint?: string; value: string; options: readonly string[]; disabled: boolean; onChange: (value: string) => void;
}) {
  const [custom, setCustom] = useState(false);
  const isCustom = custom || Boolean(value && !options.includes(value));
  const labels: Record<string, string> = { auto: '自动', '1024x1024': '1024 × 1024 · 正方形', '1536x1024': '1536 × 1024 · 横图', '1024x1536': '1024 × 1536 · 竖图', '2048x2048': '2048 × 2048 · 2K 正方形', '2560x1440': '2560 × 1440 · 16:9', '1440x2560': '1440 × 2560 · 9:16', '1280x720': '1280 × 720 · 16:9', '720x1280': '720 × 1280 · 9:16' };
  return <div className="model-size-field"><Field label={label} hint={hint}><Select value={isCustom ? 'custom' : value} disabled={disabled} onChange={event => {
    const next = event.target.value; setCustom(next === 'custom'); if (next !== 'custom') onChange(next);
  }}><option value="">使用默认值</option>{options.map(option => <option key={option} value={option}>{labels[option] ?? option}</option>)}<option value="custom">自定义尺寸</option></Select></Field>{isCustom && <Field label={`自定义${label}`}><input required value={value} placeholder="例如 1920x1080" disabled={disabled} onChange={event => onChange(event.target.value)} /></Field>}</div>;
}
