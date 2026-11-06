// Source Documents · Tax Remittances (design approved 6 Nov 2026). One list per office (all funds): the taxes withheld
// in every bank account are paid to the BIR from the General Fund (the other funds transfer their share to it).
//   cer_settings 'taxrem|<lguId>'  { list: [{ id, date (paid), form: 'ewt' | 'vat' | 'pt', month (YYYY-MM, for the month),
//                                     amount, acctId (paid from; default the General Fund account), ref (ETPS / eFPS No.) }],
//                                     begs: { <last cash exam date>: { vat, ewt, pt } } (unremitted then: Due to BIR, typed) }
// Withheld = the Tax Register of all accounts (business tax: VAT 5% or percentage tax 3%; EWT 1% or 2%).
// Schedule: unremitted at the last cash exam + withheld in the period − remitted in the period = unremitted at the cut-off.
// A remittance is a Cash in Bank debit in the Cashbook of its account, and a book item matched to the bank's ETPS debit.
import { store, newId } from '../../js/store.js';
import { esc, modal, toast, $, $$ } from '../../js/ui.js';
import { by, fmtDate, money, num } from '../cer/cer.js';
import { taxOf, isTaxable } from './journal.js';
import { sameFund, colFundOf } from '../cer/funds.js';

const r2 = (n) => Math.round((+n || 0) * 100) / 100;
export const TAXF = { vat: { label: 'VAT', forms: '1600-VT' }, ewt: { label: 'EWT', forms: '0619-E / 1601-EQ' }, pt: { label: 'Percentage Tax', forms: '1600-PT' } };
const KS = ['vat', 'ewt', 'pt'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (m) => (m ? `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}` : '');
const bad = (m) => { toast(m, 'bad'); return false; };

export const remOf = (settings, lguId) => ({ list: [], begs: {}, ...((settings && settings['taxrem|' + lguId]) || {}) });
// The account a remittance is paid from (none typed: the General Fund's).
export const remAcctId = (r, accounts) => r.acctId || (accounts.find((a) => sameFund(a.fund, colFundOf(accounts))) || accounts[0])?.id || '';
export const remText = (r) => `Remittance of taxes withheld · ${TAXF[r.form]?.forms || ''} · ${monthName(r.month)}`;

// Taxes withheld by month, all accounts of the office: { 'YYYY-MM': { vat, ewt, pt } }.
function withheldByMonth(jr, lguId, from = '', to = '9999') {
  const out = {};
  jr.filter((c) => c.lguId === lguId && isTaxable(c) && c.date && c.date >= from && c.date <= to).forEach((c) => {
    const t = taxOf(c), m = c.date.slice(0, 7), o = (out[m] = out[m] || { vat: 0, ewt: 0, pt: 0 });
    if (t.vat === false) o.pt = r2(o.pt + t.main); else o.vat = r2(o.vat + t.main);
    o.ewt = r2(o.ewt + t.one);
  });
  return out;
}
const add3 = (a, b, s = 1) => ({ vat: r2((a.vat || 0) + s * (b.vat || 0)), ewt: r2((a.ewt || 0) + s * (b.ewt || 0)), pt: r2((a.pt || 0) + s * (b.pt || 0)) });
const tot3 = (a) => r2((a.vat || 0) + (a.ewt || 0) + (a.pt || 0));
const sumBy = (rows) => rows.reduce((o, x) => add3(o, { [x.form]: +x.amount || 0 }), { vat: 0, ewt: 0, pt: 0 });

// The period: from the last cash exam of the office's latest cash examination to its count date.
async function periodOf(lguId) {
  const [audits0, exams0, officers0] = await Promise.all(['cer_audits', 'cer_exams', 'cer_officers'].map((t) => store.list(t)));
  const audit = audits0.map((r) => ({ id: r.id, ...r.data })).filter((a) => a.lguId === lguId && a.countDate).sort((a, b) => String(b.countDate).localeCompare(String(a.countDate)))[0];
  if (!audit) return null;
  const exs = exams0.map((r) => ({ id: r.id, ...r.data })).filter((e) => e.auditId === audit.id);
  const off = Object.fromEntries(officers0.map((r) => [r.id, r.data]));
  const ex = exs.find((e) => /treasurer/i.test(off[e.officerId]?.designation || '')) || exs[0];
  return { from: ex?.lastExamDate || '', to: audit.countDate };
}

export async function taxRemView({ lgu, accounts, jr, settings, enc, refs }) {
  const R = remOf(settings, lgu.id), P = await periodOf(lgu.id);
  const list = (R.list || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const acctName = (id) => { const a = accounts.find((x) => x.id === id); return a ? `${a.fund} · ${a.accountNo || ''}` : ''; };
  const defAcct = remAcctId({}, accounts);
  const v = (x) => (x ? money(x) : '');
  // Schedule for the period.
  let sched = '<p class="af-note">Set up the cash examination of this office (Audit Setup) to see the schedule for its period.</p>';
  if (P) {
    const beg = R.begs?.[P.from] || {}, wh = Object.values(withheldByMonth(jr, lgu.id, P.from, P.to)).reduce((o, x) => add3(o, x), { vat: 0, ewt: 0, pt: 0 });
    const rem = sumBy(list.filter((r) => r.date >= P.from && r.date <= P.to)), end = add3(add3(beg, wh), rem, -1);
    const row = (label, o, cls = '') => `<tr class="${cls}"><td>${label}</td>${KS.map((k) => `<td class="r">${money(o[k] || 0)}</td>`).join('')}<td class="r"><b>${money(tot3(o))}</b></td></tr>`;
    sched = `<table class="af-reg tr-sched"><thead><tr><th>${esc(fmtDate(P.from))} to ${esc(fmtDate(P.to))}</th>${KS.map((k) => `<th class="r">${TAXF[k].label}</th>`).join('')}<th class="r">Total</th></tr></thead><tbody>
      <tr><td>Unremitted, last cash exam <small class="dim">(Due to BIR, from the books)</small></td>${KS.map((k) => `<td class="r">${enc ? `<input class="input af-sm r tr-beg" data-k="${k}" inputmode="decimal" value="${v(beg[k])}" placeholder="0.00" aria-label="Unremitted ${TAXF[k].label}">` : money(beg[k] || 0)}</td>`).join('')}<td class="r">${money(tot3(beg))}</td></tr>
      ${row('+ Withheld this period <small class="dim">(Tax Register, all funds)</small>', wh)}${row('− Remitted this period', rem)}${row('= Unremitted at the cut-off', end, 'cc-tot')}</tbody></table>
      ${enc ? '<div class="cd-actions"><button class="btn sm" type="button" id="tr-begsave">Save beginning</button></div>' : ''}`;
  }
  // By month: withheld (all funds) vs remitted (for the month).
  const wm = withheldByMonth(jr, lgu.id), rm = {};
  list.forEach((r) => { if (!r.month) return; rm[r.month] = add3(rm[r.month] || {}, { [r.form]: +r.amount || 0 }); });
  const fromM = P?.from ? P.from.slice(0, 7) : '', toM = P?.to ? P.to.slice(0, 7) : '';
  const months = [...new Set([...Object.keys(wm), ...Object.keys(rm)])].filter((m) => (!fromM || m >= fromM) && (!toM || m <= toM)).sort();
  const before = list.filter((r) => fromM && r.month && r.month < fromM && (!P || (r.date >= P.from && r.date <= P.to)));
  const mrows = months.map((m) => { const w = wm[m] || {}, r = rm[m] || {}, u = r2(tot3(w) - tot3(r)), due = m < toM;
    return `<tr><td>${esc(monthName(m))}</td>${KS.map((k) => `<td class="r">${v(w[k])}</td>`).join('')}${KS.map((k) => `<td class="r">${v(r[k])}</td>`).join('')}<td class="r">${u > 0.004 && due ? `<b class="warn-t">${money(u)} ⚠</b>` : money(u)}</td></tr>`; }).join('');
  const bRow = before.length ? `<tr class="dim"><td>Months before the period <small>(in the beginning)</small></td><td colspan="3"></td>${KS.map((k) => `<td class="r">${v(sumBy(before)[k])}</td>`).join('')}<td></td></tr>` : '';
  const monthly = months.length || before.length ? `<div class="af-tbl"><table class="af-reg tr-month"><thead><tr><th rowspan="2">For the Month</th><th colspan="3" class="c">Withheld (all funds)</th><th colspan="3" class="c">Remitted</th><th rowspan="2" class="r">Unremitted</th></tr>
      <tr>${KS.map((k) => `<th class="r">${TAXF[k].label}</th>`).join('')}${KS.map((k) => `<th class="r">${TAXF[k].label}</th>`).join('')}</tr></thead><tbody>${bRow}${mrows}</tbody></table></div>` : '';
  const entry = enc ? `<div class="sd-line tr-entry" id="tr-form">
      <div class="sd-f sd-w-date"><label for="tr-date">Date Paid</label><input class="input" type="date" id="tr-date"></div>
      <div class="sd-f tr-w-form"><label for="tr-formk">Form</label><select class="input" id="tr-formk">${KS.map((k) => `<option value="${k}">${TAXF[k].label} · ${TAXF[k].forms}</option>`).join('')}</select></div>
      <div class="sd-f tr-w-mo"><label for="tr-month">For the Month</label><input class="input" type="month" id="tr-month"></div>
      <div class="sd-f sd-w-amt"><label for="tr-amt">Amount</label><input class="input r" id="tr-amt" inputmode="decimal"></div>
      <div class="sd-f tr-w-acct"><label for="tr-acct">Paid from</label><select class="input" id="tr-acct">${accounts.map((a) => `<option value="${esc(a.id)}" ${a.id === defAcct ? 'selected' : ''}>${esc(a.fund)} · ${esc(a.accountNo || '')}</option>`).join('')}</select></div>
      <div class="sd-f sd-w-ref"><label for="tr-ref">Reference</label><input class="input" id="tr-ref" placeholder="ETPS No."></div>
      <div class="sd-f sd-w-btn"><label>&nbsp;</label><button class="btn primary" type="button" id="tr-save">Enter</button></div></div>` : '';
  const tbl = list.length ? `<div class="af-tbl"><table class="af-reg"><thead><tr><th>Date Paid</th><th>Form</th><th>For the Month</th><th class="r">Amount</th><th>Paid from</th><th>Reference</th><th></th></tr></thead>
      <tbody>${list.map((r) => `<tr><td>${esc(fmtDate(r.date))}</td><td>${TAXF[r.form]?.label || ''} <small class="dim">${TAXF[r.form]?.forms || ''}</small></td><td>${esc(monthName(r.month))}</td><td class="r">${money(r.amount)}</td><td>${esc(acctName(remAcctId(r, accounts)))}</td><td>${esc(r.ref || '')}</td>
        <td class="r">${enc ? `<button class="btn sm" type="button" data-tredit="${esc(r.id)}">Edit</button> <button class="btn sm" type="button" data-trdel="${esc(r.id)}">Remove</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="af-note">No tax remittance yet.</p>';
  const html = `<div class="panel sd-pan"><div class="cd-orhead"><h3 class="cer-h3">Tax Remittances · all funds</h3><span class="pill">${list.length}</span></div>
    <p class="af-note">Taxes withheld in every fund are paid to the BIR from the General Fund. A remittance shows in the Cashbook of the account it is paid from and matches the bank's ETPS debit.</p>
    ${sched}${monthly}<h3 class="cer-h3" style="margin-top:14px">Remittances</h3>${entry}${tbl}</div>`;

  const saveR = async (patch, msg) => { await store.save('cer_settings', 'taxrem|' + lgu.id, { ...remOf(settings, lgu.id), ...patch }, by(refs)); toast(msg, 'ok'); };
  const wire = () => {
    if (!enc) return;
    let editId = '';
    $$('.tr-beg').forEach((el) => { el.onblur = () => { const x = num(el.value); if (x !== null) el.value = money(x); }; });
    if ($('#tr-begsave')) $('#tr-begsave').onclick = () => { const b = {}; $$('.tr-beg').forEach((el) => { b[el.dataset.k] = num(el.value) || 0; }); saveR({ begs: { ...(R.begs || {}), [P.from]: b } }, 'Beginning saved.'); };
    $('#tr-amt').onblur = () => { const x = num($('#tr-amt').value); if (x !== null) $('#tr-amt').value = money(x); };
    $('#tr-save').onclick = () => {
      const x = { id: editId || newId('trem'), date: $('#tr-date').value, form: $('#tr-formk').value, month: $('#tr-month').value, amount: num($('#tr-amt').value), acctId: $('#tr-acct').value, ref: $('#tr-ref').value.trim() };
      if (!x.date) return bad('Enter the date paid.'); if (!x.month) return bad('Enter the month the taxes are for.'); if (!(x.amount > 0)) return bad('Enter the amount.');
      saveR({ list: [...(R.list || []).filter((r) => r.id !== x.id), x] }, 'Tax remittance saved.');
    };
    $$('[data-tredit]').forEach((b) => { b.onclick = () => { const r = list.find((y) => y.id === b.dataset.tredit); editId = r.id;
      $('#tr-date').value = r.date; $('#tr-formk').value = r.form; $('#tr-month').value = r.month || ''; $('#tr-amt').value = money(r.amount); $('#tr-acct').value = remAcctId(r, accounts); $('#tr-ref').value = r.ref || ''; $('#tr-save').textContent = 'Save';
      $('#tr-form').scrollIntoView({ block: 'center' }); }; });
    $$('[data-trdel]').forEach((b) => { b.onclick = async () => { const ok = await modal({ title: 'Remove this tax remittance?', body: '<p style="margin:0">Only for an encoding mistake.</p>', buttons: [{ label: 'Keep', value: false }, { label: 'Remove', cls: 'primary', value: true }] });
      if (ok) saveR({ list: (R.list || []).filter((r) => r.id !== b.dataset.trdel) }, 'Removed.'); }; });
  };
  return { html, wire };
}

// From the bank statement: a debit line recorded as a tax payment (date, amount and account filled in).
export async function recordFromLine({ refs, lguId, settings, accounts, acct, line }) {
  let out = null;
  const prev = new Date(Date.UTC(+line.date.slice(0, 4), +line.date.slice(5, 7) - 2, 1)).toISOString().slice(0, 7);
  await modal({ title: 'Record as tax payment', body: `<p class="af-note" style="margin-top:0">${esc(fmtDate(line.date))} · ${esc(line.desc || '')} · ₱${money(line.debit)} · ${esc(acct.fund)}</p>
    <div class="cd-g2"><div class="field"><label for="rt-form">Form</label><select class="input" id="rt-form">${KS.map((k) => `<option value="${k}">${TAXF[k].label} · ${TAXF[k].forms}</option>`).join('')}</select></div>
    <div class="field"><label for="rt-month">For the Month</label><input class="input" type="month" id="rt-month" value="${prev}"></div>
    <div class="field"><label for="rt-ref">Reference</label><input class="input" id="rt-ref" placeholder="ETPS No."></div></div>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Save', cls: 'primary', value: 'ok', check: (bg) => {
      const m = $('#rt-month', bg).value; if (!m) return bad('Enter the month the taxes are for.');
      out = { id: newId('trem'), date: line.date, form: $('#rt-form', bg).value, month: m, amount: line.debit, acctId: acct.id, ref: $('#rt-ref', bg).value.trim() }; return true; } }] });
  if (!out) return;
  const R = remOf(settings, lguId);
  await store.save('cer_settings', 'taxrem|' + lguId, { ...R, list: [...(R.list || []), out] }, by(refs));
  toast('Recorded as a tax payment.', 'ok');
}
