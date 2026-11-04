import { creativeEntityLabels, type CreativeContext, type CreativeEntity } from '@video-quickly/contracts';
import { CharacterPicker } from '../features/CharactersPage';
import { Button, Field } from './Primitives';
import CreativeReferencePicker from './CreativeReferencePicker';
import './creative-context.css';

export default function CreativeContextEditor({ value, version, usedEntityKeys, onChange, label = '项目角色池' }: {
  value?: CreativeContext | null; version: number; usedEntityKeys: readonly string[]; onChange: (context: CreativeContext) => void; label?: string;
}) {
  const context = value ?? { characterIds: [], entities: [], continuity: '' };
  const referenced = new Set(usedEntityKeys);
  function updateEntity(key: string, patch: Partial<CreativeEntity>) {
    onChange({ ...context, entities: context.entities.map(entity => entity.key === key ? { ...entity, ...patch } : entity) });
  }
  function addEntity(kind: CreativeEntity['kind']) {
    onChange({ ...context, entities: [...context.entities, { key: `entity-${crypto.randomUUID()}`, kind, name: '', description: '' }] });
  }
  return <section className="creative-context-editor" aria-label="项目创作设定">
    <CharacterPicker label={label} maximum={50} value={context.characterIds} version={version} onChange={characterIds => onChange({ ...context, characterIds })} />
    <p className="tiny-meta">新分镜可自动选择这些角色，并在生成画面时使用对应参考图。已有镜头的角色选择会保留。</p>
    <Field label="连续性要求"><textarea rows={3} maxLength={10000} value={context.continuity} onChange={event => onChange({ ...context, continuity: event.target.value })} placeholder="全片需要保持的服装、时间、光线和空间关系…" /></Field>
    <details className="creative-context-editor__entities"><summary>人物、场景与道具{context.entities.length ? `（${context.entities.length}）` : ''}</summary>
      <p className="tiny-meta">文字设定用于保持叙事连续。场景与道具可选参考图，人物参考图从角色参考库选择。</p>
      {context.entities.map((entity, index) => <section key={entity.key} className="creative-context-editor__entity" aria-label={`${creativeEntityLabels[entity.kind]}设定 ${index + 1}`}>
        <header><strong>{creativeEntityLabels[entity.kind]} {index + 1}</strong><Button static variant="ghost" disabled={referenced.has(entity.key)} title={referenced.has(entity.key) ? '请先移除镜头中的设定引用' : undefined} aria-label={`移除${creativeEntityLabels[entity.kind]}设定 ${index + 1}`} onClick={() => onChange({ ...context, entities: context.entities.filter(item => item.key !== entity.key) })}>{referenced.has(entity.key) ? '镜头正在使用' : '移除'}</Button></header>
        <Field label="设定名称"><input required maxLength={120} value={entity.name} onChange={event => updateEntity(entity.key, { name: event.target.value })} /></Field>
        <Field label="固定特征"><textarea rows={3} maxLength={4000} value={entity.description} onChange={event => updateEntity(entity.key, { description: event.target.value })} placeholder="外观、位置、材质及需要保持的细节…" /></Field>
        {entity.kind !== 'character' && <CreativeReferencePicker version={version} label={`${creativeEntityLabels[entity.kind]}参考图`} value={entity.referenceAssetIds} onChange={referenceAssetIds => updateEntity(entity.key, { referenceAssetIds })} />}
      </section>)}
      <div className="creative-context-editor__actions">{(['character', 'scene', 'prop'] as const).map(kind => <Button static key={kind} disabled={context.entities.length >= 100} onClick={() => addEntity(kind)}>添加{creativeEntityLabels[kind]}设定</Button>)}</div>
    </details>
  </section>;
}

export function CreativeEntityPicker({ context, value = [], disabled, onChange }: {
  context?: CreativeContext | null; value?: string[]; disabled?: boolean; onChange: (keys: string[]) => void;
}) {
  const entities = context?.entities ?? [];
  if (!entities.length && !value.length) return null;
  const missing = value.filter(key => !entities.some(entity => entity.key === key));
  return <fieldset className="capability-fieldset creative-entity-picker"><legend>镜头创作设定</legend>
    {entities.map(entity => <label className="field-inline" key={entity.key}><input type="checkbox" checked={value.includes(entity.key)} disabled={disabled || !value.includes(entity.key) && value.length >= 12} onChange={event => onChange(event.target.checked ? [...value, entity.key] : value.filter(key => key !== entity.key))} />{creativeEntityLabels[entity.kind]}：{entity.name}</label>)}
    {missing.map(key => <label className="field-inline" key={key}><input type="checkbox" checked disabled={disabled} onChange={() => onChange(value.filter(item => item !== key))} />已移除的设定</label>)}
  </fieldset>;
}
