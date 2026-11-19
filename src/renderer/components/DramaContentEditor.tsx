import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { characterProfileSchema, dramaLineKindLabels, projectCharacterIds, projectSchema, recordPageSchema, shotSchema, voiceProfileSchema, type DramaLine, type ProjectDocument, type Shot } from '@video-quickly/contracts';
import { Button, Dialog, Field, IconButton, Notice, Select } from './Primitives';
import { CharacterPicker } from './CharacterPicker';
import { DramaModeFields } from '../features/DramaWorksPage';
import { useRecordPage } from '../lib/use-record-page';
import { useRuntimeRead } from '../lib/use-runtime-read';
import '../features/drama.css';

const charactersPage = recordPageSchema(characterProfileSchema);
const charactersSchema = characterProfileSchema.array();
const voicesPage = recordPageSchema(voiceProfileSchema);
const voicesSchema = voiceProfileSchema.array();

export default function DramaContentEditor({ project, version, disabled, onClose, onApply }: {
  project: ProjectDocument; version: number; disabled: boolean; onClose(): void;
  onApply(next: Pick<ProjectDocument, 'drama' | 'shots'>, baseline: ProjectDocument): Promise<boolean>;
}) {
  const [episode, setEpisode] = useState(() => structuredClone(project.drama));
  const [shots, setShots] = useState(() => structuredClone(project.shots));
  const [selectedId, setSelectedId] = useState(project.shots[0]?.id ?? '');
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState('');
  const pending = useRef(false);
  const library = useRecordPage('character.list', { archived: false, limit: 100 }, version, charactersPage);
  const selected = useRuntimeRead('character.getMany', { characterIds: projectCharacterIds({ ...project, shots }).slice(0, 50) }, version, charactersSchema);
  const characters = [...new Map([...library.items, ...(selected.data ?? [])].map(profile => [profile.id, profile])).values()];
  const voices = useRecordPage('voice.list', { archived: false, limit: 100 }, version, voicesPage);
  const selectedVoiceIds = [...new Set(shots.flatMap(shot => shot.drama?.lines.flatMap(line => line.voiceId ? [line.voiceId] : []) ?? []))];
  const selectedVoices = useRuntimeRead('voice.getMany', { voiceIds: selectedVoiceIds }, version, voicesSchema, selectedVoiceIds.length > 0);
  const voiceOptions = [...new Map([...voices.items, ...(selectedVoices.data ?? [])].map(profile => [profile.id, profile])).values()];
  const shot = shots.find(value => value.id === selectedId);
  const editable = !disabled && !busy;
  function updateShot(patch: Partial<Shot>) { if (shot) setShots(values => values.map(value => value.id === shot.id ? { ...value, ...patch } : value)); }
  function updateDrama(patch: Partial<NonNullable<Shot['drama']>>) { if (shot) updateShot({ drama: { appearances: [], lines: [], ...shot.drama, ...patch } }); }
  function updateLine(id: string, patch: Partial<DramaLine>) { updateDrama({ lines: shot?.drama?.lines.map(line => line.id === id ? { ...line, ...patch } : line) ?? [] }); }
  function moveLine(index: number, direction: -1 | 1) {
    const lines = [...(shot?.drama?.lines ?? [])], next = index + direction;
    if (next < 0 || next >= lines.length) return;
    [lines[index], lines[next]] = [lines[next], lines[index]]; updateDrama({ lines });
  }
  async function apply() {
    if (!episode || pending.current) return;
    pending.current = true; setBusy(true); setFailure('');
    try {
      const parsed = projectSchema.safeParse({ ...project, drama: episode, shots });
      if (!parsed.success) { setFailure(parsed.error.issues[0]?.message ?? '请核对短剧内容。'); return; }
      if (await onApply({ drama: parsed.data.drama, shots: parsed.data.shots }, project)) onClose();
    } catch (reason) { setFailure(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = false; setBusy(false); }
  }
  if (!episode) return null;
  return <Dialog title={`短剧内容 · 第 ${episode.number} 集`} onClose={onClose} dismissDisabled={busy} dismissOnBackdrop={false} className="drama-content-editor"><form onSubmit={event => { event.preventDefault(); void apply(); }}><div className="dialog__body form-stack">
    <DramaModeFields {...episode} disabled={!editable} onChange={patch => setEpisode({ ...episode, ...patch })} />
    <section className="drama-section"><div className="drama-section__heading"><h3>场次</h3><Button disabled={!editable || episode.scenes.length >= 500} onClick={() => setEpisode({ ...episode, scenes: [...episode.scenes, { id: crypto.randomUUID(), title: `场次 ${episode.scenes.length + 1}`, description: '', location: '', timeOfDay: '' }] })}><Plus size={15} aria-hidden="true" />添加场次</Button></div>
      {episode.scenes.map((scene, index) => {
        const bound = shots.some(value => value.drama?.sceneId === scene.id);
        const change = (patch: Partial<typeof scene>) => setEpisode({ ...episode, scenes: episode.scenes.map(value => value.id === scene.id ? { ...value, ...patch } : value) });
        return <details className="drama-entry" key={scene.id}><summary>{index + 1}. {scene.title || '未命名场次'}</summary><div className="form-stack"><Field label="场次名称" required><input name={`scene-title-${scene.id}`} required maxLength={160} value={scene.title} disabled={!editable} onChange={event => change({ title: event.target.value })} /></Field><div className="drama-form-grid"><Field label="地点"><input maxLength={1000} value={scene.location} disabled={!editable} onChange={event => change({ location: event.target.value })} /></Field><Field label="时间与天色"><input maxLength={120} value={scene.timeOfDay} disabled={!editable} onChange={event => change({ timeOfDay: event.target.value })} /></Field></div><Field label="场景与剧情描述"><textarea rows={3} maxLength={10000} value={scene.description} disabled={!editable} onChange={event => change({ description: event.target.value })} /></Field><div><Button disabled={!editable || bound} onClick={() => setEpisode({ ...episode, scenes: episode.scenes.filter(value => value.id !== scene.id) })}>移除场次</Button>{bound && <p className="field__hint">先解除镜头关联，再移除此场次。</p>}</div></div></details>;
      })}
    </section>
    <section className="drama-section"><div className="drama-section__heading"><h3>镜头与台词</h3><Button disabled={!editable || shots.length >= 100} onClick={() => {
      const created = shotSchema.parse({ id: crypto.randomUUID(), title: `镜头 ${shots.length + 1}`, narration: '', visualPrompt: '', durationUs: 6_000_000, drama: { sceneId: episode.scenes[0]?.id, appearances: [], lines: [] } });
      setShots(values => [...values, created]); setSelectedId(created.id);
    }}><Plus size={15} aria-hidden="true" />添加短剧镜头</Button></div>
      {shots.length > 0 && <Field label="当前镜头"><Select value={selectedId} onChange={event => setSelectedId(event.target.value)}>{shots.map((value, index) => <option key={value.id} value={value.id}>{index + 1}. {value.title}</option>)}</Select></Field>}
      {shot && <div className="form-stack" key={shot.id}>
        <div className="drama-form-grid"><Field label="镜头名称" required><input required maxLength={160} value={shot.title} disabled={!editable || shot.locked} onChange={event => updateShot({ title: event.target.value })} /></Field><Field label="所属场次"><Select value={shot.drama?.sceneId ?? ''} disabled={!editable || shot.locked} onChange={event => updateDrama({ sceneId: event.target.value || undefined })}><option value="">未关联场次</option>{episode.scenes.map(scene => <option key={scene.id} value={scene.id}>{scene.title}</option>)}</Select></Field></div>
        {shot.locked && <Notice>此镜头已锁定，请先在工作台解锁后编辑。</Notice>}
        <Field label="镜头画面"><textarea rows={3} maxLength={20000} value={shot.visualPrompt} disabled={!editable || shot.locked} onChange={event => updateShot({ visualPrompt: event.target.value })} /></Field>
        <CharacterPicker label="画面出镜角色" value={shot.characterIds} version={version} disabled={!editable || shot.locked} onChange={characterIds => updateShot({ characterIds, drama: { appearances: (shot.drama?.appearances ?? []).filter(binding => characterIds.includes(binding.characterId)), lines: shot.drama?.lines ?? [], sceneId: shot.drama?.sceneId } })} />
        {characters.filter(character => shot.characterIds?.includes(character.id) && character.appearances?.length).map(character => <Field key={character.id} label={`形象：${character.name}`}><Select value={shot.drama?.appearances.find(binding => binding.characterId === character.id)?.appearanceId ?? ''} disabled={!editable || shot.locked} onChange={event => {
          const appearances = (shot.drama?.appearances ?? []).filter(binding => binding.characterId !== character.id);
          if (event.target.value) appearances.push({ characterId: character.id, appearanceId: event.target.value }); updateDrama({ appearances });
        }}><option value="">使用角色默认参考</option>{character.appearances?.map(appearance => <option key={appearance.id} value={appearance.id}>{appearance.name}</option>)}</Select></Field>)}
        {(library.error || selected.error || voices.error || selectedVoices.error) && <Notice kind="error">{library.error || selected.error || voices.error || selectedVoices.error}<Button onClick={() => { library.refresh(); voices.refresh(); void selected.refresh(); void selectedVoices.refresh(); }}>重试读取角色与音色</Button></Notice>}
        {(library.nextCursor !== null || voices.nextCursor !== null) && <div className="heading-actions">{library.nextCursor !== null && <Button busy={library.loadingMore} onClick={() => void library.loadMore()}>加载更多说话角色</Button>}{voices.nextCursor !== null && <Button busy={voices.loadingMore} onClick={() => void voices.loadMore()}>加载更多台词音色</Button>}</div>}
        <div className="drama-section__heading"><h3>对白与旁白</h3><Button disabled={!editable || shot.locked || (shot.drama?.lines.length ?? 0) >= 200} onClick={() => updateDrama({ lines: [...(shot.drama?.lines ?? []), { id: crypto.randomUUID(), kind: episode.narrativeMode === 'narration' ? 'narration' : 'dialogue', text: '' }] })}><Plus size={15} aria-hidden="true" />添加台词</Button></div>
        <div className="drama-lines">{shot.drama?.lines.map((line, index) => <fieldset className="drama-line capability-fieldset" key={line.id}><legend>台词 {index + 1}</legend>
          <div className="drama-form-grid"><Field label="台词类型"><Select value={line.kind} disabled={!editable || shot.locked} onChange={event => updateLine(line.id, { kind: event.target.value as DramaLine['kind'] })}>{Object.entries(dramaLineKindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field><Field label="说话角色" required={line.kind === 'dialogue'}><Select required={line.kind === 'dialogue'} value={line.speakerId ?? ''} disabled={!editable || shot.locked} onChange={event => updateLine(line.id, { speakerId: event.target.value || undefined })}><option value="">{line.kind === 'narration' ? '旁白讲述者' : '选择说话角色'}</option>{line.speakerId && !characters.some(value => value.id === line.speakerId) && <option value={line.speakerId}>已选角色（尚未读取）</option>}{characters.map(character => <option key={character.id} value={character.id}>{character.name}{character.archived ? '（已归档）' : ''}</option>)}</Select></Field></div>
          <Field label="台词正文" required><textarea required rows={2} maxLength={10000} value={line.text} disabled={!editable || shot.locked} onChange={event => updateLine(line.id, { text: event.target.value })} /></Field>
          <div className="drama-form-grid"><Field label="台词音色"><Select value={line.voiceId ?? ''} disabled={!editable || shot.locked} onChange={event => updateLine(line.id, { voiceId: event.target.value || undefined })}><option value="">{line.speakerId ? '使用角色默认音色' : '使用默认声音要求'}</option>{line.voiceId && !voiceOptions.some(value => value.id === line.voiceId) && <option value={line.voiceId}>已选音色（尚未读取）</option>}{voiceOptions.map(voice => <option key={voice.id} value={voice.id}>{voice.name}{voice.archived ? '（已归档）' : ''}</option>)}</Select></Field><Field label="句后停顿（秒）"><input type="number" min={0} max={60} step={0.1} value={(line.pauseAfterUs ?? 0) / 1_000_000} disabled={!editable || shot.locked} onChange={event => updateLine(line.id, { pauseAfterUs: Math.round(Number(event.target.value) * 1_000_000) })} /></Field></div>
          <Field label="表演与情绪"><input maxLength={1000} value={line.emotion ?? ''} disabled={!editable || shot.locked} onChange={event => updateLine(line.id, { emotion: event.target.value })} /></Field>
          <div className="heading-actions"><IconButton label={`台词 ${index + 1} 上移`} disabled={!editable || shot.locked || index === 0} onClick={() => moveLine(index, -1)}><ArrowUp size={15} aria-hidden="true" /></IconButton><IconButton label={`台词 ${index + 1} 下移`} disabled={!editable || shot.locked || index === (shot.drama?.lines.length ?? 0) - 1} onClick={() => moveLine(index, 1)}><ArrowDown size={15} aria-hidden="true" /></IconButton><Button disabled={!editable || shot.locked} onClick={() => updateDrama({ lines: shot.drama?.lines.filter(value => value.id !== line.id) ?? [] })}><Trash2 size={15} aria-hidden="true" />移除台词</Button></div>
        </fieldset>)}</div>
      </div>}
    </section>
    {failure && <Notice kind="error">{failure}</Notice>}
  </div><div className="dialog__footer"><Button disabled={busy} onClick={onClose}>取消</Button><Button type="submit" variant="primary" busy={busy} disabled={disabled}>保存短剧内容</Button></div></form></Dialog>;
}
