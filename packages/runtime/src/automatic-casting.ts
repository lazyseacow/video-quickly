import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { creativeContextSchema, shotSchema, supportsAutomaticCasting, type AssetRecord, type CharacterProfile, type CreativeEntity, type ProjectDocument, type WorkflowNode } from '@video-quickly/contracts';

const normalizedName = (name: string) => name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

export function withAutomaticCasting(project: ProjectDocument, nodes: WorkflowNode[]): WorkflowNode[] {
  if (!supportsAutomaticCasting({ id: project.workflow.id, nodes })) return nodes;
  return nodes.map(node => ['script', 'assets', 'video'].includes(node.id) ? { ...node, config: { ...node.config, automaticCasting: true } } : node);
}

export function recurringCast(project: ProjectDocument, profiles: CharacterProfile[]) {
  const entities = [...project.creativeContext?.entities ?? []];
  const shots = [...project.shots];
  const recurring = new Set<string>();
  for (const entity of entities) {
    if (entity.kind !== 'character') continue;
    const appearances = shots.filter(shot => shot.creativeEntityKeys?.includes(entity.key));
    if (appearances.length > 1 && appearances.some(shot => !shot.locked)) recurring.add(entity.key);
  }
  // A library role with only a text description gets its own look in this project.
  for (const profile of profiles) {
    if (profile.referenceAssetIds.length) continue;
    const appearances = shots.filter(shot => shot.characterIds?.includes(profile.id));
    if (appearances.length < 2 || appearances.every(shot => shot.locked)) continue;
    const key = 'cast-' + createHash('sha256').update(profile.id).digest('hex').slice(0, 24);
    const named = entities.filter(entity => entity.kind === 'character' && normalizedName(entity.name) === normalizedName(profile.name));
    const entity = entities.find(item => item.key === key) ?? (named.length === 1 ? named[0] : undefined)
      ?? { key, kind: 'character' as const, name: profile.name, description: profile.description.slice(0, 4000) };
    if (!entities.includes(entity)) entities.push(entity);
    recurring.add(entity.key);
    for (const [index, shot] of shots.entries()) {
      if (!shot.locked && shot.characterIds?.includes(profile.id) && !shot.creativeEntityKeys?.includes(entity.key)) {
        shots[index] = shotSchema.parse({ ...shot, creativeEntityKeys: [...shot.creativeEntityKeys ?? [], entity.key] });
      }
    }
  }
  const missing = entities.filter(entity => recurring.has(entity.key) && !entity.referenceAssetIds?.length);
  const creativeContext = entities.length !== (project.creativeContext?.entities.length ?? 0)
    ? creativeContextSchema.parse({ ...project.creativeContext, entities }) : project.creativeContext;
  return { project: { ...project, creativeContext, shots }, missing };
}

async function usableLibraryImage(asset: AssetRecord, signal: AbortSignal): Promise<boolean> {
  if (!asset.active || asset.projectId !== undefined || asset.kind !== 'image'
    || !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType) || asset.size <= 0 || asset.size > 15 * 1024 * 1024) return false;
  try {
    const info = await stat(asset.path);
    if (!info.isFile() || info.size !== asset.size) return false;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(asset.path, { signal })) hash.update(chunk);
    return hash.digest('hex') === asset.sha256;
  } catch {
    signal.throwIfAborted();
    return false;
  }
}

export async function matchCastReferences(roles: CreativeEntity[], selected: CharacterProfile[], library: CharacterProfile[], assets: AssetRecord[], signal: AbortSignal) {
  const available = new Map(assets.map(asset => [asset.id, asset]));
  const references: Array<{ key: string; asset: AssetRecord }> = [];
  for (const role of roles) {
    signal.throwIfAborted();
    const matches = (profiles: CharacterProfile[]) => profiles.filter(profile => !profile.archived && profile.referenceAssetIds.length && normalizedName(profile.name) === normalizedName(role.name));
    const preferred = matches(selected);
    const candidates = preferred.length ? preferred : matches(library);
    // A name collision alone is insufficient to pick a face.
    if (candidates.length !== 1) continue;
    for (const id of candidates[0].referenceAssetIds) {
      const asset = available.get(id);
      if (asset && await usableLibraryImage(asset, signal)) {
        references.push({ key: role.key, asset });
        break;
      }
    }
  }
  return references;
}

export function characterAppearanceShot(role: CreativeEntity) {
  return shotSchema.parse({
    id: role.key, title: `${role.name} · 人物定妆`.slice(0, 160), narration: '', durationUs: 1_000_000,
    visualPrompt: `为角色「${role.name}」制作一套统一的定妆设定图。角色外观：${role.description}。用素色背景并列展示同一个人物的正脸特写与四分之三角度全身，两个视图采用完全一致的脸、发型、服装、体型和配饰。人物清晰，表情自然，无文字、边框、标识或其他人物。`,
  });
}
