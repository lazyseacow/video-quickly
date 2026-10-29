import type { AssetRecord, RunSummary, WorkspaceSummary } from '@video-quickly/contracts';

export type Action = <T = unknown>(method: string, params?: unknown, message?: string) => Promise<T | null>;
export type WorkspaceView = WorkspaceSummary & { assets: AssetRecord[]; runs: RunSummary[] };
