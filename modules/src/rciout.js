// Source Documents · Print, and Export to Excel, PDF and Word, in the layout shown on screen: title, office,
// bank · account No. · fund, month, the bordered table, Total. Paper: long (8.5 x 13 in), portrait, 0.5 in margins.
// spec: { title, office, acct, month, cols: [{ h, w (inches), right }], rows: [[cell]], total: [cell], empty }
//   cell: a string, a number (money), or { t, span, right, bold }. Text may hold line breaks (\n).
import { loadExcelJS } from '../cer/wp.js';

const fmt = (n) => (+n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clean = (s) => String(s).replace(/[\\/:*?"<>|]/g, '-');

function save(blob, file) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = clean(file); document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
const scripts = {};
function loadScript(src, ready) {
  if (ready()) return Promise.resolve();
  if (!scripts[src]) scripts[src] = new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = src; sc.onload = () => res(); sc.onerror = () => { scripts[src] = null; rej(new Error('The file writer could not load. Check the internet connection and try again.')); }; document.head.appendChild(sc); });
  return scripts[src];
}
// A row as cells { t (text), num (number or null), span, right, bold, col (first column) }.
function cellsOf(spec, row, bold) {
  let col = 0;
  return row.map((c) => {
    const o = c !== null && typeof c === 'object' ? c : { t: c };
    const num = typeof o.t === 'number' ? o.t : null;
    const span = o.span || 1, x = { t: num === null ? String(o.t ?? '') : fmt(num), num, span, col, bold: bold || !!o.bold, right: o.right ?? (num !== null || (span === 1 && !!spec.cols[col].right)) };
    col += span; return x;
  });
}
const bodyRows = (spec) => (spec.rows.length ? spec.rows.map((r) => cellsOf(spec, r)) : [[{ t: spec.empty || 'None.', num: null, span: spec.cols.length, col: 0, center: true }]]);
const widthOf = (spec, c) => spec.cols.slice(c.col, c.col + c.span).reduce((n, x) => n + x.w, 0);

/* ---------- Print ---------- */
export function htmlDoc(spec) {
  const td = (c) => `<td${c.span > 1 ? ` colspan="${c.span}"` : ''} class="${[c.right ? 'r' : '', c.center ? 'c' : '', c.bold ? 'b' : ''].join(' ')}">${esc(c.t).replace(/\n/g, '<br>')}</td>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(spec.title)}</title><style>
    @page{size:8.5in 13in; margin:0.5in}
    body{font-family:Arial,Helvetica,sans-serif; font-size:${spec.cols.length > 6 ? 9 : 10}pt; color:#000; margin:0}
    h1{text-align:center; font-size:13pt; margin:0 0 6pt; letter-spacing:.5px; text-transform:uppercase}
    p.h{text-align:center; margin:0 0 10pt; line-height:1.4}
    table{width:100%; border-collapse:collapse; table-layout:fixed}
    th,td{border:1px solid #000; padding:3pt 4pt; vertical-align:top; word-wrap:break-word}
    th{text-align:center; vertical-align:middle; font-weight:bold}
    thead{display:table-header-group} tr{break-inside:avoid}
    .r{text-align:right} .c{text-align:center} .b{font-weight:bold}
  </style></head><body><h1>${esc(spec.title)}</h1><p class="h"><b>${esc(spec.office)}</b><br>${esc(spec.acct)}<br>${esc(spec.month)}</p>
  <table><colgroup>${spec.cols.map((c) => `<col style="width:${c.w}in">`).join('')}</colgroup><thead><tr>${spec.cols.map((c) => `<th>${esc(c.h)}</th>`).join('')}</tr></thead>
  <tbody>${bodyRows(spec).map((r) => `<tr>${r.map(td).join('')}</tr>`).join('')}<tr>${cellsOf(spec, spec.total, true).map(td).join('')}</tr></tbody></table></body></html>`;
}
export function printDoc(spec) {
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(f);
  const doc = f.contentWindow.document; doc.open(); doc.write(htmlDoc(spec)); doc.close();
  setTimeout(() => { f.contentWindow.focus(); f.contentWindow.print(); setTimeout(() => f.remove(), 1000); }, 150);
}

/* ---------- Excel ---------- */
export async function xlsxDoc(spec, file) {
  const ExcelJS = await loadExcelJS();
  const n = spec.cols.length, wb = new ExcelJS.Workbook(), ws = wb.addWorksheet(spec.sheet || 'Report');
  ws.pageSetup = { paperSize: 14, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true, printTitlesRow: '6:6',
    margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 } };   // 14 = Folio, 8.5 x 13 in
  const chars = spec.cols.map((c) => Math.round(c.w * 13.5));
  ws.columns = chars.map((width) => ({ width }));
  const font = { name: 'Arial', size: n > 6 ? 9 : 10 };
  const line = { style: 'thin', color: { argb: 'FF000000' } }, box = { top: line, left: line, bottom: line, right: line };
  const title = (r, text, f) => { ws.mergeCells(r, 1, r, n); const c = ws.getCell(r, 1); c.value = text; c.font = { ...font, ...f }; c.alignment = { horizontal: 'center' }; };
  title(1, spec.title.toUpperCase(), { bold: true, size: 13 });
  title(2, spec.office, { bold: true }); title(3, spec.acct); title(4, spec.month);
  const hr = ws.getRow(6); spec.cols.forEach((h, i) => { const c = hr.getCell(i + 1); c.value = h.h; c.font = { ...font, bold: true }; c.border = box; c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; });
  hr.height = 28;
  let r = 7;
  const put = (cells) => {
    const row = ws.getRow(r); let lines = 1;
    for (let i = 1; i <= n; i++) row.getCell(i).border = box;
    cells.forEach((x) => {
      const c = row.getCell(x.col + 1); c.value = x.num !== null ? x.num : x.t; c.font = { ...font, bold: x.bold }; c.border = box;
      c.alignment = { vertical: 'top', wrapText: true, horizontal: x.center ? 'center' : x.right ? 'right' : 'left' }; if (x.num !== null) c.numFmt = '#,##0.00';
      if (x.span > 1) ws.mergeCells(r, x.col + 1, r, x.col + x.span);
      const w = chars.slice(x.col, x.col + x.span).reduce((s, v) => s + v, 0);
      lines = Math.max(lines, String(x.t).split('\n').reduce((s, p) => s + Math.max(1, Math.ceil(p.length / (w * 1.05))), 0));
    });
    row.height = Math.max(15, lines * (n > 6 ? 12 : 13)); r++;
  };
  bodyRows(spec).forEach(put); put(cellsOf(spec, spec.total, true));
  save(new Blob([await wb.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), file);
}

/* ---------- PDF ---------- */
export async function pdfDoc(spec, file) {
  await loadScript('lib/jspdf.umd.min.js', () => !!window.jspdf);
  await loadScript('lib/jspdf.plugin.autotable.min.js', () => !!(window.jspdf && window.jspdf.jsPDF.API.autoTable));
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'in', format: [8.5, 13], orientation: 'portrait' });
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(13); pdf.text(spec.title.toUpperCase(), 4.25, 0.75, { align: 'center' });
  pdf.setFontSize(10); pdf.text(spec.office, 4.25, 1.0, { align: 'center' });
  pdf.setFont('helvetica', 'normal'); pdf.text(spec.acct, 4.25, 1.18, { align: 'center' }); pdf.text(spec.month, 4.25, 1.36, { align: 'center' });
  const cell = (x) => ({ content: x.t, colSpan: x.span, styles: { halign: x.center ? 'center' : x.right ? 'right' : 'left', fontStyle: x.bold ? 'bold' : 'normal' } });
  const body = [...bodyRows(spec), cellsOf(spec, spec.total, true)].map((r) => r.map(cell));
  const tw = spec.cols.reduce((s, c) => s + c.w, 0), side = (8.5 - tw) / 2;
  pdf.autoTable({ startY: 1.55, head: [spec.cols.map((c) => c.h)], body, theme: 'grid', margin: { left: side, right: side, top: 0.5, bottom: 0.5 },
    styles: { font: 'helvetica', fontSize: spec.cols.length > 6 ? 8 : 9, textColor: 0, lineColor: 0, lineWidth: 0.01, cellPadding: 0.05, valign: 'top', overflow: 'linebreak' },
    headStyles: { fillColor: false, textColor: 0, fontStyle: 'bold', halign: 'center', valign: 'middle' },
    columnStyles: Object.fromEntries(spec.cols.map((c, i) => [i, { cellWidth: c.w }])) });
  save(pdf.output('blob'), file);
}

