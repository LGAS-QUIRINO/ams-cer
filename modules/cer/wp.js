// CER · Working papers (Annex A.1a, A.1b, A.2a), Reconciliation Statements (Annex E, F, G) and the two Excel downloads
// (Report, Working Papers) in the layout of the team's CER workbook (lib/cer-report.xlsx, lib/cer-wp.xlsx).
//
// Per CashBook in the working papers: the same as Per Audit unless a line is edited. Edits are kept with the officer's
// Verification record: cer_verify.wp{ a1a|a1b|a2a: { <line key>: { d, c } } } (d = collections / cash advance, c = deposits / liquidation).
import { cnpSheet, fnpSheet } from './cnp.js';
import { itemText } from './count.js';
import { store } from '../../js/store.js';
import { esc, modal, toast, $, $$ } from '../../js/ui.js';
import { by, fmtDate, money, num } from './cer.js';
import { kindOfForm, depRefText, partOk, ctcBegShare, ctcAlloc, depPart, repName, depsBeforeOrs } from './collections.js';
import { accountsOf, caFund, begByFund, restFund, fundOrder } from './funds.js';
import { saafRows, unusedFormsOf, notPresentedOf, countRanges, FORM_SHORT, faceOf } from './forms.js';

const r2 = (n) => Math.round(n * 100) / 100;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const BILLS = [1000, 500, 200, 100, 50, 20];
export const WP = { a1a: 'Annex A.1a', a1b: 'Annex A.1b', a2a: 'Annex A.2a' };

/* ---------- the lines of each working paper ---------- */
// book: the column of the statement of accountability (col-SCD / col-RCD → A.1a, col-SCR / col-CTC (LGU) → A.1b, ca → A.2a).
export const isCtcKey = (k) => k === 'col-SCR' || k === 'col-CTC';
export function wpBook(A, paper) {
  if (paper === 'a2a') return A.books.find((b) => b.key === 'ca') || null;
  if (paper === 'a1b') return A.books.find((b) => isCtcKey(b.key)) || null;
  return A.books.find((b) => b.key === 'col-SCD' || b.key === 'col-RCD') || null;
}
export function wpLines(c, paper, ver) {
  const { f, A, exam, advs, liqs } = c;
  const o = exam.o, lgu = A.lgu, inScope = A.inScope, orOk = A.orOk;
  const book = wpBook(A, paper); if (!book) return null;
  const lines = [];
  if (paper === 'a2a') {
    const mine = advs.filter((a) => a.officerId === o.id);
    mine.filter((a) => !a.beg && inScope(a.date)).forEach((a) => lines.push({ key: `ca|${a.id}`, date: a.date, part: a.particulars || '', no: a.checkNo || '', d: +a.amount || 0, c: 0, ord: 0 }));
    liqs.filter((l) => l.officerId === o.id && A.liqIn(l)).forEach((l) => {
      const a = mine.find((x) => x.id === l.advanceId);
      const part = [l.type === 'refund' ? `Refund, OR No. ${l.ref}` : l.ref, l.particulars, a ? `check No. ${a.checkNo}` : l.advanceId === '__beg' ? 'beginning balance' : ''].filter(Boolean).join(' · ');
      lines.push({ key: `lq|${l.id}`, date: l.date, part, no: '', d: 0, c: +l.amount || 0, ord: 1 });
    });
  } else {
    const kind = book.kind, part = book.part || '', bs = ctcBegShare(exam.balances);
    // Same records as the SCDs / RCDs (and Annex C): the ORs and deposits in this period's reports and those not yet in a report,
    // up to the cash count. A deposit dated before the last cash exam that sits in a report of this period keeps its own date
    // and comes right after the beginning balance; a deposit made before its ORs is marked so.
    const from = exam.lastExamDate || '', to = A.to;
    const face = (x) => r2((x.items || []).reduce((n, i) => n + (+i.amt || 0), 0));
    const early = new Map(depsBeforeOrs(f, o, A.fig).map((x) => [x.d, x]));
    const pre = (d) => !!(from && d && d < from);
    Object.values(A.fig.chains).filter((ch) => ch.kind === kind).forEach((ch) => [...ch.figs, ch.pend].forEach((g) => {
      (g.ors || []).filter((x) => partOk(part, x.form) && x.date && x.date <= to && orOk(x)).forEach((x) => {
        const cx = x.status === 'cancelled';
        lines.push({ key: `or|${x.id}`, date: x.date, part: cx ? 'Cancelled' : (x.items || []).map((i) => i.p).filter(Boolean).join('; '), no: x.range ? `${x.serial}–${x.serialTo}` : String(x.serial), d: cx ? 0 : face(x), c: 0, ord: 0, sn: +x.serial || 0 });
      });
      const s = part ? ctcAlloc(ch, bs) : null, share = (d) => (part ? depPart(part, d, s) : +d.amount || 0);
      const where = g.pending ? 'not yet in a report' : `in ${repName(g.rec, ch.kind)}`;
      const preNote = (d) => (pre(d.date) ? ` · ${kind === 'SCR' || d.toLO ? 'remitted' : 'deposited'} before the last cash exam; ${where}` : '');
      const earlyNote = (d) => { const x = early.get(d); return x ? ` · before its ORs (${d.from}–${d.to || d.from}, dated ${fmtDate(x.first)}${x.last !== x.first ? `–${fmtDate(x.last)}` : ''})` : ''; };
      if (part !== 'ctc') {
        const rs = (g.rec?.remittances || []).filter((m) => m.date && m.date <= to && !m.beg);
        rs.filter((m) => !pre(m.date)).forEach((m, i) => lines.push({ key: `rem|${g.id}|${i}|${m.date}|${m.amount}`, date: m.date, part: `Remittance from ${c.f.officers.find((x) => x.id === m.collectorId)?.name || 'collector'}${m.reportNo ? ', ' + m.reportNo : ''}`, no: '', d: +m.amount || 0, c: 0, ord: 0 }));
        rs.filter((m) => pre(m.date)).forEach((m, i) => lines.push({ key: `remx|${g.id}|${i}|${m.date}|${m.amount}`, date: m.date, sd: from, part: `Remittance from ${c.f.officers.find((x) => x.id === m.collectorId)?.name || 'collector'}${m.reportNo ? ', ' + m.reportNo : ''} · received before the last cash exam; ${where}`, no: '', d: +m.amount || 0, c: 0, ord: -1 }));
      }
      const ds = (g.rec?.deposits || []).filter((d) => d.date && d.date <= to && (!part || share(d)));
      const depText = (d) => (kind === 'SCR' ? `Remittance to MTO${depRefText(d, true) ? ', ' + depRefText(d, true) : ''}` : d.toLO ? `Remittance to the Liquidating Officer${d.ref ? ', ' + d.ref : ''}` : `Deposit${depRefText(d) ? ', ' + depRefText(d) : ''}${part && share(d) !== r2(+d.amount || 0) ? ` (${part === 'ctc' ? 'CTC' : 'AF 51'} part of ₱${money(d.amount)})` : ''}`);
      ds.filter((d) => !pre(d.date)).forEach((d, i) => lines.push({ key: `dep|${g.id}|${i}|${d.date}|${d.amount}`, date: d.date, part: depText(d) + earlyNote(d), no: '', d: 0, c: share(d), ord: 1 }));
      ds.filter((d) => pre(d.date)).forEach((d, i) => lines.push({ key: `depx|${g.id}|${i}|${d.date}|${d.amount}`, date: d.date, sd: from, part: depText(d) + preNote(d) + earlyNote(d), no: '', d: 0, c: share(d), ord: -1 }));
    }));
  }
  lines.sort((x, y) => String(x.sd || x.date).localeCompare(String(y.sd || y.date)) || x.ord - y.ord || String(x.date).localeCompare(String(y.date)) || (x.sn || 0) - (y.sn || 0));
  const edits = ver?.wp?.[paper] || {};
  const beg = r2(A.moves[book.key].beg);
  let ga = beg, gb = beg;
  lines.forEach((l) => {
    const e = edits[l.key];
    l.cd = e && e.d !== undefined && e.d !== null ? +e.d : l.d;
    l.cc = e && e.c !== undefined && e.c !== null ? +e.c : l.c;
    l.edited = !!e && (Math.abs(l.cd - l.d) > 0.004 || Math.abs(l.cc - l.c) > 0.004);
    ga = r2(ga + l.d - l.c); gb = r2(gb + l.cd - l.cc);
    l.ga = ga; l.gb = gb; l.k = r2((l.d - l.cd) - (l.c - l.cc));
  });
  const sum = (k) => r2(lines.reduce((n, l) => n + l[k], 0));
  // Cash advances: grouped by fund (the fund of each check's checkbook), each with its own beginning and running balance.
  let groups = null;
  if (paper === 'a2a') {
    const fx = { booklets: f.booklets, accounts: accountsOf(f.settings, A.lgu.id), jr: f.ckdj };
    const mine = advs.filter((a) => a.officerId === o.id);
    const begs = begByFund(exam, advs, fx, beg, liqs);
    const fundOfLine = (l) => { if (l.key.startsWith('ca|')) return caFund(mine.find((a) => `ca|${a.id}` === l.key) || {}, fx);
      const lq = liqs.find((x) => `lq|${x.id}` === l.key); const a = lq && mine.find((x) => x.id === lq.advanceId);
      return a ? caFund(a, fx) : restFund(exam, fx); };
    lines.forEach((l) => { l.fund = fundOfLine(l); });
    const names = [...new Set([...begs.keys(), ...lines.map((l) => l.fund)])].sort(fundOrder(fx));
    groups = names.map((fund) => {
      const ls = lines.filter((l) => l.fund === fund), b0 = begs.get(fund) || 0; let a1 = b0, b1 = b0;
      ls.forEach((l) => { a1 = r2(a1 + l.d - l.c); b1 = r2(b1 + l.cd - l.cc); l.ga = a1; l.gb = b1; });
      const t = (k) => r2(ls.reduce((n, l) => n + l[k], 0));
      return { fund, beg: b0, lines: ls, tot: { d: t('d'), c: t('c'), cd: t('cd'), cc: t('cc'), k: t('k') }, end: a1, endCb: b1 };
    });
  }
  return { paper, book, beg, lines, groups, tot: { d: sum('d'), c: sum('c'), cd: sum('cd'), cc: sum('cc'), k: sum('k') }, end: ga, endCb: gb, edited: lines.filter((l) => l.edited).length };
}

