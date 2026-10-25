// Generador PDF 1.4 mínimo y sin dependencias (no se instalan componentes adicionales).
// Fuentes estándar Helvetica / Helvetica-Bold con codificación WinAnsi: cubre el español (á, ñ, ¿, «»…).
// Solo dibuja texto, rectángulos y líneas: suficiente para un comprobante administrativo de una página.

const WIN_ANSI_EXTRA: Record<string, number> = {
  '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99,
};

/** Cadena PDF literal en WinAnsi; caracteres sin representación se sustituyen por «?». */
function str(s: string): string {
  let out = '(';
  for (const ch of s) {
    const code = WIN_ANSI_EXTRA[ch] ?? (ch.codePointAt(0)! <= 0xff ? ch.codePointAt(0)! : 0x3f);
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
    else if (code < 0x20 || code > 0x7e) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(code);
  }
  return `${out})`;
}

// Anchos de Helvetica (1/1000 em) para ASCII imprimible; el resto se aproxima. Sirve para ajustar líneas.
const HELV = '278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584'.split(',').map(Number);
export function textWidth(s: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of s) { const c = ch.codePointAt(0)!; w += c >= 32 && c <= 126 ? HELV[c - 32]! : 556; }
  return (w * size * (bold ? 1.05 : 1)) / 1000;
}

/** Parte un texto en líneas que caben en el ancho dado. */
export function wrap(s: string, size: number, maxWidth: number, bold = false): string[] {
  const words = s.split(/\s+/); const lines: string[] = []; let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (textWidth(next, size, bold) > maxWidth && cur) { lines.push(cur); cur = w; } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

type Rgb = [number, number, number];
const rgb = (c: Rgb) => c.map((x) => (x / 255).toFixed(3)).join(' ');

/** Lienzo de una página A4 (595 × 842 pt), origen arriba a la izquierda para comodidad. */
export class Page {
  private ops: string[] = [];
  readonly width = 595;
  readonly height = 842;
  rect(x: number, y: number, w: number, h: number, fill: Rgb) { this.ops.push(`${rgb(fill)} rg ${x} ${this.height - y - h} ${w} ${h} re f`); }
  line(x1: number, y1: number, x2: number, y2: number, color: Rgb, width = 0.6) {
    this.ops.push(`${rgb(color)} RG ${width} w ${x1} ${this.height - y1} m ${x2} ${this.height - y2} l S`);
  }
  text(s: string, x: number, y: number, size: number, opts: { bold?: boolean; color?: Rgb; align?: 'left' | 'right' | 'center' } = {}) {
    const w = textWidth(s, size, opts.bold);
    const xx = opts.align === 'right' ? x - w : opts.align === 'center' ? x - w / 2 : x;
    this.ops.push(`BT /${opts.bold ? 'F2' : 'F1'} ${size} Tf ${rgb(opts.color ?? [17, 27, 33])} rg ${xx.toFixed(2)} ${(this.height - y).toFixed(2)} Td ${str(s)} Tj ET`);
  }
  get content() { return this.ops.join('\n'); }
}

/** Ensambla el documento (objetos, tabla xref y trailer) a partir de una página. */
export function buildPdf(page: Page, info: { title: string; subject?: string; created: Date }): Buffer {
  const d = info.created;
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  const content = Buffer.from(page.content, 'latin1');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    null, // contenido (stream)
    `<< /Title ${str(info.title)} ${info.subject ? `/Subject ${str(info.subject)} ` : ''}/Producer (SaludCita AI - generador propio) /CreationDate (${date}) >>`,
  ];
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets: number[] = [];
  let pos = parts[0]!.length;
  objs.forEach((o, i) => {
    const head = Buffer.from(`${i + 1} 0 obj\n`, 'latin1');
    const body = o === null
      ? Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`, 'latin1'), content, Buffer.from('\nendstream', 'latin1')])
      : Buffer.from(o, 'latin1');
    const chunk = Buffer.concat([head, body, Buffer.from('\nendobj\n', 'latin1')]);
    offsets.push(pos); parts.push(chunk); pos += chunk.length;
  });
  const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${pos}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}
