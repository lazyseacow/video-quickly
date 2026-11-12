import { useEffect, useId, useRef, useState, type ReactNode, type ToggleEvent } from 'react';
import { autoUpdate } from '@floating-ui/react';
import { ChevronRight, FileText, MapPin, Package, Plus, Trash2, UserRound, Users } from 'lucide-react';
import { creativeEntityLabels, type CreativeContext, type CreativeEntity } from '@video-quickly/contracts';
import { CharacterPicker } from './CharacterPicker';
import { Button, EmptyState, Field } from './Primitives';
import CreativeReferencePicker from './CreativeReferencePicker';
import SettingsSections, { type SettingsSection } from './SettingsSections';
import './creative-context.css';

const entityIcons = { character: UserRound, scene: MapPin, prop: Package };
const entityExamples = { character: '例：通勤者小林', scene: '例：清晨的办公室', prop: '例：银色笔记本电脑' };

function CreativeContextPopover({ label, summary, children }: { label: string; summary: ReactNode; children: ReactNode }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const stopTracking = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => stopTracking.current?.(), []);

  function trackPlacement(event: ToggleEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    stopTracking.current?.();
    stopTracking.current = undefined;
    const button = trigger.current, panel = event.currentTarget;
    const content = button?.closest('.production-settings__content');
    if (event.newState !== 'open' || !button || !content) return;

    // The top layer uses viewport bounds. Keep the panel between the step navigation and footer.
    stopTracking.current = autoUpdate(button, panel, () => {
      const anchor = button.getBoundingClientRect(), viewport = content.getBoundingClientRect();
      const above = anchor.top - viewport.top, below = viewport.bottom - anchor.bottom;
      panel.toggleAttribute('data-above', above > below);
      panel.style.setProperty('--popover-space', `${Math.max(above, below)}px`);
    });
  }
  return <div className="creative-context-editor__option">
    <Button ref={trigger} static variant="ghost" className="creative-context-editor__trigger" popoverTarget={id} aria-controls={id}>{summary}</Button>
    <div id={id} popover="auto" onBeforeToggle={trackPlacement} role="region" aria-label={label} className="creative-context-editor__popover">{children}</div>
  </div>;
}

