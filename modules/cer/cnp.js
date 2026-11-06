// CER · Working paper: Schedule of Collections Not Presented at the Last Cash Examination (design approved 6 Nov 2026).
// Collections dated before the last cash exam whose OR series was remitted (or deposited) in this period: what the officer
// still held at the last exam. Less the balance accounted for then (Audit Setup) = collections not presented at that exam.
// The GF 74-A stays as is; this working paper is the one place it is shown (with a finding in the Auditor's Notes).
import { esc } from '../../js/ui.js';
import { fmtDate, money } from './cer.js';

const r2 = (n) => Math.round((+n || 0) * 100) / 100;
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const nm = (v) => String(v || '').toLowerCase().replace(/[^a-z]/g, '');

export function cnpData(f, o, exam, from, to) {
  if (!from) return null;
  const inS = (d) => !!d && d >= from && d <= to;
  const amt = (x) => r2((x.items || []).reduce((n, i) => n + (+i.amt || 0), 0));
  const mx = (x) => (x.range ? +x.serialTo : +x.serial);
  // Remittances / deposits of this period with their series: typed by the officer, or by the Liquidating Officer.
  const rems = [
    ...f.reports.filter((r) => r.officerId === o.id).flatMap((r) => (r.deposits || []).filter((d) => d.from && inS(d.date)).map((d) => ({ date: d.date, to: d.toLO ? d.ref : 'Bank', a: +d.from, z: +(d.to || d.from), amount: +d.amount || 0 }))),
    ...f.reports.filter((r) => r.officerId !== o.id).flatMap((r) => (r.remittances || []).filter((m) => m.collectorId === o.id && m.from && inS(m.date) && !m.beg)
      .map((m) => ({ date: m.date, to: f.officers.find((x) => x.id === r.officerId)?.name || 'Liquidating Officer', a: +m.from, z: +(m.to || m.from), amount: +m.amount || 0 })))];
  const lines = f.ors.filter((x) => x.officerId === o.id && x.status !== 'cancelled' && x.date && x.date < from).map((x) => {
    const rm = rems.filter((m) => +x.serial >= m.a && mx(x) <= m.z).sort((a, b) => a.date.localeCompare(b.date))[0];
    return rm ? { date: x.date, a: +x.serial, z: mx(x), amount: amt(x), rem: rm, held: days(x.date, rm.date) } : null;
  }).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date) || a.a - b.a);
  const total = r2(lines.reduce((n, l) => n + l.amount, 0));
  const beg = r2(Object.entries(exam.balances || {}).filter(([k]) => k.startsWith('col-')).reduce((n, [, v]) => n + (+v?.amount || 0), 0));
  return { lines, total, beg, notPresented: r2(Math.max(0, total - beg)), from, to };
}

export function cnpHtml(c) {
  const { f, o, exam, A, agency } = c;
  const d = cnpData(f, o, exam, A.from, A.to);
  const head = `<h2 class="rp-title">SCHEDULE OF COLLECTIONS NOT PRESENTED AT THE LAST CASH EXAMINATION</h2>
    <p class="c"><b>${esc(o.name)}</b>${o.designation ? ' · ' + esc(o.designation) : ''} · ${esc(agency)}<br>Last cash examination: ${esc(fmtDate(A.from)) || '—'} · Cash count: ${esc(fmtDate(A.to))}</p>`;
  if (!d || !d.lines.length) return { html: `<div class="rp-page rp-wide">${head}<p class="c dim">None: no collection dated before the last cash examination was remitted in this period (collections by OR range with the remittance series, Cashbook only).</p></div>` };
  const rows = d.lines.map((l) => `<tr><td>${esc(fmtDate(l.date))}</td><td class="mono">${l.a === l.z ? l.a : `${l.a} – ${l.z}`}</td><td class="r">${money(l.amount)}</td><td>${esc(fmtDate(l.rem.date))}</td><td>${esc(l.rem.to)}</td><td class="mono">${l.rem.a}–${l.rem.z}</td><td class="r">${l.held}</td></tr>`).join('');
  return { html: `<div class="rp-page rp-wide">${head}
    <table class="rp-t"><thead><tr><th>Date of Collection</th><th>OR Series</th><th class="r">Amount</th><th>Date Remitted</th><th>Remitted to</th><th>Remittance Series</th><th class="r">Days Held</th></tr></thead>
    <tbody>${rows}<tr class="tot"><td colspan="2">Total</td><td class="r">${money(d.total)}</td><td colspan="4"></td></tr></tbody></table>
    <table class="rp-t" style="max-width:640px;margin-top:14px"><tbody>
      <tr><td>Collections before the last cash examination, remitted this period</td><td class="r">${money(d.total)}</td></tr>
      <tr><td>Less: Balance accounted for at the last cash examination (Audit Setup)</td><td class="r">${money(d.beg)}</td></tr>
      <tr class="tot"><td>Collections not presented at the last cash examination</td><td class="r">${money(d.notPresented)}</td></tr></tbody></table></div>` };
}

// Excel: one sheet in the working papers.
export function cnpSheet(wb, c) {
  const { f, o, exam, A, agency } = c;
  const d = cnpData(f, o, exam, A.from, A.to);
  if (!d || !d.lines.length) return;
  const ws = wb.addWorksheet('WP-NOT PRESENTED');
  ws.columns = [14, 22, 14, 14, 26, 22, 10].map((width) => ({ width }));
  const B = { style: 'thin', color: { argb: 'FF000000' } }, box = { top: B, left: B, bottom: B, right: B };
  const put = (r, vals, o2 = {}) => vals.forEach((v, i) => { const cl = ws.getCell(r, i + 1); cl.value = v; cl.font = { name: 'Arial', size: 10, bold: !!o2.bold }; if (o2.box) cl.border = box; if (typeof v === 'number' && i !== 6) cl.numFmt = '#,##0.00'; cl.alignment = { vertical: 'top', wrapText: true }; });
  ws.mergeCells(1, 1, 1, 7); put(1, ['SCHEDULE OF COLLECTIONS NOT PRESENTED AT THE LAST CASH EXAMINATION'], { bold: true }); ws.getCell(1, 1).alignment = { horizontal: 'center' };
  ws.mergeCells(2, 1, 2, 7); put(2, [`${o.name}${o.designation ? ' · ' + o.designation : ''} · ${agency}`]); ws.getCell(2, 1).alignment = { horizontal: 'center' };
  ws.mergeCells(3, 1, 3, 7); put(3, [`Last cash examination: ${fmtDate(A.from)} · Cash count: ${fmtDate(A.to)}`]); ws.getCell(3, 1).alignment = { horizontal: 'center' };
  put(5, ['Date of Collection', 'OR Series', 'Amount', 'Date Remitted', 'Remitted to', 'Remittance Series', 'Days Held'], { bold: true, box: true });
  let r = 6;
  d.lines.forEach((l) => { put(r++, [fmtDate(l.date), l.a === l.z ? String(l.a) : `${l.a} – ${l.z}`, l.amount, fmtDate(l.rem.date), l.rem.to, `${l.rem.a}–${l.rem.z}`, l.held], { box: true }); });
  put(r++, ['Total', '', d.total, '', '', '', ''], { bold: true, box: true });
  r++;
  put(r++, ['Collections before the last cash examination, remitted this period', '', d.total]);
  put(r++, ['Less: Balance accounted for at the last cash examination (Audit Setup)', '', d.beg]);
  put(r++, ['Collections not presented at the last cash examination', '', d.notPresented], { bold: true });
}