/* ---------- Word ---------- */
export async function docxDoc(spec, file) {
  await loadScript('lib/docx.min.js', () => !!window.docx);
  const X = window.docx;
  const TW = 1440, B = { style: X.BorderStyle.SINGLE, size: 4, color: '000000' }, borders = { top: B, bottom: B, left: B, right: B };
  const sz = spec.cols.length > 6 ? 18 : 20;
  const para = (text, o = {}) => new X.Paragraph({ alignment: o.align || X.AlignmentType.LEFT, spacing: { after: o.after || 0 },
    children: String(text ?? '').split('\n').map((p, i) => new X.TextRun({ text: p, font: 'Arial', size: o.size || sz, bold: !!o.bold, break: i ? 1 : 0 })) });
  const A = X.AlignmentType;
  const cell = (x, head) => new X.TableCell({ borders, columnSpan: x.span > 1 ? x.span : undefined, width: { size: Math.round(widthOf(spec, x) * TW), type: X.WidthType.DXA },
    verticalAlign: head ? X.VerticalAlign.CENTER : X.VerticalAlign.TOP, margins: { top: 40, bottom: 40, left: 70, right: 70 },
    children: [para(x.t, { bold: x.bold || head, align: head || x.center ? A.CENTER : x.right ? A.RIGHT : A.LEFT })] });
  const rows = [new X.TableRow({ tableHeader: true, cantSplit: true, children: spec.cols.map((c, i) => cell({ t: c.h, span: 1, col: i }, true)) })];
  [...bodyRows(spec), cellsOf(spec, spec.total, true)].forEach((r) => rows.push(new X.TableRow({ cantSplit: true, children: r.map((x) => cell(x)) })));
  const tw = spec.cols.reduce((s, c) => s + c.w, 0);
  const doc = new X.Document({ sections: [{
    properties: { page: { size: { width: 8.5 * TW, height: 13 * TW }, margin: { top: 0.5 * TW, bottom: 0.5 * TW, left: 0.5 * TW, right: 0.5 * TW } } },
    children: [para(spec.title.toUpperCase(), { bold: true, size: 26, align: A.CENTER, after: 120 }), para(spec.office, { bold: true, align: A.CENTER, size: 20 }), para(spec.acct, { align: A.CENTER, size: 20 }), para(spec.month, { align: A.CENTER, after: 200, size: 20 }),
      new X.Table({ width: { size: Math.round(tw * TW), type: X.WidthType.DXA }, columnWidths: spec.cols.map((c) => Math.round(c.w * TW)), layout: X.TableLayoutType.FIXED, rows })] }] });
  save(await X.Packer.toBlob(doc), file);
}

