// AMS · Source Documents (design approved 5 Nov 2026).
// The auditee's records encoded once, read by Cash Examination (and later Records Management).
// First record: the checks of each bank account, encoded either way: in the Report of Checks Issued (the check amount; the
// journal entry is filled later) or in the Check Disbursements Journal (the entry; the check amount = gross − tax). Nothing is typed twice. Data and tax rules: journal.js.
import { store, newId } from '../../js/store.js';
import { esc, modal, toast, $, $$, today } from '../../js/ui.js';
import { roleLine } from '../../js/views/admin.js';
import { moduleFrame } from '../../js/frame.js';
import { hasRole, by, mayView, agencyName, fmtDate, money, num } from '../cer/cer.js';
import { exportXlsx, loadXlsx, excelDate } from '../cer/forms.js';
import { accountsModal, DEFAULT_FUNDS } from '../cer/banks.js';
import { printRci, xlsxRci, pdfRci, docxRci } from './rciout.js';
import { loadCoa, loadJournal, CA_CODES, grossOf, taxOf, checkAmountOf, isCa, isTaxable, chkNo, hasEntry, tallies, hasAmount } from './journal.js';

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
  const tab = ['ckdj', 'tax', 'rci'].includes(q.get('tab')) ? q.get('tab') : 'rci';
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
  const tabs = `<div class="sd-tabs" role="tablist">${[['rci', 'Report of Checks Issued'], ['ckdj', 'Check Disbursements Journal'], ['tax', 'Tax Register']].map(([k, t]) => `<button type="button" role="tab" class="sd-tab ${k === tab ? 'on' : ''}" data-tab="${k}" aria-selected="${k === tab}">${t}</button>`).join('')}</div>`;
  const totals = { g: r2(list.reduce((n, c) => n + (c.cancelled ? 0 : grossOf(c)), 0)), t: r2(list.reduce((n, c) => n + taxOf(c).amount, 0)), a: r2(list.reduce((n, c) => n + checkAmountOf(c), 0)) };
  const vatText = (c) => { const v = taxOf(c).vat; return v === true ? 'VAT' : v === false ? 'Non-VAT' : ''; };
  // The entry being typed: per tab (the RCI line, or the CkDJ line), a new check or the one being edited.
  const key = `${lgu.id}|${acct.id}|${tab}`;
  if (ED.key !== key) Object.assign(ED, { key, id: '', d: null });
  if (ED.id && !mine.some((c) => c.id === ED.id)) Object.assign(ED, { id: '', d: null });
  if (!ED.d) ED.d = blankCheck('', '');
  const flagsOf = (c) => [inBook(c.checkNo) ? '' : 'Not in a checkbook', !c.cancelled && !hasEntry(c) ? 'No entry yet' : '', !c.cancelled && hasEntry(c) && !tallies(c) ? `Does not tally: gross − tax = ₱${money(r2(grossOf(c) - taxOf(c).amount))}` : '',
    isCa(c) && !c.officerId ? 'Cash advance: no officer' : '', ...(c.lines || []).filter((l) => l.old).map((l) => `Old code ${l.old} (${l.oldName}): choose the new account`)].filter(Boolean);

  let inner = '';
  if (tab === 'rci') {
    // Step 1 (or after the CkDJ): the check as issued; its amount is the check amount.
    const form = enc ? rciHtml(ED.d, !!ED.id, m) : '';
    inner = `${form}<div class="panel sd-pan"><div class="cd-orhead"><h3 class="cer-h3">Report of Checks Issued · ${esc(monthLabel(m))}</h3><span class="pill">${list.length}</span>
        ${enc ? '<a href="#" class="cd-link" id="sd-rtpl">RCI Template</a><button class="btn sm" type="button" id="sd-imp">Import from Excel</button>' : ''}<button class="btn sm" type="button" id="sd-print">Print</button><details class="sd-exp"><summary class="btn sm">Export ▾</summary><div class="sd-menu"><button type="button" data-rout="xlsx">Excel</button><button type="button" data-rout="pdf">PDF</button><button type="button" data-rout="docx">Word</button></div></details></div>
      <div id="cer-print" class="rp-doc"><div class="rp-page"><h2 class="rp-title">REPORT OF CHECKS ISSUED</h2>
        <p class="c"><b>${esc(agencyName(refs, lgu))}</b><br>${esc(acctLabel(acct))}<br>${esc(monthLabel(m))}</p>
        <table class="rp-t"><thead><tr><th>Date</th><th>Check No.</th><th>DV / Payroll No.</th><th>Payee</th><th>Nature of Payment</th><th class="r">Amount</th>${enc ? '<th class="af-noprint"></th>' : ''}</tr></thead>
        <tbody>${list.length ? list.map((c) => `<tr class="${c.id === ED.id ? 'cd-on' : ''}"><td>${esc(fmtDate(c.date))}</td><td>${esc(c.checkNo)}</td><td>${c.cancelled ? '' : esc(c.ref || '')}</td>${c.cancelled ? '<td colspan="2">Cancelled</td><td class="r">–</td>' : `<td>${esc(c.payee || '')}</td><td>${esc(c.particulars || '')}</td><td class="r">${money(checkAmountOf(c))}</td>`}${enc ? `<td class="af-noprint"><button class="btn sm" type="button" data-rciedit="${esc(c.id)}">Edit</button></td>` : ''}</tr>`).join('') : `<tr><td colspan="${enc ? 7 : 6}" class="c">No check issued this month.</td></tr>`}
        <tr class="tot"><td colspan="5">Total</td><td class="r">${money(totals.a)}</td>${enc ? '<td class="af-noprint"></td>' : ''}</tr></tbody></table></div></div></div>`;
  } else if (tab === 'ckdj') {
    // Step 2 (or first): the entry of each check — accounts, gross amounts, tax.
    const form = enc ? entryHtml(ED.d, officers, !!ED.id, m) : '';
    const rows = list.map((c) => {
      const t = taxOf(c), ls = c.lines || [], fl = flagsOf(c);
      return `<tr class="${c.id === ED.id ? 'cd-on' : ''}"><td>${esc(fmtDate(c.date))}</td><td class="mono">${esc(c.checkNo)}</td><td>${esc(c.ref || '')}</td><td title="${esc(c.payee || '')}">${esc(c.payee || '')}</td><td title="${esc(c.particulars || '')}">${esc(c.cancelled ? 'Cancelled' : c.particulars || '')}</td>
        <td class="r">${c.cancelled ? '' : money(checkAmountOf(c))}</td><td class="r">${c.cancelled || !hasEntry(c) ? '' : money(t.amount)}</td>
        <td title="${esc(ls.map((l) => `${l.code} ${l.name || names[l.code] || ''} ₱${money(l.gross)}`).join('\n'))}">${ls.length ? `<span class="mono">${esc(ls[0].code)}</span> <small class="dim">${esc(ls[0].name || names[ls[0].code] || '')}</small>${ls.length > 1 ? ` <span class="pill">+${ls.length - 1}</span>` : ''}` : ''}</td>
        <td class="r">${ls.length ? money(grossOf(c)) : ''}</td><td>${c.cancelled || !hasEntry(c) ? '' : isTaxable(c) ? `Yes${vatText(c) ? ` <small class="dim">${vatText(c)}</small>` : ''}` : 'No'}</td>
        <td class="sd-notec">${fl.map((t) => `<span class="sd-flag">${esc(t)}</span>`).join('')}${enc ? `<button type="button" class="sd-note" data-note="${esc(c.id)}" title="Auditor's note">${c.note ? esc(c.note) : '<span class="dim">+ note</span>'}</button>` : esc(c.note || '')}</td>
        <td>${enc ? `<button class="btn sm ${!c.cancelled && !hasEntry(c) ? 'primary' : ''}" type="button" data-sdedit="${esc(c.id)}">${!c.cancelled && !hasEntry(c) ? 'Fill entry' : 'Edit'}</button>` : ''}</td></tr>`;
    }).join('');
    inner = `${form}<div class="panel sd-pan"><div class="cd-orhead"><h3 class="cer-h3">Check Disbursements Journal · ${esc(monthLabel(m))}</h3><span class="pill">${list.length}</span>
        ${enc ? '<button class="btn sm" type="button" id="sd-imp">Import from Excel</button>' : ''}<button class="btn sm" type="button" id="sd-xls">Export to Excel</button></div>
      ${list.length ? `<div class="af-tbl sd-scroll"><table class="af-reg sd-tbl"><thead><tr><th scope="col">Date</th><th scope="col">Check No.</th><th scope="col">DV / Payroll</th><th scope="col">Payee</th><th scope="col">Particulars</th><th scope="col" class="r">Check Amount</th><th scope="col" class="r">Tax</th><th scope="col">Account</th><th scope="col" class="r">Gross Amount</th><th scope="col">Taxable</th><th scope="col">Auditor's Note</th><th scope="col"></th></tr></thead>
        <tbody>${rows}</tbody><tfoot><tr class="cd-foot"><td colspan="5">Total, ${esc(monthLabel(m))}</td><td class="r">${money(totals.a)}</td><td class="r">${money(totals.t)}</td><td></td><td class="r">${money(totals.g)}</td><td colspan="3"></td></tr></tfoot></table></div>`
        : `<div class="empty"><b>No check encoded for ${esc(monthLabel(m))}.</b></div>`}</div>`;
  } else {
    const tl = list.filter(isTaxable);
    inner = `<div class="panel sd-pan"><div class="cd-orhead"><h3 class="cer-h3">Tax Register · ${esc(monthLabel(m))}</h3><span class="pill">${tl.length}</span><button class="btn sm" type="button" id="sd-txls">Export to Excel</button></div>
      ${tl.length ? `<div class="af-tbl"><table class="af-reg"><thead><tr><th scope="col">Check No.</th><th scope="col">Date</th><th scope="col">Payee</th><th scope="col">VAT / Non-VAT</th><th scope="col" class="r">Gross Amount</th><th scope="col" class="r">Tax Base</th><th scope="col" class="r">5% or 3%</th><th scope="col" class="r">1%</th><th scope="col" class="r">Tax Amount</th><th scope="col"></th></tr></thead>
        <tbody>${tl.map((c) => { const t = taxOf(c); return `<tr><td class="mono">${esc(c.checkNo)}</td><td>${esc(fmtDate(c.date))}</td><td>${esc(c.payee || '')}</td><td>${vatText(c) || '<span class="pill p-part">Choose</span>'}</td><td class="r">${money(grossOf(c))}</td><td class="r">${t.base ? money(t.base) : ''}</td><td class="r">${money(t.main)}</td><td class="r">${money(t.one)}</td><td class="r"><b>${money(t.amount)}</b></td>
          <td>${enc ? `<button class="btn sm" type="button" data-sdtax="${esc(c.id)}">Edit</button>` : ''}</td></tr>`; }).join('')}</tbody>
        <tfoot><tr class="cd-foot"><td colspan="6">Total</td><td class="r">${money(r2(tl.reduce((n, c) => n + taxOf(c).main, 0)))}</td><td class="r">${money(r2(tl.reduce((n, c) => n + taxOf(c).one, 0)))}</td><td class="r">${money(r2(tl.reduce((n, c) => n + taxOf(c).amount, 0)))}</td><td></td></tr></tfoot></table></div>`
        : '<div class="empty"><b>No taxable check this month.</b></div>'}</div>`;
  }
  const body = top + tabs + inner;

  const wire = () => {
    wireTop();
    $$('[data-tab]').forEach((b) => { b.onclick = () => go({ tab: b.dataset.tab }); });
    const xRows = () => list.map((c) => ({ Date: fmtDate(c.date), 'Check No.': c.checkNo, 'Reference No.': c.ref || '', Payee: c.payee || '', Particulars: c.cancelled ? 'Cancelled' : c.particulars || '',
      'Check Amount': checkAmountOf(c), 'Tax Amount': taxOf(c).amount, 'Account Code': (c.lines || []).map((l) => l.code).join('; '), 'Account Name': (c.lines || []).map((l) => l.name || names[l.code] || '').join('; '),
      'Gross Amount': c.cancelled ? 0 : grossOf(c), Taxable: c.cancelled || !hasEntry(c) ? '' : isTaxable(c) ? 'YES' : 'NO', "Auditor's Note": c.note || '' }));
    const fileBase = `${agencyName(refs, lgu)} ${acct.accountNo || ''} ${m}`;
    if ($('#sd-xls')) $('#sd-xls').onclick = () => exportXlsx(`Check Disbursements Journal ${fileBase}.xlsx`, 'CkDJ', xRows());
    if ($('#sd-txls')) $('#sd-txls').onclick = () => exportXlsx(`Tax Register ${fileBase}.xlsx`, 'Tax Register', list.filter(isTaxable).map((c) => { const t = taxOf(c); return { 'Check No.': c.checkNo, Date: fmtDate(c.date), Payee: c.payee || '', 'VAT / Non-VAT': vatText(c), 'Gross Amount': grossOf(c), 'Tax Base': t.base || '', '5% or 3%': t.main, '1%': t.one, 'Tax Amount': t.amount }; }));
    const rciData = () => ({ office: agencyName(refs, lgu), acct: acctLabel(acct), month: monthLabel(m), total: totals.a,
      rows: list.map((c) => ({ date: fmtDate(c.date), checkNo: c.checkNo || '', ref: c.cancelled ? '' : c.ref || '', payee: c.payee || '', nature: c.particulars || '', amount: checkAmountOf(c), cancelled: !!c.cancelled })) });
    if ($('#sd-print')) $('#sd-print').onclick = () => printRci(rciData());
    $$('[data-rout]').forEach((b) => { b.onclick = async () => {
      b.closest('details').open = false;
      const k = b.dataset.rout, f = `RCI ${fileBase}.${k}`;
      try { await (k === 'xlsx' ? xlsxRci : k === 'pdf' ? pdfRci : docxRci)(rciData(), f); } catch (err) { toast(err.message || String(err), 'bad'); } }; });
    const startEdit = (id, sel) => { const c = mine.find((x) => x.id === id); ED.id = c.id; ED.d = JSON.parse(JSON.stringify({ ...blankCheck('', ''), ...c })); if (c.cancelled) ED.d.particulars = 'Cancelled'; if (!ED.d.lines.length) ED.d.lines = [blankLine()]; ctx.rerender(); setTimeout(() => { const f = $('#sd-form'); if (f) f.scrollIntoView({ block: 'start' }); const el = sel && $(sel); if (el) el.focus(); }, 0); };
    $$('[data-sdedit]').forEach((b) => { b.onclick = () => startEdit(b.dataset.sdedit, '.sd-code'); });
    $$('[data-rciedit]').forEach((b) => { b.onclick = () => startEdit(b.dataset.rciedit, '#sd-amt'); });
    // Auditor's note: typed in the table.
    $$('[data-note]').forEach((b) => { b.onclick = async () => {
      const c = mine.find((x) => x.id === b.dataset.note); let val = null;
      await modal({ title: `Auditor's Note · Check No. ${c.checkNo}`, body: `<div class="field"><label for="sd-nt">Note</label><input class="input" id="sd-nt" value="${esc(c.note || '')}"></div>`,
        onOpen: (bg) => { $('#sd-nt', bg).onkeydown = (e) => { if (e.key === 'Enter') $('.mf .btn.primary', bg).click(); }; },
        buttons: [{ label: 'Cancel', value: null }, { label: 'Save', cls: 'primary', value: 'ok', check: (bg) => { val = $('#sd-nt', bg).value.trim(); return true; } }] });
      if (val === null) return; const { id, ...rec } = c; await store.save('src_ckdj', id, { ...rec, note: val }, by(refs)); toast('Note saved.', 'ok');
    }; });
    // Tax Register: edit the tax of a check.
    $$('[data-sdtax]').forEach((b) => { b.onclick = async () => {
      const c = mine.find((x) => x.id === b.dataset.sdtax); const t = await taxModal(c); if (!t) return;
      const { id, ...rec } = c; const next = { ...rec, tax: t }; if (next.amountSrc !== 'rci') next.amount = r2(grossOf(next) - taxOf(next).amount);
      await store.save('src_ckdj', id, next, by(refs)); toast(`Tax of Check No. ${c.checkNo} saved.`, 'ok');
    }; });
    if ($('#sd-imp')) $('#sd-imp').onclick = () => importJournal({ refs, lgu, acct, mine, coa, names });
    if ($('#sd-rtpl')) $('#sd-rtpl').onclick = async (e) => { e.preventDefault();
      try { const XLSX = await loadXlsx(); const ws = XLSX.utils.aoa_to_sheet([['Date', 'Check No.', 'DV / Payroll No.', 'Payee', 'Nature of Payment', 'Amount'], ['10/17/2025', '1894917', 'DV 2025-10-041', 'Juan Dela Cruz', 'Cash advance, Barangay Day', 10000], ['10/18/2025', '1894918', '', '', 'Cancelled', '']]);
        ws['!cols'] = [12, 12, 18, 28, 36, 14].map((w) => ({ wch: w })); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'RCI'); XLSX.writeFile(wb, 'RCI Template.xlsx'); } catch (err) { toast(err.message || String(err), 'bad'); } };
    if (enc && tab === 'ckdj') wireEntry({ refs, lgu, acct, mine, coa, names, m, rerender: ctx.rerender });
    if (enc && tab === 'rci') wireRci({ refs, lgu, acct, mine, m, rerender: ctx.rerender });
  };
  return { body, wire };
}

