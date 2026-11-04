import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { imageEditInputSchema, type AssetRecord, type ModelProfile, type ProjectDocument, type WorkflowNode } from '@video-quickly/contracts';

export async function resolveImageEdit(context: { node: WorkflowNode; project: ProjectDocument; assets: AssetRecord[]; model?: ModelProfile }) {
  if (context.node.config.imageEdit === undefined) return undefined;
  const input = imageEditInputSchema.parse(context.node.config.imageEdit);
  const shot = context.project.shots.find(shot => shot.id === context.node.config.shotId);
  if (context.node.kind !== 'assets' || context.node.config.operation !== 'regenerate' || !shot || shot.sceneTemplate || shot.assetId !== input.sourceAssetId) throw new Error('局部改图须使用当前镜头绑定的图片。');
  if (!context.model || context.model.provider !== 'openai-compatible' || /dall-e/i.test(context.model.model)) throw new Error('局部改图需要支持 OpenAI Images 编辑协议的模型。');
  const read = async (id: string, mask = false) => {
    const asset = context.assets.find(asset => asset.id === id);
    if (!asset?.active || asset.kind !== 'image' || asset.projectId && asset.projectId !== context.project.id || !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType)) throw new Error('改图输入须为当前项目或公共素材库中的有效图片。');
    const info = await stat(asset.path).catch(() => undefined);
    if (!info?.isFile() || info.size <= 0 || info.size > (mask ? 4 : 20) * 1024 * 1024 || info.size !== asset.size) throw new Error('改图源图或遮罩缺失、已更改或过大。');
    const bytes = await readFile(asset.path);
    if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('改图输入校验失败，请重新导入。');
    return { asset, bytes };
  };
  const source = await read(input.sourceAssetId), mask = input.maskAssetId ? await read(input.maskAssetId, true) : undefined;
  const { imageDimensions, validateEditMask } = await import('@video-quickly/video/image-tools');
  const size = await imageDimensions(source.bytes);
  if (mask) {
    if (mask.asset.derivation && (mask.asset.derivation.kind !== 'edit-mask' || mask.asset.derivation.sourceAssetId !== source.asset.id || mask.asset.derivation.sourceSha256 !== source.asset.sha256)) throw new Error('遮罩与当前源图不匹配，请重新选择修改区域。');
    await validateEditMask(mask.bytes, size);
  }
  return { source, mask };
}
