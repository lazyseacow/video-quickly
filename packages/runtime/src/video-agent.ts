import { workflowNodeSchema, type ProjectDocument, type WorkflowNode } from '@video-quickly/contracts';
import type { AgentBusinessTools } from './agent.js';

export function videoAgentNode(project: ProjectDocument): WorkflowNode {
  return workflowNodeSchema.parse({ id: 'video-agent', kind: 'agent', label: '视频 Agent', modelId: project.workflow.production.textModelId,
    skillIds: project.workflow.production.agentSkillIds,
    prompt: '根据创作要求自主完成视频制作。先发现允许使用的 Skill 和 MCP，按任务读取相关 Skill；需要外部资料或素材时调用工具。通过 execute_video_task 完成简报、风格、完整分镜、必要的参考图、每个镜头视频、剪辑和导出。已有合适产物可以复用。每次调用后检查实际结果，必要时调整要求或重新生成；重复恢复使用相同 requestId，有意重新生成使用新 requestId。先读取最新项目取得真实镜头编号，不编造编号、素材或已完成的操作。只有导出工具实际成功后才报告制作完成。',
    config: { requiresModel: true, videoAgent: true, mcpServerIds: project.workflow.production.agentMcpServerIds },
  });
}

export function videoTaskNode(project: ProjectDocument, parent: WorkflowNode, input: Parameters<AgentBusinessTools['execute']>[0]): WorkflowNode {
  const kind = input.operation === 'image' ? 'assets' : input.operation === 'video' || input.operation === 'edit' ? 'animation' : input.operation;
  const template = project.workflow.nodes.find(node => node.kind === kind && (input.operation === 'edit' ? node.config.operation === 'prepare-edit' : input.operation !== 'video' || node.config.operation !== 'prepare-edit'));
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
