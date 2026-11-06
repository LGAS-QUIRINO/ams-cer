// CER · Working paper: Schedule of Collections Not Presented at the Last Cash Examination (design approved 6 Nov 2026).
// Collections dated before the last cash exam whose OR series was remitted (or deposited) in this period: what the officer
// still held at the last exam. Less the balance accounted for then (Audit Setup) = collections not presented at that exam.
// The GF 74-A stays as is; this working paper is the one place it is shown (with a finding in the Auditor's Notes).
import { esc } from '../../js/ui.js';
import { fmtDate, money } from './cer.js';
import { FORM_SHORT } from './forms.js';

const r2 = (n) => Math.round((+n || 0) * 100) / 100;
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const nm = (v) => String(v || '').toLowerCase().replace(/[^a-z]/g, '');

// One section per form (design approved 7 Nov 2026): its lines, subtotal, less its own balance at the last exam, and a summary.
const TITLE = { af51: 'ACCOUNTABLE FORM 51', af51b: 'ACCOUNTABLE FORM 51', ctci: 'COMMUNITY TAX CERTIFICATE – INDIVIDUAL (CTC)', ctcc: 'COMMUNITY TAX CERTIFICATE – CORPORATE (CTC)' };
const SHORT = { af51: 'AF 51', af51b: 'AF 51', ctci: 'CTC – Individual', ctcc: 'CTC – Corporate' };
const ORDER = ['af51', 'af51b', 'ctci', 'ctcc'];
const titleOf = (k) => TITLE[k] || String(FORM_SHORT[k] || k).toUpperCase();
const shortOf = (k) => SHORT[k] || FORM_SHORT[k] || k;
const serHead = (k) => (/^ctc/.test(k) ? 'CTC Series' : 'OR Series');
const LET = 'ABCDEFGHIJ';

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
    return rm ? { form: x.form || '', date: x.date, a: +x.serial, z: mx(x), amount: amt(x), rem: rm, held: days(x.date, rm.date) } : null;
  }).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date) || a.a - b.a);
  const bal = exam.balances || {};
  const keys = [...new Set(lines.map((l) => l.form))].sort((a, b) => ((ORDER.indexOf(a) + 1) || 99) - ((ORDER.indexOf(b) + 1) || 99) || a.localeCompare(b));
  const groups = keys.map((k) => {
    const ls = lines.filter((l) => l.form === k), total = r2(ls.reduce((n, l) => n + l.amount, 0)), beg = r2(+bal['col-' + k]?.amount || 0);
    return { form: k, title: titleOf(k), short: shortOf(k), ser: serHead(k), lines: ls, total, beg, notPresented: r2(Math.max(0, total - beg)) };
  });
  const T = (k) => r2(groups.reduce((n, g) => n + g[k], 0));
  return { lines, groups, total: T('total'), beg: T('beg'), notPresented: T('notPresented'), from, to };
}

export function cnpHtml(c) {
  const { f, o, exam, A, agency } = c;
  const d = cnpData(f, o, exam, A.from, A.to);
  const head = `<h2 class="rp-title">SCHEDULE OF COLLECTIONS NOT PRESENTED AT THE LAST CASH EXAMINATION</h2>
    <p class="c"><b>${esc(o.name)}</b>${o.designation ? ' · ' + esc(o.designation) : ''} · ${esc(agency)}<br>Last cash examination: ${esc(fmtDate(A.from)) || '—'} · Cash count: ${esc(fmtDate(A.to))}</p>`;
  if (!d || !d.lines.length) return { html: `<div class="rp-page rp-wide">${head}<p class="c dim">None: no collection dated before the last cash examination was remitted in this period (collections by OR range with the remittance series, Cashbook only).</p></div>` };
  const sec = (g, i) => `<h3 class="cnp-h">${LET[i] || ''}. ${esc(g.title)}</h3>
    <table class="rp-t"><thead><tr><th>Date of Collection</th><th>${g.ser}</th><th class="r">Amount</th><th>Date Remitted</th><th>Remitted to</th><th>Remittance Series</th><th class="r">Days Held</th></tr></thead>
    <tbody>${g.lines.map((l) => `<tr><td>${esc(fmtDate(l.date))}</td><td class="mono">${l.a === l.z ? l.a : `${l.a} – ${l.z}`}</td><td class="r">${money(l.amount)}</td><td>${esc(fmtDate(l.rem.date))}</td><td>${esc(l.rem.to)}</td><td class="mono">${l.rem.a}–${l.rem.z}</td><td class="r">${l.held}</td></tr>`).join('')}
      <tr class="tot"><td colspan="2">Subtotal, ${esc(g.short)}</td><td class="r">${money(g.total)}</td><td colspan="4"></td></tr></tbody></table>
    <table class="rp-t cnp-calc"><tbody>
      <tr><td>Collections before the last cash examination, remitted this period</td><td class="r">${money(g.total)}</td></tr>
      <tr><td>Less: ${esc(g.short)} balance at the last cash examination (Audit Setup)</td><td class="r">${money(g.beg)}</td></tr>
      <tr class="tot"><td>${esc(g.short)} collections not presented at the last cash examination</td><td class="r">${money(g.notPresented)}</td></tr></tbody></table>`;
  const sum = `<h3 class="cnp-h">SUMMARY</h3><table class="rp-t cnp-calc"><thead><tr><th>Form</th><th class="r">Before last exam, remitted now</th><th class="r">Balance at last exam</th><th class="r">Not presented</th></tr></thead>
    <tbody>${d.groups.map((g) => `<tr><td>${esc(g.short)}</td><td class="r">${money(g.total)}</td><td class="r">${money(g.beg)}</td><td class="r">${money(g.notPresented)}</td></tr>`).join('')}
      <tr class="tot"><td>Total</td><td class="r">${money(d.total)}</td><td class="r">${money(d.beg)}</td><td class="r">${money(d.notPresented)}</td></tr></tbody></table>`;
  return { html: `<div class="rp-page rp-wide">${head}${d.groups.map(sec).join('')}${sum}</div>` };
}

