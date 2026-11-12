import { createRequire } from 'node:module';

const { createCanvas, loadImage } = createRequire(new URL('../../src/packages/video/package.json', import.meta.url))('@napi-rs/canvas') as typeof import('../../src/packages/video/node_modules/@napi-rs/canvas');

export async function fixtureCharacterImage(profile = false, format: 'png' | 'jpeg' | 'webp' = 'png') {
  const headX = profile ? 175 : 160, headWidth = profile ? 26 : 38, eyes = profile ? [185] : [148, 172];
  const portrait = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="360" viewBox="0 -20 320 360">
    <rect y="-20" width="320" height="360" fill="#eee8d8"/>
    <ellipse cx="160" cy="286" rx="61" ry="10" fill="#d0c9ba"/>
    <path d="M125 206h70l-4 69h-23l-8-48-8 48h-24z" fill="#273a45"/>
    <path d="M125 268h24v15h-32zm46 0h22l10 15h-32z" fill="#22252e"/>
    <path d="M133 121h54l26 88-25 14h-56l-25-14z" fill="#2e6973"/>
    <path d="M133 121l-26 88 18 8 23-75zm54 0l26 88-18 8-23-75z" fill="#40818a"/>
    <path d="M129 132l29 18 35-24-6 19-28 21-33-23z" fill="#e2a055"/>
    <ellipse cx="${headX}" cy="91" rx="${headWidth}" ry="36" fill="#ddb28d"/>
    <path d="M${headX - headWidth} 91q-4-42 ${headWidth} -47q42 2 ${headWidth} 46l-17-16-25 9z" fill="#273a45"/>
    ${eyes.map(eye => `<circle cx="${eye}" cy="94" r="3" fill="#26343d"/>`).join('')}
  </svg>`);
  const canvas = createCanvas(320, 360);
  canvas.getContext('2d').drawImage(await loadImage(portrait), 0, 0);
  return format === 'png' ? canvas.encodeSync('png') : canvas.encodeSync(format);
}
