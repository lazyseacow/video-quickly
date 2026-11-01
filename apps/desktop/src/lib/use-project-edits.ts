import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ProjectDocument } from '@video-quickly/contracts';
import { ProjectEditSession, type SavedEdits } from './project-edits';
import { loadDraft, saveDraft } from './draft-storage';

type DraftWrite = { key: string; session: ProjectEditSession; snapshot: SavedEdits; promise: Promise<void>; status: 'pending' | 'succeeded' | 'failed' };
function sameDraftSnapshot(previous: SavedEdits, next: SavedEdits) {
  // Match the fields persisted by saveDraft. Session-only flags do not change a draft.
  return previous.version === next.version && previous.projectId === next.projectId && previous.revision === next.revision &&
    previous.base === next.base && previous.present === next.present && previous.undo === next.undo && previous.redo === next.redo && previous.selectedShotId === next.selectedShotId;
}

export function useProjectEdits(project: ProjectDocument, workspaceDirectory: string) {
  const [session, setSession] = useState(() => new ProjectEditSession(project));
  const [ready, setReady] = useState(false);
  const [persistenceReady, setPersistenceReady] = useState(false);
  const [storageError, setStorageError] = useState('');
  const restoredKey = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const storageWrite = useRef(0);
  const latestDraftWrite = useRef<DraftWrite | undefined>(undefined);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const key = `${workspaceDirectory}:${project.id}`;
  const storageOwner = useRef({ key, session }); storageOwner.current = { key, session };
  const reportStorage = useCallback((write: number, message: string) => {
    if (mounted.current && write === storageWrite.current && storageOwner.current.key === key && storageOwner.current.session === session) setStorageError(message);
  }, [key, session]);
  const persistDraft = useCallback((retryFailed = false) => {
    const snapshot = session.getSnapshot(), previous = latestDraftWrite.current;
    if (previous?.key === key && previous.session === session && sameDraftSnapshot(previous.snapshot, snapshot) && (!retryFailed || previous.status !== 'failed')) return previous.promise;
    // Start changed snapshots immediately; ordering remains owned by native IDB transactions.
    const promise = saveDraft(key, snapshot);
    const write: DraftWrite = { key, session, snapshot, promise, status: 'pending' };
    latestDraftWrite.current = write;
    void promise.then(
      () => { if (latestDraftWrite.current === write) write.status = 'succeeded'; },
      () => { if (latestDraftWrite.current === write) write.status = 'failed'; },
    );
    return promise;
  }, [key, session]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (restoredKey.current === key) return;
    let active = true;
    void loadDraft(key).then(saved => { if (active) { restoredKey.current = key; setSession(new ProjectEditSession(project, saved)); setPersistenceReady(true); } })
      .catch(error => { if (active) setStorageError(`草稿恢复失败：${error instanceof Error ? error.message : String(error)}`); })
      .finally(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, [key]);
  useEffect(() => { if (ready) session.receive(project); }, [ready, session, project]);
  useEffect(() => {
    if (!ready || !persistenceReady) return;
    let active = true;
    const persist = () => {
      // Capture publications in session order, rather than a later render's
      // effect. Native IDB transactions retain this order across remounts.
      const write = ++storageWrite.current;
      void persistDraft().then(() => { if (active) reportStorage(write, ''); })
        .catch(error => { if (active) reportStorage(write, `草稿尚未写入本机：${error instanceof Error ? error.message : String(error)}`); });
    };
    persist();
    const unsubscribe = session.subscribe(persist);
    return () => { active = false; unsubscribe(); };
  }, [ready, persistenceReady, persistDraft, reportStorage, session]);
  const checkpoint = useCallback(async () => {
    // Failed recovery must not overwrite an unread draft. Project saving is
    // still available when this local recovery boundary is unavailable.
    if (!persistenceReady) return false;
    const write = ++storageWrite.current;
    try {
      await persistDraft(true);
      reportStorage(write, '');
      return true;
    } catch (error) {
      reportStorage(write, `草稿尚未写入本机：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }, [persistenceReady, persistDraft, reportStorage]);
  return { session, state, ready, storageError, canPersistDraft: persistenceReady, checkpoint };
}