/* ---------- Annex E, F, G: Reconciliation Statements of Accountability ---------- */
// Balance per books (and its reconciling items): from Verification, Reconciliation with the Officer's Books.
// Balance per Cash Book: from the working paper's Per CashBook, its reconciling items are the working paper's differences.
export function rsaOf(c, which, ver) {
  const { A } = c;
  const paper = which === 'E' ? 'a1a' : which === 'F' ? 'a1b' : 'a2a';
  const w = wpLines(c, paper, ver); if (!w) return null;
  const st = A.st.find((x) => x.key === w.book.key) || { balance: w.end };
  const rc = ver?.recon?.[w.book.key] || {};
  const n = (v) => (v === null || v === undefined || v === '' ? null : +v);
  const books = n(rc.cashbook), uBeg = n(rc.unrecBeg) || 0, uDr = n(rc.unrecDebit) || 0, uCr = n(rc.unrecCredit) || 0;
  const dr = r2(w.lines.reduce((s, l) => s + (l.d - l.cd), 0)), cr = r2(w.lines.reduce((s, l) => s + (l.c - l.cc), 0));
  return { which, paper, label: which === 'E' ? (w.book.kind === 'RCD' ? 'Official Receipts' : 'Official Receipt (AF 51)') : which === 'F' ? 'CTC' : 'Cash Advances', key: w.book.key,
    sa: st.balance, books, uBeg, uDr, uCr: -uCr, adjBooks: books === null ? null : r2(books + uBeg + uDr - uCr),
    cb: w.endCb, cbDr: dr, cbCr: -cr, adjCb: r2(w.endCb + dr - cr) };
}

