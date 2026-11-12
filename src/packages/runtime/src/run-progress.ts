import type { MediaDiagnosticEvent } from '@video-quickly/integrations';
import type { AssetRecord, GenerationShotProgress, ProjectDocument, RunStepProgress, RunStepProgressDetail, StoryboardPart } from '@video-quickly/contracts';
import { DocumentStore } from './database.js';

interface RecordedProgress extends RunStepProgress { shots: GenerationShotProgress[] }
const activeStates = new Set(['queued', 'preparing', 'submitting', 'waiting', 'generating', 'downloading', 'validating']);

/** Read-only feedback. Execution and recovery continue to use their original receipts. */
export function createRunProgress(store: DocumentStore, changed: () => void = () => {}) {
  function save(id: string, value: RecordedProgress) { store.put('run-step-progress', id, value); changed(); }
  function read(id: string) { return store.get<RecordedProgress>('run-step-progress', id); }
  function summary(id: string): RunStepProgress | undefined {
    const progress = read(id);
    if (!progress) return;
    const { shots, ...value } = progress;
    return shots.length ? { ...value, total: shots.length, completed: shots.filter(shot => shot.status === 'completed').length } : value;
  }
  function detail(id: string): RunStepProgressDetail | undefined {
    const progress = read(id), value = summary(id);
    if (!progress || !value) return;
    const ids = new Set(progress.shots.flatMap(shot => [shot.assetId, shot.referenceAssetId]).filter((id): id is string => Boolean(id)));
    const assets = [...ids].map(id => store.get<AssetRecord>('asset', id)).filter((asset): asset is AssetRecord => Boolean(asset?.active));
    return { ...value, shots: progress.shots, assets };
  }
  function begin(id: string, project: ProjectDocument, kind: 'image' | 'video' | undefined, assets: AssetRecord[]) {
    const previous = read(id), timestamp = new Date().toISOString();
    const shots: GenerationShotProgress[] = kind ? project.shots.map(shot => {
      const saved = previous?.shots.find(item => item.id === shot.id);
      const reference = kind === 'video' ? assets.find(asset => asset.id === shot.assetId && asset.kind === 'image' && asset.active)
        ?? assets.find(asset => asset.shotId === shot.id && asset.kind === 'image' && asset.active) : undefined;
      return { id: shot.id, title: shot.title, durationUs: shot.durationUs, status: saved?.status === 'completed' ? 'completed' : 'pending',
        assetId: saved?.status === 'completed' ? saved.assetId : undefined, referenceAssetId: reference?.id, updatedAt: timestamp };
    }) : [];
    save(id, { phase: kind ? 'generating' : 'preparing', startedAt: previous && !previous.endedAt ? previous.startedAt : timestamp, updatedAt: timestamp, shots,
      ...(previous?.storyboard ? { storyboard: previous.storyboard, completed: previous.completed, total: previous.total } : {}) });
  }
  function storyboard(id: string, part: StoryboardPart, completed?: number, total?: number) {
    const current = read(id);
    if (!current || current.endedAt) return;
    save(id, { ...current, storyboard: part, completed, total, updatedAt: new Date().toISOString() });
  }
  function phase(id: string, phase: RunStepProgress['phase'], confirmed = false, fraction?: number) {
    if (fraction !== undefined && !Number.isFinite(fraction)) return;
    const current = read(id);
    if (!current || current.endedAt) return;
    const timestamp = new Date().toISOString();
    const value = fraction === undefined ? current.fraction : Math.max(current.fraction ?? 0, Math.min(1, Math.max(0, fraction)));
    if (fraction !== undefined && value !== undefined && value < 1 && current.phase === phase && Date.now() - Date.parse(current.updatedAt) < 250) return;
    if (current.phase === phase && current.fraction === value && (!confirmed || current.lastConfirmedAt && Date.now() - Date.parse(current.lastConfirmedAt) < 5000)) return;
    save(id, { ...current, phase, fraction: value, updatedAt: timestamp, ...(confirmed ? { lastConfirmedAt: timestamp } : {}) });
  }
  function media(id: string, event: MediaDiagnosticEvent) {
    const current = read(id);
    if (!current || current.endedAt || !event.shotId) return;
    const shot = current.shots.find(shot => shot.id === event.shotId);
    if (!shot) return;
    let status = shot.status;
    switch (event.event) {
      case 'media.queued': status = 'queued'; break;
      case 'media.started': status = 'preparing'; break;
      case 'media.request_started': if (event.phase === 'submit') status = 'submitting'; break;
      case 'media.request_completed': if (status === 'submitting') status = 'waiting'; break;
      case 'media.status_received': status = event.remoteStatus ?? 'waiting'; break;
      case 'media.download_started': status = 'downloading'; break;
      case 'media.validation_started': status = 'validating'; break;
      case 'media.completed': case 'media.reused': status = 'completed'; break;
      case 'media.failed': status = 'interrupted'; break;
      case 'media.canceled': status = 'canceled'; break;
      default: return;
    }
    const confirmed = event.event === 'media.request_completed' || event.event === 'media.status_received';
    const timestamp = new Date().toISOString(), assetId = event.assetId ?? shot.assetId;
    if (shot.status === status && shot.assetId === assetId && (!confirmed || current.lastConfirmedAt && Date.now() - Date.parse(current.lastConfirmedAt) < 5000)) return;
    save(id, { ...current, updatedAt: timestamp, ...(confirmed ? { lastConfirmedAt: timestamp } : {}),
      shots: current.shots.map(item => item.id === shot.id ? { ...item, status, assetId, updatedAt: timestamp } : item) });
  }
  function asset(id: string, asset: AssetRecord) {
    const current = read(id);
    if (!current || !current.shots.some(shot => shot.id === asset.shotId)) return;
    store.put('asset', asset.id, asset);
  }
  function end(id: string, outcome: 'completed' | 'interrupted' | 'canceled') {
    const current = read(id);
    if (!current || current.endedAt) return;
    const timestamp = new Date().toISOString();
    save(id, { ...current, ...(outcome === 'completed' ? { phase: 'completed' as const } : {}), updatedAt: timestamp, endedAt: timestamp,
      shots: current.shots.map(shot => outcome !== 'completed' && activeStates.has(shot.status) ? { ...shot, status: outcome, updatedAt: timestamp } : shot) });
  }
  return { begin, storyboard, phase, media, asset, end, summary, detail };
}
