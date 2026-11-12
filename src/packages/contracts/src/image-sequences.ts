import type { CharacterProfile, JsonValue, ModelProfile, ProjectDocument, Shot, WorkflowNode } from './index.js';
import { creativeReferenceAssetIds } from './creative-context.js';
import { imageSequenceMode } from './model-parameters.js';
import { groupsNativeFirstFrames, groupsReferenceImages } from './production.js';

interface ImageSequence {
  batches: Shot[][];
  seedream: boolean;
}

const MAX_SEEDREAM_IMAGES = 15;
const MAX_BATCH_SHOTS = 4;
export const seedreamTextOnly = /seedream[-_.]?3/i;
export const seedreamSingleImageV5 = /seedream[-_.]5[-_.]0[-_.](?:pro|flash)(?:[-_.]|$)/i;
const seedreamModelName = /^(?:doubao-)?seedream[-_.][45]/i;

export function imageReferenceLimit(model: Pick<ModelProfile, 'provider' | 'model'>): number | undefined {
  if (model.provider === 'seedream' || model.provider === 'openai-compatible' && seedreamModelName.test(model.model)) return seedreamSingleImageV5.test(model.model) ? 10 : 14;
  if (model.provider === 'openai-compatible') return 16;
  return undefined;
}

export function hasTemplateValue(value: JsonValue | undefined, placeholder: string, exact = true): boolean {
  if (typeof value === 'string') return exact ? value === placeholder : value.includes(placeholder);
  if (value && typeof value === 'object') return Object.values(value).some(item => hasTemplateValue(item, placeholder, exact));
  return false;
}

function supportsAnchor(model: ModelProfile, referenceCount: number): boolean {
  if (referenceCount >= (imageReferenceLimit(model) ?? Infinity)) return false;
  if (model.provider === 'seedream') return !seedreamTextOnly.test(model.model);
  if (model.provider === 'openai-compatible') {
    return !/dall-e/i.test(model.model) && !seedreamTextOnly.test(model.model)
      && (referenceCount > 0 || model.parameters.imageSequenceMode === 'continuous' || /^(?:gpt-image-|chatgpt-image-)/i.test(model.model) || seedreamModelName.test(model.model));
  }
  if (model.provider === 'custom-http') {
    return hasTemplateValue(model.parameters.requestTemplate, '{{character_images}}') && hasTemplateValue(model.parameters.requestTemplate, '{{prompt}}', false);
  }
  return false;
}

/** Keep a shared reference order. Locked shots and changes to the reference inputs start a new sequence. */
export function planReferenceImageSequences({ project, node, model, characters = [] }: { project: ProjectDocument; node: WorkflowNode; model?: ModelProfile; characters?: CharacterProfile[] }): ImageSequence[] {
  const singleShots = (shots: readonly Shot[]): ImageSequence[] => shots.map(shot => ({ batches: [[shot]], seedream: false }));
  if (!model || !groupsReferenceImages(node)) return singleShots(project.shots);
  if (node.config.useFirstShotReference === true) {
    const batches = project.shots.filter(shot => !shot.locked).map(shot => [shot]);
    return batches.length ? [{ batches, seedream: false }] : [];
  }
  const nativeFirstFrames = groupsNativeFirstFrames(project.workflow, node);
  const seedream = imageSequenceMode(model) === 'seedream' && !seedreamSingleImageV5.test(model.model) && !seedreamTextOnly.test(model.model);
  const matchImageInputs = nativeFirstFrames && seedream;
  const characterKeys = new Set(project.creativeContext?.entities.filter(entity => entity.kind === 'character').map(entity => entity.key));
  const groups: Shot[][] = [];
  let previous: string | undefined;
  for (const shot of project.shots) {
    if (nativeFirstFrames && shot.locked) { previous = undefined; continue; }
    const keys = [...(shot.creativeEntityKeys ?? [])].sort();
    const bindings = shot.locked ? undefined : JSON.stringify(matchImageInputs
      ? [shot.characterIds ?? [], keys.filter(key => characterKeys.has(key)), creativeReferenceAssetIds(project, shot)]
      : [shot.characterIds ?? [], keys]);
    if (bindings !== undefined && bindings === previous) groups.at(-1)!.push(shot);
    else groups.push([shot]);
    previous = bindings;
  }
  return groups.flatMap(shots => {
    if (shots.length === 1) return singleShots(shots);
    const first = shots[0];
    const referenceCount = new Set([
      ...characters.filter(character => first.characterIds?.includes(character.id)).flatMap(character => character.referenceAssetIds),
      ...creativeReferenceAssetIds(project, first),
    ]).size;
    if (!seedream || referenceCount > MAX_SEEDREAM_IMAGES - 2) {
      return supportsAnchor(model, referenceCount) ? [{ batches: shots.map(shot => [shot]), seedream: false }] : singleShots(shots);
    }
    const batches: Shot[][] = [];
    for (let offset = 0; offset < shots.length;) {
      const limit = Math.min(MAX_BATCH_SHOTS, MAX_SEEDREAM_IMAGES - referenceCount - Number(offset > 0));
      batches.push(shots.slice(offset, offset + limit));
      offset += limit;
    }
    return [{ batches, seedream: true }];
  });
}
