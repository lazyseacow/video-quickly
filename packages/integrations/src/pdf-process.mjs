import { PDFParse } from 'pdf-parse';

// Isolate PDF.js and its native canvas/font initialization in a Node process.
// Windows CI reproduces a native access violation in the worker_threads path.
async function extract(bytes) {
  const parser = new PDFParse({ data: bytes });
  try {
    const info = await parser.getInfo();
    if (info.total > 80) throw new Error('PDF 超过 80 页，请先拆分需要的页段。');
    const result = await parser.getText();
    if (!result.pages.some(page => page.text.trim())) throw new Error('PDF 未提取到文字层；扫描件请先 OCR 或粘贴可核对的原文。');
    return result.pages.map(page => `【第 ${page.num} 页】\n${page.text.trim()}`).join('\n\n');
  } finally { await parser.destroy(); }
}
function complete(message) {
  process.send(message, error => { if (error) process.exitCode = 1; if (process.connected) process.disconnect(); });
}
process.once('message', bytes => {
  void extract(bytes).then(content => complete({ content }), error => {
    process.exitCode = 1;
    complete({ error: error instanceof Error ? error.message : String(error) });
  });
});