/* ---------- on screen ---------- */
const amt = (n) => (n === null || n === undefined ? '' : Math.abs(n) < 0.005 ? '-' : n < 0 ? `(${money(-n)})` : money(n));
export function wpHtml(c, paper, ver, edit) {
  const w = wpLines(c, paper, ver);
  const { A, agency, station, prep, rev, sign } = c;
  const title = paper === 'a2a' ? ['DETAILED STATEMENT OF CASH ADVANCES AND LIQUIDATIONS', 'Cash Advances', 'Check No.', 'Cash Advances', 'Liquidations']
    : paper === 'a1b' ? (w?.book.kind === 'RCD' ? ['DETAILED STATEMENT OF COLLECTIONS AND DEPOSITS', 'CTC', 'CTC No.', 'Collections', 'Deposits'] : ['DETAILED STATEMENT OF COLLECTIONS AND REMITTANCES', 'CTC', 'CTC No.', 'Collections', 'Remittance'])
      : ['DETAILED STATEMENT OF COLLECTIONS AND DEPOSITS', 'OFFICIAL RECEIPTS', 'OR No.', 'Collections', 'Deposits'];
  if (!w) return `<div class="rp-page"><p class="c">${paper === 'a2a' ? 'No cash advance accountability for this officer.' : paper === 'a1b' ? 'No CTC collections for this officer.' : 'No collection accountability for this officer.'}</p></div>`;
  const cell = (l, f2, v) => (edit ? `<button type="button" class="wp-cb${l.edited ? ' wp-ed' : ''}" data-cb="${esc(l.key)}" data-f="${f2}" title="Click to type what the cashbook shows">${amt(v)}</button>` : amt(v));
  return `<div class="rp-page rp-wide wp-page"><div class="rp-top"><span></span><span class="r"><b>${WP[paper]}</b></span></div>
    <h2 class="rp-title">${title[0]}</h2><p class="c"><b>${title[1]}</b><br>${esc(fmtDate(A.from))} to ${esc(fmtDate(A.to))}</p>
    <p class="c">${esc(c.o.name)} · ${esc(c.o.designation || '')} · ${esc(agency)}, ${esc(station)}</p>
    <table class="rp-t wp-t"><thead><tr><th rowspan="2">Date</th><th rowspan="2">Particulars</th><th rowspan="2">${title[2]}</th><th colspan="3">Per Audit</th><th colspan="3">Per CashBook</th><th rowspan="2" class="r">Reconciling amount</th></tr>
      <tr><th class="r">${title[3]}</th><th class="r">${title[4]}</th><th class="r">Balance</th><th class="r">${title[3]}</th><th class="r">${title[4]}</th><th class="r">Balance</th></tr></thead>
      <tbody>${(w.groups && w.groups.length > 1 ? w.groups : [{ fund: '', beg: w.beg, lines: w.lines }]).map((g) => `${g.fund ? `<tr class="rp-form"><td colspan="10"><b>${esc(g.fund)}</b></td></tr>` : ''}
      <tr><td>${esc(fmtDate(A.from))}</td><td>Beginning Balance</td><td></td><td></td><td></td><td class="r">${amt(g.beg)}</td><td></td><td></td><td class="r">${amt(g.beg)}</td><td class="r">-</td></tr>
      ${g.lines.map((l) => `<tr${l.edited ? ' class="wp-diff"' : ''}><td>${esc(fmtDate(l.date))}</td><td>${esc(l.part)}</td><td class="mono">${esc(l.no)}</td><td class="r">${amt(l.d)}</td><td class="r">${amt(l.c)}</td><td class="r">${amt(l.ga)}</td>
        <td class="r">${cell(l, 'd', l.cd)}</td><td class="r">${cell(l, 'c', l.cc)}</td><td class="r">${amt(l.gb)}</td><td class="r">${amt(l.k)}</td></tr>`).join('')}
      ${g.fund ? `<tr class="rp-sub"><td></td><td><i>Subtotal, ${esc(g.fund)}</i></td><td></td><td class="r">${amt(g.tot.d)}</td><td class="r">${amt(g.tot.c)}</td><td class="r">${amt(g.end)}</td><td class="r">${amt(g.tot.cd)}</td><td class="r">${amt(g.tot.cc)}</td><td class="r">${amt(g.endCb)}</td><td class="r">${amt(g.tot.k)}</td></tr>` : ''}`).join('')}
      <tr class="tot"><td></td><td>Total</td><td></td><td class="r">${amt(w.tot.d)}</td><td class="r">${amt(w.tot.c)}</td><td class="r">${amt(w.end)}</td><td class="r">${amt(w.tot.cd)}</td><td class="r">${amt(w.tot.cc)}</td><td class="r">${amt(w.endCb)}</td><td class="r">${amt(w.tot.k)}</td></tr></tbody></table>
    <div class="rp-signs">${sign('Prepared by', prep)}${sign('Reviewed by', rev)}</div></div>`;
}
export function rsaHtml(c, ver) {
  const { A, agency, station, prep, rev, sign } = c;
  const list = ['E', 'F', 'G'].map((x) => rsaOf(c, x, ver)).filter(Boolean);
  if (!list.length) return '<div class="rp-page"><p class="c">No accountability for this officer.</p></div>';
  const row = (lbl, v, ind) => `<tr><td${ind ? ' class="rp-ind"' : ''}>${lbl}</td><td class="r">${v === null ? '' : amt(v)}</td></tr>`;
  return list.map((r, i) => {
    const isCa = r.which === 'G', isCol = r.which === 'E';
    return `${i ? '<div class="rp-break"></div>' : ''}<div class="rp-page"><div class="rp-top"><span></span><span class="r"><b>ANNEX ${r.which}</b></span></div>
      <p class="c">Republic of the Philippines<br><b>${esc(agency)}</b><br>${esc(station)}</p><p class="c"><b>${esc(c.o.name)}</b><br>${esc(c.o.designation || '')}</p>
      <h2 class="rp-title">Reconciliation Statement of Accountability</h2><p class="c"><b>${r.label}</b><br>${esc(fmtDate(A.to))}</p>
      <table class="rp-kv rp-rsa"><tbody>
        ${row(`Balance per Statement of Accountability, ${esc(fmtDate(A.to))}`, r.sa)}
        <tr><td colspan="2">&nbsp;</td></tr>
        ${row(`Balance per books${isCa ? ', Certified by Accountant' : ''}, ${esc(fmtDate(A.to))}`, r.books)}
        <tr><td colspan="2">Add (Deduct): Reconciling Items</td></tr>
        ${row('Unrecorded beginning balance', r.uBeg, true)}${row(isCa ? 'Unrecorded Cash Advances' : isCol ? 'Undeposited Collections' : 'Unrecorded Collections', r.uDr, true)}${row(isCa ? 'Unrecorded Liquidations' : 'Unrecorded Deposits/Remittances', r.uCr, true)}
        <tr class="tot"><td>Adjusted balance of accountability</td><td class="r">${r.adjBooks === null ? '' : amt(r.adjBooks)}</td></tr>
        <tr><td colspan="2">&nbsp;</td></tr>
        ${row(`Balance per Cash Book, ${esc(fmtDate(A.to))}`, r.cb)}
        <tr><td colspan="2">Add (Deduct): Reconciling Items</td></tr>
        ${row(isCa ? 'Unrecorded Cash Advances' : 'Unrecorded Collections', r.cbDr, true)}${row(isCa ? 'Unrecorded Liquidations' : 'Unrecorded Deposits', r.cbCr, true)}
        <tr class="tot"><td>Adjusted balance of accountability</td><td class="r">${amt(r.adjCb)}</td></tr></tbody></table>
      <div class="rp-signs">${sign('Prepared by', prep)}${sign('Reviewed by', rev)}</div></div>`;
  }).join('');
}

// Per CashBook: tick (same as Per Audit) and the click-to-edit cells. Saves into the officer's cer_verify record.
export function wireWp(c, paper, ver, refs) {
  const w = wpLines(c, paper, ver); if (!w) return;
  const save = async (wpPaper) => {
    const cur = ver ? (() => { const { id, ...x } = ver; return x; })() : { examId: c.exam.id, recon: {}, decisions: {} };
    await store.save('cer_verify', c.exam.id, { ...cur, wp: { ...(cur.wp || {}), [paper]: wpPaper } }, by(refs));
  };
  const tick = $('#wp-same');
  if (tick) tick.onchange = async () => {
    if (!tick.checked) { tick.checked = !w.edited; if (!w.edited) toast('Click a Per CashBook amount to type what the cashbook shows; the tick turns off by itself.'); return; }
    const ok = await modal({ title: 'Per CashBook same as Per Audit?', body: `<p style="margin:0">The ${w.edited} line${w.edited > 1 ? 's' : ''} you changed go back to the Per Audit figures.</p>`, buttons: [{ label: 'Keep my changes', value: false }, { label: 'Put back', cls: 'primary', value: true }] });
    if (!ok) { tick.checked = false; return; }
    await save({}); toast('Per CashBook is the same as Per Audit again.', 'ok');
  };
  $$('[data-cb]').forEach((b) => { b.onclick = () => {
    const l = w.lines.find((x) => x.key === b.dataset.cb); if (!l) return;
    const f2 = b.dataset.f, cur = f2 === 'd' ? l.cd : l.cc, aud = f2 === 'd' ? l.d : l.c;
    const inp = document.createElement('input'); inp.className = 'input af-sm r wp-in'; inp.inputMode = 'decimal'; inp.value = cur ? money(cur) : '';
    b.replaceWith(inp); inp.focus(); inp.select();
    let done = false;
    const finish = async (keep) => {
      if (done) return; done = true;
      if (!keep) { inp.replaceWith(b); return; }
      const v = inp.value.trim() === '' ? 0 : num(inp.value);
      if (v === null) { toast('Type an amount.', 'bad'); done = false; inp.focus(); return; }
      const edits = { ...(ver?.wp?.[paper] || {}) };
      const e = { ...(edits[l.key] || {}) }; e[f2] = r2(v);
      const same = Math.abs((e.d ?? l.d) - l.d) < 0.005 && Math.abs((e.c ?? l.c) - l.c) < 0.005;
      if (same) delete edits[l.key]; else edits[l.key] = e;
      if (Math.abs(v - cur) < 0.005) { inp.replaceWith(b); return; }
      await save(edits);
      toast(same ? 'The line agrees with the audit again.' : `Per CashBook changed (audit ₱${money(aud)}).`, 'ok');
    };
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } if (e.key === 'Escape') finish(false); };
    inp.onblur = () => finish(true);
  }; });
}