/* ---------- the tax window (Tax Register) ---------- */
// VAT or Non-VAT sets the base; the 5% or 3% and the 1% are computed and may be typed over (rounding).
async function taxModal(c) {
  const t0 = c.tax || {}, g = grossOf(c);
  let out = null;
  const comp = (vat) => { const base = vat ? r2(g / 1.12) : g; return { base, main: r2(base * (vat ? 5 : 3) / 100), one: r2(base / 100) }; };
  const cur = taxOf(c);
  await modal({ title: `Tax · Check No. ${c.checkNo || ''}${c.payee ? ' · ' + c.payee : ''}`, body: `
    <div class="sd-taxw"><div class="field"><span class="cd-lbl">Payee is</span><div class="sd-vat"><label class="cer-tick"><input type="radio" name="sd-vat" value="1" ${t0.vat === true ? 'checked' : ''}> VAT</label><label class="cer-tick"><input type="radio" name="sd-vat" value="0" ${t0.vat === false ? 'checked' : ''}> Non-VAT</label></div></div>
      <div class="field"><span class="cd-lbl">Gross Amount</span><div class="input cd-ro r">${money(g)}</div></div>
      <div class="field"><span class="cd-lbl">Tax Base</span><div class="input cd-ro r" id="tw-base">${cur.base ? money(cur.base) : '—'}</div></div>
      <div class="field"><label for="tw-main" id="tw-ml">${t0.vat === false ? '3%' : '5%'}</label><input class="input r" id="tw-main" inputmode="decimal" value="${t0.vat === true || t0.vat === false || cur.main ? money(cur.main) : ''}"></div>
      <div class="field"><label for="tw-one">1%</label><input class="input r" id="tw-one" inputmode="decimal" value="${t0.vat === true || t0.vat === false || cur.one ? money(cur.one) : ''}"></div>
      <div class="field"><span class="cd-lbl">Tax Amount</span><div class="input cd-ro r" id="tw-tot">${money(cur.amount)}</div></div></div>
    <p class="af-note">VAT: base = gross ÷ 1.12, 5%. Non-VAT: base = gross, 3%. Both with 1%. Type over an amount to match the voucher.</p>`,
    onOpen: (bg) => {
      const tot = () => { $('#tw-tot', bg).textContent = money(r2((num($('#tw-main', bg).value) || 0) + (num($('#tw-one', bg).value) || 0))); };
      $$('[name="sd-vat"]', bg).forEach((r) => { r.onchange = () => { const v = r.value === '1', x = comp(v); $('#tw-base', bg).textContent = money(x.base); $('#tw-ml', bg).textContent = v ? '5%' : '3%'; $('#tw-main', bg).value = money(x.main); $('#tw-one', bg).value = money(x.one); tot(); }; });
      ['#tw-main', '#tw-one'].forEach((k) => { $(k, bg).oninput = tot; });
    },
    buttons: [{ label: 'Cancel', value: null }, { label: 'Save Tax', cls: 'primary', value: 'ok', check: (bg) => {
      const sel = $('[name="sd-vat"]:checked', bg); if (!sel) return bad('Choose VAT or Non-VAT.');
      const vat = sel.value === '1', x = comp(vat), main = num($('#tw-main', bg).value), one = num($('#tw-one', bg).value);
      if (main === null || one === null) return bad('Enter the amounts.');
      out = { taxable: true, vat, main: main === x.main ? null : main, one: one === x.one ? null : one };
      if (r2(main + one) > g) return bad('The tax is more than the gross amount.');
      return true;
    } }] });
  return out;
}

