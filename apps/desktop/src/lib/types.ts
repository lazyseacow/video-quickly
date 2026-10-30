import type { AssetRecord, RunSummary, WorkspaceSummary, WorkflowNode } from '@video-quickly/contracts';

export type Action = <T = unknown>(method: string, params?: unknown, message?: string) => Promise<T | null>;
export type WorkspaceView = WorkspaceSummary & { assets: AssetRecord[]; runs: RunSummary[] };
export interface StepOutputSelection { projectId: string; runId: string; nodeId: string; kind: WorkflowNode['kind'] }
