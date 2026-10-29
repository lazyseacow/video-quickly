import { savedEditsSchema, type SavedEdits } from './project-edits';

let connection: Promise<IDBDatabase> | undefined;
function database() {
  return connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('video-quickly-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('projects');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { connection = undefined; reject(request.error); };
    request.onblocked = () => { connection = undefined; reject(new Error('草稿存储升级被其他窗口阻塞，请关闭旧窗口后重试。')); };
  });
}
export async function loadDraft(key: string): Promise<SavedEdits | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction('projects').objectStore('projects').get(key);
    request.onsuccess = () => {
      if (request.result === undefined) { resolve(undefined); return; }
      const parsed = savedEditsSchema.safeParse(request.result);
      if (parsed.success) resolve(parsed.data);
      else reject(new Error('本地草稿格式无效，未自动恢复。'));
    };
    request.onerror = () => reject(request.error);
  });
}
export async function saveDraft(key: string, state: SavedEdits) {
  const db = await database();
  // Store only the versioned document and delta commands, without runtime or UI state.
  const { version, projectId, revision, base, present, undo, redo, selectedShotId } = state;
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('projects', 'readwrite');
    transaction.objectStore('projects').put({ version, projectId, revision, base, present, undo, redo, selectedShotId }, key);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('草稿未能写入本机存储。'));
    transaction.onerror = () => reject(transaction.error);
  });
}
