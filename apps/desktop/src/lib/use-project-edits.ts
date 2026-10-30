import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ProjectDocument } from '@video-quickly/contracts';
import { ProjectEditSession } from './project-edits';
import { loadDraft, saveDraft } from './draft-storage';

export function useProjectEdits(project: ProjectDocument, workspaceDirectory: string) {
  const [session, setSession] = useState(() => new ProjectEditSession(project));
  const [ready, setReady] = useState(false);
  const [persistenceReady, setPersistenceReady] = useState(false);
  const [storageError, setStorageError] = useState('');
  const restoredKey = useRef<string | undefined>(undefined);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const key = `${workspaceDirectory}:${project.id}`;
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
    void saveDraft(key, state).then(() => { if (active) setStorageError(''); })
      .catch(error => { if (active) setStorageError(`草稿尚未写入本机：${error instanceof Error ? error.message : String(error)}`); });
    return () => { active = false; };
  }, [key, ready, persistenceReady, state]);
  return { session, state, ready, storageError };
}