/* ---------- shared bits of the two entry lines ---------- */
const blankCheck = (date, checkNo) => ({ coa: 2, date, checkNo, ref: '', payee: '', particulars: '', amount: '', lines: [blankLine()], tax: { taxable: false }, cancelled: false, officerId: '', note: '' });
const isCancelText = (s) => /^\s*cancell?ed\s*$/i.test(s || '');
const nextNo = (no) => { const m = /^(.*?)(\d+)$/.exec(String(no || '')); if (!m) return ''; const n = String(+m[2] + 1).padStart(m[2].length, '0'); return m[1] + n; };
const lastDayOf = (m) => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate();
const dateIn = (m, v) => { const n = parseInt(String(v || '').trim(), 10); return n >= 1 && n <= lastDayOf(m) ? `${m}-${String(n).padStart(2, '0')}` : ''; };
const headHtml = (d, m, natureLabel) => `
      <div class="sd-f sd-w-day"><label for="sd-date">Day</label><input class="input r" id="sd-date" inputmode="numeric" maxlength="2" value="${d.date ? +d.date.slice(8, 10) : ''}" title="${esc(monthLabel(m))}" aria-label="Day of ${esc(monthLabel(m))}"></div>
      <div class="sd-f sd-w-no"><label for="sd-no">Check No.</label><input class="input mono" id="sd-no" value="${esc(d.checkNo)}"></div>
      <div class="sd-f sd-w-ref"><label for="sd-ref">DV / Payroll</label><input class="input" id="sd-ref" value="${esc(d.ref)}"></div>
      <div class="sd-f sd-w-txt"><label for="sd-payee">Payee</label><input class="input" id="sd-payee" value="${esc(d.payee)}"></div>
      <div class="sd-f sd-w-txt"><label for="sd-part">${natureLabel}</label><input class="input" id="sd-part" value="${esc(d.particulars)}" placeholder="or Cancelled"></div>`;
