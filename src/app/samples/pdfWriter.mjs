// Minimal PDF 1.4 writer (Helvetica / Helvetica-Bold / Courier, text + filled rectangles).
// Enough to produce realistic-looking sample e-tickets without a PDF dependency.

const esc = (s) => String(s).replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, '?');
const rgb = (hex) => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (v / 255).toFixed(3)).join(' ');
};

/**
 * @param {{ texts: {x:number,y:number,text:string,size?:number,font?:'F1'|'F2'|'F3',color?:string}[], rects?: {x:number,y:number,w:number,h:number,color:string}[] }} page
 * Coordinates are top-left based (y grows downward) for convenience; converted to PDF space here.
 */
export function makePdf(page, { width = 595, height = 842, title = 'Document' } = {}) {
  const ops = [];
  for (const r of page.rects || []) ops.push(`${rgb(r.color)} rg ${r.x} ${height - r.y - r.h} ${r.w} ${r.h} re f`);
  for (const t of page.texts) {
    ops.push(`BT /${t.font || 'F1'} ${t.size || 10} Tf ${rgb(t.color || '#101828')} rg ${t.x} ${height - t.y} Td (${esc(t.text)}) Tj ET`);
  }
  const content = ops.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >> >> /Contents 7 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    `<< /Title (${esc(title)}) /Producer (flyo-preflight sample generator) >>`,
  ];
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
