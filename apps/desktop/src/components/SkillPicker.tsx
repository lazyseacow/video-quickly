import { useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Folder } from 'lucide-react';
import type { SkillGroup, SkillPackage } from '@video-quickly/contracts';
import HelpTip from './HelpTip';
import { Button, IconButton } from './Primitives';
import './skill-library.css';

export default function SkillPicker({ skills, groups = [], value, onChange, label = '应用 Skill', hint, selectionSummary, disabled = false, className = '', inline = false }: {
  skills: SkillPackage[]; groups?: SkillGroup[]; value: string[]; onChange(ids: string[]): void;
  label?: string; hint?: string; selectionSummary?: string; disabled?: boolean; className?: string; inline?: boolean;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null), searchInput = useRef<HTMLInputElement>(null), back = useRef<HTMLButtonElement>(null);
  const returnGroup = useRef<string | undefined>(undefined);
  const [inlineOpen, setInlineOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [groupId, setGroupId] = useState<string>();
  const selected = new Set(value), grouped = new Set(groups.flatMap(group => group.skillIds));
  const query = search.trim().toLocaleLowerCase();
  const collections = [
    ...groups.map(group => ({ id: group.id, name: group.name, members: skills.filter(skill => group.skillIds.includes(skill.id)) })),
    { id: 'ungrouped', name: '独立 Skill', members: skills.filter(skill => !grouped.has(skill.id)) },
  ].filter(group => group.members.length > 0).map(group => ({
    ...group,
    matches: group.name.toLocaleLowerCase().includes(query) ? group.members : group.members.filter(skill => `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query)),
    selectedCount: group.members.filter(skill => selected.has(skill.id)).length,
  }));
  const visibleGroups = collections.filter(group => group.matches.length > 0);
  const activeGroup = collections.find(group => group.id === groupId);
  const activeGroupId = activeGroup?.id;
  const drilldown = inline ? undefined : activeGroup;
  const missing = value.filter(id => !skills.some(skill => skill.id === id));

  useLayoutEffect(() => {
    const currentPanel = panel.current;
    if (inline) {
      if (inlineOpen && activeGroupId) currentPanel?.parentElement?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (!returnGroup.current || !currentPanel?.matches(':popover-open')) return;
    if (activeGroupId) {
      back.current?.focus({ preventScroll: true });
    } else {
      const groupButton = currentPanel.querySelector<HTMLButtonElement>(`[data-skill-group="${CSS.escape(returnGroup.current)}"]`);
      (groupButton ?? searchInput.current)?.focus();
      returnGroup.current = undefined;
    }
  }, [activeGroupId, inline, inlineOpen]);

  useLayoutEffect(() => {
    if (inlineOpen) searchInput.current?.focus();
  }, [inlineOpen]);

  function resetPanel() {
    returnGroup.current = undefined;
    setGroupId(undefined);
    setSearch('');
  }

  function groupSelection(group: typeof collections[number]) {
    const eligible = group.members.filter(skill => skill.enabled);
    const all = eligible.length > 0 && eligible.every(skill => selected.has(skill.id));
    const toggle = () => {
      onChange(all ? value.filter(id => !group.members.some(skill => skill.id === id)) : [...new Set([...value, ...eligible.map(skill => skill.id)])]);
    };
    if (inline) {
      const label = `选用整组“${group.name}”`;
      return <label className="skill-picker__group-check" title={label}>
        <input type="checkbox" aria-label={label} checked={all} disabled={!eligible.length} ref={input => {
          if (input) input.indeterminate = !all && group.selectedCount > 0;
        }} onChange={toggle} />
      </label>;
    }
    return <Button static variant="ghost" disabled={!eligible.length} aria-label={`${all ? '取消' : '选用'}整组“${group.name}”`} onClick={toggle}>{all ? '取消整组' : '选用整组'}</Button>;
  }

  function groupMembers(group: typeof collections[number]) {
    return group.matches.length ? <ul className="skill-picker__list" aria-label={`${group.name}中的 Skill`}>{group.matches.map(skill => <li key={skill.id}>
      <label className="skill-picker__item">
        <input type="checkbox" checked={selected.has(skill.id)} disabled={!skill.enabled && !selected.has(skill.id)} onChange={event => onChange(event.target.checked ? [...new Set([...value, skill.id])] : value.filter(id => id !== skill.id))} />
        <span>
          <strong>{skill.name} <span className="tiny-meta">{skill.version.slice(0, 12)}</span>{!skill.enabled && '（已停用）'}</strong>
          {skill.description && (inline
            ? <HelpTip preview label={`${skill.name}说明`} description={skill.description} className="skill-picker__description" />
            : <small>{skill.description}</small>)}
        </span>
      </label>
    </li>)}</ul> : <p className="skill-picker__hint field__hint" role="status">组内没有匹配的 Skill。</p>;
  }

  return <fieldset className={`skill-picker${inline ? ' skill-picker--inline' : ''} ${className}`} disabled={disabled} aria-label={label} onBlur={event => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget) && panel.current?.matches(':popover-open')) panel.current.hidePopover();
  }}>
    <Button ref={trigger} static variant="ghost" className="skill-picker__trigger" popoverTarget={inline ? undefined : id} aria-controls={id} aria-expanded={inline ? inlineOpen : undefined} aria-labelledby={`${id}-label`} aria-describedby={`${id}-count`} onClick={inline ? () => {
      setInlineOpen(!inlineOpen);
      if (inlineOpen) resetPanel();
    } : undefined}>
      <span id={`${id}-label`} className="skill-picker__name">{label}</span>
      <span id={`${id}-count`} className="skill-picker__count" aria-live="polite">{selectionSummary ?? `已选 ${selected.size} 个`}</span>
      <ChevronDown size={16} aria-hidden="true" />
    </Button>
    <div ref={panel} id={id} className="skill-picker__panel" popover={inline ? undefined : 'auto'} hidden={inline && !inlineOpen} tabIndex={inline ? undefined : -1} onToggle={event => {
      if (event.target !== event.currentTarget) return;
      if (event.newState === 'open') (searchInput.current ?? event.currentTarget).focus({ preventScroll: true });
      else resetPanel();
    }} onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Enter' && event.target === searchInput.current) event.preventDefault();
      if (event.key === 'Escape' && (activeGroup || inline)) {
        event.preventDefault();
        event.stopPropagation();
        if (activeGroup) {
          if (inline) (panel.current?.querySelector<HTMLButtonElement>(`[data-skill-group="${CSS.escape(activeGroup.id)}"]`) ?? searchInput.current)?.focus();
          setGroupId(undefined);
        } else {
          setInlineOpen(false);
          resetPanel();
          trigger.current?.focus();
        }
      }
    }}>
      {skills.length ? <>
        <div className="skill-picker__toolbar">
          <input ref={searchInput} type="search" aria-label={drilldown ? `搜索“${drilldown.name}”中的 Skill` : '搜索 Skill 或分组'} placeholder={drilldown ? '搜索组内 Skill' : '搜索 Skill 或分组'} value={search} onChange={event => setSearch(event.target.value)} />
          <Button static variant="ghost" disabled={selected.size === 0} onClick={() => { searchInput.current?.focus({ preventScroll: true }); onChange([]); }}>清空选择</Button>
        </div>
        {drilldown ? <>
          <div className="skill-picker__submenu">
            <IconButton ref={back} label="返回 Skill 分组" onClick={() => setGroupId(undefined)}><ChevronLeft size={16} aria-hidden="true" /></IconButton>
            <strong className="skill-picker__name" title={drilldown.name}>{drilldown.name}</strong>
            {groupSelection(drilldown)}
          </div>
          {groupMembers(drilldown)}
        </> : visibleGroups.length ? <ul className="skill-picker__list" aria-label="Skill 分组">{visibleGroups.map(group => {
          const expanded = inline && group.id === activeGroupId;
          const groupTrigger = <Button static variant="ghost" data-skill-group={group.id} className="skill-picker__row" aria-expanded={inline ? expanded : undefined} aria-controls={expanded ? `${id}-branch` : undefined} onClick={() => {
            if (!inline) returnGroup.current = group.id;
            setGroupId(expanded ? undefined : group.id);
          }}>
            {!inline && <Folder size={16} aria-hidden="true" />}
            <span className="skill-picker__name" title={group.name}>{group.name}</span>
            <span className="skill-picker__count" aria-label={`已选 ${group.selectedCount} 个，共 ${group.members.length} 个`}>{group.selectedCount} / {group.members.length}</span>
            {inline ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
          </Button>;
          return <li key={group.id}>
            {inline ? <div className="skill-picker__group-row">{groupSelection(group)}{groupTrigger}</div> : groupTrigger}
            {expanded && <div id={`${id}-branch`} className="skill-picker__branch">{groupMembers(group)}</div>}
          </li>;
        })}</ul> : <p className="skill-picker__hint field__hint" role="status">没有匹配的 Skill 或分组。</p>}
        {hint && !activeGroup && <p className="skill-picker__hint field__hint">{hint}</p>}
      </> : <p className="skill-picker__hint field__hint">暂无 Skill，可在 Skill 工作室导入。</p>}
    </div>
    {missing.length > 0 && <p className="field-error" role="alert">有 {missing.length} 个 Skill 已不可用，请移除后重新选择。<Button onClick={() => onChange(value.filter(id => !missing.includes(id)))}>移除不可用项</Button></p>}
  </fieldset>;
}
