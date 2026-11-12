import { timeAtFrame, workflowNodeSchema, type ProductionSettings, type ProjectDocument, type WorkflowNode } from '@video-quickly/contracts';
import { createTransitionTimeline } from '@video-quickly/video';
import type { AgentBusinessTools, AgentTransitionEdit } from './agent.js';

export function legacyVideoAgentNode(project: ProjectDocument): WorkflowNode {
  return workflowNodeSchema.parse({ id: 'video-agent', kind: 'agent', label: '视频 Agent', modelId: project.workflow.production.textModelId,
    skillIds: project.workflow.production.agentSkillIds,
    prompt: '根据创作要求自主完成视频制作。先发现允许使用的 Skill 和 MCP，按任务读取相关 Skill；需要外部资料或素材时调用工具。通过 execute_video_task 完成简报、风格、完整分镜、必要的参考图、每个镜头视频、剪辑和导出。已有合适产物可以复用。每次调用后检查实际结果，必要时调整要求或重新生成；重复恢复使用相同 requestId，有意重新生成使用新 requestId。先读取最新项目取得真实镜头编号，不编造编号、素材或已完成的操作。只有导出工具实际成功后才报告制作完成。',
    config: { requiresModel: true, videoAgent: true, mcpServerIds: project.workflow.production.agentMcpServerIds },
  });
}

export function videoEditingAgentNode(step: WorkflowNode, modelId: string, { agentSkillIds, agentMcpServerIds }: Pick<ProductionSettings, 'agentSkillIds' | 'agentMcpServerIds'>): WorkflowNode {
  const { operation: _localOperation, ...config } = step.config;
  return { ...step, kind: 'agent', modelId, skillIds: agentSkillIds,
    description: '按需使用 Skill 和工具补充镜头素材，准备时间轴、运镜与转场。',
    prompt: [step.prompt, '当前任务是剪辑与运镜准备。读取本次分镜、已生成素材和声音要求，根据创作要求判断哪些镜头需要补充素材或调整剪辑。按需使用相关 Skill 和 MCP 工具，优先使用已经准备好的素材。仅在明确需要修正时，才重新生成指定镜头的图片或视频。通过 execute_video_task 导入素材和应用剪辑，保留锁定镜头。',
      '先完成会改变镜头时长的素材处理。用 read_project_snapshot 获取最新镜头 ID，通过 edit 裁剪、拆分、重排，设置背景音乐、字幕、关键帧或转场。拆分后使用回执中的新镜头 ID。背景音乐先用 list_audio_assets 查找可用素材。需要在成片显示字幕时，检查制作设置中的字幕开关，可通过 timeline.subtitleMode 开启。转场用 fromShotId、toShotId 和 type 指定，顺序以本次重排后的成片为准。根据 result.appliedEdits 和 result.appliedTransitions 简要总结实际应用的结果。接下来的流程会自动导出。',
    ].filter(Boolean).join('\n\n'),
    config: { ...config, requiresModel: true, mcpServerIds: agentMcpServerIds, boundaryTransitions: true, timelineEdits: true },
  };
}

export function applyAgentTransitions(project: ProjectDocument, transitions: readonly AgentTransitionEdit[], durations?: ReadonlyMap<string, number>) {
  const byIncoming = new Map<string, AgentTransitionEdit['type']>();
  for (const { toShotId, type } of transitions) {
    if (byIncoming.has(toShotId)) throw new Error(`入场镜头 ${toShotId} 在同一剪辑请求中只能指定一次转场。`);
    byIncoming.set(toShotId, type);
  }
  const shots = project.shots.map(shot => {
    const transition = byIncoming.get(shot.id);
    if (!transition) return shot;
    if (shot.locked) throw new Error(`入场镜头 ${shot.id} 已锁定，请先解锁再调整转场。`);
    return { ...shot, animation: { ...shot.animation, transition } };
  });
  const editedProject = { ...project, shots };
  const timedShots = shots.map(shot => ({ animation: shot.animation, durationUs: durations?.get(shot.id) ?? shot.durationUs }));
  const { rate, clips } = createTransitionTimeline(timedShots, project.profile.frameRate);
  const clipIndices = new Map(clips.map((clip, index) => [shots[clip.index].id, index]));
  const appliedTransitions = transitions.map(({ fromShotId, toShotId }) => {
    const index = clipIndices.get(toShotId);
    if (index === undefined || index === 0 || shots[clips[index - 1].index].id !== fromShotId) {
      throw new Error(`请选择成片顺序中都有输出帧的相邻镜头（${fromShotId} → ${toShotId}）。`);
    }
    const outgoing = clips[index - 1], incoming = clips[index];
    const startFrame = incoming.firstFrame;
    const endFrameExclusive = startFrame + Math.min(outgoing.padFrames, incoming.frameCount);
    const startUs = timeAtFrame(startFrame, rate);
    return { fromShotId, toShotId, type: endFrameExclusive > startFrame ? incoming.transition : 'cut',
      startFrame, endFrameExclusive, startUs, durationUs: timeAtFrame(endFrameExclusive, rate) - startUs };
  });
  return { editedProject, appliedTransitions };
}

type VideoOperation = Parameters<AgentBusinessTools['execute']>[0]['operation'];

function videoTaskTemplate(project: ProjectDocument, operation: VideoOperation) {
  const kind = operation === 'image' ? 'assets' : operation === 'video' || operation === 'edit' ? 'animation' : operation;
  const template = project.workflow.nodes.find(node => node.kind === kind && (operation === 'edit' ? node.config.operation === 'prepare-edit' : operation !== 'video' || node.config.operation !== 'prepare-edit'));
  return { kind, template };
}

export function videoTaskNode(project: ProjectDocument, parent: WorkflowNode, input: Parameters<AgentBusinessTools['execute']>[0]): WorkflowNode {
  const { kind, template } = videoTaskTemplate(project, input.operation);
  const settings = project.workflow.production;
  const modelId = input.modelId ?? template?.modelId ?? (['brief', 'style', 'script'].includes(input.operation) ? settings.textModelId ?? parent.modelId : input.operation === 'image' ? settings.imageModelId : input.operation === 'video' ? settings.videoModelId : undefined);
  return workflowNodeSchema.parse({ ...template, id: `${parent.id}/tool/${input.requestId}`, kind: input.operation === 'import' ? 'assets' : kind,
    label: input.operation === 'import' ? '导入工具素材' : template?.label ?? input.operation,
    prompt: [template?.prompt, input.instruction].filter(Boolean).join('\n\n'), modelId: ['edit', 'export', 'import'].includes(input.operation) ? undefined : modelId,
    skillIds: input.skillIds ?? (template?.skillIds ?? []).filter(id => !parent.skillIds.length || parent.skillIds.includes(id)), requiresReview: false,
    config: { ...template?.config, agentTask: true, ...(input.shotId ? { shotId: input.shotId } : {}),
      ...(['brief', 'style', 'script'].includes(input.operation) ? { requiresModel: true } : {}),
      ...(input.operation === 'image' ? { operation: 'prepare-references', referenceMode: 'generate', requiresModel: true } : {}),
      ...(input.operation === 'video' ? { operation: 'generate-native-video', requiresModel: true } : {}),
      ...(input.operation === 'edit' ? { operation: 'prepare-edit', requiresModel: false } : {}),
      ...(input.operation === 'import' || input.operation === 'export' ? { requiresModel: false } : {}),
    },
  });
}
