import { createHistoryWorkflow, DEFAULT_VIDEO_PROFILE, projectSchema, type AssetRecord, type RunRecord } from '@video-quickly/contracts';
import { DocumentStore } from '../../packages/runtime/src/database';

export function seedLargeWorkspace(store: DocumentStore, shotCount: number, options = { assets: 1000, runs: 200, eventsPerRun: 100 }) {
  const timestamp = '2026-10-29T00:00:00.000Z';
  const project = projectSchema.parse({
    id: `benchmark-${shotCount}`, title: `${shotCount} 镜头基准`, brief: '隔离的按需读取与编辑基准。', revision: 1,
    profile: DEFAULT_VIDEO_PROFILE, workflow: createHistoryWorkflow(), createdAt: timestamp, updatedAt: timestamp,
    shots: Array.from({ length: shotCount }, (_, index) => ({ id: `shot-${index}`, title: `镜头 ${index + 1}`, narration: '这是可重复的长项目基准旁白。'.repeat(8), visualPrompt: '固定画面要求。'.repeat(8), durationUs: 3_000_000 })),
  });
  store.database.transaction(() => {
    store.put('project', project.id, project);
    for (let index = 0; index < options.assets; index++) {
      const asset: AssetRecord = { id: `${project.id}-asset-${index}`, projectId: project.id, name: `素材 ${index}`, kind: 'image', path: '/fixture/image.png', mimeType: 'image/png', size: 1024, sha256: '0'.repeat(64), version: 1, createdAt: timestamp, provenance: '基准夹具', retained: false, active: true };
      store.put('asset', asset.id, asset);
    }
    const event = store.database.prepare('INSERT INTO execution_events(run_id, type, body, created_at) VALUES (?, ?, ?, ?)');
    const activity = store.database.prepare("INSERT INTO activities(run_id, activity_id, input_hash, safety, status, result, started_at, completed_at) VALUES (?, 'brief', 'fixture', 'local', 'completed', ?, ?, ?)");
    for (let index = 0; index < options.runs; index++) {
      const run: RunRecord = { id: `${project.id}-run-${index}`, projectId: project.id, projectRevision: 1, workflowVersion: 1, snapshotDigest: 'fixture', status: 'succeeded', createdAt: timestamp, updatedAt: timestamp, events: [], activities: [] };
      store.put('run', run.id, run);
      activity.run(run.id, JSON.stringify({ text: '已保存的活动结果。'.repeat(100) }), timestamp, timestamp);
      for (let sequence = 0; sequence < options.eventsPerRun; sequence++) event.run(run.id, 'fixture', JSON.stringify({ message: `历史事件 ${sequence}` }), timestamp);
    }
  })();
  return project;
}
