import { parentPort, workerData } from 'node:worker_threads';
import { PDFParse } from 'pdf-parse';

// PDF.js uses a fake worker in Node. Keep its module/font initialization and
// text extraction off the runtime thread so unrelated RPCs remain responsive.
const parser = new PDFParse({ data: workerData });
try {
  const info = await parser.getInfo();
  if (info.total > 80) throw new Error('PDF 超过 80 页，请先拆分需要的页段。');
  const result = await parser.getText();
  if (!result.pages.some(page => page.text.trim())) throw new Error('PDF 未提取到文字层；扫描件请先 OCR 或粘贴可核对的原文。');
  const content = result.pages.map(page => `【第 ${page.num} 页】\n${page.text.trim()}`).join('\n\n');
  await parser.destroy();
  parentPort.postMessage({ content });
} catch (error) {
  await parser.destroy();
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
} finally { parentPort.close(); }
