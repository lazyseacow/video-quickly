import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProductionSettings, WorkflowDefinition, WorkflowNode } from '@video-quickly/contracts';
import { loadStageConfigurationDraft, saveStageConfigurationDraft } from './draft-storage';
import { applyProductionProjectDraft, applyStageConfigurationDraft, updateProductionConfigurationDraft, updateStageConfigurationDraft, type ProductionProjectSettings, type StageConfigurationDraft } from './stage-configuration-draft';

export function useStageConfigurationDraft(projectId: string, workflow: WorkflowDefinition, directory: string, projectSettings?: ProductionProjectSettings) {
  const key = `${directory}:${projectId}:stage-configuration`;
  const [loaded, setLoaded] = useState<{ key: string; ready: boolean; draft?: StageConfigurationDraft; error: string }>({ key, ready: false, error: '' });
  const [attempt, setAttempt] = useState(0);
  const owner = useRef(key); owner.current = key;
  const currentWorkflow = useRef(workflow); currentWorkflow.current = workflow;
  const currentSettings = useRef(projectSettings); currentSettings.current = projectSettings;
  const currentDraft = useRef<StageConfigurationDraft | undefined>(undefined);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    let active = true;
    setLoaded({ key, ready: false, error: '' });
    void loadStageConfigurationDraft(key).then(draft => {
      if (!active || owner.current !== key) return;
      if (draft && draft.projectId !== projectId) throw new Error('待用配置不属于当前项目。');
      currentDraft.current = draft;
      setLoaded({ key, ready: true, draft, error: '' });
    }).catch(error => {
      if (active && owner.current === key) setLoaded({ key, ready: false, error: `待用配置恢复失败：${error instanceof Error ? error.message : String(error)}` });
    });
    return () => { active = false; };
  }, [key, projectId, attempt]);
  const ready = loaded.key === key && loaded.ready;
  const draft = ready ? loaded.draft : undefined;
  const applied = useMemo(() => applyStageConfigurationDraft(workflow, draft), [workflow, draft]);
  const projectDraft = projectSettings ? applyProductionProjectDraft(projectSettings, draft) : undefined;
  const write = useCallback((nodes?: WorkflowNode[], production?: ProductionSettings, settings?: ProductionProjectSettings, baseline?: ProductionProjectSettings, execution?: WorkflowDefinition['execution']) => {
    if (!ready) return Promise.reject(new Error('请先恢复待用配置后再保存。'));
    const operation = writes.current.then(async () => {
      if (owner.current !== key) throw new Error('项目已切换，未保存待用配置。');
      const next = nodes && production && settings && currentSettings.current ? updateProductionConfigurationDraft(projectId, currentDraft.current, currentWorkflow.current, nodes, production, baseline ?? currentSettings.current, settings, execution)
        : nodes ? updateStageConfigurationDraft(projectId, currentDraft.current, currentWorkflow.current.nodes, nodes)
        : { version: 1 as const, projectId, changes: [] };
      await saveStageConfigurationDraft(key, next);
      if (owner.current === key) {
        currentDraft.current = next;
        setLoaded({ key, ready: true, draft: next, error: '' });
      }
      return next;
    });
    writes.current = operation.catch(() => undefined);
    return operation;
  }, [key, projectId, ready]);
  return { ...applied, conflicts: [...applied.conflicts, ...projectDraft?.conflicts ?? []], projectSettings: projectDraft?.settings, ready, draft, pending: Boolean(draft?.changes.length || draft?.production || draft?.project || draft?.execution), error: loaded.key === key ? loaded.error : '',
    saveNodes: (nodes: WorkflowNode[]) => write(nodes), saveConfiguration: (nodes: WorkflowNode[], production: ProductionSettings, settings: ProductionProjectSettings, baseline?: ProductionProjectSettings, execution?: WorkflowDefinition['execution']) => write(nodes, production, settings, baseline, execution), clear: () => write(), retry: () => setAttempt(value => value + 1) };
}