const editHead = (d, editing) => (editing ? `<div class="cd-orhead"><h3 class="cer-h3">Edit Check No. ${esc(d.checkNo)}</h3><button class="btn sm" type="button" id="sd-del">Delete</button><button class="btn sm" type="button" id="sd-new">Cancel</button></div>` : '');
// Checks the header and the duplicate check No.; returns the error or ''.
function headError(d, mine, m) {
  if (!d.date) return `Enter the day (1 to ${lastDayOf(m)}).`;
  if (!chkNo(d.checkNo)) return 'Enter the check No.';
  const dup = mine.find((x) => x.id !== ED.id && chkNo(x.checkNo) === chkNo(d.checkNo));
  return dup ? `Check No. ${d.checkNo} is already in (${fmtDate(dup.date)}).` : '';
}
function wireCommon(c, save, order) {
  const { refs, mine, rerender } = c;
  if ($('#sd-new')) $('#sd-new').onclick = () => { ED.id = ''; ED.d = null; rerender(); };
  if ($('#sd-del')) $('#sd-del').onclick = async () => {
    const ok = await modal({ title: 'Delete this check?', body: `<p style="margin:0">Delete Check No. <b>${esc(ED.d.checkNo)}</b>? It is removed from the RCI and the CkDJ.</p>`, buttons: [{ label: 'Cancel', value: false }, { label: 'Delete', cls: 'danger', value: true }] });
    if (!ok) return;
    const cur = mine.find((x) => x.id === ED.id); const { id, ...rec } = cur;
    await store.save('src_ckdj', id, rec, by(refs), { deleted: true }); ED.id = ''; ED.d = null; toast('Check deleted.', 'ok');
  };
  $('#sd-save').onclick = save;
  // Enter moves to the next box; on the last box it saves.
  $('#sd-form').onkeydown = (e) => {
    if (e.key !== 'Enter' || e.target.tagName === 'BUTTON') return;
    e.preventDefault();
    const els = order(), i = els.indexOf(e.target);
    if ((e.target.id === 'sd-part' && isCancelText(e.target.value)) || i < 0 || i === els.length - 1) { save(); return; }
    els[i + 1].focus();
  };
}
async function saveCheck(c, rec, wasNew) {
  const id = ED.id || newId('ckdj');
  ED.id = ''; ED.d = wasNew ? blankCheck(rec.date, nextNo(rec.checkNo)) : null;
  await store.save('src_ckdj', id, rec, by(c.refs));
  toast(`Check No. ${rec.checkNo} saved.`, 'ok');
  setTimeout(() => { const el = $('#sd-ref'); if (el) el.focus(); }, 60);
}

