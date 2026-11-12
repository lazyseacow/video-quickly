import type { AssetRecord, CharacterProfile, JsonValue, ModelProfile, PreparedAudioMix, ProjectDocument, SkillPackage, WorkflowNode } from '@video-quickly/contracts';

export interface MediaDiagnosticEvent {
  event: `media.${'queued' | 'started' | 'completed' | 'failed' | 'canceled' | 'reused' | 'receipt_loaded' | 'request_started' | 'request_completed' | 'request_failed' | 'status_received' | 'poll_started' | 'poll_completed' | 'poll_retry_scheduled' | 'poll_recovered' | 'download_started' | 'download_completed' | 'validation_started' | 'validation_completed' | 'render_started' | 'render_completed'}`;
  level: 'debug' | 'info' | 'warn' | 'error';
  phase?: 'queue' | 'generate' | 'submit' | 'poll' | 'download' | 'validate' | 'render';
  shotId?: string;
  assetId?: string;
  state?: 'prepared' | 'submitted' | 'download' | 'completed' | 'unknown' | 'rejected';
  durationMs?: number;
  queueMs?: number;
  byteSize?: number;
  statusCode?: number;
  pollCount?: number;
  retryCount?: number;
  retryDelayMs?: number;
  cached?: boolean;
  resumed?: boolean;
  hasRemoteId?: boolean;
  remoteStatus?: 'queued' | 'generating';
  error?: unknown;
}

export interface MediaActivityContext {
  skills?: SkillPackage[];
  project: ProjectDocument;
  node: WorkflowNode;
  runId: string;
  operationId: string;
  signal: AbortSignal;
  queueSignal?: AbortSignal;
  onFailure?: (error: unknown) => void;
  dataDirectory: string;
  assets: AssetRecord[];
  characters?: CharacterProfile[];
  promptOverride?: string;
  promptUpstream?: Record<string, JsonValue>;
  onProgress?: (value: number) => void;
  onAsset?: (asset: AssetRecord) => void;
  onDiagnostic?: (event: MediaDiagnosticEvent) => void;
  preparedAudioMix?: PreparedAudioMix;
  model?: ModelProfile;
  apiKey?: string;
  unifiedShotProfile?: boolean;
  legacyVideoReferences?: boolean;
  ffmpegPath?: string;
  ffprobePath?: string;
  remoteTaskId?: string;
  persistRemoteTask(id: string): void;
}
