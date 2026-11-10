import { cropToolImage } from '../../packages/video/src/image-tools';

export async function fixtureCharacterViews() {
  const views = [
    { x: 0, y: 0, headX: 160, headWidth: 38, eyes: [148, 172] },
    { x: 320, y: 0, headX: 168, headWidth: 34, eyes: [160, 179] },
    { x: 0, y: 320, headX: 175, headWidth: 26, eyes: [185] },
    { x: 320, y: 320, headX: 160, headWidth: 38, eyes: [] },
  ];
  const drawings = views.map(({ x, y, headX, headWidth, eyes }) => `<g transform="translate(${x} ${y})">
    <ellipse cx="160" cy="286" rx="61" ry="10" fill="#d0c9ba"/>
    <path d="M125 206h70l-4 69h-23l-8-48-8 48h-24z" fill="#273a45"/>
    <path d="M125 268h24v15h-32zm46 0h22l10 15h-32z" fill="#22252e"/>
    <path d="M133 121h54l26 88-25 14h-56l-25-14z" fill="#2e6973"/>
    <path d="M133 121l-26 88 18 8 23-75zm54 0l26 88-18 8-23-75z" fill="#40818a"/>
    <path d="M129 132l29 18 35-24-6 19-28 21-33-23z" fill="#e2a055"/>
    <ellipse cx="${headX}" cy="91" rx="${headWidth}" ry="36" fill="#ddb28d"/>
    <path d="M${headX - headWidth} 91q-4-42 ${headWidth} -47q42 2 ${headWidth} 46l-17-16-25 9z" fill="#273a45"/>
    ${eyes.map(eye => `<circle cx="${eye}" cy="94" r="3" fill="#26343d"/>`).join('')}
    ${eyes.length ? '' : `<ellipse cx="${headX}" cy="89" rx="${headWidth}" ry="34" fill="#273a45"/>`}
  </g>`).join('');
  const board = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><rect width="640" height="640" fill="#eee8d8"/>${drawings}</svg>`);
  const [png] = await cropToolImage(board, [{ x: 0, y: 0, width: 640, height: 640 }]);
  return png;
}
