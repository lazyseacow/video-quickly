import type { AssetRecord, CharacterProfile, ImageEditInput, ModelProfile, ProjectDocument, PromptPreview, RunSelection, Shot, ShotCandidateKind, SkillPackage, WorkflowAssistantContext, WorkflowDefinition, WorkflowNode } from '@video-quickly/contracts';
import type { McpServer } from './mcp.js';
import type { WorkflowUpstreamResult } from './workflow-prompts.js';
import type { WorkflowOutputVersion } from './workflow-outputs.js';

// Existing media checkpoints use the scheduling width frozen at creation.
export type FrozenProjectDocument = ProjectDocument & { workflow: { execution?: { maxConcurrentShots: number } } };

export interface RunSnapshot {
  project: FrozenProjectDocument;
  models: ModelProfile[];
  skills: SkillPackage[];
  automaticSkillIds?: string[];
  autonomousVideo?: boolean;
  videoEditingAgentId?: string;
  mcpServers: McpServer[];
  nodes: WorkflowNode[];
  handlerVersion: number;
  outputContractVersion?: WorkflowOutputVersion;
  storyboardBatchSize?: number;
  unifiedShotProfile?: true;
  // In-progress runs continue with the reference strategy selected when they started.
  useOriginalVideoReferences?: true;
  includeProjectOriginalText?: true;
  // Older storyboard receipts include the original prompt in their input hash.
  includeEpisodeOriginalText?: true;
  inspectionNodes?: WorkflowNode[];
  inspectionThreads?: Record<string, string>;
  inspectionEdges?: WorkflowDefinition['edges'];
  regeneration?: { shotId: string; kind: ShotCandidateKind; baseline: Shot; instruction?: string; imageEdit?: ImageEditInput };
  assistant?: WorkflowAssistantContext;
  characters?: CharacterProfile[];
  characterAssets?: AssetRecord[];
  assets?: AssetRecord[];
  exportBatch?: { batchId: string; targetId: string };
  research?: { sourceIds?: string[]; instruction?: string };
  selection?: RunSelection;
  trial?: { inputProject: ProjectDocument; upstream: WorkflowUpstreamResult[]; preview: PromptPreview };
  sourceGeneration?: { inputProject: ProjectDocument; upstream: WorkflowUpstreamResult[]; requestHash: string };
}
