import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { ImageRectangle } from '@video-quickly/contracts';

function imageBytesForCanvas(bytes: Buffer): Buffer {
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return bytes;
  // Canvas can mistake an SVG inside a PNG's C2PA manifest for the image
  // format. Omit the manifest only from the buffer used to decode pixels.
  const parts: Buffer[] = [];
  let retainedStart = 0;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const end = offset + 12 + bytes.readUInt32BE(offset);
    if (end > bytes.length) return bytes;
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (type === 'IEND') return retainedStart ? Buffer.concat([...parts, bytes.subarray(retainedStart)]) : bytes;
    if (type === 'caBX') {
      if (offset > retainedStart) parts.push(bytes.subarray(retainedStart, offset));
      retainedStart = end;
    }
    offset = end;
  }
  return bytes;
}

export async function readToolImage(bytes: Buffer) {
  const image = await loadImage(imageBytesForCanvas(bytes));
  if (!image.width || !image.height || image.width * image.height > 32_000_000) throw new Error('图片须为有效图片，且不超过 3200 万像素。');
  return image;
}

export async function imageDimensions(bytes: Buffer): Promise<{ width: number; height: number }> {
  const image = await readToolImage(bytes);
  return { width: image.width, height: image.height };
}

export function validateImageRectangle(rectangle: ImageRectangle, size: { width: number; height: number }) {
  if (rectangle.x + rectangle.width > size.width || rectangle.y + rectangle.height > size.height) throw new Error('所选区域超出原图范围。');
}

export async function cropToolImage(bytes: Buffer, rectangles: ImageRectangle[]): Promise<Buffer[]> {
  const image = await readToolImage(bytes);
  return rectangles.map(rectangle => {
    validateImageRectangle(rectangle, image);
    const canvas = createCanvas(rectangle.width, rectangle.height), context = canvas.getContext('2d');
    context.drawImage(image, rectangle.x, rectangle.y, rectangle.width, rectangle.height, 0, 0, rectangle.width, rectangle.height);
    return canvas.toBuffer('image/png');
  });
}

export async function createEditMask(bytes: Buffer, rectangle: ImageRectangle): Promise<Buffer> {
  const image = await readToolImage(bytes); validateImageRectangle(rectangle, image);
  const canvas = createCanvas(image.width, image.height), context = canvas.getContext('2d');
  context.fillStyle = '#fff'; context.fillRect(0, 0, image.width, image.height);
  context.clearRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
  return canvas.toBuffer('image/png');
}

export async function validateEditMask(bytes: Buffer, size: { width: number; height: number }): Promise<void> {
  if (bytes.length > 4 * 1024 * 1024 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('遮罩须为不超过 4 MiB 的透明 PNG 图片。');
  const mask = await readToolImage(bytes);
  if (mask.width !== size.width || mask.height !== size.height) throw new Error('遮罩与源图的像素尺寸须相同。');
  const canvas = createCanvas(mask.width, mask.height), context = canvas.getContext('2d'); context.drawImage(mask, 0, 0);
  const rgba = context.getImageData(0, 0, mask.width, mask.height).data;
  for (let index = 3; index < rgba.length; index += 4) if (rgba[index] === 0) return;
  throw new Error('遮罩需要完全透明的待修改区域。');
}
