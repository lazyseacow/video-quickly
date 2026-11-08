import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { SkillGroup, SkillPackage } from '@video-quickly/contracts';
import { Button } from './Primitives';
import './skill-library.css';

export default function SkillPicker({ skills, groups = [], value, onChange, label = '应用 Skill', showLegend = true, disabled = false }: {
  skills: SkillPackage[]; groups?: SkillGroup[]; value: string[]; onChange(ids: string[]): void; label?: string; showLegend?: boolean; disabled?: boolean;
}) {
  const [search, setSearch] = useState('');
  const selected = new Set(value), grouped = new Set(groups.flatMap(group => group.skillIds));
  const collections = [
    ...groups.map(group => ({ id: group.id, name: group.name, members: skills.filter(skill => group.skillIds.includes(skill.id)) })),
    { id: 'ungrouped', name: '独立 Skill', members: skills.filter(skill => !grouped.has(skill.id)) },
  ].filter(group => group.members.length > 0);
  const query = search.trim().toLocaleLowerCase();
  const missing = value.filter(id => !skills.some(skill => skill.id === id));
  return <fieldset className="skill-picker" disabled={disabled} aria-label={label}>
    {showLegend && <legend>{label}</legend>}
    {skills.length ? <>
      <div className="skill-picker__toolbar"><input type="search" aria-label={`搜索${label}`} placeholder="搜索 Skill 或分组" value={search} onChange={event => setSearch(event.target.value)} /><span className="tiny-meta">已选 {selected.size} 个</span>{value.length > 0 && <Button variant="ghost" onClick={() => onChange([])}>清空选择</Button>}</div>
      <div className="skill-picker__groups">{collections.map(group => {
        const members = group.name.toLocaleLowerCase().includes(query) ? group.members : group.members.filter(skill => `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query));
        if (!members.length) return null;
        const eligible = group.members.filter(skill => skill.enabled), all = eligible.length > 0 && eligible.every(skill => selected.has(skill.id));
        return <details className="skill-picker__group" key={group.id} open={query ? true : undefined}>
          <summary><span><ChevronRight size={14} className="skill-picker__chevron" aria-hidden="true" />{group.name}<small>{group.members.filter(skill => selected.has(skill.id)).length} / {group.members.length}</small></span><Button variant="ghost" disabled={!eligible.length} aria-label={`${all ? '取消' : '选用'}整组“${group.name}”`} aria-pressed={all} onClick={event => {
            event.preventDefault(); event.stopPropagation();
            onChange(all ? value.filter(id => !group.members.some(skill => skill.id === id)) : [...new Set([...value, ...eligible.map(skill => skill.id)])]);
          }}>{all ? '取消整组' : '选用整组'}</Button></summary>
          <div className="skill-picker__items">{members.map(skill => <label key={skill.id} className="skill-picker__item"><input type="checkbox" checked={selected.has(skill.id)} disabled={!skill.enabled && !selected.has(skill.id)} onChange={event => onChange(event.target.checked ? [...new Set([...value, skill.id])] : value.filter(id => id !== skill.id))} /><span><strong>{skill.name} <span className="tiny-meta">{skill.version.slice(0, 12)}</span>{!skill.enabled && '（已停用）'}</strong><small>{skill.description}</small></span></label>)}</div>
        </details>;
      })}</div>
    </> : <p className="field__hint">暂无 Skill，可在 Skill 工作室导入。</p>}
    {missing.length > 0 && <p className="field-error" role="alert">有 {missing.length} 个 Skill 已不可用，请移除后重新选择。<Button onClick={() => onChange(value.filter(id => !missing.includes(id)))}>移除不可用项</Button></p>}
  </fieldset>;
}