// Excel: one sheet in the working papers, the same sections and summary.
export function cnpSheet(wb, c) {
  const { f, o, exam, A, agency } = c;
  const d = cnpData(f, o, exam, A.from, A.to);
  if (!d || !d.lines.length) return;
  const ws = wb.addWorksheet('WP-NOT PRESENTED');
  ws.columns = [14, 22, 14, 14, 26, 22, 10].map((width) => ({ width }));
  const B = { style: 'thin', color: { argb: 'FF000000' } }, box = { top: B, left: B, bottom: B, right: B };
  const put = (r, vals, o2 = {}) => vals.forEach((v, i) => { const cl = ws.getCell(r, i + 1); cl.value = v; cl.font = { name: 'Arial', size: 10, bold: !!o2.bold }; if (o2.box) cl.border = box; if (typeof v === 'number' && (i !== 6 || o2.money)) cl.numFmt = '#,##0.00'; cl.alignment = { vertical: 'top', wrapText: !o2.nowrap }; });
  ws.mergeCells(1, 1, 1, 7); put(1, ['SCHEDULE OF COLLECTIONS NOT PRESENTED AT THE LAST CASH EXAMINATION'], { bold: true }); ws.getCell(1, 1).alignment = { horizontal: 'center' };
  ws.mergeCells(2, 1, 2, 7); put(2, [`${o.name}${o.designation ? ' · ' + o.designation : ''} · ${agency}`]); ws.getCell(2, 1).alignment = { horizontal: 'center' };
  ws.mergeCells(3, 1, 3, 7); put(3, [`Last cash examination: ${fmtDate(A.from)} · Cash count: ${fmtDate(A.to)}`]); ws.getCell(3, 1).alignment = { horizontal: 'center' };
  let r = 5;
  d.groups.forEach((g, i) => {
    put(r++, [`${LET[i] || ''}. ${g.title}`], { bold: true, nowrap: true });
    put(r++, ['Date of Collection', g.ser, 'Amount', 'Date Remitted', 'Remitted to', 'Remittance Series', 'Days Held'], { bold: true, box: true });
    g.lines.forEach((l) => { put(r++, [fmtDate(l.date), l.a === l.z ? String(l.a) : `${l.a} – ${l.z}`, l.amount, fmtDate(l.rem.date), l.rem.to, `${l.rem.a}–${l.rem.z}`, l.held], { box: true }); });
    put(r++, [`Subtotal, ${g.short}`, '', g.total, '', '', '', ''], { bold: true, box: true });
    put(r++, ['Collections before the last cash examination, remitted this period', '', '', '', '', '', g.total], { money: true, nowrap: true });
    put(r++, [`Less: ${g.short} balance at the last cash examination (Audit Setup)`, '', '', '', '', '', g.beg], { money: true, nowrap: true });
    put(r++, [`${g.short} collections not presented at the last cash examination`, '', '', '', '', '', g.notPresented], { bold: true, money: true, nowrap: true });
    r++;
  });
  put(r++, ['SUMMARY'], { bold: true });
  const sumRow = (vals, o2) => { put(r, [vals[0], '', vals[1], '', vals[2], '', vals[3]], { box: true, money: true, ...o2 }); ws.mergeCells(r, 1, r, 2); ws.mergeCells(r, 3, r, 4); ws.mergeCells(r, 5, r, 6); r++; };
  sumRow(['Form', 'Before last exam, remitted now', 'Balance at last exam', 'Not presented'], { bold: true });
  d.groups.forEach((g) => sumRow([g.short, g.total, g.beg, g.notPresented]));
  sumRow(['Total', d.total, d.beg, d.notPresented], { bold: true });
}
