import { basename, extname } from 'node:path';
import { z } from 'zod';
import { dramaScriptReadResultSchema } from '@video-quickly/contracts';
import { readResearchSource } from '@video-quickly/integrations/research';
import { readDramaDocx } from './drama-docx.js';

/** Local import only. Reading a script never schedules a model or changes a project. */
export async function readDramaScript(raw: unknown) {
  const { path } = z.object({ path: z.string().min(1) }).strict().parse(raw);
  const text = extname(path).toLowerCase() === '.docx' ? await readDramaDocx(path) : (await readResearchSource({ path })).content;
  return dramaScriptReadResultSchema.parse({ fileName: basename(path), text });
}
