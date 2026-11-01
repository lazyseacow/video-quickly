import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ProjectDocument } from '@video-quickly/contracts';
import { ProjectEditSession } from './project-edits';
import { loadDraft, saveDraft } from './draft-storage';

export function useProjectEdits(project: ProjectDocument, workspaceDirectory: string) {
  const [session, setSession] = useState(() => new ProjectEditSession(project));
  const [ready, setReady] = useState(false);
  const [persistenceReady, setPersistenceReady] = useState(false);
  const [storageError, setStorageError] = useState('');
  const restoredKey = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const storageWrite = useRef(0);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const key = `${workspaceDirectory}:${project.id}`;
  const storageOwner = useRef({ key, session }); storageOwner.current = { key, session };
  const reportStorage = useCallback((write: number, message: string) => {
    if (mounted.current && write === storageWrite.current && storageOwner.current.key === key && storageOwner.current.session === session) setStorageError(message);
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
      void saveDraft(key, session.getSnapshot()).then(() => { if (active) reportStorage(write, ''); })
        .catch(error => { if (active) reportStorage(write, `草稿尚未写入本机：${error instanceof Error ? error.message : String(error)}`); });
    };
    persist();
    const unsubscribe = session.subscribe(persist);
    return () => { active = false; unsubscribe(); };
  }, [key, ready, persistenceReady, reportStorage, session]);
  const checkpoint = useCallback(async () => {
    // Failed recovery must not overwrite an unread draft. Project saving is
    // still available when this local recovery boundary is unavailable.
    if (!persistenceReady) return false;
    const write = ++storageWrite.current;
    try {
      await saveDraft(key, session.getSnapshot());
      reportStorage(write, '');
      return true;
    } catch (error) {
      reportStorage(write, `草稿尚未写入本机：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }, [key, persistenceReady, reportStorage, session]);
  return { session, state, ready, storageError, checkpoint };
}