/* ---------- the RCI line: the check as issued (the check amount) ---------- */
function rciHtml(d, editing, m) {
  return `<div class="panel sd-pan" id="sd-form">${editHead(d, editing)}
    <div class="sd-line">${headHtml(d, m, 'Nature of Payment')}
      <div class="sd-f sd-w-amt"><label for="sd-amt">Amount</label><input class="input r" id="sd-amt" inputmode="decimal" value="${d.amount === '' || d.amount === undefined || d.amount === null ? (editing && !d.cancelled ? esc(money(checkAmountOf(d))) : '') : esc(money(d.amount))}"></div>
      <div class="sd-f sd-w-btn"><label>&nbsp;</label><button class="btn primary" type="button" id="sd-save">${editing ? 'Save' : 'Enter'}</button></div>
    </div></div>`;
}
function wireRci(c) {
  const { lgu, acct, mine, m } = c;
  const d = ED.d;
  if (!$('#sd-form')) return;
  const read = () => { d.date = dateIn(m, $('#sd-date').value); d.checkNo = $('#sd-no').value.trim(); d.ref = $('#sd-ref').value.trim(); d.payee = $('#sd-payee').value.trim(); d.particulars = $('#sd-part').value.trim(); d.cancelled = isCancelText(d.particulars); };
  const paint = () => { read(); ['#sd-ref', '#sd-payee', '#sd-amt'].forEach((k) => { $(k).disabled = d.cancelled; }); $('#sd-form').classList.toggle('sd-cancelled', d.cancelled); };
  ['#sd-date', '#sd-no', '#sd-ref', '#sd-payee', '#sd-part'].forEach((k) => { $(k).oninput = paint; });
  const save = async () => {
    read();
    const err = headError(d, mine, m); if (err) return bad(err);
    const amt = num($('#sd-amt').value);
    if (!d.cancelled && !(amt > 0)) return bad('Enter the amount.');
    const cur = ED.id ? mine.find((x) => x.id === ED.id) : null;
    const rec = { ...(cur ? (({ id, ...r }) => r)(cur) : { lines: [], tax: { taxable: false }, officerId: '', note: '' }), lguId: lgu.id, acctId: acct.id, date: d.date, checkNo: d.checkNo,
      ref: d.cancelled ? '' : d.ref, payee: d.cancelled ? '' : d.payee, particulars: d.cancelled ? 'Cancelled' : d.particulars, cancelled: d.cancelled, amount: d.cancelled ? 0 : r2(amt), amountSrc: 'rci' };
    if (d.cancelled) { rec.lines = []; rec.tax = { taxable: false }; rec.officerId = ''; }
    await saveCheck(c, rec, !ED.id);
  };
  wireCommon(c, save, () => ['#sd-date', '#sd-no', '#sd-ref', '#sd-payee', '#sd-part', '#sd-amt'].map((k) => $(k)).filter((el) => el && !el.disabled));
  paint();
}

