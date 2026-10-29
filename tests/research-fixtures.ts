/** A real, tiny two-page PDF using the standard Helvetica font. */
export function researchPdf(pages = ['First page evidence about paper.', 'Second page evidence about printing.']) {
  const objects = [`<< /Type /Catalog /Pages 2 0 R >>`, `<< /Type /Pages /Kids [${pages.map((_, index) => `${3 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`];
  const font = 3 + pages.length * 2;
  for (const [index, text] of pages.entries()) {
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${text.replace(/[\\()]/g, '\\$&')}) Tj ET` : '0 0 10 10 re f';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + index * 2} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let document = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(document)); document += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document);
}

/** Original CID text with an embedded ToUnicode CMap, including a surrogate pair. */
export function chineseResearchPdf(pages = ['中文资料🙂：纸张由植物纤维构成。', '第二页证据：核对原文，不冒充已核验。']) {
  const alphabet = [...new Set(Array.from(pages.join('')))];
  const codes = new Map(alphabet.map((character, index) => [character, (index + 1).toString(16).padStart(4, '0').toUpperCase()]));
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, index) => `${3 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`];
  const font = 3 + pages.length * 2, descendant = font + 1, descriptor = font + 2, unicode = font + 3;
  for (const [index, text] of pages.entries()) {
    const encoded = Array.from(text).map(character => codes.get(character)).join('');
    const stream = `BT /F1 12 Tf 72 720 Td <${encoded}> Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + index * 2} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /VideoQuicklyChinese-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${alphabet.length} beginbfchar\n${alphabet.map(character => `<${codes.get(character)}> <${Buffer.from(character, 'utf16le').swap16().toString('hex').toUpperCase()}>`).join('\n')}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
  objects.push(`<< /Type /Font /Subtype /Type0 /BaseFont /VideoQuicklyChinese /Encoding /Identity-H /DescendantFonts [${descendant} 0 R] /ToUnicode ${unicode} 0 R >>`, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /VideoQuicklyChinese /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW 1000 /CIDToGIDMap /Identity >>`, '<< /Type /FontDescriptor /FontName /VideoQuicklyChinese /Flags 4 /FontBBox [0 -200 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -200 /CapHeight 880 /StemV 80 >>', `<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`);
  let document = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(document)); document += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document);
}
