// Source Documents · Report of Checks Issued: Print, and Export to Excel, PDF and Word, all in the layout shown on screen
// (title, office, bank · account No. · fund, month, the bordered table, Total). Paper: long (8.5 x 13 in), portrait.
// d: { office, acct, month, rows: [{ date, checkNo, ref, payee, nature, amount (number), cancelled }], total }
import { loadExcelJS } from '../cer/wp.js';

const HEAD = ['Date', 'Check No.', 'DV / Payroll No.', 'Payee', 'Nature of Payment', 'Amount'];
const W_IN = [0.88, 0.78, 0.9, 1.42, 2.42, 1.0];          // column widths, inches (7.4 in of the 7.5 in between margins)
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

/* ---------- Print: the same page, on long paper ---------- */
export function rciHtmlDoc(d) {
  const rows = d.rows.length ? d.rows.map((r) => `<tr><td>${esc(r.date)}</td><td>${esc(r.checkNo)}</td><td>${esc(r.ref)}</td>${r.cancelled ? '<td colspan="2">Cancelled</td><td class="r">–</td>' : `<td>${esc(r.payee)}</td><td>${esc(r.nature)}</td><td class="r">${fmt(r.amount)}</td>`}</tr>`).join('')
    : '<tr><td colspan="6" class="c">No check issued this month.</td></tr>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Report of Checks Issued</title><style>
    @page{size:8.5in 13in; margin:0.5in}
    body{font-family:Arial,Helvetica,sans-serif; font-size:10pt; color:#000; margin:0}
    h1{text-align:center; font-size:13pt; margin:0 0 6pt; letter-spacing:.5px}
    p.h{text-align:center; margin:0 0 10pt; line-height:1.4}
    table{width:100%; border-collapse:collapse; table-layout:fixed}
    th,td{border:1px solid #000; padding:3pt 4pt; vertical-align:top; word-wrap:break-word}
    th{text-align:center; vertical-align:middle; font-weight:bold}
    thead{display:table-header-group} tr{break-inside:avoid}
    .r{text-align:right} .c{text-align:center} tr.tot td{font-weight:bold}
  </style></head><body><h1>REPORT OF CHECKS ISSUED</h1><p class="h"><b>${esc(d.office)}</b><br>${esc(d.acct)}<br>${esc(d.month)}</p>
  <table><colgroup>${W_IN.map((w) => `<col style="width:${w}in">`).join('')}</colgroup><thead><tr>${HEAD.map((h, i) => `<th${i === 5 ? ' class="r"' : ''}>${h}</th>`).join('')}</tr></thead>
  <tbody>${rows}<tr class="tot"><td colspan="5">Total</td><td class="r">${fmt(d.total)}</td></tr></tbody></table></body></html>`;
}
export function printRci(d) {
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(f);
  const doc = f.contentWindow.document; doc.open(); doc.write(rciHtmlDoc(d)); doc.close();
  setTimeout(() => { f.contentWindow.focus(); f.contentWindow.print(); setTimeout(() => f.remove(), 1000); }, 150);
}

/* ---------- Excel ---------- */
export async function xlsxRci(d, file) {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('RCI');
  ws.pageSetup = { paperSize: 14, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true, printTitlesRow: '6:6',
    margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 } };   // 14 = Folio, 8.5 x 13 in
  ws.columns = [11, 11, 13, 21, 36, 14].map((width) => ({ width }));
  const font = { name: 'Arial', size: 10 };
  const line = { style: 'thin', color: { argb: 'FF000000' } }, box = { top: line, left: line, bottom: line, right: line };
  const title = (r, text, f) => { ws.mergeCells(r, 1, r, 6); const c = ws.getCell(r, 1); c.value = text; c.font = { ...font, ...f }; c.alignment = { horizontal: 'center' }; };
  title(1, 'REPORT OF CHECKS ISSUED', { bold: true, size: 13 });
  title(2, d.office, { bold: true }); title(3, d.acct); title(4, d.month);
  const hr = ws.getRow(6); HEAD.forEach((h, i) => { const c = hr.getCell(i + 1); c.value = h; c.font = { ...font, bold: true }; c.border = box; c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; });
  hr.height = 28;
  let r = 7;
  const put = (vals, opt = {}) => {
    const row = ws.getRow(r);
    vals.forEach((v, i) => { const c = row.getCell(i + 1); c.value = v; c.font = { ...font, bold: !!opt.bold }; c.border = box;
      c.alignment = { vertical: 'top', wrapText: true, horizontal: i === 5 ? 'right' : 'left' }; if (i === 5 && typeof v === 'number') c.numFmt = '#,##0.00'; });
    if (opt.merge) ws.mergeCells(r, opt.merge[0], r, opt.merge[1]);
    const longest = Math.max(1, ...[[3, 21], [4, 36], [2, 13]].map(([i, w]) => Math.ceil(String(vals[i] ?? '').length / (w * 1.1))));
    row.height = Math.max(15, longest * 13);
    r++;
  };
  if (!d.rows.length) put(['No check issued this month.', '', '', '', '', ''], { merge: [1, 6] });
  d.rows.forEach((x) => (x.cancelled ? put([x.date, x.checkNo, x.ref, 'Cancelled', '', '–'], { merge: [4, 5] }) : put([x.date, x.checkNo, x.ref, x.payee, x.nature, x.amount])));
  put(['Total', '', '', '', '', d.total], { bold: true, merge: [1, 5] });
  save(new Blob([await wb.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), file);
}

/* ---------- PDF ---------- */
export async function pdfRci(d, file) {
  await loadScript('lib/jspdf.umd.min.js', () => !!window.jspdf);
  await loadScript('lib/jspdf.plugin.autotable.min.js', () => !!(window.jspdf && window.jspdf.jsPDF.API.autoTable));
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'in', format: [8.5, 13], orientation: 'portrait' });
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(13); pdf.text('REPORT OF CHECKS ISSUED', 4.25, 0.75, { align: 'center' });
  pdf.setFontSize(10); pdf.text(d.office, 4.25, 1.0, { align: 'center' });
  pdf.setFont('helvetica', 'normal'); pdf.text(d.acct, 4.25, 1.18, { align: 'center' }); pdf.text(d.month, 4.25, 1.36, { align: 'center' });
  const body = d.rows.length ? d.rows.map((x) => (x.cancelled ? [x.date, x.checkNo, x.ref, { content: 'Cancelled', colSpan: 2 }, '–'] : [x.date, x.checkNo, x.ref, x.payee, x.nature, fmt(x.amount)]))
    : [[{ content: 'No check issued this month.', colSpan: 6, styles: { halign: 'center' } }]];
  body.push([{ content: 'Total', colSpan: 5, styles: { fontStyle: 'bold' } }, { content: fmt(d.total), styles: { fontStyle: 'bold' } }]);
  pdf.autoTable({ startY: 1.55, head: [HEAD], body, theme: 'grid', margin: { left: 0.55, right: 0.55, top: 0.5, bottom: 0.5 },
    styles: { font: 'helvetica', fontSize: 9, textColor: 0, lineColor: 0, lineWidth: 0.01, cellPadding: 0.05, valign: 'top', overflow: 'linebreak' },
    headStyles: { fillColor: false, textColor: 0, fontStyle: 'bold', halign: 'center', valign: 'middle' },
    columnStyles: Object.fromEntries(W_IN.map((w, i) => [i, { cellWidth: w, halign: i === 5 ? 'right' : 'left' }])) });
  save(pdf.output('blob'), file);
}

/* ---------- Word ---------- */
export async function docxRci(d, file) {
  await loadScript('lib/docx.min.js', () => !!window.docx);
  const X = window.docx;
  const TW = 1440, B = { style: X.BorderStyle.SINGLE, size: 4, color: '000000' }, borders = { top: B, bottom: B, left: B, right: B };
  const run = (text, o = {}) => new X.TextRun({ text: String(text ?? ''), font: 'Arial', size: o.size || 20, bold: !!o.bold });
  const para = (text, o = {}) => new X.Paragraph({ alignment: o.align || X.AlignmentType.LEFT, spacing: { after: o.after || 0 }, children: [run(text, o)] });
  const cell = (text, i, o = {}) => new X.TableCell({ borders, columnSpan: o.span, width: { size: Math.round((o.w || W_IN[i]) * TW), type: X.WidthType.DXA },
    verticalAlign: o.head ? X.VerticalAlign.CENTER : X.VerticalAlign.TOP, margins: { top: 40, bottom: 40, left: 70, right: 70 },
    children: [para(text, { bold: o.bold || o.head, align: o.head ? X.AlignmentType.CENTER : i === 5 || o.right ? X.AlignmentType.RIGHT : o.center ? X.AlignmentType.CENTER : X.AlignmentType.LEFT })] });
  const sum = (a, b) => W_IN.slice(a, b).reduce((n, w) => n + w, 0);
  const rows = [new X.TableRow({ tableHeader: true, cantSplit: true, children: HEAD.map((h, i) => cell(h, i, { head: true })) })];
  if (!d.rows.length) rows.push(new X.TableRow({ children: [cell('No check issued this month.', 0, { span: 6, w: sum(0, 6), center: true })] }));
  d.rows.forEach((x) => rows.push(new X.TableRow({ cantSplit: true, children: x.cancelled
    ? [cell(x.date, 0), cell(x.checkNo, 1), cell(x.ref, 2), cell('Cancelled', 3, { span: 2, w: sum(3, 5) }), cell('–', 5)]
    : [cell(x.date, 0), cell(x.checkNo, 1), cell(x.ref, 2), cell(x.payee, 3), cell(x.nature, 4), cell(fmt(x.amount), 5)] })));
  rows.push(new X.TableRow({ cantSplit: true, children: [cell('Total', 0, { span: 5, w: sum(0, 5), bold: true }), cell(fmt(d.total), 5, { bold: true })] }));
  const C = X.AlignmentType.CENTER;
  const doc = new X.Document({ sections: [{
    properties: { page: { size: { width: 8.5 * TW, height: 13 * TW }, margin: { top: 0.5 * TW, bottom: 0.5 * TW, left: 0.5 * TW, right: 0.5 * TW } } },
    children: [para('REPORT OF CHECKS ISSUED', { bold: true, size: 26, align: C, after: 120 }), para(d.office, { bold: true, align: C }), para(d.acct, { align: C }), para(d.month, { align: C, after: 200 }),
      new X.Table({ width: { size: Math.round(sum(0, 6) * TW), type: X.WidthType.DXA }, columnWidths: W_IN.map((w) => Math.round(w * TW)), layout: X.TableLayoutType.FIXED, rows })] }] });
  save(await X.Packer.toBlob(doc), file);
}
