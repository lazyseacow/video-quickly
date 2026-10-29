import { getModelParameterFields, modelParameterValue, withModelParameter, type JsonValue, type ModelCapability, type ModelProfile } from '@video-quickly/contracts';
import { Field } from './Primitives';
import './model-editors.css';

const labels = { text: '文本参数', image: '图片参数', video: '视频参数', tts: '配音参数', asr: '识别参数' } as const;

export default function ModelParameters({ provider, capabilities, value, disabled = false, onChange }: {
  provider: ModelProfile['provider']; capabilities: ModelCapability[]; value: Record<string, JsonValue>; disabled?: boolean;
  onChange: (value: Record<string, JsonValue>) => void;
}) {
  const fields = getModelParameterFields({ provider, capabilities });
  return <div className="model-parameters">
    {Object.entries(labels).map(([operation, label]) => {
      const group = fields.filter(field => field.operation === operation);
      return group.length ? <fieldset key={operation}><legend>{label}</legend><div className="model-editor__grid">{group.map(field => {
        const current = modelParameterValue(value, field.key);
        const text = typeof current === 'string' || typeof current === 'number' ? String(current) : '';
        return <Field key={field.key} label={field.label} hint={field.hint}>{field.type === 'select' ? <select value={text} disabled={disabled} onChange={event => onChange(withModelParameter(value, field.key, event.target.value || undefined))}><option value="">使用默认值</option>{field.options?.map(option => <option key={option} value={option}>{option}</option>)}{text && !field.options?.includes(text) && <option value={text}>无效值：{text}</option>}</select> : <input type={field.type === 'number' ? 'number' : 'text'} value={text} min={field.min} max={field.max} step={field.integer ? '1' : 'any'} disabled={disabled} onChange={event => {
          const raw = event.target.value;
          const next = !raw ? undefined : field.type === 'number' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
          onChange(withModelParameter(value, field.key, next));
        }} />}</Field>;
      })}</div></fieldset> : null;
    })}
    {!fields.length && <p className="tiny-meta">此协议使用高级 JSON 配置工作流或请求映射。</p>}
    {fields.length > 0 && <p className="tiny-meta">留空使用步骤或服务默认值。具体尺寸、时长与音色范围以所接模型为准。</p>}
  </div>;
}
