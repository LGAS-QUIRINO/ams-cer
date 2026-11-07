// CER · Working paper: Schedule of Collections Not Presented at the Last Cash Examination (design approved 6 Nov 2026).
// Collections dated before the last cash exam whose OR series was remitted (or deposited) in this period: what the officer
// still held at the last exam. Less the balance accounted for then (Audit Setup) = collections not presented at that exam.
// The GF 74-A stays as is; this working paper is the one place it is shown (with a finding in the Auditor's Notes).
import { esc } from '../../js/ui.js';
import { fmtDate, money } from './cer.js';
import { FORM_SHORT, mergeRanges, rangesText, countRanges } from './forms.js';
import { wpPage, wcell, wtitle } from './wp.js';

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
// "9394901-9394911; 9394915" → [[9394901, 9394911], [9394915, 9394915]]
const parseSer = (t) => String(t || '').split(/[;,]/).map((p) => p.trim()).filter(Boolean).map((p) => { const m = p.replace(/\s/g, '').match(/^(\d+)(?:[-–](\d+))?$/); if (!m) return null; const a = +m[1], z = +(m[2] || m[1]); return z >= a ? [a, z] : null; }).filter(Boolean);

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
    return rm ? { form: x.form || '', bookletId: x.bookletId || '', reportId: x.reportId || '', date: x.date, a: +x.serial, z: mx(x), amount: amt(x), rem: rm, held: days(x.date, rm.date) } : null;
  }).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date) || a.a - b.a);
  const bal = exam.balances || {};
  // The OR series of a beginning balance (Audit Setup, when known): those ORs were presented at the last cash exam, so they are
  // left out here; only the part of the balance they do not cover is deducted.
  const begSer = {}; Object.entries(bal).forEach(([k, v]) => { if (k.startsWith('col-') && v && v.series) { const rs = parseSer(v.series); if (rs.length) begSer[k.slice(4)] = rs; } });
  const begIn = {};   // per form: amount of the remitted lines inside the beginning series
  const kept = [];
  lines.forEach((l) => {
    const rs = begSer[l.form]; if (!rs) { kept.push(l); return; }
    const n = l.z - l.a + 1, cov = rs.reduce((t, [a, z]) => t + Math.max(0, Math.min(z, l.z) - Math.max(a, l.a) + 1), 0);
    const inAmt = r2(l.amount * Math.min(1, cov / n)); begIn[l.form] = r2((begIn[l.form] || 0) + inAmt);
    if (cov < n) kept.push(cov ? { ...l, amount: r2(l.amount - inAmt), partBeg: cov } : l);
  });
  const keys = [...new Set(kept.map((l) => l.form))].sort((a, b) => ((ORDER.indexOf(a) + 1) || 99) - ((ORDER.indexOf(b) + 1) || 99) || a.localeCompare(b));
  const groups = keys.map((k) => {
    const ls = kept.filter((l) => l.form === k), total = r2(ls.reduce((n, l) => n + l.amount, 0)), begAll = r2(+bal['col-' + k]?.amount || 0);
    const beg = begSer[k] ? r2(Math.max(0, begAll - (begIn[k] || 0))) : begAll;
    return { form: k, title: titleOf(k), short: shortOf(k), ser: serHead(k), lines: ls, total, beg, begAll, begIn: begIn[k] || 0, series: begSer[k] || null, notPresented: r2(Math.max(0, total - beg)) };
  });
  // Each beginning series against the ORs encoded in it (for Verification).
  const begCheck = Object.entries(begSer).map(([k, rs]) => {
    const ors = f.ors.filter((x) => x.officerId === o.id && x.form === k && x.status !== 'cancelled' && rs.some(([a, z]) => +x.serial >= a && mx(x) <= z));
    return { form: k, short: shortOf(k), text: rangesText(rs), beg: r2(+bal['col-' + k]?.amount || 0), ors: r2(ors.reduce((n, x) => n + amt(x), 0)) };
  });
  const T = (k) => r2(groups.reduce((n, g) => n + g[k], 0));
  return { lines: kept, groups, begSer, begCheck, total: T('total'), beg: T('beg'), notPresented: T('notPresented'), from, to };
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
      <tr><td>Less: ${esc(g.short)} balance at the last cash examination (Audit Setup)${g.series ? `, not covered by its series ${esc(rangesText(g.series))}` : ''}</td><td class="r">${money(g.beg)}</td></tr>
      <tr class="tot"><td>${esc(g.short)} collections not presented at the last cash examination</td><td class="r">${money(g.notPresented)}</td></tr></tbody></table>`;
  const sum = `<h3 class="cnp-h">SUMMARY</h3><table class="rp-t cnp-calc"><thead><tr><th>Form</th><th class="r">Before last exam, remitted now</th><th class="r">Balance at last exam</th><th class="r">Not presented</th></tr></thead>
    <tbody>${d.groups.map((g) => `<tr><td>${esc(g.short)}</td><td class="r">${money(g.total)}</td><td class="r">${money(g.beg)}</td><td class="r">${money(g.notPresented)}</td></tr>`).join('')}
      <tr class="tot"><td>Total</td><td class="r">${money(d.total)}</td><td class="r">${money(d.beg)}</td><td class="r">${money(d.notPresented)}</td></tr></tbody></table>`;
  return { html: `<div class="rp-page rp-wide">${head}${d.groups.map(sec).join('')}${sum}</div>` };
}

// Excel: one sheet in the working papers, drawn like the screen (sections, computation, summary).
export function cnpSheet(wb, c) {
  const { f, o, exam, A, agency } = c;
  const d = cnpData(f, o, exam, A.from, A.to);
  if (!d || !d.lines.length) return;
  const ws = wb.addWorksheet('WP-NOT PRESENTED');
  ws.columns = [14, 24, 15, 14, 28, 24, 11].map((width) => ({ width }));
  wpPage(ws, true);
  const H = { b: true, box: true, al: 'center', fill: 'FFF0F0F0' }, T = { b: true, box: true, fill: 'FFF3F4F6' };
  wtitle(ws, 1, 7, 'SCHEDULE OF COLLECTIONS NOT PRESENTED AT THE LAST CASH EXAMINATION', { b: true, sz: 12 });
  wtitle(ws, 2, 7, `${o.name}${o.designation ? ' · ' + o.designation : ''} · ${agency}`);
  wtitle(ws, 3, 7, `Last cash examination: ${fmtDate(A.from)} · Cash count: ${fmtDate(A.to)}`);
  // A line across columns a–b (merged), the rest as given.
  const span = (r, a, b, v, o2) => { wcell(ws, r, a, v, o2); for (let k = a + 1; k <= b; k++) wcell(ws, r, k, null, { ...o2, keep: true }); ws.mergeCells(r, a, r, b); };
  let r = 5;
  d.groups.forEach((g, i) => {
    wcell(ws, r++, 1, `${LET[i] || ''}. ${g.title}`, { b: true, wrap: false });
    ['Date of Collection', g.ser, 'Amount', 'Date Remitted', 'Remitted to', 'Remittance Series', 'Days Held'].forEach((t, k) => wcell(ws, r, k + 1, t, H)); r++;
    g.lines.forEach((l) => { [fmtDate(l.date), l.a === l.z ? String(l.a) : `${l.a} – ${l.z}`, l.amount, fmtDate(l.rem.date), l.rem.to, `${l.rem.a}–${l.rem.z}`, l.held].forEach((v, k) => wcell(ws, r, k + 1, v, { box: true, ...(k === 6 ? { n: '0' } : {}), ...([0, 1, 3, 5].includes(k) ? { al: 'center' } : {}) })); r++; });
    span(r, 1, 2, `Subtotal, ${g.short}`, T); wcell(ws, r, 3, g.total, T); span(r, 4, 7, null, T); r++;
    r++;
    // The amounts in F–G, the same column as Not presented in the summary.
    span(r, 1, 5, 'Collections before the last cash examination, remitted this period', { box: true }); span(r++, 6, 7, g.total, { box: true });
    span(r, 1, 5, `Less: ${g.short} balance at the last cash examination (Audit Setup)${g.series ? `, not covered by its series ${rangesText(g.series)}` : ''}`, { box: true }); span(r++, 6, 7, g.beg, { box: true });
    span(r, 1, 5, `${g.short} collections not presented at the last cash examination`, T); span(r++, 6, 7, g.notPresented, T);
    r++;
  });
  wcell(ws, r++, 1, 'SUMMARY', { b: true });
  span(r, 1, 2, 'Form', H); span(r, 3, 4, 'Before last exam, remitted now', H); wcell(ws, r, 5, 'Balance at last exam', H); span(r++, 6, 7, 'Not presented', H);
  const sumRow = (vals, o2) => { span(r, 1, 2, vals[0], o2); span(r, 3, 4, vals[1], o2); wcell(ws, r, 5, vals[2], o2); span(r++, 6, 7, vals[3], o2); };
  d.groups.forEach((g) => sumRow([g.short, g.total, g.beg, g.notPresented], { box: true }));
  sumRow(['Total', d.total, d.beg, d.notPresented], T);
}

/* ---------- Accountable forms not presented at the last cash examination (design approved 7 Nov 2026) ----------
   The forms side of the schedule above: the same ORs (issued before the last cash exam, remitted this period), by form,
   as series From / To / Qty. Left out: the ORs of the beginning balance, by its series in Audit Setup; without a series,
   the latest ORs before the last exam up to the beginning amount (assumed: what is on hand at a count is the latest). */
export function fnpData(f, o, exam, from, to) {
  const d = cnpData(f, o, exam, from, to); if (!d || !d.lines.length) return null;
  const groups = d.groups.map((g) => {
    let ls = g.lines, assumed = [], assumedAmt = 0;
    if (!g.series && g.begAll > 0.004) {
      let cum = 0; const take = new Set();
      [...ls].sort((a, b) => b.date.localeCompare(a.date) || b.a - a.a).some((l) => { if (cum + l.amount > g.begAll + 0.004) return true; cum = r2(cum + l.amount); take.add(l); return false; });
      assumed = mergeRanges([...take].map((l) => [l.a, l.z])); assumedAmt = cum; ls = ls.filter((l) => !take.has(l));
    }
    // Rows: the series merged per date reported (the RCD's date, or the remittance date when not yet in an RCD).
    const repDate = (l) => { const r = l.reportId && f.reports.find((x) => x.id === l.reportId && !x.pending); return (r && r.date) || l.rem.date || ''; };
    const byDate = {}; ls.forEach((l) => { (byDate[repDate(l)] = byDate[repDate(l)] || []).push([l.a, l.z]); });
    // Amount of a row: the collections of the lines in its series and date (as in the collections schedule).
    const rows = Object.entries(byDate).flatMap(([dt, rr]) => mergeRanges(rr).map(([a, z]) => ({ a, z, qty: z - a + 1, date: dt,
      amount: r2(ls.filter((l) => repDate(l) === dt && l.a >= a && l.z <= z).reduce((n, l) => n + l.amount, 0)) }))).sort((x, y) => x.a - y.a);
    const rs = mergeRanges(ls.map((l) => [l.a, l.z]));
    const amount = r2(rows.reduce((n, x) => n + x.amount, 0));
    // Ties to the collections schedule; a difference only from a beginning balance not matched to whole ORs.
    const diff = r2(amount - g.notPresented);
    return { form: g.form, title: g.title, short: g.short, rows, qty: countRanges(rs), amount, diff,
      note: g.series ? `Not listed: ${rangesText(g.series)} (₱${money(g.begIn)}), in the beginning balance at the last cash examination (series per Audit Setup).`
        : assumed.length ? `Not listed: ${rangesText(assumed)} (₱${money(assumedAmt)}), assumed in the beginning balance of ₱${money(g.begAll)} (the latest before the last cash examination; no series in Audit Setup).` : '' };
  }).filter((g) => g.qty || g.note);
  const qty = groups.reduce((n, g) => n + g.qty, 0), amount = r2(groups.reduce((n, g) => n + (g.qty ? g.amount : 0), 0));
  return qty ? { groups: groups.filter((g) => g.qty), all: groups, qty, amount, from, to } : null;
}

export function fnpHtml(c) {
  const { f, o, exam, A, agency } = c;
  const d = fnpData(f, o, exam, A.from, A.to);
  const head = `<h2 class="rp-title">SCHEDULE OF ACCOUNTABLE FORMS NOT PRESENTED AT THE LAST CASH EXAMINATION</h2>
    <p class="c"><b>${esc(o.name)}</b>${o.designation ? ' · ' + esc(o.designation) : ''} · ${esc(agency)}<br>Last cash examination: ${esc(fmtDate(A.from)) || '—'} · Cash count: ${esc(fmtDate(A.to))}</p>`;
  if (!d) return { portrait: true, html: `<div class="rp-page">${head}<p class="c dim">None: every OR issued before the last cash examination and remitted in this period was in the beginning balance.</p></div>` };
  // Centred on the page, every block the same width so the headings and tables line up.
  const sec = (g, i) => `<div class="fnp-blk"><h3 class="cnp-h">${LET[i] || ''}. ${esc(g.title)}</h3>
    <table class="rp-t fnp-t"><thead><tr><th class="c">From</th><th class="c">To</th><th class="r">Qty.</th><th class="r">Amount</th><th class="c">Date Reported</th></tr></thead>
    <tbody>${g.rows.map((r) => `<tr><td class="mono c">${r.a}</td><td class="mono c">${r.z}</td><td class="r">${r.qty}</td><td class="r">${money(r.amount)}</td><td class="c">${esc(fmtDate(r.date))}</td></tr>`).join('')}
      <tr class="tot"><td colspan="2">Subtotal, ${esc(g.short)}</td><td class="r">${g.qty}</td><td class="r">${money(g.amount)}</td><td></td></tr>
      ${Math.abs(g.diff) > 0.004 ? `<tr><td colspan="3"><i>Difference from the collections schedule (beginning balance not matched to whole ORs)</i></td><td class="r"><i>${money(g.diff)}</i></td><td></td></tr>` : ''}</tbody></table>${g.note ? `<p class="rp-note">${esc(g.note)}</p>` : ''}</div>`;
  const sum = `<div class="fnp-blk"><h3 class="cnp-h">SUMMARY</h3><table class="rp-t fnp-sum"><thead><tr><th>Form</th><th class="r">Qty. (pcs)</th><th class="r">Amount</th></tr></thead>
    <tbody>${d.groups.map((g) => `<tr><td>${esc(g.short)}</td><td class="r">${g.qty}</td><td class="r">${money(g.amount)}</td></tr>`).join('')}<tr class="tot"><td>Total</td><td class="r">${d.qty}</td><td class="r">${money(d.amount)}</td></tr></tbody></table></div>`;
  return { portrait: true, html: `<div class="rp-page">${head}${d.groups.map(sec).join('')}${sum}</div>` };
}

export function fnpSheet(wb, c) {
  const { f, o, exam, A, agency } = c;
  const d = fnpData(f, o, exam, A.from, A.to); if (!d) return;
  const ws = wb.addWorksheet('WP-FORMS NOT PRESENTED');
  ws.columns = [5, 16, 16, 9, 16, 16, 5].map((width) => ({ width }));   // the table in B–F, centred on the page
  wpPage(ws, false);
  const H = { b: true, box: true, al: 'center', fill: 'FFF0F0F0' }, T = { b: true, box: true, fill: 'FFF3F4F6' };
  wtitle(ws, 1, 7, 'SCHEDULE OF ACCOUNTABLE FORMS NOT PRESENTED AT THE LAST CASH EXAMINATION', { b: true, sz: 12 });
  ws.getRow(1).height = 32;
  wtitle(ws, 2, 7, `${o.name}${o.designation ? ' · ' + o.designation : ''} · ${agency}`);
  wtitle(ws, 3, 7, `Last cash examination: ${fmtDate(A.from)} · Cash count: ${fmtDate(A.to)}`);
  const span = (r, a, b, v, o2) => { wcell(ws, r, a, v, o2); for (let k = a + 1; k <= b; k++) wcell(ws, r, k, null, { ...o2, keep: true }); ws.mergeCells(r, a, r, b); };
  let r = 5;
  d.groups.forEach((g, i) => {
    wcell(ws, r++, 2, `${LET[i] || ''}. ${g.title}`, { b: true, wrap: false });
    ['From', 'To', 'Qty.', 'Amount', 'Date Reported'].forEach((t, k) => wcell(ws, r, k + 2, t, H)); r++;
    g.rows.forEach((x) => { [String(x.a), String(x.z), x.qty, x.amount, fmtDate(x.date)].forEach((v, k) => wcell(ws, r, k + 2, v, { box: true, ...(k === 2 ? { n: '0' } : k === 3 ? {} : { al: 'center' }) })); r++; });
    span(r, 2, 3, `Subtotal, ${g.short}`, T); wcell(ws, r, 4, g.qty, { ...T, n: '0' }); wcell(ws, r, 5, g.amount, T); wcell(ws, r++, 6, null, T);
    if (Math.abs(g.diff) > 0.004) { span(r, 2, 4, 'Difference from the collections schedule (beginning balance not matched to whole ORs)', { i: true, box: true }); wcell(ws, r, 5, g.diff, { i: true, box: true }); wcell(ws, r, 6, null, { box: true }); ws.getRow(r).height = 28; r++; }
    if (g.note) { span(r, 2, 6, g.note, { i: true }); ws.getRow(r).height = 28; r++; }
    r++;
  });
  wcell(ws, r++, 2, 'SUMMARY', { b: true });
  span(r, 2, 3, 'Form', H); wcell(ws, r, 4, 'Qty. (pcs)', H); span(r, 5, 6, 'Amount', H); r++;
  d.groups.forEach((g) => { span(r, 2, 3, g.short, { box: true }); wcell(ws, r, 4, g.qty, { box: true, n: '0' }); span(r, 5, 6, g.amount, { box: true }); r++; });
  span(r, 2, 3, 'Total', T); wcell(ws, r, 4, d.qty, { ...T, n: '0' }); span(r, 5, 6, d.amount, T);
}