function CreativeEntityWorkspace({ label, summary, actions, sections, selected, onSelect }: {
  label: string; summary: ReactNode; actions: ReactNode; sections: SettingsSection[]; selected?: string; onSelect: (key: string) => void;
}) {
  const id = useId();
  const workspace = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (workspace.current?.matches(':popover-open')) {
      workspace.current.querySelector('[role="tab"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [selected]);

  function focusWorkspace(event: ToggleEvent<HTMLDivElement>) {
    const panel = event.currentTarget;
    if (event.target !== panel || event.newState !== 'open' || panel.querySelector(':focus')) return;
    const target = panel.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
      ?? panel.querySelector<HTMLButtonElement>('.creative-context-editor__actions button');
    target?.focus();
  }
  return <div className="creative-context-editor__option">
    <Button static variant="ghost" className="creative-context-editor__trigger" popoverTarget={id} aria-controls={id}>{summary}</Button>
    <div ref={workspace} id={id} popover="auto" tabIndex={-1} role="region" aria-labelledby={`${id}-title`} className="creative-context-editor__workspace" onToggle={focusWorkspace} onBlur={event => {
      const panel = event.currentTarget;
      if (event.relatedTarget instanceof Node && !panel.contains(event.relatedTarget) && panel.matches(':popover-open')) panel.hidePopover();
    }}>
      <header className="creative-context-editor__workspace-header">
        <h3 id={`${id}-title`}>{label}</h3>
        {actions}
        <Button static variant="ghost" className="creative-context-editor__workspace-return" popoverTarget={id} popoverTargetAction="hide">返回创作要求</Button>
      </header>
      {sections.length ? <SettingsSections label="设定列表" sections={sections} value={selected} onValueChange={onSelect} />
        : <EmptyState icon={<FileText size={22} aria-hidden="true" />} title="还没有设定" description="从上方添加人物、场景或道具，记录后续镜头需要沿用的特征。" />}
    </div>
  </div>;
}

export default function CreativeContextEditor({ value, version, usedEntityKeys, onChange, label = '项目角色池', floatingSections = false }: {
  value?: CreativeContext | null; version: number; usedEntityKeys: readonly string[]; onChange: (context: CreativeContext) => void; label?: string; floatingSections?: boolean;
}) {
  const context = value ?? { characterIds: [], entities: [], continuity: '' };
  const id = useId(), editor = useRef<HTMLElement>(null), entities = useRef<HTMLDetailsElement>(null), entityToFocus = useRef<string | undefined>(undefined);
  const [selectedEntity, setSelectedEntity] = useState<string>();
  const referenced = new Set(usedEntityKeys);
  const rolesSummary = [context.characterIds.length ? `已选择 ${context.characterIds.length} 个角色` : '', context.continuity.trim() ? '已填写连续性要求' : ''].filter(Boolean).join(' · ');
  useEffect(() => {
    if (!entityToFocus.current) return;
    const entry = [...editor.current?.querySelectorAll<HTMLElement>('[data-entity-key]') ?? []].find(item => item.dataset.entityKey === entityToFocus.current);
    if (!entry) return;
    if (entities.current) {
      entities.current.open = true;
      const details = entry.querySelector('details');
      if (details) details.open = true;
    }
    entry.querySelector('input')?.focus();
    entityToFocus.current = undefined;
  }, [context.entities]);
  function updateEntity(key: string, patch: Partial<CreativeEntity>) {
    onChange({ ...context, entities: context.entities.map(entity => entity.key === key ? { ...entity, ...patch } : entity) });
  }
  function addEntity(kind: CreativeEntity['kind']) {
    const key = `entity-${crypto.randomUUID()}`;
    entityToFocus.current = key;
    if (floatingSections) setSelectedEntity(key);
    onChange({ ...context, entities: [...context.entities, { key, kind, name: '', description: '' }] });
  }
  function entityFields(entity: CreativeEntity, index: number) {
    const kind = creativeEntityLabels[entity.kind];
    const inUse = referenced.has(entity.key);
    const remove = <Button static variant="ghost" disabled={inUse} title={inUse ? '请先移除镜头中的设定引用' : undefined} aria-label={`移除${kind}设定 ${index + 1}`} onClick={() => {
      onChange({ ...context, entities: context.entities.filter(item => item.key !== entity.key) });
      editor.current?.querySelector<HTMLButtonElement>('.creative-context-editor__actions button')?.focus();
    }}><Trash2 size={14} aria-hidden="true" />{inUse ? '镜头正在使用' : '移除此设定'}</Button>;
    return <>
      {floatingSections && <header className="creative-context-editor__workspace-fields-heading"><h4>{kind}设定</h4>{remove}</header>}
      <Field label="设定名称"><input required pattern={'.*\\S.*'} title="请输入设定名称，不能只填空格" maxLength={120} value={entity.name} placeholder={entityExamples[entity.kind]} onChange={event => updateEntity(entity.key, { name: event.target.value })} /></Field>
      <Field label="固定特征"><textarea rows={floatingSections ? 4 : 2} maxLength={4000} value={entity.description} onChange={event => updateEntity(entity.key, { description: event.target.value })} placeholder="外观、位置、材质与细节" /></Field>
      {entity.kind !== 'character' && <CreativeReferencePicker version={version} label={`${kind}参考图`} value={entity.referenceAssetIds} onChange={referenceAssetIds => updateEntity(entity.key, { referenceAssetIds })} />}
      {!floatingSections && <div className="creative-context-editor__entity-footer">{remove}</div>}
    </>;
  }
  const roleFields = <>
    <CharacterPicker label={label} hideWhenEmpty={floatingSections} maximum={50} value={context.characterIds} version={version} onChange={characterIds => onChange({ ...context, characterIds })} />
    <Field label="连续性要求"><textarea rows={2} maxLength={10000} value={context.continuity} onChange={event => onChange({ ...context, continuity: event.target.value })} placeholder="服装、时间、光线与空间关系" /></Field>
  </>;
  const entityLabel = '人物、场景与道具';
  const entitySummary = <><FileText size={18} aria-hidden="true" /><span className="creative-context-editor__summary-copy"><strong>{entityLabel}</strong>{context.entities.length > 0 && <span>{context.entities.map(entity => entity.name.trim() || `未命名${creativeEntityLabels[entity.kind]}`).join('、')}</span>}</span><span className="creative-context-editor__badge">{context.entities.length ? `${context.entities.length} 项` : '可选'}</span><ChevronRight size={16} aria-hidden="true" /></>;
  const entityActions = <div className="creative-context-editor__actions" role="group" aria-label="添加设定">
    {(['character', 'scene', 'prop'] as const).map(kind => {
      const name = `${creativeEntityLabels[kind]}设定`;
      return <Button static key={kind} disabled={context.entities.length >= 100} aria-label={`添加${name}`} onClick={() => addEntity(kind)}>
        <Plus size={14} aria-hidden="true" />{floatingSections ? name : `添加${name}`}
      </Button>;
    })}
  </div>;
  return <section ref={editor} className="creative-context-editor" aria-label="项目创作设定">
    {floatingSections ? <>
      <CreativeContextPopover label="角色与连续性" summary={<><Users size={18} aria-hidden="true" /><span className="creative-context-editor__summary-copy"><strong>角色与连续性</strong>{rolesSummary && <span>{rolesSummary}</span>}</span><span className="creative-context-editor__badge">可选</span><ChevronRight size={16} aria-hidden="true" /></>}>
        <div className="creative-context-editor__role-fields">{roleFields}</div>
      </CreativeContextPopover>
      <CreativeEntityWorkspace label={entityLabel} summary={entitySummary} actions={entityActions} selected={selectedEntity} onSelect={setSelectedEntity} sections={context.entities.map((entity, index) => ({
        id: entity.key, label: `${creativeEntityLabels[entity.kind]} · ${entity.name.trim() || '未命名'}`, icon: entityIcons[entity.kind],
        content: <section data-entity-key={entity.key} className="creative-context-editor__workspace-fields" aria-label={`${creativeEntityLabels[entity.kind]}设定 ${index + 1}`}>{entityFields(entity, index)}</section>,
      }))} />
    </> : <>
      {roleFields}
      <details ref={entities} className="form-disclosure creative-context-editor__entities creative-context-editor__disclosure">
        <summary>{entitySummary}</summary>
        <div className="creative-context-editor__entity-content">
          {entityActions}
          {context.entities.length > 0 && <div className="creative-context-editor__entity-list">{context.entities.map((entity, index) => {
            const Icon = entityIcons[entity.kind];
            return <section key={entity.key} data-entity-key={entity.key} className="creative-context-editor__entity" aria-label={`${creativeEntityLabels[entity.kind]}设定 ${index + 1}`}>
              <details className="form-disclosure" name={`${id}-entity`}>
                <summary><Icon size={18} aria-hidden="true" /><span className="creative-context-editor__summary-copy"><strong>{entity.name.trim() || `未命名${creativeEntityLabels[entity.kind]}`}</strong>{entity.description.trim() && <span>{entity.description}</span>}</span><span className="creative-context-editor__badge">{creativeEntityLabels[entity.kind]}</span><ChevronRight size={16} aria-hidden="true" /></summary>
                <div className="creative-context-editor__entity-fields">{entityFields(entity, index)}</div>
              </details>
            </section>;
          })}</div>}
        </div>
      </details>
    </>}
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
