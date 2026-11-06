import { useEffect, useId, useRef, useState } from 'react';
import { ChevronRight, FileText, MapPin, Package, Plus, Trash2, UserRound, Users } from 'lucide-react';
import { creativeEntityLabels, type CreativeContext, type CreativeEntity } from '@video-quickly/contracts';
import { CharacterPicker } from '../features/CharactersPage';
import { Button, Field } from './Primitives';
import CreativeReferencePicker from './CreativeReferencePicker';
import './creative-context.css';

const entityIcons = { character: UserRound, scene: MapPin, prop: Package };
const entityExamples = { character: '例：通勤者小林', scene: '例：清晨的办公室', prop: '例：银色笔记本电脑' };

export default function CreativeContextEditor({ value, version, usedEntityKeys, onChange, label = '项目角色池', collapsibleRoles = false }: {
  value?: CreativeContext | null; version: number; usedEntityKeys: readonly string[]; onChange: (context: CreativeContext) => void; label?: string; collapsibleRoles?: boolean;
}) {
  const context = value ?? { characterIds: [], entities: [], continuity: '' };
  const id = useId(), editor = useRef<HTMLElement>(null), entities = useRef<HTMLDetailsElement>(null), entityToFocus = useRef<string | undefined>(undefined);
  const [rolesOpen, setRolesOpen] = useState(Boolean(context.characterIds.length || context.continuity));
  const referenced = new Set(usedEntityKeys);
  const rolesSummary = [context.characterIds.length ? `已选择 ${context.characterIds.length} 个角色` : '', context.continuity.trim() ? '已填写连续性要求' : ''].filter(Boolean).join(' · ');
  useEffect(() => {
    if (!entityToFocus.current) return;
    const entry = [...editor.current?.querySelectorAll<HTMLElement>('[data-entity-key]') ?? []].find(item => item.dataset.entityKey === entityToFocus.current);
    if (!entry) return;
    if (entities.current) entities.current.open = true;
    const details = entry.querySelector('details');
    if (details) details.open = true;
    entry.querySelector('input')?.focus();
    entityToFocus.current = undefined;
  }, [context.entities]);
  function updateEntity(key: string, patch: Partial<CreativeEntity>) {
    onChange({ ...context, entities: context.entities.map(entity => entity.key === key ? { ...entity, ...patch } : entity) });
  }
  function addEntity(kind: CreativeEntity['kind']) {
    const key = `entity-${crypto.randomUUID()}`;
    entityToFocus.current = key;
    onChange({ ...context, entities: [...context.entities, { key, kind, name: '', description: '' }] });
  }
  const roleFields = <>
    <CharacterPicker label={label} hideWhenEmpty={collapsibleRoles} maximum={50} value={context.characterIds} version={version} onChange={characterIds => onChange({ ...context, characterIds })} />
    <Field label="连续性要求"><textarea rows={2} maxLength={10000} value={context.continuity} onChange={event => onChange({ ...context, continuity: event.target.value })} placeholder="服装、时间、光线与空间关系" /></Field>
  </>;
  return <section ref={editor} className="creative-context-editor" aria-label="项目创作设定">
    {collapsibleRoles ? <details className="creative-context-editor__roles creative-context-editor__disclosure" open={rolesOpen} onToggle={event => setRolesOpen(event.currentTarget.open)}>
      <summary><Users size={18} aria-hidden="true" /><span className="creative-context-editor__summary-copy"><strong>角色与连续性</strong>{rolesSummary && <span>{rolesSummary}</span>}</span><span className="creative-context-editor__badge">可选</span><ChevronRight size={16} aria-hidden="true" /></summary>
      <div className="creative-context-editor__role-fields">{roleFields}</div>
    </details> : roleFields}
    <details ref={entities} className="creative-context-editor__entities creative-context-editor__disclosure">
      <summary><FileText size={18} aria-hidden="true" /><span className="creative-context-editor__summary-copy"><strong>人物、场景与道具</strong>{context.entities.length > 0 && <span>{context.entities.map(entity => entity.name.trim() || `未命名${creativeEntityLabels[entity.kind]}`).join('、')}</span>}</span><span className="creative-context-editor__badge">{context.entities.length ? `${context.entities.length} 项` : '可选'}</span><ChevronRight size={16} aria-hidden="true" /></summary>
      <div className="creative-context-editor__entity-content">
        <div className="creative-context-editor__actions">{(['character', 'scene', 'prop'] as const).map(kind => <Button static key={kind} disabled={context.entities.length >= 100} onClick={() => addEntity(kind)}><Plus size={14} aria-hidden="true" />添加{creativeEntityLabels[kind]}设定</Button>)}</div>
        <div className="creative-context-editor__entity-list">{context.entities.map((entity, index) => {
          const Icon = entityIcons[entity.kind];
          return <section key={entity.key} data-entity-key={entity.key} className="creative-context-editor__entity" aria-label={`${creativeEntityLabels[entity.kind]}设定 ${index + 1}`}>
            <details name={`${id}-entity`}>
              <summary><Icon size={18} aria-hidden="true" /><span className="creative-context-editor__summary-copy"><strong>{entity.name.trim() || `未命名${creativeEntityLabels[entity.kind]}`}</strong>{entity.description.trim() && <span>{entity.description}</span>}</span><span className="creative-context-editor__badge">{creativeEntityLabels[entity.kind]}</span><ChevronRight size={16} aria-hidden="true" /></summary>
              <div className="creative-context-editor__entity-fields">
                <Field label="设定名称"><input required pattern={'.*\\S.*'} title="请输入设定名称，不能只填空格" maxLength={120} value={entity.name} placeholder={entityExamples[entity.kind]} onChange={event => updateEntity(entity.key, { name: event.target.value })} /></Field>
                <Field label="固定特征"><textarea rows={2} maxLength={4000} value={entity.description} onChange={event => updateEntity(entity.key, { description: event.target.value })} placeholder="外观、位置、材质与细节" /></Field>
                {entity.kind !== 'character' && <CreativeReferencePicker version={version} label={`${creativeEntityLabels[entity.kind]}参考图`} value={entity.referenceAssetIds} onChange={referenceAssetIds => updateEntity(entity.key, { referenceAssetIds })} />}
                <div className="creative-context-editor__entity-footer"><Button static variant="ghost" disabled={referenced.has(entity.key)} title={referenced.has(entity.key) ? '请先移除镜头中的设定引用' : undefined} aria-label={`移除${creativeEntityLabels[entity.kind]}设定 ${index + 1}`} onClick={() => { onChange({ ...context, entities: context.entities.filter(item => item.key !== entity.key) }); editor.current?.querySelector<HTMLButtonElement>('.creative-context-editor__actions button')?.focus(); }}><Trash2 size={14} aria-hidden="true" />{referenced.has(entity.key) ? '镜头正在使用' : '移除此设定'}</Button></div>
              </div>
            </details>
          </section>;
        })}</div>
      </div>
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