export const exportDoc = (kind, spec, file) => (kind === 'xlsx' ? xlsxDoc : kind === 'pdf' ? pdfDoc : docxDoc)(spec, `${file}.${kind}`);
// The Print button and the Export menu (Excel, PDF, Word) for a panel head.
export const outButtons = (p) => `<button class="btn sm" type="button" id="${p}-print">Print</button><details class="sd-exp"><summary class="btn sm">Export ▾</summary><div class="sd-menu"><button type="button" data-${p}out="xlsx">Excel</button><button type="button" data-${p}out="pdf">PDF</button><button type="button" data-${p}out="docx">Word</button></div></details>`;
export function wireOut(p, spec, file, onErr) {
  const pr = document.getElementById(`${p}-print`); if (pr) pr.onclick = () => printDoc(spec());
  document.querySelectorAll(`[data-${p}out]`).forEach((b) => { b.onclick = async () => {
    b.closest('details').open = false;
    try { await exportDoc(b.getAttribute(`data-${p}out`), spec(), file); } catch (err) { onErr(err.message || String(err)); } }; });
}

/* ---------- the Report of Checks Issued ---------- */
export const RCI_COLS = [{ h: 'Date', w: 0.88 }, { h: 'Check No.', w: 0.78 }, { h: 'DV / Payroll No.', w: 0.9 }, { h: 'Payee', w: 1.42 }, { h: 'Nature of Payment', w: 2.42 }, { h: 'Amount', w: 1.0, right: true }];
// d: { office, acct, month, rows: [{ date, checkNo, ref, payee, nature, amount, cancelled }], total }
export const rciSpec = (d) => ({ title: 'Report of Checks Issued', sheet: 'RCI', office: d.office, acct: d.acct, month: d.month, cols: RCI_COLS, empty: 'No check issued this month.',
  rows: d.rows.map((x) => (x.cancelled ? [x.date, x.checkNo, x.ref, { t: 'Cancelled', span: 2 }, { t: '–', right: true }] : [x.date, x.checkNo, x.ref, x.payee, x.nature, x.amount])),
  total: [{ t: 'Total', span: 5 }, d.total] });