/* ---------- the CkDJ line: the entry (accounts, gross, tax); the check amount is fixed when it came from the RCI ---------- */
function entryHtml(d, officers, editing, m) {
  const ln = (l, i) => `<div class="sd-ln" data-ln="${i}">
      <input class="input mono sd-code" list="sd-coa" value="${esc(l.code)}" placeholder="${l.old ? `Old ${esc(l.old)}: choose` : 'Code or title'}" aria-label="Account" title="${esc(l.name || (l.old ? `Old code ${l.old} · ${l.oldName}: choose the new account` : ''))}">
      <input class="input r sd-gross" inputmode="decimal" value="${l.gross === '' || l.gross === undefined ? '' : esc(money(l.gross))}" aria-label="Gross amount">
      ${i ? '<button class="btn sm sd-xl" type="button" aria-label="Remove account">✕</button>' : ''}</div>`;
  const tx = d.tax || {};
  const fixed = d.amountSrc === 'rci';
  return `<div class="panel sd-pan" id="sd-form">${editHead(d, editing)}
    <div class="sd-line">${headHtml(d, m, 'Particulars')}
      <div class="sd-f sd-w-amt"><label title="${fixed ? 'From the Report of Checks Issued' : 'Gross − Tax'}">Check Amount${fixed ? ' ·RCI' : ''}</label><div class="input cd-ro r" id="sd-chk"></div></div>
      <div class="sd-f sd-w-tax"><label for="sd-tax">Tax</label><button type="button" class="input cd-ro r sd-taxbtn" id="sd-tax" title="Tax Register">0.00</button></div>
      <div class="sd-f sd-w-acct"><div class="sd-acch"><label>Account</label><label class="r">Gross Amount</label><span></span></div>
        <div class="sd-accts">${d.lines.map(ln).join('')}<button type="button" class="sd-add" id="sd-addln">+ another account</button></div></div>
      <div class="sd-f sd-w-yn"><label for="sd-taxable">Taxable</label><select class="input" id="sd-taxable"><option value="0" ${tx.taxable ? '' : 'selected'}>No</option><option value="1" ${tx.taxable ? 'selected' : ''}>Yes</option></select></div>
      <div class="sd-f sd-w-btn"><label>&nbsp;</label><button class="btn primary" type="button" id="sd-save">${editing ? 'Save' : 'Enter'}</button></div>
    </div>
    <div class="sd-tally" id="sd-tally" hidden></div>
    <div class="sd-offrow" id="sd-offbox" hidden><label for="sd-off">Cash advance of</label><select class="input" id="sd-off"><option value="">— Officer —</option>${officers.map((o) => `<option value="${esc(o.id)}" ${o.id === d.officerId ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select></div>
  </div>`;
}

function wireEntry(c) {
  const { lgu, acct, mine, coa, names, m, rerender } = c;
  const d = ED.d;
  if (!$('#sd-form')) return;
  if (!$('#sd-coa')) { const dl = document.createElement('datalist'); dl.id = 'sd-coa'; dl.innerHTML = coa.accounts.map(([k, t]) => `<option value="${esc(k)}">${esc(t)}</option>`).join(''); document.body.appendChild(dl); }
  const fixed = d.amountSrc === 'rci';
  // A typed code or title becomes the code; the name follows the Chart of Accounts.
  const toCode = (v) => { const t = String(v || '').trim(); if (names[t]) return t; const hit = coa.accounts.find(([, n]) => n.toLowerCase() === t.toLowerCase()); return hit ? hit[0] : t; };
  const read = () => {
    d.date = dateIn(m, $('#sd-date').value); d.checkNo = $('#sd-no').value.trim(); d.ref = $('#sd-ref').value.trim(); d.payee = $('#sd-payee').value.trim(); d.particulars = $('#sd-part').value.trim();
    d.cancelled = isCancelText(d.particulars); d.officerId = $('#sd-off').value;
    const g0 = grossOf(d);
    d.lines = $$('.sd-ln').map((el, i) => { const code = toCode($('.sd-code', el).value), was = d.lines[i] || {}; return { code, name: names[code] || '', gross: num($('.sd-gross', el).value) ?? '', ...(!code && was.old ? { old: was.old, oldName: was.oldName } : {}) }; });
    const taxable = $('#sd-taxable').value === '1';
    if (!taxable) d.tax = { taxable: false };
    else { d.tax = { ...d.tax, taxable: true }; if (grossOf(d) !== g0) { d.tax.main = null; d.tax.one = null; } }   // a new gross: the tax is computed again
  };
  const net = () => r2(grossOf(d) - taxOf(d).amount);
  const paint = () => {
    read();
    $$('.sd-ln').forEach((el, i) => { const l = d.lines[i]; $('.sd-code', el).title = l.name || (l.code ? 'Not in the Chart of Accounts' : ''); $('.sd-code', el).classList.toggle('sd-bad', !!l.code && !l.name); });
    const off = d.cancelled;
    ['#sd-ref', '#sd-payee', '#sd-taxable'].forEach((k) => { $(k).disabled = off; });
    $$('.sd-ln input, #sd-addln').forEach((el) => { el.disabled = off; });
    $('#sd-form').classList.toggle('sd-cancelled', off);
    $('#sd-tax').textContent = money(taxOf(d).amount) || '0.00';
    $('#sd-tax').classList.toggle('sd-need', !off && d.tax.taxable && d.tax.vat !== true && d.tax.vat !== false);
    $('#sd-chk').textContent = off ? '0.00' : money(fixed ? r2(d.amount) : net());
    const tl = $('#sd-tally'), diff = fixed && !off && grossOf(d) ? r2(net() - r2(d.amount)) : 0;
    tl.hidden = !diff; tl.textContent = diff ? `Gross − Tax = ₱${money(net())}; the check is ₱${money(r2(d.amount))} (difference ₱${money(diff)}).` : '';
    $('#sd-offbox').hidden = off || !d.lines.some((l) => CA_CODES.includes(l.code));
  };
  const openTax = async () => { read(); if (!grossOf(d)) { bad('Enter the gross amount first.'); $('#sd-taxable').value = '0'; paint(); return false; }
    const t = await taxModal(d); if (t) d.tax = t; else if (d.tax.vat !== true && d.tax.vat !== false) { d.tax = { taxable: false }; $('#sd-taxable').value = '0'; } paint(); return !!t; };
  const save = async () => {
    read();
    const err = headError(d, mine, m); if (err) return bad(err);
    let lines = d.lines.filter((l) => l.code || l.gross !== '');
    if (!d.cancelled) {
      if (!lines.length) return bad('Enter the account and the gross amount.');
      if (lines.some((l) => !l.code)) return bad('Enter the account of each line.');
      if (lines.some((l) => !names[l.code])) return bad(`${lines.find((l) => !names[l.code]).code} is not in the Chart of Accounts.`);
      if (lines.some((l) => !(+l.gross > 0))) return bad('Enter the gross amount of each account.');
      if (d.tax.taxable && d.tax.vat !== true && d.tax.vat !== false && !taxOf(d).amount) { if (!(await openTax())) return; }
      if (net() < 0) return bad('The tax is more than the gross amount.');
      if (lines.some((l) => CA_CODES.includes(l.code)) && !d.officerId) return bad('Choose the officer of the cash advance.');
    } else lines = [];
    const cur = ED.id ? mine.find((x) => x.id === ED.id) : null;
    const rec = { ...(cur ? (({ id, ...r }) => r)(cur) : {}), coa: 2, lguId: lgu.id, acctId: acct.id, date: d.date, checkNo: d.checkNo, ref: d.cancelled ? '' : d.ref, payee: d.cancelled ? '' : d.payee, particulars: d.cancelled ? 'Cancelled' : d.particulars,
      lines: lines.map((l) => ({ code: l.code, name: names[l.code], gross: r2(l.gross) })), tax: d.cancelled ? { taxable: false } : d.tax, cancelled: d.cancelled,
      officerId: lines.some((l) => CA_CODES.includes(l.code)) ? d.officerId : '', note: d.note || (cur && cur.note) || '' };
    // Encoded here first: the check amount is gross − tax (it shows in the RCI); from the RCI: it stays as typed there.
    if (fixed && !d.cancelled) { rec.amount = r2(d.amount); rec.amountSrc = 'rci'; } else { rec.amount = d.cancelled ? 0 : net(); rec.amountSrc = 'ckdj'; }
    await saveCheck(c, rec, !ED.id);
  };
  $$('.sd-ln input').forEach((el) => { el.oninput = paint; el.onchange = () => { if (el.classList.contains('sd-code')) el.value = toCode(el.value); paint(); }; });
  $$('.sd-xl').forEach((b) => { b.onclick = () => { read(); d.lines.splice(+b.closest('.sd-ln').dataset.ln, 1); rerender(); }; });
  ['#sd-date', '#sd-no', '#sd-ref', '#sd-payee', '#sd-part'].forEach((k) => { $(k).oninput = paint; });
  $('#sd-off').onchange = paint;
  $('#sd-taxable').onchange = async () => { paint(); if ($('#sd-taxable').value === '1' && d.tax.vat !== true && d.tax.vat !== false) await openTax(); };
  $('#sd-tax').onclick = () => { if ($('#sd-taxable').value === '1') openTax(); };
  $('#sd-addln').onclick = () => { read(); d.lines.push(blankLine()); rerender(); setTimeout(() => { const all = $$('.sd-code'); if (all.length) all[all.length - 1].focus(); }, 0); };
  wireCommon(c, save, () => ['#sd-date', '#sd-no', '#sd-ref', '#sd-payee', '#sd-part', ...$$('.sd-ln').flatMap((el, i) => [`.sd-ln[data-ln="${i}"] .sd-code`, `.sd-ln[data-ln="${i}"] .sd-gross`]), '#sd-taxable'].map((k) => $(k)).filter((el) => el && !el.disabled));
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
    const cols = [['date', /^date/i], ['no', /check\s*no/i], ['ref', /reference|dv|payroll/i], ['payee', /payee/i], ['part', /particular|nature/i], ['chk', /check\s*amount/i], ['amt', /^\s*amount\s*(\(.*\))?\s*$/i], ['tax', /tax\s*amount/i], ['code', /account\s*code/i], ['name', /account\s*name/i], ['gross', /gross/i], ['note', /note/i], ['taxyn', /^\s*(tax|taxable)\s*$/i]];
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
    // An RCI file (no account code; Amount = the check amount) or a CkDJ file (account codes and gross amounts).
    const rci = M.code === undefined && (M.amt !== undefined || M.chk !== undefined);
    const byNo = new Map(), problems = [];
    let lastDate = '';
    sheet.rows.slice(sheet.header + 1).forEach((row, i) => {
      const line = sheet.header + i + 2, noTxt = String(get(row, 'no')).trim();
      if (!noTxt || /total/i.test(String(get(row, 'date')))) return;
      const n = chkNo(noTxt); if (!n) { problems.push({ line, why: `Check No. "${noTxt}" is not a number.` }); return; }
      const g = byNo.get(n) || { n, no: noTxt, date: '', ref: '', payee: '', part: '', tax: 0, taxyn: false, note: '', lines: [], rows: [] };
      g.rows.push(line);
      const date = excelDate(XLSX, get(row, 'date')); if (date) lastDate = date; if (date && !g.date) g.date = date;
      // A cancelled check without a date takes the date of the row above.
      if (!date && !g.date && lastDate && /cancel/i.test(String(get(row, 'part') ?? ''))) g.date = lastDate;
      ['ref', 'payee', 'part', 'note'].forEach((k) => { const v = String(get(row, k) ?? '').trim(); if (v && !g[k]) g[k] = v; });
      if (rci) { const a = num(get(row, 'amt')) ?? num(get(row, 'chk')); if (a) g.amount = r2((g.amount || 0) + a); byNo.set(n, g); return; }
      g.tax = r2(g.tax + (num(get(row, 'tax')) || 0));
      if (/^y/i.test(String(get(row, 'taxyn') ?? '').trim())) g.taxyn = true;
      const code = String(get(row, 'code') ?? '').trim(), gross = num(get(row, 'gross')) ?? (num(get(row, 'chk')) === null ? null : r2(num(get(row, 'chk')) + (num(get(row, 'tax')) || 0)));
      if (code || gross) g.lines.push({ code, name: names[code] || String(get(row, 'name') || ''), gross: gross || 0 });
      byNo.set(n, g);
    });
    const byChk = new Map(mine.map((c) => [chkNo(c.checkNo), c]));
    const add = [], upd = [];
    [...byNo.values()].sort((a, b) => a.n - b.n).forEach((g) => {
      if (!g.date) { problems.push({ line: g.rows[0], why: `Check No. ${g.no}: the date is missing.` }); return; }
      // Already in: only its empty fields are filled from the file (nothing typed is overwritten).
      const cur = byChk.get(g.n);
      if (cur) {
        const fill = {};
        if (!cur.cancelled) {
          if (!cur.particulars && g.part && !/cancel/i.test(g.part)) fill.particulars = g.part;
          if (!cur.payee && g.payee) fill.payee = g.payee;
          if (!cur.ref && g.ref) fill.ref = g.ref;
          if (rci && !hasAmount(cur) && !hasEntry(cur) && g.amount > 0) { fill.amount = g.amount; fill.amountSrc = 'rci'; }
          if (!cur.note && g.note) fill.note = g.note;
        }
        if (Object.keys(fill).length) upd.push({ cur, fill }); else problems.push({ line: g.rows[0], why: `Check No. ${g.no} is already in.` });
        return;
      }
      const cancelled = /cancel/i.test(g.part) && !g.lines.some((l) => l.gross) && !g.amount;
      if (rci && !cancelled && !(g.amount > 0)) { problems.push({ line: g.rows[0], why: `Check No. ${g.no}: the amount is missing.` }); return; }
      const unknown = g.lines.filter((l) => l.code && !names[l.code]).map((l) => l.code);
      add.push({ ...g, cancelled, unknown });
    });
    return { add, upd, problems, rci };
  };
  const show = (bg, p) => {
    const box = $('#sj-res', bg);
    if (p.error) { box.innerHTML = `<div class="msg bad">${esc(p.error)}</div>`; return; }
    const cx = p.add.filter((x) => x.cancelled).length, unk = p.add.filter((x) => x.unknown.length).length, ca = p.add.filter((x) => x.lines.some((l) => CA_CODES.includes(l.code))).length;
    box.innerHTML = `<div class="oi-sum"><b>${p.add.length} check${p.add.length === 1 ? '' : 's'} to add${p.rci ? ' (RCI: fill the entries in the CkDJ later)' : ''}</b>${p.upd.length ? `<span>${p.upd.length} already in: blanks filled</span>` : ''}${cx ? `<span>${cx} cancelled</span>` : ''}${ca ? `<span class="warn-t">${ca} cash advance${ca > 1 ? 's' : ''}: choose the officer after the import (Edit)</span>` : ''}${unk ? `<span class="warn-t">${unk} with an account code not in the Chart of Accounts</span>` : ''}</div>
      ${p.problems.length ? `<div class="af-probs"><b>Not imported (${p.problems.length})</b>${p.problems.slice(0, 60).map((q) => `<div>Row ${q.line} — ${esc(q.why)}</div>`).join('')}</div>` : ''}`;
  };
  const v = await modal({ title: `Import Check Disbursements · ${acctLabel(acct)}`, wide: true,
    body: `<p class="af-note">An RCI (Date, Check No., DV / Payroll No., Payee, Nature of Payment, Amount; see the RCI Template) or the Check Register sheet of the barangay template (Date, Check No., Reference No., Payee, Particulars, Tax Amount, Account Code, Gross Amount). Rows with the same check No. become one check; check Nos. already in are skipped.</p>
      <div class="field"><label for="sj-file">Excel file</label><input class="input" type="file" id="sj-file" accept=".xlsx,.xlsm,.xls,.csv"></div><div id="sj-res"></div>`,
    onOpen: (bg) => { $('#sj-file', bg).onchange = async (e) => { const fl = e.target.files[0]; if (!fl) return; $('#sj-res', bg).innerHTML = '<p class="af-note">Reading…</p>'; try { plan = await read(fl); show(bg, plan); } catch (err) { plan = null; $('#sj-res', bg).innerHTML = `<div class="msg bad">${esc(err.message || String(err))}</div>`; } }; },
    buttons: [{ label: 'Cancel', value: null }, { label: 'Import', cls: 'primary', value: 'go', check: () => { if (!plan || plan.error) { toast('Choose the Excel file first.', 'bad'); return false; } if (!plan.add.length && !plan.upd.length) { toast('Nothing to import.', 'bad'); return false; } return true; } }] });
  if (v !== 'go') return;
  for (const g of plan.add) {
    if (plan.rci) { await store.save('src_ckdj', newId('ckdj'), { coa: 2, lguId: lgu.id, acctId: acct.id, date: g.date, checkNo: g.no, ref: g.cancelled ? '' : g.ref, payee: g.cancelled ? '' : g.payee, particulars: g.cancelled ? 'Cancelled' : g.part,
      amount: g.cancelled ? 0 : g.amount, amountSrc: 'rci', lines: [], tax: { taxable: false }, cancelled: g.cancelled, officerId: '', note: g.note || '' }, by(refs), { quiet: true }); continue; }
    await store.save('src_ckdj', newId('ckdj'), { coa: 2, lguId: lgu.id, acctId: acct.id, date: g.date, checkNo: g.no, ref: g.ref, payee: g.payee, particulars: g.part, lines: g.cancelled ? [] : g.lines.map((l) => ({ code: l.code, name: l.name, gross: r2(l.gross) })),
      tax: g.cancelled || !(g.tax || g.taxyn) ? { taxable: false } : { taxable: true, vat: null, main: g.tax, one: 0 }, cancelled: g.cancelled, officerId: '', note: g.note }, by(refs), { quiet: true });
  }
  for (const { cur, fill } of plan.upd) { const { id, ...rec } = cur; await store.save('src_ckdj', id, { ...rec, ...fill }, by(refs), { quiet: true }); }
  const { emitChange } = await import('../../js/store.js'); emitChange('local');
  toast(`${plan.add.length} check${plan.add.length === 1 ? '' : 's'} imported${plan.upd.length ? `, ${plan.upd.length} updated` : ''}.`, 'ok');
}
