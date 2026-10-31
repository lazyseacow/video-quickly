import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';

const root = join(import.meta.dirname, '../apps/desktop/src');
const styles = readdirSync(root, { recursive: true }).filter((file): file is string => typeof file === 'string' && file.endsWith('.css'));

it('keeps all owned interface styles on shared color, typography, spacing and radius roles', () => {
  const violations: string[] = [];
  for (const file of styles) {
    if (file === 'design-tokens.css') continue;
    const source = readFileSync(join(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of source.matchAll(/(?:^|[;{])\s*([a-z-]+)\s*:\s*([^;}]+)/gm)) {
      const [, property, value] = match;
      const rawColor = /#[\da-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(value)
        || /^(?:color|background(?:-color)?|border(?:-[a-z-]+)?|outline(?:-color)?|box-shadow|text-shadow)$/.test(property) && /\b(?:black|white|gray|grey|red|blue|green|orange|yellow|purple)\b/i.test(value)
        || /var\(--neutral-/.test(value);
      const rawType = ['font-size', 'font-weight', 'line-height', 'letter-spacing', 'font-family'].includes(property) && !value.includes('var(') && !['inherit', 'normal'].includes(value);
      const rawSpace = /^(?:(?:row-|column-)?gap|padding(?:-[a-z-]+)?|margin(?:-[a-z-]+)?)$/.test(property) && /(?<![\w.-])[1-9]\d*px\b/.test(value);
      const rawRadius = property === 'border-radius' && /\d+px\b/.test(value) && !value.includes('var(');
      if (rawColor || rawType || rawSpace || rawRadius) violations.push(`${relative(root, join(root, file))}: ${property}: ${value}`);
    }
  }
  expect(violations).toEqual([]);
});

it('provides each referenced foundation role and keeps GSAP timing in the CSS contract', () => {
  const tokens = readFileSync(join(root, 'design-tokens.css'), 'utf8');
  const definitions = new Set([...tokens.matchAll(/(--[a-z\d-]+)\s*:/g)].map(match => match[1]));
  const references = styles.flatMap(file => [...readFileSync(join(root, file), 'utf8').matchAll(/var\((--(?:space|text-size|font-weight|line-height|letter-spacing|radius|motion)-[a-z\d-]+)/g)].map(match => match[1]));
  expect([...new Set(references)].filter(role => !definitions.has(role))).toEqual([]);
  const motion = readFileSync(join(root, 'lib/motion.ts'), 'utf8');
  for (const role of ['enter', 'exit', 'switch']) expect(motion).toContain(`duration('--motion-${role}')`);
});
