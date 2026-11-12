import type { ReactNode } from 'react';
import { characterProfileSchema, recordPageSchema, type CharacterProfile } from '@video-quickly/contracts';
import { Button, Notice } from './Primitives';
import { useRecordPage } from '../lib/use-record-page';
import { useRuntimeRead } from '../lib/use-runtime-read';
import './character-picker.css';

const characterPage = recordPageSchema(characterProfileSchema);
const characterProfiles = characterProfileSchema.array();

type CharacterPickerProps = { value?: string[]; version: number; onChange: (ids: string[]) => void; disabled?: boolean; label?: string; maximum?: number; hideWhenEmpty?: boolean };
type CharacterPickerPage = ReturnType<typeof useRecordPage<CharacterProfile>>;

export function CharacterPickerLibrary({ version, children }: { version: number; children: (library: CharacterPickerPage) => ReactNode }) {
  const library = useRecordPage('character.list', { archived: false, limit: 20 }, version, characterPage);
  return children(library);
}

export function CharacterPicker(props: CharacterPickerProps) {
  return <CharacterPickerLibrary version={props.version}>
    {library => <CharacterPickerOptions {...props} library={library} />}
  </CharacterPickerLibrary>;
}

export function CharacterPickerOptions({ library, value = [], version, onChange, disabled = false, label = '镜头角色', maximum = 8, hideWhenEmpty = false }: CharacterPickerProps & { library: CharacterPickerPage }) {
  const selected = useRuntimeRead('character.getMany', { characterIds: value }, version, characterProfiles, value.length > 0);
  const selectedById = new Map(selected.data?.map(character => [character.id, character]));
  const missing = new Set(selected.data ? value.filter(id => !selectedById.has(id)) : []);
  const profilesById = new Map(library.items.map(character => [character.id, character]));
  for (const character of selectedById.values()) profilesById.set(character.id, character);
  for (const id of missing) profilesById.delete(id);
  const profiles = [...profilesById.values()];
  if (hideWhenEmpty && !profiles.length && !missing.size && !library.error && !selected.error) return null;
  return <fieldset className="character-shot-picker capability-fieldset">
    <legend>{label}</legend>
    {profiles.map(character => <label key={character.id} className="field-inline"><input type="checkbox" checked={value.includes(character.id)} disabled={disabled || !value.includes(character.id) && (character.archived || value.length >= maximum)} onChange={event => onChange(event.target.checked ? [...value, character.id] : value.filter(id => id !== character.id))} />{character.name}{character.archived ? '（已归档）' : ''}</label>)}
    {missing.size > 0 && <Notice>找不到 {missing.size} 个已选角色。<Button disabled={disabled} onClick={() => onChange(value.filter(id => !missing.has(id)))}>移除缺失角色</Button></Notice>}
    {!profiles.length && !library.busy && !missing.size && <p className="tiny-meta">在「素材库 → 角色」创建角色后，可在此选择。</p>}
    {library.error ? <Notice kind="error">{library.error}</Notice> : selected.error && <Notice kind="error">{selected.error}<Button aria-label="重试读取已选角色" onClick={selected.refresh}>重试</Button></Notice>}
    {library.nextCursor !== null && <Button aria-label="加载更多角色" busy={library.loadingMore} disabled={!library.canLoadMore} onClick={() => void library.loadMore()}>加载更多</Button>}
  </fieldset>;
}
