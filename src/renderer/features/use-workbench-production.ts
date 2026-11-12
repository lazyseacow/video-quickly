import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isRunActive, projectReadinessSchema, type ProjectReadiness, type ReadinessIssue, type WorkflowNode } from '@video-quickly/contracts';
import { rpc } from '../lib/client';
import { beginGuideAction } from '../lib/guide-actions';
import type { ProjectEditSession } from '../lib/project-edits';
import type { Action, WorkspaceView } from '../lib/types';
import type { useStageConfigurationDraft } from '../lib/use-stage-configuration-draft';
import { matchingStepModels, stepGuidance } from '../lib/workflow-guidance';

interface WorkbenchProductionOptions {
  projectId: string;
  workspace: Pick<WorkspaceView, 'models' | 'runs'>;
  session: Pick<ProjectEditSession, 'state' | 'edit' | 'dirty'>;
  stageConfiguration: Pick<ReturnType<typeof useStageConfigurationDraft>, 'ready' | 'pending' | 'projectSettings' | 'workflow' | 'clear'>;
  configurationError: string;
  isConfigurationSaving: () => boolean;
  save: () => Promise<boolean>;
  pausePreview: () => void;
  readinessDialog?: 'manual' | ProjectReadiness;
  onReadinessBlocked: (report: ProjectReadiness) => void;
  action: Action;
  notify: (message: string, error?: boolean) => void;
}

interface StartReadinessRequest {
  id: string;
  isInspecting: boolean;
  canceled: boolean;
}

export function useWorkbenchProduction({
  projectId, workspace, session, stageConfiguration, configurationError, isConfigurationSaving, save,
  pausePreview, readinessDialog, onReadinessBlocked, action, notify,
}: WorkbenchProductionOptions) {
  const activeProductionRun = workspace.runs.find(run => run.projectId === projectId && isRunActive(run.status));
  const isProductionActive = Boolean(activeProductionRun);
  const [pendingProductionAction, setPendingProductionAction] = useState<'checking' | 'starting' | 'stopping'>();
  const productionInFlight = useRef(false);
  const productionTriggerButton = useRef<HTMLButtonElement | null>(null);
  const startReadinessRequest = useRef<StartReadinessRequest | undefined>(undefined);
  const productionLabel = isProductionActive ? '停止' : pendingProductionAction === 'checking' ? '正在检查' : '开始制作';

  useLayoutEffect(() => () => {
    const request = startReadinessRequest.current;
    if (!request) return;
    request.canceled = true;
    if (request.isInspecting) void rpc('project.readiness.cancel', { projectId, requestId: request.id })
      .catch(() => notify('停止本地检查尚未确认；执行器断开时会清理检查任务。', true));
  }, [projectId, notify]);

  useEffect(() => {
    if (pendingProductionAction || readinessDialog && readinessDialog !== 'manual') return;
    const trigger = productionTriggerButton.current;
    productionTriggerButton.current = null;
    // Disabling clears native focus; keep any deliberate move to another control.
    if (trigger?.isConnected && !trigger.disabled && document.activeElement === document.body) trigger.focus({ preventScroll: true });
  }, [pendingProductionAction, readinessDialog]);

  async function startProduction() {
    if (productionInFlight.current || isProductionActive) return false;
    if (isConfigurationSaving()) {
      notify('正在保存制作设置，请稍后开始制作。', true);
      return false;
    }
    productionInFlight.current = true;
    setPendingProductionAction('starting');
    const request: StartReadinessRequest = { id: crypto.randomUUID(), isInspecting: false, canceled: false };
    startReadinessRequest.current = request;
    try {
      const completeGuideAction = beginGuideAction('production-started');
      if (!stageConfiguration.ready || configurationError) {
        notify(configurationError || '正在恢复待用配置，请稍后重试。', true);
        return false;
      }
      if (stageConfiguration.pending) {
        session.edit({ ...session.state.present, ...stageConfiguration.projectSettings, workflow: stageConfiguration.workflow }, '使用待用制作配置');
      }
      if (!await save()) return false;
      if (stageConfiguration.pending) await stageConfiguration.clear();

      const savedProjectRevision = session.state.revision;
      if (request.canceled) return false;
      setPendingProductionAction('checking');
      request.isInspecting = true;
      const report = projectReadinessSchema.parse(await rpc('project.readiness', { projectId, requestId: request.id }));
      request.isInspecting = false;
      if (request.canceled) return false;
      if (report.projectId !== projectId || report.projectRevision !== savedProjectRevision || session.state.revision !== savedProjectRevision || session.dirty) {
        notify('检查期间项目内容已变化，请再次点击开始制作。', true);
        return false;
      }
      if (!report.ready) {
        onReadinessBlocked({
          ...report,
          issues: report.issues.map(issue => resolveReadinessRepair(issue, session.state.present.workflow.nodes, workspace.models)),
        });
        return false;
      }

      setPendingProductionAction('starting');
      const startedRun = await action('run.start', { projectId, revision: savedProjectRevision }, '制作已开始');
      if (startedRun) completeGuideAction();
      return Boolean(startedRun);
    } catch (error) {
      if (!request.canceled) notify(error instanceof Error ? error.message : '制作尚未开始，请核对配置后重试。', true);
      return false;
    } finally {
      startReadinessRequest.current = undefined;
      productionInFlight.current = false;
      setPendingProductionAction(undefined);
    }
  }

  async function stopProduction() {
    if (productionInFlight.current || !activeProductionRun) return;
    productionInFlight.current = true;
    setPendingProductionAction('stopping');
    pausePreview();
    try {
      await action('run.cancel', { runId: activeProductionRun.id }, '已请求停止制作');
    } finally {
      productionInFlight.current = false;
      setPendingProductionAction(undefined);
    }
  }

  function toggleProduction(trigger: HTMLButtonElement) {
    productionTriggerButton.current = trigger;
    void (isProductionActive ? stopProduction() : startProduction());
  }

  return {
    isProductionActive, pendingProductionAction, productionLabel, toggleProduction,
    isProductionInFlight: () => productionInFlight.current,
  };
}

function resolveReadinessRepair(issue: ReadinessIssue, nodes: readonly WorkflowNode[], models: WorkspaceView['models']): ReadinessIssue {
  if (issue.category !== 'model' || issue.fix !== 'step') return issue;
  const step = nodes.find(node => node.id === issue.nodeId);
  if (!step || !stepGuidance(step).capability || matchingStepModels(step, models).length) return issue;
  return { ...issue, fix: 'models', modelId: undefined };
}