/* ---------- Excel downloads ---------- */
let xjs = null;
export function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  if (!xjs) xjs = new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'lib/exceljs.min.js'; sc.onload = () => res(window.ExcelJS); sc.onerror = () => { xjs = null; rej(new Error('The Excel writer could not load. Check the internet connection and try again.')); }; document.head.appendChild(sc); });
  return xjs;
}
async function template(name) {
  const ExcelJS = await loadExcelJS();
  const r = await fetch(`lib/${name}`); if (!r.ok) throw new Error('The report template could not load.');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await r.arrayBuffer());
  return wb;
}
const D = (s) => { if (!s) return null; const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
// Amounts get #,##0.00 where the template cell has no format of its own; quantities and serial numbers stay whole numbers.
const QTY = { 'GF-74A Front': /^(G(2[89]|3[0-3])|F4[1-7]|AN4[1-8]|AQ57)$/, SAAFwo: /./, 'WP-AF51': /^D\d+$/, 'WP-CTC': /^D\d+$/, 'WP-CA': /^D\d+$/ };
const set = (ws, addr, v) => {
  v = clean(v);
  const cl = ws.getCell(addr); cl.value = v;
  if (typeof v === 'number' && (!cl.numFmt || cl.numFmt === 'General')) cl.numFmt = QTY[ws.name]?.test(addr) ? '0' : '#,##0.00';
  if (v instanceof Date && (!cl.numFmt || cl.numFmt === 'General')) cl.numFmt = 'mm/dd/yyyy';
};
// Excel refuses a file with NaN / Infinity, an invalid date, or control characters in a cell (LibreOffice lets them pass).
function clean(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string') return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
  return String(v);
}
// One row of a template table made a single centred box (e.g. "None"): the row's small merges are undone, the whole
// width merged, the outer borders kept.
const colNo = (L) => [...L].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
function wideBox(ws, r, c1, c2, text) {
  const a = colNo(c1), z = colNo(c2);
  const first = ws.getCell(r, a), last = ws.getCell(r, z);
  const bd = { ...(first.border || {}), right: (last.border || {}).right || (first.border || {}).right };
  Object.keys(ws._merges || {}).forEach((k) => { const m = ws._merges[k]; const mm = m.model || m; if (mm.top === r && mm.bottom === r && mm.left >= a && mm.right <= z) ws.unMergeCells(r, mm.left, r, mm.right); });
  for (let k = a; k <= z; k++) ws.getCell(r, k).value = null;
  ws.mergeCells(r, a, r, z);
  const cl = ws.getCell(r, a); cl.value = text;
  const ref = ws.getCell(r, 1).font || {}; if (ref.size) cl.font = { ...(cl.font || {}), name: ref.name || (cl.font || {}).name, size: ref.size, bold: false };   // the table's own font
  cl.alignment = { ...(cl.alignment || {}), horizontal: 'center', vertical: 'middle' };
  cl.border = bd;
}
const hideRows = (ws, from, to) => { for (let r = from; r <= to; r++) ws.getRow(r).hidden = true; };
async function save(wb, file) {
  // Excel refuses a file whose first tab (from the original workbook) is past the last sheet, or whose filters point to a removed sheet.
  wb.views = [{ x: 0, y: 0, width: 23256, height: 12456, firstSheet: 0, activeTab: 0, visibility: 'visible' }];
  wb.definedNames.model = [];
  wb.worksheets.forEach((ws) => {
    ws.autoFilter = null;
    // ExcelJS writes <pageSetUpPr> before <outlinePr> in <sheetPr>, which Excel calls corrupt: drop outlinePr (its values are the defaults).
    if (ws.properties) delete ws.properties.outlineProperties;
    ['horizontalDpi', 'verticalDpi'].forEach((k) => { if (!(ws.pageSetup[k] >= 1)) delete ws.pageSetup[k]; });
    // Print area written as $A$1:$BA$66 (ExcelJS adds only the column $).
    if (ws.pageSetup.printArea) ws.pageSetup.printArea = ws.pageSetup.printArea.replace(/\$?([A-Z]+)\$?(\d+)/g, '$1$$$2');
  });
  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a'); a.href = url; a.download = file; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
}
export const fileBase = (c) => `${String(c.A.lgu.data.name || c.agency).replace(/^\s*[BMP]LGU\s*[-–]\s*/i, '').toUpperCase()} - ${c.audit.countDate}`;

export async function downloadReport(c, ver) {
  const wb = await template('cer-report.xlsx');
  const { A, audit, exam, o, agency, station, prep, rev } = c;
  const b = exam.bond || {};
  const cnt = A.count || { bills: {}, coins: 0, items: [] };
  const des = o.designation || '';
  // GF 74-A front
  let ws = wb.getWorksheet('GF-74A Front');
  // The template's row 44 lacks the merges of rows 41–47 on the left (stray borders): rebuilt like row 43.
  [['A', 'E'], ['F', 'I'], ['J', 'Q'], ['R', 'Y'], ['Z', 'AE'], ['AF', 'AM']].forEach(([c1, c2]) => {
    const a = colNo(c1), z = colNo(c2);
    if (Object.values(ws._merges || {}).some((m) => { const mm = m.model || m; return mm.top === 44 && mm.left === a && mm.right === z; })) return;
    for (let k = a; k <= z; k++) { const src = ws.getCell(43, k); const cl = ws.getCell(44, k); cl.value = null; cl.style = JSON.parse(JSON.stringify(src.style || {})); }
    try { ws.mergeCells(44, a, 44, z); } catch (e) { /* already merged */ }
  });
  set(ws, 'O4', o.name); set(ws, 'AO4', des); set(ws, 'F5', agency); set(ws, 'AO5', station);
  set(ws, 'A7', b.maxCash ? +b.maxCash : null); set(ws, 'T7', b.amount ? +b.amount : null); set(ws, 'AH7', b.riskNo || ''); set(ws, 'AS7', b.from || b.to ? `${fmtDate(b.from)} to ${fmtDate(b.to)}` : '');
  set(ws, 'A9', prep.name); set(ws, 'AA9', prep.pos);
  set(ws, 'E12', o.name); set(ws, 'AB12', des); set(ws, 'AS12', fmtDate(audit.countDate)); set(ws, 'B15', des); set(ws, 'AB15', agency); set(ws, 'K20', o.name); set(ws, 'AB20', fmtDate(audit.countDate));
  let cash = 0;
  BILLS.forEach((v, i) => { const n = parseInt(cnt.bills?.[v], 10) || 0; cash += v * n; set(ws, `G${28 + i}`, n || null); set(ws, `K${28 + i}`, n ? v * n : null); });
  set(ws, 'K34', +cnt.coins || null); cash = r2(cash + (+cnt.coins || 0)); set(ws, 'L35', cash);
  const items = (cnt.items || []).map((it) => { const a = num(it.allowed ?? it.presented) ?? 0; return { p: itemText(it.particulars), pr: +it.presented || 0, a, d: r2((+it.presented || 0) - a) }; });
  const fit = (list, n, join) => (list.length <= n ? list : [...list.slice(0, n - 1), join(list.slice(n - 1))]);
  fit(items, 7, (xs) => ({ p: `${xs.length} other items`, pr: r2(xs.reduce((s, x) => s + x.pr, 0)), a: r2(xs.reduce((s, x) => s + x.a, 0)), d: r2(xs.reduce((s, x) => s + x.d, 0)) }))
    .forEach((x, i) => { set(ws, `S${28 + i}`, x.p); set(ws, `AG${28 + i}`, x.pr); set(ws, `AN${28 + i}`, x.a); set(ws, `AU${28 + i}`, x.d); });
  // As on screen: no cash item → one box across the table reading None.
  if (!items.length) wideBox(ws, 28, 'S', 'BA', 'None');
  const tA = r2(items.reduce((s, x) => s + x.a, 0)), tD = r2(items.reduce((s, x) => s + x.d, 0));
  set(ws, 'AG35', r2(tA + tD)); set(ws, 'AN35', tA); set(ws, 'AU35', tD); set(ws, 'AU36', r2(cash + tA));
  // Short names: the Name of Form columns of GF 74-A are narrow.
  const SHORT = { af51: 'AF 51', af51b: 'AF 51', ctci: 'CTC – Ind.', ctcc: 'CTC – Corp.', chk: 'Checks' };
  const forms = unusedFormsOf(c.f, o.id, exam).map((x) => ({ ...x, name: SHORT[x.form] || x.name }));
  const mv = forms.filter((x) => x.face && x.qty), nomv = forms.filter((x) => !x.face);
  fit(mv, 7, (xs) => ({ name: 'Others', qty: xs.reduce((s, x) => s + x.qty, 0), text: '', face: null, amount: xs.reduce((s, x) => s + x.amount, 0) }))
    .forEach((x, i) => { set(ws, `A${41 + i}`, x.name); set(ws, `F${41 + i}`, x.qty); set(ws, `J${41 + i}`, x.ns ? 'No serial' : x.text); set(ws, `R${41 + i}`, x.face); set(ws, `Z${41 + i}`, x.amount); });
  fit(nomv, 7, (xs) => ({ name: 'Others', qty: xs.reduce((s, x) => s + x.qty, 0), text: xs.map((x) => x.text).join('; ') }))
    .forEach((x, i) => { set(ws, `AF${41 + i}`, x.name); set(ws, `AN${41 + i}`, x.qty); set(ws, `AR${41 + i}`, x.text.replace(/ – /g, '- ')); });
  // Nothing counted: see the SAAF; booklets not presented: noted on the next free line.
  const nps = notPresentedOf(c.f, exam, A.to);
  if (!nomv.length) wideBox(ws, 41, 'AF', 'BA', 'See Annex B (SAAF)');
  else if (nps.length && nomv.length < 7) wideBox(ws, 41 + nomv.length, 'AF', 'BA', 'Not presented: see Annex B (SAAF)');
  if (!mv.length) wideBox(ws, 41, 'A', 'AE', nps.some((x) => faceOf({ form: x.form })) ? 'See Annex B (SAAF)' : 'None');
  const mvAmt = mv.reduce((s, x) => s + x.amount, 0), pcs = nomv.reduce((s, x) => s + x.qty, 0);
  set(ws, 'AA48', mvAmt); set(ws, 'AN48', pcs);
  set(ws, 'D53', fmtDate(audit.countDate)); set(ws, 'AQ55', r2(cash + tA)); set(ws, 'AQ56', mvAmt); set(ws, 'AQ57', pcs); set(ws, 'J59', tD);
  set(ws, 'A64', o.name); set(ws, 'X64', des); set(ws, 'AM64', agency);
  // GF 74-A back: columns AF51 / CTC / Cash Advance (LGU: Collections)
  ws = wb.getWorksheet('GF-74A Back');
  const colOf = (k) => (k === 'ca' ? 'AE' : isCtcKey(k) ? 'T' : 'M');
  const lbl = { M: A.st.some((x) => x.key === 'col-RCD' && !x.part) ? 'Collections' : 'AF51', T: 'CTC', AE: 'Cash Advance' };
  set(ws, 'M2', lbl.M); set(ws, 'T2', lbl.T); set(ws, 'AE2', lbl.AE); set(ws, 'A4', fmtDate(A.from));
  const tot = { beg: 0, d: 0, c: 0, bal: 0, inv: 0, sh: 0 };
  A.st.forEach((x) => {
    const col = colOf(x.key), isCa = x.key === 'ca';
    set(ws, `${col}3`, x.beg); set(ws, `${col}${isCa ? 8 : 7}`, x.debit); set(ws, `${col}20`, x.debit); set(ws, `${col}${isCa ? 25 : 24}`, x.credit); set(ws, `${col}34`, x.credit);
    set(ws, `${col}36`, x.balance); set(ws, `${col}37`, x.inv); set(ws, `${col}39`, x.sh);
    tot.beg += x.beg; tot.d += x.debit; tot.c += x.credit; tot.bal += x.balance; tot.inv += x.inv || 0; tot.sh += x.sh || 0;
  });
  const colD = r2(A.st.filter((x) => x.key !== 'ca').reduce((s, x) => s + x.debit, 0)), colC = r2(A.st.filter((x) => x.key !== 'ca').reduce((s, x) => s + x.credit, 0));
  const caS = A.st.find((x) => x.key === 'ca');
  set(ws, 'AL3', r2(tot.beg)); set(ws, 'AL7', colD); set(ws, 'AL8', caS ? caS.debit : 0); set(ws, 'AL20', r2(tot.d)); set(ws, 'AL24', colC); set(ws, 'AL25', caS ? caS.credit : 0); set(ws, 'AL34', r2(tot.c));
  set(ws, 'AL36', r2(tot.bal)); set(ws, 'AL37', A.inv ? r2(tot.inv) : null); set(ws, 'AL39', A.inv ? r2(tot.sh) : null);
  const words = (await import('./reports.js')).inWords(r2(tot.bal));
  set(ws, 'AE42', agency); set(ws, 'R44', fmtDate(audit.countDate)); set(ws, 'E45', words); set(ws, 'AI46', r2(tot.bal));
  set(ws, 'B52', o.name); set(ws, 'R52', des); set(ws, 'AC52', agency); set(ws, 'G54', `${o.name}, ${des}, ${agency}, ${station}`);
  set(ws, 'A57', o.name); set(ws, 'R57', des); set(ws, 'AC57', agency); set(ws, 'A62', prep.name); set(ws, 'R62', prep.des || prep.pos);
  // Annex B · SAAF: one line per range, a blank line between forms, the beginning first
  ws = wb.getWorksheet('SAAFwo');
  set(ws, 'T9', 'Remarks'); ws.getCell('T9').style = JSON.parse(JSON.stringify(ws.getCell('Q9').style || {})); ws.getCell('T10').style = JSON.parse(JSON.stringify(ws.getCell('S10').style || {}));
  ws.getColumn('T').width = 15; if (ws.pageSetup.printArea) ws.pageSetup.printArea = String(ws.pageSetup.printArea).replace(/\$?S\$?140/, '$T$140');
  set(ws, 'I3', fmtDate(audit.countDate)); set(ws, 'B5', o.name); set(ws, 'B6', des); set(ws, 'B7', `${agency}, ${station}`);
  const rows = saafRows(c.f, o.id, exam, A.from, A.to, c.advs);
  let r = 12; const FIRST = 12, LAST = 131;
  const groups = []; rows.forEach((x) => { const g = groups.find((y) => y.form === x.form) || (groups.push({ form: x.form, name: x.form === 'af51' || x.form === 'af51b' ? 'AF 51' : x.name, rows: [] }), groups[groups.length - 1]); g.rows.push(x); });
  const T = { beg: 0, rec: 0, iss: 0, end: 0, cnt: 0, diff: 0 };
  const put = (row, c0, rg, ns) => { if (!rg) return; if (ns) { set(ws, `${c0[2]}${row}`, countRanges([rg])); return; } set(ws, `${c0[0]}${row}`, rg[0]); set(ws, `${c0[1]}${row}`, rg[1]); set(ws, `${c0[2]}${row}`, rg[1] - rg[0] + 1); };
  const { byFund } = await import('./reports.js');
  // Column A cells share one style object: give each its own copy.
  const styA = (row, bold, indent) => { const cl = ws.getCell(`A${row}`); const st = JSON.parse(JSON.stringify(cl.style || {})); st.font = { ...(st.font || {}), bold }; st.alignment = { ...(st.alignment || {}), indent }; cl.style = st; };
  for (let q = FIRST; q <= LAST; q++) styA(q, false, 0);
  groups.forEach((g) => { if (g.form === 'chk') g.rows = byFund(g.rows); });
  groups.forEach((g, gi) => {
    if (gi && r <= LAST) r++;   // blank line between forms
    const isChk = g.form === 'chk';
    if (r <= LAST) { set(ws, `A${r}`, g.name); styA(r, true, 0); r++; }   // the form on its own line
    g.rows.forEach((x, i) => {
      const cols = [x.beg, x.rec, x.issued, x.end, x.count || []];
      const n = x.ns ? 1 : Math.max(1, ...cols.map((rs) => rs.length));
      for (let k = 0; k < n && r <= LAST; k++, r++) {
        if (k === 0) {
          const fund = isChk && x.fund && (i === 0 || g.rows[i - 1].fund !== x.fund) ? x.fund : '';
          const label = fund || (x.other ? 'Not in the register' : '');
          if (label) set(ws, `A${r}`, label);
          styA(r, false, fund ? 2 : 0);
        }
        const pick = (rs) => (x.ns ? (k === 0 && rs.length ? rs : null) : rs[k] || null);
        [['B', 'C', 'D'], ['E', 'F', 'G'], ['H', 'I', 'J'], ['K', 'L', 'M'], ['N', 'O', 'P']].forEach((c0, ci) => { const p = pick(cols[ci]); if (!p) return; if (x.ns) set(ws, `${c0[2]}${r}`, countRanges(p)); else put(r, c0, p, false); });
        if (k === 0 && x.diff !== null && x.diff !== undefined) set(ws, `S${r}`, x.diff);
        if (k === 0 && x.remarks) set(ws, `T${r}`, x.remarks);
      }
      T.beg += countRanges(x.beg); T.rec += countRanges(x.rec); T.iss += countRanges(x.issued); T.end += countRanges(x.end); T.cnt += x.count ? countRanges(x.count) : 0; T.diff += x.diff || 0;
    });
  });
  hideRows(ws, Math.max(r, FIRST + 1), LAST);
  set(ws, 'D132', T.beg); set(ws, 'G132', T.rec); set(ws, 'J132', T.iss); set(ws, 'M132', T.end); set(ws, 'P132', T.cnt); set(ws, 'S132', T.diff);
  set(ws, 'B139', prep.name); set(ws, 'B140', prep.pos); set(ws, 'N139', o.name); set(ws, 'N140', des);
  // Annex C, Annex D: months within the scope
  // Entries dated before the last cash exam (counted on purpose) go on the beginning line, not as a month.
  const inS = (y) => !A.from || y.date >= A.from;
  const preOf = (k) => { const ls = A.moves[k].list.filter((y) => !inS(y)); return { d: r2(ls.reduce((s, y) => s + y.debit, 0)), c: r2(ls.reduce((s, y) => s + y.credit, 0)) }; };
  const months = (keys) => [...new Set(keys.flatMap((k) => A.moves[k].list.filter(inS).map((m) => m.date.slice(0, 7))))].sort();
  const mSum = (k, m) => { const ls = A.moves[k].list.filter((y) => y.date.startsWith(m) && inS(y)); return { d: r2(ls.reduce((s, y) => s + y.debit, 0)), c: r2(ls.reduce((s, y) => s + y.credit, 0)) }; };
  const mLabel = (m) => `${MONTHS[+m.slice(5) - 1]} ${m.slice(0, 4)}`;
  const heads = (w2, cols) => { set(w2, 'B3', agency.toUpperCase()); set(w2, 'B4', station); set(w2, 'B6', o.name); set(w2, 'B7', des); set(w2, 'B10', `${fmtDate(A.from)} to ${fmtDate(A.to)}`); };
  const colBooks = A.st.filter((x) => x.key !== 'ca');
  ws = wb.getWorksheet('Accountability-CDR');
  if (!colBooks.length) wb.removeWorksheet(ws.id);
  else {
    heads(ws);
    const bA = colBooks.find((x) => !isCtcKey(x.key)), bC = colBooks.find((x) => isCtcKey(x.key));
    if (bA && bA.key === 'col-RCD' && !bA.part) set(ws, 'D12', 'Collections');
    const keys = colBooks.map((x) => x.key);
    const pa = bA ? preOf(bA.key) : { d: 0, c: 0 }, pc = bC ? preOf(bC.key) : { d: 0, c: 0 };
    const run = { a: bA ? r2(bA.beg + pa.d - pa.c) : 0, c: bC ? r2(bC.beg + pc.d - pc.c) : 0 };
    const nz = (v) => (v ? v : null);
    set(ws, 'C14', fmtDate(A.from)); set(ws, 'D14', nz(pa.d)); set(ws, 'E14', nz(pa.c)); set(ws, 'F14', run.a); set(ws, 'G14', nz(pc.d)); set(ws, 'H14', nz(pc.c)); set(ws, 'I14', run.c);
    set(ws, 'J14', nz(r2(pa.d + pc.d))); set(ws, 'K14', nz(r2(pa.c + pc.c))); set(ws, 'L14', r2(run.a + run.c));
    const ms = months(keys); let rr = 15;
    ms.slice(0, 36).forEach((m) => {
      const a = bA ? mSum(bA.key, m) : { d: 0, c: 0 }, cc = bC ? mSum(bC.key, m) : { d: 0, c: 0 };
      run.a = r2(run.a + a.d - a.c); run.c = r2(run.c + cc.d - cc.c);
      set(ws, `B${rr}`, mLabel(m)); set(ws, `D${rr}`, a.d); set(ws, `E${rr}`, a.c); set(ws, `F${rr}`, run.a); set(ws, `G${rr}`, cc.d); set(ws, `H${rr}`, cc.c); set(ws, `I${rr}`, run.c);
      set(ws, `J${rr}`, r2(a.d + cc.d)); set(ws, `K${rr}`, r2(a.c + cc.c)); set(ws, `L${rr}`, r2(run.a + run.c)); rr++;
    });
    hideRows(ws, rr, 50);
    set(ws, 'C51', fmtDate(A.to));
    const sA = bA || { debit: 0, credit: 0, balance: 0 }, sC = bC || { debit: 0, credit: 0, balance: 0 };
    set(ws, 'D51', sA.debit); set(ws, 'E51', sA.credit); set(ws, 'F51', sA.balance); set(ws, 'G51', sC.debit); set(ws, 'H51', sC.credit); set(ws, 'I51', sC.balance);
    set(ws, 'J51', r2(sA.debit + sC.debit)); set(ws, 'K51', r2(sA.credit + sC.credit)); set(ws, 'L51', r2(sA.balance + sC.balance));
    set(ws, 'D55', prep.name); set(ws, 'D56', prep.pos); set(ws, 'D57', prep.des); set(ws, 'J55', rev.name); set(ws, 'J56', rev.pos); set(ws, 'J57', rev.des);
  }
  ws = wb.getWorksheet('Accountability-CA');
  if (!caS) wb.removeWorksheet(ws.id);
  else {
    heads(ws);
    const p0 = preOf('ca'); let run = r2(caS.beg + p0.d - p0.c);
    set(ws, 'C13', fmtDate(A.from)); if (p0.d) set(ws, 'D13', p0.d); if (p0.c) set(ws, 'E13', p0.c); set(ws, 'F13', run);
    let rr = 14;
    months(['ca']).slice(0, 36).forEach((m) => { const a = mSum('ca', m); run = r2(run + a.d - a.c); set(ws, `B${rr}`, mLabel(m)); set(ws, `D${rr}`, a.d); set(ws, `E${rr}`, a.c); set(ws, `F${rr}`, run); rr++; });
    hideRows(ws, rr, 49);
    set(ws, 'C50', fmtDate(A.to)); set(ws, 'D50', caS.debit); set(ws, 'E50', caS.credit); set(ws, 'F50', caS.balance);
    set(ws, 'B56', prep.name); set(ws, 'B57', prep.pos); set(ws, 'B58', prep.des); set(ws, 'E56', rev.name); set(ws, 'E57', rev.pos); set(ws, 'E58', rev.des);
  }
  // Annex E, F, G
  [['E', 'RSA_AF51', 33], ['F', 'RSA_CTC', 34], ['G', 'RSA_CA', 34]].forEach(([which, name, sig]) => {
    const w2 = wb.getWorksheet(name); const x = rsaOf(c, which, ver);
    if (!x) { wb.removeWorksheet(w2.id); return; }
    set(w2, 'A3', agency); set(w2, 'A4', station); set(w2, 'A6', o.name); set(w2, 'A7', des); set(w2, 'A11', fmtDate(A.to));
    set(w2, 'D13', fmtDate(A.to)); set(w2, 'F13', x.sa); set(w2, 'C15', fmtDate(A.to)); set(w2, 'F15', x.books);
    set(w2, 'F17', x.uBeg); set(w2, 'F18', x.uDr); set(w2, 'F19', x.uCr); set(w2, 'F20', x.adjBooks);
    set(w2, 'C22', fmtDate(A.to)); set(w2, 'F22', x.cb);
    if (which === 'E') { set(w2, 'F24', x.cbDr); set(w2, 'F25', x.cbCr); set(w2, 'F26', x.adjCb); }
    else { set(w2, 'F24', 0); set(w2, 'F25', x.cbDr); set(w2, 'F26', x.cbCr); set(w2, 'F27', x.adjCb); }
    set(w2, `A${sig}`, prep.name); set(w2, `A${sig + 1}`, prep.pos); set(w2, `A${sig + 2}`, prep.des); set(w2, `E${sig}`, rev.name); set(w2, `E${sig + 1}`, rev.pos); set(w2, `E${sig + 2}`, rev.des);
  });
  await save(wb, `CER - ${fileBase(c)}.xlsx`);
}

/* ---------- Working papers (Excel): drawn like the screen ----------
   Each sheet is built fresh (no template): title block, a boxed table with a two-row header, every line boxed,
   subtotals and total, the signatures; long bond paper (Legal in Excel), fitted to the page width and centred. */
const BOX = (() => { const b = { style: 'thin', color: { argb: 'FF000000' } }; return { top: b, left: b, bottom: b, right: b }; })();
const NUM = '#,##0.00;(#,##0.00);"-"';
export function wpPage(ws, landscape, titles) {
  ws.pageSetup = { orientation: landscape ? 'landscape' : 'portrait', paperSize: 5, fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 }, ...(titles ? { printTitlesRow: titles } : {}) };
}
// One cell: value, and { b: bold, i: italic, al: 'left' | 'center' | 'right', box, fill, n: number format, sz, wrap }.
export function wcell(ws, r, col, v, o = {}) {
  const cl = ws.getCell(r, col); if (!o.keep) cl.value = clean(v);   // keep: the other cells of a merge (style only, the value stays)
  cl.font = { name: 'Arial', size: o.sz || 10, bold: !!o.b, italic: !!o.i };
  cl.alignment = { vertical: 'middle', horizontal: o.al || (typeof v === 'number' ? 'right' : 'left'), wrapText: o.wrap !== false };
  if (o.box) cl.border = BOX;
  if (o.fill) cl.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: o.fill } };
  if (typeof v === 'number' || o.n) cl.numFmt = o.n || NUM;
  return cl;
}
export function wtitle(ws, r, nCols, text, o = {}) { wcell(ws, r, 1, text, { al: 'center', ...o }); ws.mergeCells(r, 1, r, nCols); }
function wsigns(ws, r, prep, rev, colA, colB) {
  wcell(ws, r, colA, 'Prepared by:'); wcell(ws, r, colB, 'Reviewed by:');
  [[prep, colA], [rev, colB]].forEach(([p, col]) => { wcell(ws, r + 3, col, p.name || '', { b: true, wrap: false }); wcell(ws, r + 4, col, p.pos || '', { wrap: false }); wcell(ws, r + 5, col, p.des || '', { wrap: false }); });
}
function wpSheetNew(wb, c, paper, ver, name) {
  const w = wpLines(c, paper, ver); if (!w) return;
  const { A, agency, station, prep, rev, o } = c;
  const title = paper === 'a2a' ? ['DETAILED STATEMENT OF CASH ADVANCES AND LIQUIDATIONS', 'CASH ADVANCES', 'Check No.', 'Cash Advances', 'Liquidations']
    : paper === 'a1b' ? (w.book.kind === 'RCD' ? ['DETAILED STATEMENT OF COLLECTIONS AND DEPOSITS', 'CTC', 'CTC No.', 'Collections', 'Deposits'] : ['DETAILED STATEMENT OF COLLECTIONS AND REMITTANCES', 'CTC', 'CTC No.', 'Collections', 'Remittance'])
      : ['DETAILED STATEMENT OF COLLECTIONS AND DEPOSITS', 'OFFICIAL RECEIPTS', 'OR No.', 'Collections', 'Deposits'];
  const ws = wb.addWorksheet(name);
  ws.columns = [12, 44, 13, 14, 14, 14, 14, 14, 14, 14].map((width) => ({ width }));
  wpPage(ws, true, '7:8');
  wcell(ws, 1, 10, WP[paper], { b: true, al: 'right', wrap: false });
  wtitle(ws, 2, 10, title[0], { b: true, sz: 12 }); wtitle(ws, 3, 10, title[1], { b: true });
  wtitle(ws, 4, 10, `${fmtDate(A.from)} to ${fmtDate(A.to)}`); wtitle(ws, 5, 10, `${o.name} · ${o.designation || ''} · ${agency}, ${station}`);
  const H = { b: true, box: true, al: 'center', fill: 'FFF0F0F0' };
  [[1, 'Date'], [2, 'Particulars'], [3, title[2]], [10, 'Reconciling amount']].forEach(([col, t]) => { wcell(ws, 7, col, t, H); wcell(ws, 8, col, null, { ...H, keep: true }); ws.mergeCells(7, col, 8, col); });
  [[4, 'Per Audit'], [7, 'Per CashBook']].forEach(([col, t]) => { wcell(ws, 7, col, t, H); wcell(ws, 7, col + 1, null, { ...H, keep: true }); wcell(ws, 7, col + 2, null, { ...H, keep: true }); ws.mergeCells(7, col, 7, col + 2); });
  [title[3], title[4], 'Balance', title[3], title[4], 'Balance'].forEach((t, k) => wcell(ws, 8, 4 + k, t, H));
  let r = 9;
  const line = (vals, o2 = {}) => { vals.forEach((v, k) => wcell(ws, r, k + 1, v, { box: true, ...(k === 0 || k === 2 ? { al: 'center' } : {}), ...o2 })); r++; };
  const groups = w.groups && w.groups.length > 1 ? w.groups : [{ fund: '', beg: w.beg, lines: w.lines }];
  groups.forEach((g) => {
    if (g.fund) { wcell(ws, r, 1, g.fund, { b: true, box: true, fill: 'FFF7F9FC' }); for (let k = 2; k <= 10; k++) wcell(ws, r, k, null, { box: true, fill: 'FFF7F9FC', keep: true }); ws.mergeCells(r, 1, r, 10); r++; }
    line([fmtDate(A.from), 'Beginning Balance', '', null, null, g.beg, null, null, g.beg, 0]);
    g.lines.forEach((l) => line([fmtDate(l.date), l.part, l.no || '', l.d || 0, l.c || 0, l.ga, l.cd || 0, l.cc || 0, l.gb, l.k], l.edited ? { fill: 'FFFFF4E5' } : {}));
    if (g.fund) line(['', `Subtotal, ${g.fund}`, '', g.tot.d, g.tot.c, g.end, g.tot.cd, g.tot.cc, g.endCb, g.tot.k], { i: true, b: true });
  });
  line(['', 'Total', '', w.tot.d, w.tot.c, w.end, w.tot.cd, w.tot.cc, w.endCb, w.tot.k], { b: true, fill: 'FFF3F4F6' });
  wsigns(ws, r + 2, prep, rev, 2, 7);
}
function bankSheetNew(wb, bank) {
  if (!bank.length) return;
  const ws = wb.addWorksheet('BANK STATEMENT');
  const isAmt = (h) => /debit|credit|balance|amount|withdraw|deposit/i.test(h);
  const nCols = Math.max(6, ...bank.map((bk) => (bk.heads && bk.heads.length) || 6));
  ws.columns = Array.from({ length: nCols }, (_, k) => ({ width: k === 1 ? 44 : 15 }));
  wpPage(ws, true);
  wtitle(ws, 1, nCols, 'BANK STATEMENT', { b: true, sz: 12 });
  let r = 3;
  bank.forEach((bk) => {
    [['Account Number', bk.account || ''], ['Currency', 'PHP'], ['Account Type', bk.label || '']].forEach(([k, v]) => { wcell(ws, r, 1, k, { b: true, wrap: false }); wcell(ws, r, 2, v, { wrap: false }); r++; });
    r++;
    const heads = bk.heads && bk.heads.length ? bk.heads : ['Date', 'Description', 'Debit', 'Credit', 'Balance', 'Cheque Number'];
    heads.forEach((h, k) => wcell(ws, r, k + 1, clean(h), { b: true, box: true, al: 'center', fill: 'FFF0F0F0' })); r++;
    const bi = heads.findIndex((h) => /balance/i.test(h));
    if (bk.opening !== null && bk.opening !== undefined) { heads.forEach((h, k) => wcell(ws, r, k + 1, k === 1 ? 'Beginning balance' : k === (bi >= 0 ? bi : 4) ? num(bk.opening) : null, { box: true, i: k === 1 })); r++; }
    bk.lines.forEach((l) => {
      const cells = l.cells && l.cells.length ? l.cells : [fmtDate(l.date), l.desc, l.debit || '', l.credit || '', l.bal ?? '', l.chq];
      heads.forEach((h, k) => { const v = cells[k] ?? ''; const n2 = isAmt(h) && v !== '' ? num(v) : null; wcell(ws, r, k + 1, n2 !== null ? n2 : clean(v), { box: true, ...(n2 === null && k !== 1 ? { al: 'center' } : {}) }); });
      r++;
    });
    r += 2;
  });
}

export async function downloadWp(c, ver, bank) {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  const { A } = c;
  const scope = `${fmtDate(A.from)} to ${fmtDate(A.to)}`;
  [['a1a', 'WP-AF51'], ['a1b', 'WP-CTC'], ['a2a', 'WP-CA']].forEach(([paper, name]) => wpSheetNew(wb, c, paper, ver, name));
  bankSheetNew(wb, bank);
  cnpSheet(wb, c);
  fnpSheet(wb, c);
  if (!wb.worksheets.length) { const ws = wb.addWorksheet('Working Papers'); ws.getCell('A1').value = `No working paper for ${c.o.name}: no collections, cash advances or imported bank statement within ${scope}.`; }
  await save(wb, `WP - ${fileBase(c)}.xlsx`);
}
export { amt as wpAmt, r2 as wpR2 };
