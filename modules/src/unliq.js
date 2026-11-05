// Source Documents · Unliquidated Cash Advances (design approved 6 Nov 2026).
// The open cash advances of an office as of a date: all bank accounts, grouped by fund, then by person (the AO, else the
// payee: Punong Barangay, Kagawad…). Show all cash advances or AOs only. Liquidations and refunds dated after the as-of date
// are not counted. Days outstanding and aging (1–30, 31–60, 61–90, over 90 days). The screen is the printout.
import { store } from '../../js/store.js';
import { esc, toast, $ } from '../../js/ui.js';
import { agencyName, fmtDate, money } from '../cer/cer.js';
import { outButtons, wireOut } from './rciout.js';
import { cashAdvancesOf } from './cadv.js';

const r2 = (n) => Math.round((+n || 0) * 100) / 100;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (d) => `${MONTHS[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}, ${d.slice(0, 4)}`;
const endOf = (m) => `${m}-${String(new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate()).padStart(2, '0')}`;
const days = (from, to) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 86400000));
const go = (params) => { const q = new URLSearchParams(location.hash.split('?')[1] || ''); Object.entries(params).forEach(([k, v]) => (v ? q.set(k, v) : q.delete(k))); location.hash = '#/src?' + q.toString(); };
const COLS = [{ h: 'Date', w: 0.8 }, { h: 'Check No.', w: 0.8 }, { h: 'Particulars', w: 2.2 }, { h: 'Amount', w: 1.0, right: true }, { h: 'Liquidated', w: 1.0, right: true }, { h: 'Refunded', w: 0.9, right: true },
  { h: 'Balance', w: 1.0, right: true }, { h: 'Days', w: 0.5, right: true }, { h: '1–30', w: 0.95, right: true, g: 'AGING (DAYS OUTSTANDING)' }, { h: '31–60', w: 0.95, right: true, g: 'AGING (DAYS OUTSTANDING)' },
  { h: '61–90', w: 0.95, right: true, g: 'AGING (DAYS OUTSTANDING)' }, { h: 'Over 90', w: 0.95, right: true, g: 'AGING (DAYS OUTSTANDING)' }];

