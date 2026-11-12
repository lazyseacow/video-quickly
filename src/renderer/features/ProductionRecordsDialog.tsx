import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { productionSettingsSchema, resolveProductionWorkflow, type WorkflowDefinition, type WorkflowStage } from '@video-quickly/contracts';
import { Dialog } from '../components/Primitives';
import SettingsSections from '../components/SettingsSections';
import ToastNotice, { type ToastMessage } from '../components/ToastNotice';
import type { PlanningControls } from '../lib/planning-edits';
import type { StepOutputSelection } from '../lib/types';
import '../components/production-settings.css';

const StageRunView = lazy(() => import('./StageRunView'));

interface ProductionRecordsDialogProps {
  workflow: WorkflowDefinition;
  runId?: string;
  version: number;
  initialStage: string;
  initialNodeId?: string;
  flatRecords?: boolean;
  recordStages?: WorkflowStage[];
  planning?: PlanningControls;
  onClose: () => void;
  onOpenOutput: (selection: StepOutputSelection) => void;
}

export default function ProductionRecordsDialog({ workflow, runId, version, initialStage, initialNodeId, flatRecords, recordStages, planning, onClose, onOpenOutput }: ProductionRecordsDialogProps) {
  // Keep the configured task defaults from opening the dialog. StageRunView
  // reads the recorded stages and steps from the run snapshot.
  const [configuration] = useState(() => ({ nodes: workflow.nodes, production: productionSettingsSchema.parse(workflow.production) }));
  const [runStage, setRunStage] = useState(initialStage);
  const [runActionsTarget, setRunActionsTarget] = useState<HTMLDivElement | null>(null);
  const [notice, setNotice] = useState<ToastMessage>();
  const noticeState = useRef({ id: 0, text: '' });
  const showNotice = useCallback((text: string) => {
    if (noticeState.current.text === text) return;
    noticeState.current = { id: noticeState.current.id + 1, text };
    setNotice(text ? noticeState.current : undefined);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(current => current === notice ? undefined : current), 2000);
    return () => clearTimeout(timer);
  }, [notice]);

  const { nodes, stages: workflowStages } = resolveProductionWorkflow({ ...workflow, ...configuration });
  const flat = flatRecords ?? workflow.id === 'native-video';
  const stages = recordStages ?? workflowStages ?? nodes.map(node => ({ id: node.id, label: node.label, description: node.description, nodeIds: [node.id] }));
  const selectedStage = stages.find(stage => stage.id === runStage) ?? stages[0];
  const runView = { runId, version, initialNodeId, planning, actionsTarget: runActionsTarget, onNotice: showNotice, onOpenOutput };
  const loading = <p role="status">正在读取本次制作…</p>;

  return <Dialog title="本次制作" onClose={onClose} className="settings-dialog production-settings-dialog production-results-dialog">
    <div className="dialog__body">
      <div className="production-settings__run">
        {flat ? <Suspense fallback={loading}>
          <StageRunView {...runView} flat nodes={nodes} nodeIds={nodes.map(node => node.id)} configurableNodeIds={[]} />
        </Suspense> : <SettingsSections label="制作阶段记录" layout="tabs" value={runStage} onValueChange={setRunStage} sections={stages.map(stage => ({
          id: stage.id,
          label: stage.label,
          content: stage.id === selectedStage?.id ? <Suspense fallback={loading}>
            <StageRunView {...runView} stageId={stage.id} nodeIds={stage.nodeIds} configurableNodeIds={[]} />
          </Suspense> : null,
        }))} />}
      </div>
    </div>
    <div className="dialog__footer"><div ref={setRunActionsTarget} className="production-settings__record-actions" /></div>
    <ToastNotice toast={notice} onDismiss={() => setNotice(undefined)} />
  </Dialog>;
}
