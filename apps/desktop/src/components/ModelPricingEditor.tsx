import { type ModelPricing } from '@video-quickly/contracts';
import { Button, Field } from './Primitives';
import './model-editors.css';

const prices = [
  ['inputPerMillionTokens', '输入价格（每百万 Token）'], ['outputPerMillionTokens', '输出价格（每百万 Token）'],
  ['perImage', '每张图片价格'], ['perVideoSecond', '每秒视频价格'],
  ['perThousandCharacters', '每千字符配音价格'], ['perAudioMinute', '每分钟音频价格'],
] as const;

export default function ModelPricingEditor({ value, disabled = false, onChange }: {
  value?: ModelPricing | null; disabled?: boolean; onChange: (value: ModelPricing | null) => void;
}) {
  return <fieldset className="model-pricing"><legend>费用估算</legend><label className="field-inline"><input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={event => onChange(event.target.checked ? { currency: 'USD' } : null)} />设置手动价格</label>
    <p className="tiny-meta">手动填写，仅用于估算，不代表服务账单。留空的计费项不会按零费用处理。</p>
    {value && <><Field label="价格币种"><select value={value.currency} disabled={disabled} onChange={event => onChange({ ...value, currency: event.target.value === 'CNY' ? 'CNY' : 'USD' })}><option value="USD">USD</option><option value="CNY">CNY</option></select></Field><div className="model-editor__grid">{prices.map(([key, label]) => <Field key={key} label={label}><input type="number" min="0" step="any" value={Number.isFinite(value[key]) ? value[key] : ''} disabled={disabled} onChange={event => {
      const next = { ...value }; if (!event.target.value) delete next[key]; else next[key] = event.target.valueAsNumber;
      onChange(next);
    }} /></Field>)}</div><Button variant="ghost" disabled={disabled} onClick={() => onChange(null)}>清除价格</Button></>}
  </fieldset>;
}