export async function unliqView({ refs, lgu, accounts, m, q, jr, books, enc }) {
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(q.get('asof') || '') ? q.get('asof') : endOf(m);
  const who = q.get('who') === 'ao' ? 'ao' : 'all';
  const [{ advs, liqs }, audits0] = await Promise.all([cashAdvancesOf({ lgu, accounts, jr, books }), store.list('cer_audits')]);
  const countDate = audits0.map((r) => r.data).filter((a) => a.lguId === lgu.id && a.countDate).map((a) => a.countDate).sort().pop() || '';
  // Each open check as of the date.
  const open = advs.filter((a) => a.date && a.date <= asOf && (who === 'all' || a.isAo)).map((a) => {
    const mine = liqs.filter((l) => l.advanceId === a.id && l.date && l.date <= asOf);
    const liq = r2(mine.filter((l) => l.type !== 'refund').reduce((n, l) => n + (+l.amount || 0), 0));
    const ref = r2(mine.filter((l) => l.type === 'refund').reduce((n, l) => n + (+l.amount || 0), 0));
    const bal = r2((+a.amount || 0) - liq - ref), dd = days(a.date, asOf);
    return { ...a, liq, ref, bal, dd, age: dd <= 30 ? 0 : dd <= 60 ? 1 : dd <= 90 ? 2 : 3 };
  }).filter((a) => a.bal > 0.004);
  // Funds in the order of the bank accounts; persons: AOs first, then by name.
  const fundName = (a) => a.fund || 'Fund not identified';
  const fOrder = (f) => { const i = accounts.findIndex((x) => x.fund === f); return i < 0 ? 99 : i; };
  const funds = [...new Set(open.map(fundName))].sort((a, b) => fOrder(a) - fOrder(b) || a.localeCompare(b));
  const sums = (xs) => { const t = { amt: 0, liq: 0, ref: 0, bal: 0, ag: [0, 0, 0, 0] }; xs.forEach((a) => { t.amt += +a.amount || 0; t.liq += a.liq; t.ref += a.ref; t.bal += a.bal; t.ag[a.age] += a.bal; });
    return { amt: r2(t.amt), liq: r2(t.liq), ref: r2(t.ref), bal: r2(t.bal), ag: t.ag.map(r2) }; };
  const n0 = (v) => (v ? v : '');
  const totRow = (label, t) => [{ t: label, span: 3, bold: true }, { t: t.amt, bold: true }, { t: n0(t.liq), bold: true }, { t: n0(t.ref), bold: true }, { t: t.bal, bold: true }, '', ...t.ag.map((v) => ({ t: n0(v), bold: true }))];
  // The rows: kind (fund, person, check, sub, ftot) and the cells (as in the printout).
  const rows = [];
  funds.forEach((f) => {
    const fx = open.filter((a) => fundName(a) === f);
    rows.push({ kind: 'fund', cells: [{ t: f.toUpperCase(), span: 12, bold: true }] });
    const persons = [...new Set(fx.map((a) => `${a.isAo ? 0 : 1}|${a.officer || '(no name)'}`))].sort();
    persons.forEach((pk) => {
      const px = fx.filter((a) => `${a.isAo ? 0 : 1}|${a.officer || '(no name)'}` === pk).sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.checkNo).localeCompare(String(b.checkNo), undefined, { numeric: true }));
      const p = px[0];
      rows.push({ kind: 'person', cells: [{ t: `${p.officer || '(no name)'}${p.designation ? ' · ' + p.designation : ''}${p.isAo ? ' (AO)' : ''}`, span: 12, bold: true }] });
      px.forEach((a) => rows.push({ kind: 'check', cells: [fmtDate(a.date), a.rest ? 'Beginning' : a.checkNo, a.particulars || '', r2(a.amount), n0(a.liq), n0(a.ref), a.bal, String(a.dd), ...[0, 1, 2, 3].map((k) => (a.age === k ? a.bal : ''))] }));
      rows.push({ kind: 'sub', cells: totRow('Subtotal', sums(px)) });
    });
    rows.push({ kind: 'ftot', cells: totRow(`Total, ${f}`, sums(fx)) });
  });
  const grand = sums(open);
  const sub = `${who === 'ao' ? 'Accountable officers only' : 'All cash advances'} · all bank accounts`;
  const spec = () => ({ title: 'Unliquidated Cash Advances', sheet: 'Unliquidated CA', office: agencyName(refs, lgu), acct: sub, month: `As of ${longDate(asOf)}`, landscape: true, cols: COLS,
    empty: 'No unliquidated cash advance.', rows: rows.map((r) => r.cells), total: totRow('Grand Total', grand) });

  // On screen: the printout.
  const td = (c, i) => { const o = c !== null && typeof c === 'object' ? c : { t: c }; const num = typeof o.t === 'number';
    return `<td${o.span > 1 ? ` colspan="${o.span}"` : ''} class="${num || (COLS[i] && COLS[i].right && !(o.span > 1)) ? 'r' : ''}">${num ? money(o.t) : esc(o.t)}</td>`; };
  const tr = (r) => { let col = 0; return `<tr class="ul-${r.kind}">${r.cells.map((c) => { const h = td(c, col); col += (c && c.span) || 1; return h; }).join('')}</tr>`; };
  const H = `<tr>${COLS.slice(0, 8).map((c) => `<th rowspan="2">${esc(c.h)}</th>`).join('')}<th colspan="4" class="lq-g">AGING (DAYS OUTSTANDING)</th></tr><tr>${COLS.slice(8).map((c) => `<th>${esc(c.h)}</th>`).join('')}</tr>`;
  const inner = `<div class="panel sd-pan"><div class="ul-bar">
      <div class="field"><label for="ul-who">Show</label><select class="input" id="ul-who"><option value="all" ${who === 'all' ? 'selected' : ''}>All cash advances</option><option value="ao" ${who === 'ao' ? 'selected' : ''}>AOs only</option></select></div>
      <div class="field"><label for="ul-asof">As of</label><input class="input" type="date" id="ul-asof" value="${esc(asOf)}"></div>
      <button class="btn sm" type="button" id="ul-end">End of ${esc(MONTHS[+m.slice(5, 7) - 1])}</button>${countDate ? `<button class="btn sm" type="button" id="ul-cnt" title="${esc(fmtDate(countDate))}">Cash count date</button>` : ''}
      <span class="ul-sp"></span>${outButtons('ul')}</div>
    <div class="rp-doc"><div class="rp-page rp-wide lq-page"><h2 class="rp-title">UNLIQUIDATED CASH ADVANCES</h2>
      <p class="c"><b>${esc(agencyName(refs, lgu))}</b><br>${esc(sub)}<br>As of ${esc(longDate(asOf))}</p>
      <table class="rp-t lq-t ul-t"><colgroup>${COLS.map((c) => `<col style="width:${(c.w / 12 * 100).toFixed(2)}%">`).join('')}</colgroup><thead>${H}</thead>
      <tbody>${rows.length ? rows.map(tr).join('') : '<tr><td colspan="12" class="c">No unliquidated cash advance.</td></tr>'}${tr({ kind: 'gtot', cells: totRow('Grand Total', grand) })}</tbody></table></div></div>
    <p class="af-note">Cash advances from the CkDJ (the payee is the person; an AO is matched by name) and those typed in Cash Examination, Cash Advances. The beginning balance not itemized by check is not listed.</p></div>`;
  const wire = () => {
    wireOut('ul', spec, `Unliquidated Cash Advances ${agencyName(refs, lgu)} ${asOf}`, (msg) => toast(msg, 'bad'));
    $('#ul-who').onchange = (e) => go({ who: e.target.value === 'ao' ? 'ao' : '' });
    $('#ul-asof').onchange = (e) => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) go({ asof: e.target.value }); };
    $('#ul-end').onclick = () => go({ asof: '' });
    if ($('#ul-cnt')) $('#ul-cnt').onclick = () => go({ asof: countDate });
  };
  return { inner, wire };
}
