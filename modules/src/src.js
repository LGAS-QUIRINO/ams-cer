// AMS · Source Documents (design approved 5 Nov 2026).
// The auditee's records encoded once, read by Cash Examination (and later Records Management).
// First record: the Check Disbursements Journal, per LGU and bank account; the Tax Register and the Report of Checks Issued
// are made from it. Data and tax rules: journal.js.
import { store, newId } from '../../js/store.js';
import { esc, modal, toast, $, $$, today } from '../../js/ui.js';
import { roleLine } from '../../js/views/admin.js';
import { moduleFrame } from '../../js/frame.js';
import { hasRole, by, mayView, agencyName, fmtDate, money, num } from '../cer/cer.js';
import { exportXlsx, loadXlsx, excelDate } from '../cer/forms.js';
import { accountsModal, DEFAULT_FUNDS } from '../cer/banks.js';
import { loadCoa, loadJournal, CA_CODES, grossOf, taxOf, checkAmountOf, isCa, chkNo } from './journal.js';

const r2 = (n) => Math.round((+n || 0) * 100) / 100;
const flat = (r) => ({ id: r.id, ...r.data });
const canEncode = (refs) => hasRole(refs, 'staff', 'member', 'atl', 'sa', 'admin');
const acctLabel = (x) => `${x.bank || 'Bank'} · ${x.accountNo || '—'} · ${x.fund}`;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (m) => `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
const go = (params) => { const q = new URLSearchParams(location.hash.split('?')[1] || ''); Object.entries(params).forEach(([k, v]) => (v ? q.set(k, v) : q.delete(k))); location.hash = '#/src?' + q.toString(); };
const bad = (m) => { toast(m, 'bad'); return false; };
const blankLine = () => ({ code: '', name: '', gross: '' });
const ED = { id: '', key: '', d: null };   // the check in the entry form (kept across redraws)

if (!document.querySelector('link[data-cer]')) {
  const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'modules/cer/cer.css'; l.dataset.cer = '1'; document.head.appendChild(l);
}

export async function render(ctx) {
  const { app, refs, q } = ctx;
  const me = refs.me ? refs.me.data : { name: ctx.session.name || ctx.session.email };
  const roleText = [refs.me?.data.position, roleLine(refs)].filter(Boolean).join(' · ');
  const { body, wire } = await journalView(ctx);
  app.innerHTML = moduleFrame({ title: 'Source<br>Documents', items: [{ key: 'ckdj', label: 'Check Disbursements', icon: 'book', href: '#/src' }, { section: true, label: 'OTHER MODULES' }, { key: 'cer', label: 'Cash Examination', icon: 'overview', href: '#/cer' }],
    active: 'ckdj', crumb: 'Check Disbursements Journal', me, roleText, body });
  if (wire) wire();
}

async function journalView(ctx) {
  const { refs, q } = ctx;
  const enc = canEncode(refs);
  const [settings0, jr, officers0, books0, coa] = await Promise.all([store.list('cer_settings'), loadJournal(), store.list('cer_officers'), store.list('cer_booklets'), loadCoa()]);
  const settings = Object.fromEntries(settings0.map((s) => [s.id, s.data]));
  // Offices sorted by municipality: the province, then each municipality followed by its barangays.
  const munOf = (l) => (l.data.kind === 'barangay' ? refs.lgu[l.data.parentId] : l.data.kind === 'municipality' ? l : null);
  const sortKey = (l) => { const mu = munOf(l); return [l.data.kind === 'province' ? '0' : '1', mu ? mu.data.name : '', l.data.kind === 'barangay' ? '1' + l.data.name : '0'].join('|'); };
  const lgus = Object.values(refs.lgu).filter((l) => mayView(refs, l)).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const officeName = (l) => (l.data.kind === 'barangay' ? `${agencyName(refs, l)} · ${munOf(l)?.data.name || ''}` : agencyName(refs, l));
  if (!lgus.length) return { body: '<div class="panel"><div class="empty"><b>No LGU assigned to you.</b></div></div>' };
  const lgu = lgus.find((l) => l.id === q.get('l')) || lgus[0];
  const accounts = settings['banks|' + lgu.id]?.list || [];
  const funds = settings['funds|' + lgu.id]?.list || DEFAULT_FUNDS;
  const acct = accounts.find((x) => x.id === q.get('acct')) || accounts[0] || null;
  const m = /^\d{4}-\d{2}$/.test(q.get('m') || '') && +q.get('m').slice(0, 4) > 1990 ? q.get('m') : today().slice(0, 7);
  const yNow = +today().slice(0, 4), years = []; for (let y = yNow + 1; y >= yNow - 6; y--) years.push(y);
  const tab = ['ckdj', 'tax', 'rci'].includes(q.get('tab')) ? q.get('tab') : 'ckdj';
  const top = `<div class="panel sd-top"><div class="field sd-office"><label for="sd-lgu">Office</label><input class="input" id="sd-lgu" list="sd-lgus" value="${esc(officeName(lgu))}" placeholder="Type the barangay or municipality" autocomplete="off">
        <datalist id="sd-lgus">${lgus.map((l) => `<option value="${esc(officeName(l))}">`).join('')}</datalist></div>
      <div class="field sd-acctf"><label for="sd-acct">Bank Account</label><select class="input" id="sd-acct">${accounts.length ? accounts.map((x) => `<option value="${esc(x.id)}" ${acct && x.id === acct.id ? 'selected' : ''}>${esc(acctLabel(x))}</option>`).join('') : '<option value="">No bank account yet</option>'}</select></div>
      <div class="field"><label for="sd-mo">Month</label><select class="input" id="sd-mo">${MONTHS.map((n, i) => `<option value="${String(i + 1).padStart(2, '0')}" ${+m.slice(5, 7) === i + 1 ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <div class="field"><label for="sd-yr">Year</label><select class="input" id="sd-yr">${(years.includes(+m.slice(0, 4)) ? years : [+m.slice(0, 4), ...years]).map((y) => `<option ${y === +m.slice(0, 4) ? 'selected' : ''}>${y}</option>`).join('')}</select></div>
      <button class="btn sm" type="button" id="sd-accts" title="Bank Accounts">Bank Accounts (${accounts.length})</button></div>`;
  const wireTop = () => {
    const pickOffice = (e) => { const v = e.target.value.trim().toLowerCase(); const l = lgus.find((x) => officeName(x).toLowerCase() === v) || (v ? lgus.filter((x) => officeName(x).toLowerCase().includes(v)) : []).find((x, i, all) => all.length === 1);
      if (l && l.id !== lgu.id) { ED.id = ''; ED.d = null; go({ l: l.id, acct: '' }); } };
    $('#sd-lgu').oninput = (e) => { if (lgus.some((x) => officeName(x) === e.target.value)) pickOffice(e); };
    $('#sd-lgu').onchange = pickOffice;
    $('#sd-lgu').onfocus = (e) => e.target.select();
    $('#sd-acct').onchange = (e) => { ED.id = ''; ED.d = null; go({ acct: e.target.value }); };
    const pickM = () => go({ m: `${$('#sd-yr').value}-${$('#sd-mo').value}` });
    $('#sd-mo').onchange = pickM; $('#sd-yr').onchange = pickM;
    $('#sd-accts').onclick = () => accountsModal(refs, lgu.id, accounts, funds, enc);
  };
  if (!acct) return { body: top + `<div class="panel"><div class="empty"><b>No bank account for ${esc(agencyName(refs, lgu))} yet.</b> ${enc ? 'Add the accounts with <b>Bank Accounts</b> (bank, account No. and fund).' : ''}</div></div>`, wire: wireTop };

  const names = Object.fromEntries(coa.accounts);
  const officers = officers0.map(flat).filter((o) => o.lguId === lgu.id).sort((a, b) => a.name.localeCompare(b.name));
  const chkBooks = books0.map(flat).filter((b) => b.form === 'chk');
  const inBook = (no) => { const n = chkNo(no); return !!n && chkBooks.some((b) => b.from <= n && n <= b.to); };
  const mine = jr.filter((c) => c.lguId === lgu.id && c.acctId === acct.id);
  const list = mine.filter((c) => String(c.date || '').startsWith(m)).sort((a, b) => String(a.date).localeCompare(String(b.date)) || chkNo(a.checkNo) - chkNo(b.checkNo));
  const tabs = `<div class="sd-tabs" role="tablist">${[['ckdj', 'Check Disbursements Journal'], ['tax', 'Tax Register'], ['rci', 'Report of Checks Issued']].map(([k, t]) => `<button type="button" role="tab" class="sd-tab ${k === tab ? 'on' : ''}" data-tab="${k}" aria-selected="${k === tab}">${t}</button>`).join('')}</div>`;
  const totals = { g: r2(list.reduce((n, c) => n + (c.cancelled ? 0 : grossOf(c)), 0)), t: r2(list.reduce((n, c) => n + taxOf(c).amount, 0)), a: r2(list.reduce((n, c) => n + checkAmountOf(c), 0)) };
  const offName = (id) => officers.find((o) => o.id === id)?.name || '';

  let inner = '';
  if (tab === 'ckdj') {
    // The entry form: a new check, or the one being edited.
    const key = `${lgu.id}|${acct.id}`;
    if (ED.key !== key) Object.assign(ED, { key, id: '', d: null });
    if (ED.id && !mine.some((c) => c.id === ED.id)) Object.assign(ED, { id: '', d: null });
    if (!ED.d) ED.d = { date: '', checkNo: '', ref: '', payee: '', particulars: '', lines: [blankLine()], tax: { rate: 0, one: false, amount: '' }, cancelled: false, officerId: '', note: '' };
    const form = enc ? entryHtml(ED.d, officers, !!ED.id) : '';
    const rows = list.map((c) => {
      const t = taxOf(c), ca = isCa(c);
      const pills = [c.cancelled ? '<span class="pill p-flag">Cancelled</span>' : '', ca ? `<span class="pill sd-ca">Cash advance${c.officerId ? ' · ' + esc(offName(c.officerId)) : ''}</span>` : '',
        !c.cancelled && t.amount ? `<span class="pill p-stock">${c.tax?.rate ? `${c.tax.rate}%${c.tax.one ? ' + 1%' : ''}` : 'Tax'}</span>` : '', inBook(c.checkNo) ? '' : '<span class="pill p-part">Not in a checkbook</span>'].filter(Boolean).join(' ');
      return `<tr class="${c.id === ED.id ? 'cd-on' : ''}"><td>${esc(fmtDate(c.date))}</td><td class="mono">${esc(c.checkNo)}</td><td>${esc(c.ref || '')}</td><td>${esc(c.payee || '')}</td><td>${esc(c.particulars || '')}</td>
        <td>${c.cancelled ? '' : (c.lines || []).map((l) => `<span class="mono">${esc(l.code)}</span> <small class="dim">${esc(l.name || names[l.code] || '')}</small>${(c.lines || []).length > 1 ? ` <small>₱${money(l.gross)}</small>` : ''}`).join('<br>')}</td>
        <td class="r">${c.cancelled ? '' : money(grossOf(c))}</td><td class="r">${t.amount ? money(t.amount) : ''}</td><td class="r">${c.cancelled ? '' : money(checkAmountOf(c))}</td><td>${pills}</td><td><small>${esc(c.note || '')}</small></td>
        <td>${enc ? `<button class="btn sm" type="button" data-sdedit="${esc(c.id)}">Edit</button>` : ''}</td></tr>`;
    }).join('');
    inner = `${form}<div class="panel sd-pan"><div class="cd-orhead"><h3 class="cer-h3">${esc(monthLabel(m))}</h3><span class="pill">${list.length}</span>
        ${enc ? '<button class="btn sm" type="button" id="sd-imp">Import from Excel</button>' : ''}<button class="btn sm" type="button" id="sd-xls">Export to Excel</button></div>
      ${list.length ? `<div class="af-tbl"><table class="af-reg sd-tbl"><thead><tr><th scope="col">Date</th><th scope="col">Check No.</th><th scope="col">Reference No.</th><th scope="col">Payee</th><th scope="col">Particulars</th><th scope="col">Account</th><th scope="col" class="r">Gross</th><th scope="col" class="r">Tax</th><th scope="col" class="r">Check Amount</th><th scope="col"></th><th scope="col">Auditor's Note</th><th scope="col"></th></tr></thead>
        <tbody>${rows}</tbody><tfoot><tr class="cd-foot"><td colspan="6">Total, ${esc(monthLabel(m))}</td><td class="r">${money(totals.g)}</td><td class="r">${money(totals.t)}</td><td class="r">${money(totals.a)}</td><td colspan="3"></td></tr></tfoot></table></div>`
        : `<div class="empty"><b>No check encoded for ${esc(monthLabel(m))}.</b></div>`}</div>`;
  } else if (tab === 'tax') {
    const tl = list.filter((c) => taxOf(c).amount);
    inner = `<div class="panel sd-pan"><div class="cd-orhead"><h3 class="cer-h3">Tax Register · ${esc(monthLabel(m))}</h3><span class="pill">${tl.length}</span><button class="btn sm" type="button" id="sd-txls">Export to Excel</button></div>
      ${tl.length ? `<div class="af-tbl"><table class="af-reg"><thead><tr><th scope="col">Check No.</th><th scope="col">Date</th><th scope="col">Payee</th><th scope="col" class="r">Gross</th><th scope="col" class="r">Tax Base</th><th scope="col" class="r">5% or 3%</th><th scope="col" class="r">1%</th><th scope="col" class="r">Tax Amount</th></tr></thead>
        <tbody>${tl.map((c) => { const t = taxOf(c); return `<tr><td class="mono">${esc(c.checkNo)}</td><td>${esc(fmtDate(c.date))}</td><td>${esc(c.payee || '')}</td><td class="r">${money(grossOf(c))}</td><td class="r">${t.base ? money(t.base) : ''}</td><td class="r">${t.main ? `${money(t.main)} <small class="dim">(${c.tax.rate}%)</small>` : ''}</td><td class="r">${t.one ? money(t.one) : ''}</td><td class="r">${money(t.amount)}</td></tr>`; }).join('')}</tbody>
        <tfoot><tr class="cd-foot"><td colspan="5">Total</td><td class="r">${money(r2(tl.reduce((n, c) => n + taxOf(c).main, 0)))}</td><td class="r">${money(r2(tl.reduce((n, c) => n + taxOf(c).one, 0)))}</td><td class="r">${money(r2(tl.reduce((n, c) => n + taxOf(c).amount, 0)))}</td></tr></tfoot></table></div>`
        : '<div class="empty"><b>No check with tax this month.</b></div>'}</div>`;
  } else {
    inner = `<div class="panel sd-pan"><div class="cd-orhead"><h3 class="cer-h3">Report of Checks Issued · ${esc(monthLabel(m))}</h3><span class="pill">${list.length}</span><button class="btn sm" type="button" id="sd-print">Print</button><button class="btn sm" type="button" id="sd-rxls">Export to Excel</button></div>
      <div id="cer-print" class="rp-doc"><div class="rp-page"><h2 class="rp-title">REPORT OF CHECKS ISSUED</h2>
        <p class="c"><b>${esc(agencyName(refs, lgu))}</b><br>${esc(acctLabel(acct))}<br>${esc(monthLabel(m))}</p>
        <table class="rp-t"><thead><tr><th>Date</th><th>Check No.</th><th>DV / Payroll No.</th><th>Payee</th><th>Nature of Payment</th><th class="r">Amount</th></tr></thead>
        <tbody>${list.length ? list.map((c) => `<tr><td>${esc(fmtDate(c.date))}</td><td>${esc(c.checkNo)}</td><td>${c.cancelled ? '' : esc(c.ref || '')}</td>${c.cancelled ? '<td colspan="2">Cancelled</td><td class="r">–</td>' : `<td>${esc(c.payee || '')}</td><td>${esc(c.particulars || '')}</td><td class="r">${money(checkAmountOf(c))}</td>`}</tr>`).join('') : '<tr><td colspan="6" class="c">No check issued this month.</td></tr>'}
        <tr class="tot"><td colspan="5">Total</td><td class="r">${money(totals.a)}</td></tr></tbody></table></div></div></div>`;
  }
  const body = top + tabs + inner;

  const wire = () => {
    wireTop();
    $$('[data-tab]').forEach((b) => { b.onclick = () => go({ tab: b.dataset.tab }); });
    const xRows = () => list.map((c) => ({ Date: fmtDate(c.date), 'Check No.': c.checkNo, 'Reference No.': c.ref || '', Payee: c.payee || '', Particulars: c.cancelled ? 'Cancelled' : c.particulars || '',
      Accounts: (c.lines || []).map((l) => `${l.code} ${l.name || names[l.code] || ''}`).join('; '), Gross: c.cancelled ? 0 : grossOf(c), Tax: taxOf(c).amount, 'Check Amount': checkAmountOf(c), "Auditor's Note": c.note || '' }));
    const fileBase = `${agencyName(refs, lgu)} ${acct.accountNo || ''} ${m}`;
    if ($('#sd-xls')) $('#sd-xls').onclick = () => exportXlsx(`Check Disbursements Journal ${fileBase}.xlsx`, 'CkDJ', xRows());
    if ($('#sd-txls')) $('#sd-txls').onclick = () => exportXlsx(`Tax Register ${fileBase}.xlsx`, 'Tax Register', list.filter((c) => taxOf(c).amount).map((c) => { const t = taxOf(c); return { 'Check No.': c.checkNo, Date: fmtDate(c.date), Payee: c.payee || '', Gross: grossOf(c), 'Tax Base': t.base || '', '5% or 3%': t.main || '', Rate: c.tax?.rate ? c.tax.rate + '%' : '', '1%': t.one || '', 'Tax Amount': t.amount }; }));
    if ($('#sd-rxls')) $('#sd-rxls').onclick = () => exportXlsx(`RCI ${fileBase}.xlsx`, 'RCI', list.map((c) => ({ Date: fmtDate(c.date), 'Check No.': c.checkNo, 'DV / Payroll No.': c.cancelled ? '' : c.ref || '', Payee: c.cancelled ? 'Cancelled' : c.payee || '', 'Nature of Payment': c.cancelled ? '' : c.particulars || '', Amount: checkAmountOf(c) })));
    if ($('#sd-print')) $('#sd-print').onclick = () => { document.body.classList.add('af-printing', 'rp-printing'); window.print(); document.body.classList.remove('af-printing', 'rp-printing'); };
    $$('[data-sdedit]').forEach((b) => { b.onclick = () => { const c = mine.find((x) => x.id === b.dataset.sdedit); ED.id = c.id; ED.d = JSON.parse(JSON.stringify({ tax: { rate: 0, one: false, amount: '' }, lines: [blankLine()], ...c })); if (!ED.d.lines.length) ED.d.lines = [blankLine()]; ctx.rerender(); setTimeout(() => { const f = $('#sd-form'); if (f) f.scrollIntoView({ block: 'start' }); }, 0); }; });
    if ($('#sd-imp')) $('#sd-imp').onclick = () => importJournal({ refs, lgu, acct, mine, coa, names });
    if (enc && tab === 'ckdj') wireEntry({ refs, lgu, acct, mine, coa, names, officers, rerender: ctx.rerender });
  };
  return { body, wire };
}

/* ---------- the entry form ---------- */
function entryHtml(d, officers, editing) {
  const t = d.tax || {};
  const lineRow = (l, i) => `<tr data-ln="${i}"><td><input class="input mono sd-code" list="sd-coa" value="${esc(l.code)}" placeholder="Type code or title" aria-label="Account code"></td>
      <td class="sd-name">${esc(l.name || '')}</td><td><input class="input r sd-gross" inputmode="decimal" value="${l.gross === '' || l.gross === undefined ? '' : esc(money(l.gross))}" aria-label="Gross amount"></td>
      <td>${d.lines.length > 1 ? `<button class="btn sm sd-xl" type="button" aria-label="Remove line">✕</button>` : ''}</td></tr>`;
  return `<div class="panel sd-pan" id="sd-form"><div class="cd-orhead"><h3 class="cer-h3">${editing ? `Edit Check No. ${esc(d.checkNo)}` : 'New Check'}</h3></div>
    <div class="sd-g5">
      <div class="field"><label for="sd-date">Date</label><input class="input" type="date" id="sd-date" value="${esc(d.date)}"></div>
      <div class="field"><label for="sd-no">Check No.</label><input class="input mono" id="sd-no" value="${esc(d.checkNo)}"></div>
      <div class="field"><label for="sd-ref">Reference No.</label><input class="input" id="sd-ref" value="${esc(d.ref)}" placeholder="DV / Payroll No."></div>
      <div class="field"><label for="sd-payee">Payee</label><input class="input" id="sd-payee" value="${esc(d.payee)}"></div>
      <div class="field"><label for="sd-part">Particulars</label><input class="input" id="sd-part" value="${esc(d.particulars)}"></div></div>
    <label class="cer-tick sd-cx"><input type="checkbox" id="sd-cancel" ${d.cancelled ? 'checked' : ''}> Cancelled</label>
    <div id="sd-amts" ${d.cancelled ? 'hidden' : ''}>
      <div class="af-tbl"><table class="af-reg cd-edit sd-lines"><thead><tr><th scope="col">Account Code</th><th scope="col">Account Name</th><th scope="col" class="r">Gross Amount</th><th scope="col"></th></tr></thead>
        <tbody>${d.lines.map(lineRow).join('')}</tbody></table></div>
      <div class="cd-actions sd-left"><button class="btn sm" type="button" id="sd-addln">+ Account line</button></div>
      <div class="sd-g5">
        <div class="field"><label for="sd-rate">Tax</label><select class="input" id="sd-rate"><option value="0" ${!t.rate && !num(t.amount) ? 'selected' : ''}>None</option><option value="5" ${t.rate === 5 ? 'selected' : ''}>5% · VAT (gross ÷ 1.12)</option><option value="3" ${t.rate === 3 ? 'selected' : ''}>3% · Non-VAT (gross)</option><option value="x" ${!t.rate && num(t.amount) ? 'selected' : ''}>Type the amount</option></select></div>
        <label class="cer-tick sd-one" ${t.rate ? '' : 'hidden'}><input type="checkbox" id="sd-one" ${t.one ? 'checked' : ''}> 1%</label>
        <div class="field"><label for="sd-tax">Tax Amount</label><input class="input r" id="sd-tax" inputmode="decimal" value="" ${!t.rate && num(t.amount) ? '' : 'readonly'}></div>
        <div class="field"><label>Check Amount</label><div class="input cd-ro r" id="sd-chk"></div></div>
        <div class="field" id="sd-offbox" hidden><label for="sd-off">Officer (cash advance)</label><select class="input" id="sd-off"><option value="">— Officer —</option>${officers.map((o) => `<option value="${esc(o.id)}" ${o.id === d.officerId ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select></div></div></div>
    <div class="field sd-note"><label for="sd-note">Auditor's Note</label><input class="input" id="sd-note" value="${esc(d.note || '')}"></div>
    <div class="cd-actions">${editing ? '<button class="btn" type="button" id="sd-del">Delete</button><button class="btn" type="button" id="sd-new">Cancel</button>' : '<button class="btn" type="button" id="sd-new">Clear</button>'}<button class="btn primary" type="button" id="sd-save">${editing ? 'Save Changes' : 'Save Check'}</button></div></div>`;
}

function wireEntry(c) {
  const { refs, lgu, acct, mine, coa, names, rerender } = c;
  const d = ED.d;
  const form = $('#sd-form'); if (!form) return;
  if (!$('#sd-coa')) { const dl = document.createElement('datalist'); dl.id = 'sd-coa'; dl.innerHTML = coa.accounts.map(([k, t]) => `<option value="${esc(k)}">${esc(t)}</option>`).join(''); document.body.appendChild(dl); }
  // A typed code or title becomes the code; the name follows the Chart of Accounts.
  const toCode = (v) => { const t = String(v || '').trim(); if (names[t]) return t; const hit = coa.accounts.find(([k, n]) => n.toLowerCase() === t.toLowerCase()); return hit ? hit[0] : t; };
  const read = () => {
    d.date = $('#sd-date').value; d.checkNo = $('#sd-no').value.trim(); d.ref = $('#sd-ref').value.trim(); d.payee = $('#sd-payee').value.trim(); d.particulars = $('#sd-part').value.trim();
    d.cancelled = $('#sd-cancel').checked; d.note = $('#sd-note').value.trim(); d.officerId = $('#sd-off').value;
    d.lines = $$('.sd-lines tbody tr').map((tr) => { const code = toCode($('.sd-code', tr).value); return { code, name: names[code] || '', gross: num($('.sd-gross', tr).value) ?? '' }; });
    const rate = $('#sd-rate').value;
    d.tax = rate === 'x' ? { rate: 0, one: false, amount: num($('#sd-tax').value) || 0 } : { rate: +rate, one: +rate ? $('#sd-one').checked : false, amount: 0 };
  };
  const paint = () => {
    read();
    $$('.sd-lines tbody tr').forEach((tr, i) => { $('.sd-name', tr).textContent = d.lines[i].name || (d.lines[i].code ? 'Not in the Chart of Accounts' : ''); });
    $('#sd-amts').hidden = d.cancelled;
    $('.sd-one').hidden = !d.tax.rate;
    const t = taxOf(d);
    if ($('#sd-rate').value !== 'x') $('#sd-tax').value = t.amount ? money(t.amount) : '';
    $('#sd-tax').readOnly = $('#sd-rate').value !== 'x';
    $('#sd-chk').textContent = money(checkAmountOf(d));
    $('#sd-offbox').hidden = !d.lines.some((l) => CA_CODES.includes(l.code));
  };
  const wireLines = () => {
    $$('.sd-lines input').forEach((el) => { el.oninput = paint; el.onchange = () => { if (el.classList.contains('sd-code')) el.value = toCode(el.value); paint(); }; });
    $$('.sd-xl').forEach((b) => { b.onclick = () => { read(); d.lines.splice(+b.closest('tr').dataset.ln, 1); rerender(); }; });
  };
  wireLines();
  ['#sd-date', '#sd-no', '#sd-ref', '#sd-payee', '#sd-part', '#sd-note', '#sd-tax'].forEach((k) => { $(k).oninput = paint; });
  ['#sd-cancel', '#sd-rate', '#sd-one', '#sd-off'].forEach((k) => { $(k).onchange = paint; });
  $('#sd-addln').onclick = () => { read(); d.lines.push(blankLine()); rerender(); setTimeout(() => { const all = $$('.sd-code'); if (all.length) all[all.length - 1].focus(); }, 0); };
  $('#sd-new').onclick = () => { ED.id = ''; ED.d = null; rerender(); };
  if ($('#sd-del')) $('#sd-del').onclick = async () => {
    const ok = await modal({ title: 'Delete this check?', body: `<p style="margin:0">Delete Check No. <b>${esc(d.checkNo)}</b> from the journal?</p>`, buttons: [{ label: 'Cancel', value: false }, { label: 'Delete', cls: 'danger', value: true }] });
    if (!ok) return;
    const cur = mine.find((x) => x.id === ED.id); const { id, ...rec } = cur;
    await store.save('src_ckdj', id, rec, by(refs), { deleted: true }); ED.id = ''; ED.d = null; toast('Check deleted.', 'ok');
  };
  $('#sd-save').onclick = async () => {
    read();
    if (!d.date) return bad('Enter the date.');
    if (!chkNo(d.checkNo)) return bad('Enter the check No.');
    const dup = mine.concat().find((x) => x.id !== ED.id && chkNo(x.checkNo) === chkNo(d.checkNo));
    if (dup) return bad(`Check No. ${d.checkNo} is already in the journal (${fmtDate(dup.date)}).`);
    let lines = d.lines.filter((l) => l.code || l.gross !== '');
    if (!d.cancelled) {
      if (!lines.length) return bad('Enter the account code and the gross amount.');
      if (lines.some((l) => !l.code)) return bad('Enter the account code of each line.');
      if (lines.some((l) => !names[l.code])) return bad(`${lines.find((l) => !names[l.code]).code} is not in the Chart of Accounts.`);
      if (lines.some((l) => !(+l.gross > 0))) return bad('Enter the gross amount of each line.');
      if (checkAmountOf({ ...d, lines }) < 0) return bad('The tax is more than the gross amount.');
      if (lines.some((l) => CA_CODES.includes(l.code)) && !d.officerId) return bad('Choose the officer who received the cash advance.');
    } else lines = [];
    const rec = { lguId: lgu.id, acctId: acct.id, date: d.date, checkNo: d.checkNo, ref: d.ref, payee: d.payee, particulars: d.particulars, lines: lines.map((l) => ({ code: l.code, name: names[l.code], gross: r2(l.gross) })),
      tax: d.cancelled ? { rate: 0, one: false, amount: 0 } : d.tax, cancelled: d.cancelled, officerId: lines.some((l) => CA_CODES.includes(l.code)) ? d.officerId : '', note: d.note };
    const id = ED.id || newId('ckdj');
    ED.id = ''; ED.d = null;
    await store.save('src_ckdj', id, rec, by(refs));
    toast(`Check No. ${rec.checkNo} saved.`, 'ok');
    const mm = rec.date.slice(0, 7); if (mm !== (new URLSearchParams(location.hash.split('?')[1] || '').get('m') || today().slice(0, 7))) go({ m: mm });
  };
  paint();
}

/* ---------- Import from Excel: the Check Register sheet of the barangay template ---------- */
// Columns: Date, Check No., Reference No., Payee, Particulars, Check Amount, Tax Amount, Account Code, Account Name, Gross Amount,
// Tax, Auditor's Note. Rows with the same check No. become one check with several account lines; the tax is kept as typed.
async function importJournal({ refs, lgu, acct, mine, names }) {
  let plan = null;
  const read = async (file) => {
    const XLSX = await loadXlsx();
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const cols = [['date', /^date/i], ['no', /check\s*no/i], ['ref', /reference|dv|payroll/i], ['payee', /payee/i], ['part', /particular/i], ['chk', /check\s*amount/i], ['tax', /tax\s*amount/i], ['code', /account\s*code/i], ['name', /account\s*name/i], ['gross', /gross/i], ['note', /note/i]];
    let sheet = null;
    for (const n of [...wb.SheetNames].sort((a, b) => (/check/i.test(b) ? 1 : 0) - (/check/i.test(a) ? 1 : 0))) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' });
      for (let r = 0; r < Math.min(rows.length, 15) && !sheet; r++) {
        const map = {}; rows[r].forEach((cell, i) => { const t = String(cell || ''); cols.forEach(([k, re]) => { if (map[k] === undefined && re.test(t)) map[k] = i; }); });
        if (map.no !== undefined && map.date !== undefined) sheet = { rows, header: r, map };
      }
      if (sheet) break;
    }
    if (!sheet) return { error: 'No sheet with the columns Date and Check No. was found. Use the Check Register of the template.' };
    const M = sheet.map, get = (row, k) => (M[k] === undefined ? '' : row[M[k]]);
    const byNo = new Map(), problems = [];
    sheet.rows.slice(sheet.header + 1).forEach((row, i) => {
      const line = sheet.header + i + 2, noTxt = String(get(row, 'no')).trim();
      if (!noTxt || /total/i.test(String(get(row, 'date')))) return;
      const n = chkNo(noTxt); if (!n) { problems.push({ line, why: `Check No. "${noTxt}" is not a number.` }); return; }
      const g = byNo.get(n) || { n, no: noTxt, date: '', ref: '', payee: '', part: '', tax: 0, note: '', lines: [], rows: [] };
      g.rows.push(line);
      const date = excelDate(XLSX, get(row, 'date')); if (date && !g.date) g.date = date;
      ['ref', 'payee', 'part', 'note'].forEach((k) => { const v = String(get(row, k) ?? '').trim(); if (v && !g[k]) g[k] = v; });
      g.tax = r2(g.tax + (num(get(row, 'tax')) || 0));
      const code = String(get(row, 'code') ?? '').trim(), gross = num(get(row, 'gross')) ?? (num(get(row, 'chk')) === null ? null : r2(num(get(row, 'chk')) + (num(get(row, 'tax')) || 0)));
      if (code || gross) g.lines.push({ code, name: names[code] || String(get(row, 'name') || ''), gross: gross || 0 });
      byNo.set(n, g);
    });
    const taken = new Set(mine.map((c) => chkNo(c.checkNo)));
    const add = [];
    [...byNo.values()].sort((a, b) => a.n - b.n).forEach((g) => {
      if (!g.date) { problems.push({ line: g.rows[0], why: `Check No. ${g.no}: the date is missing.` }); return; }
      if (taken.has(g.n)) { problems.push({ line: g.rows[0], why: `Check No. ${g.no} is already in the journal.` }); return; }
      const cancelled = /cancel/i.test(g.part) && !g.lines.some((l) => l.gross);
      const unknown = g.lines.filter((l) => l.code && !names[l.code]).map((l) => l.code);
      add.push({ ...g, cancelled, unknown });
    });
    return { add, problems };
  };
  const show = (bg, p) => {
    const box = $('#sj-res', bg);
    if (p.error) { box.innerHTML = `<div class="msg bad">${esc(p.error)}</div>`; return; }
    const cx = p.add.filter((x) => x.cancelled).length, unk = p.add.filter((x) => x.unknown.length).length, ca = p.add.filter((x) => x.lines.some((l) => CA_CODES.includes(l.code))).length;
    box.innerHTML = `<div class="oi-sum"><b>${p.add.length} check${p.add.length === 1 ? '' : 's'} to add</b>${cx ? `<span>${cx} cancelled</span>` : ''}${ca ? `<span class="warn-t">${ca} cash advance${ca > 1 ? 's' : ''}: choose the officer after the import (Edit)</span>` : ''}${unk ? `<span class="warn-t">${unk} with an account code not in the Chart of Accounts</span>` : ''}</div>
      ${p.problems.length ? `<div class="af-probs"><b>Not imported (${p.problems.length})</b>${p.problems.slice(0, 60).map((q) => `<div>Row ${q.line} — ${esc(q.why)}</div>`).join('')}</div>` : ''}`;
  };
  const v = await modal({ title: `Import Check Disbursements · ${acctLabel(acct)}`, wide: true,
    body: `<p class="af-note">The Check Register sheet of the barangay template: Date, Check No., Reference No., Payee, Particulars, Tax Amount, Account Code, Gross Amount, Auditor's Note. Rows with the same check No. become one check.</p>
      <div class="field"><label for="sj-file">Excel file</label><input class="input" type="file" id="sj-file" accept=".xlsx,.xlsm,.xls,.csv"></div><div id="sj-res"></div>`,
    onOpen: (bg) => { $('#sj-file', bg).onchange = async (e) => { const fl = e.target.files[0]; if (!fl) return; $('#sj-res', bg).innerHTML = '<p class="af-note">Reading…</p>'; try { plan = await read(fl); show(bg, plan); } catch (err) { plan = null; $('#sj-res', bg).innerHTML = `<div class="msg bad">${esc(err.message || String(err))}</div>`; } }; },
    buttons: [{ label: 'Cancel', value: null }, { label: 'Import', cls: 'primary', value: 'go', check: () => { if (!plan || plan.error) { toast('Choose the Excel file first.', 'bad'); return false; } if (!plan.add.length) { toast('Nothing to import.', 'bad'); return false; } return true; } }] });
  if (v !== 'go') return;
  for (const g of plan.add) {
    await store.save('src_ckdj', newId('ckdj'), { lguId: lgu.id, acctId: acct.id, date: g.date, checkNo: g.no, ref: g.ref, payee: g.payee, particulars: g.part, lines: g.cancelled ? [] : g.lines.map((l) => ({ code: l.code, name: l.name, gross: r2(l.gross) })),
      tax: { rate: 0, one: false, amount: g.cancelled ? 0 : g.tax }, cancelled: g.cancelled, officerId: '', note: g.note }, by(refs), { quiet: true });
  }
  const { emitChange } = await import('../../js/store.js'); emitChange('local');
  toast(`${plan.add.length} check${plan.add.length === 1 ? '' : 's'} imported.`, 'ok');
}
