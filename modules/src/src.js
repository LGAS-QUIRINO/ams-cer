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
import { rciSpec, outButtons, wireOut } from './rciout.js';
import { loadExcelJS } from '../cer/wp.js';
import { liqView } from './liq.js';
import { unliqView } from './unliq.js';
import { taxRemView } from './taxrem.js';
import { focusAfter } from './focus.js';
import { loadCoa, loadJournal, matchAo, CA_CODES, grossOf, taxOf, checkAmountOf, isCa, isTaxable, chkNo, hasEntry, tallies, hasAmount, creditsOf, netOf } from './journal.js';

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
  const tab = ['ckdj', 'tax', 'rci', 'liq', 'unl'].includes(q.get('tab')) ? q.get('tab') : 'rci';
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
    const pickM = () => go({ m: `${$('#sd-yr').value}-${$('#sd-mo').value}`, asof: '' });
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
  const tabs = `<div class="sd-tabs" role="tablist">${[['rci', 'Report of Checks Issued'], ['ckdj', 'Check Disbursements Journal'], ['tax', 'Tax Register'], ['liq', 'Liquidation Journal'], ['unl', 'Unliquidated Cash Advances']].map(([k, t]) => `<button type="button" role="tab" class="sd-tab ${k === tab ? 'on' : ''}" data-tab="${k}" aria-selected="${k === tab}">${t}</button>`).join('')}</div>`;
  const totals = { g: r2(list.reduce((n, c) => n + (c.cancelled ? 0 : grossOf(c)), 0)), t: r2(list.reduce((n, c) => n + taxOf(c).amount, 0)), a: r2(list.reduce((n, c) => n + checkAmountOf(c), 0)), s: r2(list.reduce((n, c) => n + creditsOf(c), 0)) };
  const vatText = (c) => { const v = taxOf(c).vat; return v === true ? 'VAT' : v === false ? 'Non-VAT' : ''; };
  // The entry being typed: per tab (the RCI line, or the CkDJ line), a new check or the one being edited.
  const key = `${lgu.id}|${acct.id}|${tab}`;
  if (ED.key !== key) Object.assign(ED, { key, id: '', d: null });
  if (ED.id && !mine.some((c) => c.id === ED.id)) Object.assign(ED, { id: '', d: null });
  if (!ED.d) ED.d = blankCheck('', '');
  const flagsOf = (c) => [inBook(c.checkNo) ? '' : 'Not in a checkbook', !c.cancelled && !hasEntry(c) ? 'No entry yet' : '', !c.cancelled && hasEntry(c) && !tallies(c) ? `Does not tally: gross − tax${creditsOf(c) ? ' − sundry' : ''} = ₱${money(netOf(c))}` : '',
...(c.lines || []).filter((l) => l.old).map((l) => `Old code ${l.old} (${l.oldName}): choose the new account`)].filter(Boolean);

  let inner = '', lqWire = null;
  if (tab === 'unl') {
    const v = await unliqView({ refs, lgu, accounts, m, q, jr, books: chkBooks, enc });
    inner = v.inner; lqWire = v.wire;
  } else if (tab === 'liq') {
    const v = await liqView({ refs, lgu, acct, accounts, m, coa, names, jr, books: chkBooks, enc, monthLabel, acctLabel, rerender: ctx.rerender });
    inner = v.inner; lqWire = v.wire;
  } else if (tab === 'rci') {
    // Step 1 (or after the CkDJ): the check as issued; its amount is the check amount.
    const form = enc ? rciHtml(ED.d, !!ED.id, m) : '';
    inner = `${form}<div class="panel sd-pan"><div class="cd-orhead"><h3 class="cer-h3">Report of Checks Issued · ${esc(monthLabel(m))}</h3><span class="pill">${list.length}</span>
        ${enc ? '<a href="#" class="cd-link" id="sd-rtpl">RCI Template</a><button class="btn sm" type="button" id="sd-imp">Import from Excel</button>' : ''}${outButtons('rc')}</div>
      <div id="cer-print" class="rp-doc"><div class="rp-page"><h2 class="rp-title">REPORT OF CHECKS ISSUED</h2>
        <p class="c"><b>${esc(agencyName(refs, lgu))}</b><br>${esc(acctLabel(acct))}<br>${esc(monthLabel(m))}</p>
        <table class="rp-t"><thead><tr><th>Date</th><th>Check No.</th><th>DV / Payroll No.</th><th>Payee</th><th>Nature of Payment</th><th class="r">Amount</th>${enc ? '<th class="af-noprint"></th>' : ''}</tr></thead>
        <tbody>${list.length ? list.map((c) => `<tr class="${c.id === ED.id ? 'cd-on' : ''}"><td>${esc(fmtDate(c.date))}</td><td>${esc(c.checkNo)}</td><td>${c.cancelled ? '' : esc(c.ref || '')}</td>${c.cancelled ? '<td colspan="2">Cancelled</td><td class="r">–</td>' : `<td>${esc(c.payee || '')}</td><td>${esc(c.particulars || '')}</td><td class="r">${money(checkAmountOf(c))}</td>`}${enc ? `<td class="af-noprint"><button class="btn sm" type="button" data-rciedit="${esc(c.id)}">Edit</button></td>` : ''}</tr>`).join('') : `<tr><td colspan="${enc ? 7 : 6}" class="c">No check issued this month.</td></tr>`}
        <tr class="tot"><td colspan="5">Total</td><td class="r">${money(totals.a)}</td>${enc ? '<td class="af-noprint"></td>' : ''}</tr></tbody></table></div></div></div>`;
  } else if (tab === 'ckdj') {
    // Step 2 (or first): the entry of each check — accounts, gross amounts, tax.
    const form = enc ? entryHtml(ED.d, officers, !!ED.id, m) : '';
    // Fill next entry: the checks of the month with no entry yet; when none is left, the next month that has some.
    const blanks = list.filter(noEntry), nm = blankMonth(mine, m);
    const fillHead = blanks.length ? `<button class="btn sm primary" type="button" id="sd-fillnext" data-id="${esc((blanks.find((c) => c.id !== ED.id) || blanks[0]).id)}">Fill next entry (${blanks.length} left)</button>`
      : list.length ? `<span class="sd-done">✓ All entries filled for ${esc(monthLabel(m))}${nm ? ` · <a href="#" id="sd-nextm" data-m="${nm.m}">Next: ${esc(monthLabel(nm.m))} (${nm.n} left) →</a>` : ''}</span>` : '';
    const rows = list.map((c) => {
      const t = taxOf(c), ls = c.lines || [], fl = flagsOf(c), cs = c.cancelled ? [] : c.credits || [];
      return `<tr class="${c.id === ED.id ? 'cd-on' : ''}"><td>${esc(fmtDate(c.date))}</td><td class="mono">${esc(c.checkNo)}</td><td>${esc(c.ref || '')}</td><td title="${esc(c.payee || '')}">${esc(c.payee || '')}</td><td title="${esc(c.particulars || '')}">${esc(c.cancelled ? 'Cancelled' : c.particulars || '')}</td>
        <td class="r">${c.cancelled ? '' : money(checkAmountOf(c))}</td><td class="r">${c.cancelled || !hasEntry(c) ? '' : money(t.amount)}</td>
        <td class="sd-sg" title="${esc(cs.map((l) => `${l.code} ${l.name || names[l.code] || ''} ₱${money(l.amount)}`).join('\n'))}">${cs.length ? `<span class="mono">${esc(cs[0].code)}</span> <small class="dim">${esc(cs[0].name || names[cs[0].code] || '')}</small>${cs.length > 1 ? ` <span class="pill">+${cs.length - 1}</span>` : ''}` : ''}</td><td class="r sd-sg">${cs.length ? money(creditsOf(c)) : ''}</td>
        <td title="${esc(ls.map((l) => `${l.code} ${l.name || names[l.code] || ''} ₱${money(l.gross)}`).join('\n'))}">${ls.length ? `<span class="mono">${esc(ls[0].code)}</span> <small class="dim">${esc(ls[0].name || names[ls[0].code] || '')}</small>${ls.length > 1 ? ` <span class="pill">+${ls.length - 1}</span>` : ''}` : ''}</td>
        <td class="r">${ls.length ? money(grossOf(c)) : ''}</td><td>${c.cancelled || !hasEntry(c) ? '' : isTaxable(c) ? `Yes${vatText(c) ? ` <small class="dim">${vatText(c)}</small>` : ''}` : 'No'}</td>
        <td class="sd-notec">${fl.map((t) => `<span class="sd-flag">${esc(t)}</span>`).join('')}${enc ? `<button type="button" class="sd-note" data-note="${esc(c.id)}" title="Auditor's note">${c.note ? esc(c.note) : '<span class="dim">+ note</span>'}</button>` : esc(c.note || '')}</td>
        <td>${enc ? `<button class="btn sm ${!c.cancelled && !hasEntry(c) ? 'primary' : ''}" type="button" data-sdedit="${esc(c.id)}">${!c.cancelled && !hasEntry(c) ? 'Fill entry' : 'Edit'}</button>` : ''}</td></tr>`;
    }).join('');
    inner = `${form}<div class="panel sd-pan"><div class="cd-orhead"><h3 class="cer-h3">Check Disbursements Journal · ${esc(monthLabel(m))}</h3><span class="pill">${list.length}</span>
        ${enc ? fillHead : ''}${enc ? '<button class="btn sm" type="button" id="sd-imp">Import from Excel</button>' : ''}<button class="btn sm" type="button" id="sd-xls">Export to Excel</button></div>
      ${list.length ? `<div class="af-tbl sd-scroll"><table class="af-reg sd-tbl"><thead><tr><th scope="col">Date</th><th scope="col">Check No.</th><th scope="col">DV / Payroll</th><th scope="col">Payee</th><th scope="col">Particulars</th><th scope="col" class="r">Check Amount</th><th scope="col" class="r">Tax</th><th scope="col" class="sd-sg">Sundry Credit</th><th scope="col" class="r sd-sg">Amount</th><th scope="col">Account</th><th scope="col" class="r">Gross Amount</th><th scope="col">Taxable</th><th scope="col">Auditor's Note</th><th scope="col"></th></tr></thead>
        <tbody>${rows}</tbody><tfoot><tr class="cd-foot"><td colspan="5">Total, ${esc(monthLabel(m))}</td><td class="r">${money(totals.a)}</td><td class="r">${money(totals.t)}</td><td class="sd-sg"></td><td class="r sd-sg">${money(totals.s)}</td><td></td><td class="r">${money(totals.g)}</td><td colspan="3"></td></tr></tfoot></table></div>`
        : `<div class="empty"><b>No check encoded for ${esc(monthLabel(m))}.</b></div>`}
      ${(() => { const rc = recapOf(list, names); return rc.rows.length ? `<h4 class="sd-rech">Recapitulation · ${esc(monthLabel(m))}</h4><div class="af-tbl sd-recap"><table class="af-reg"><thead><tr><th scope="col">Account Code</th><th scope="col">Account Title</th><th scope="col" class="r">Debit</th><th scope="col" class="r">Credit</th></tr></thead>
        <tbody>${rc.rows.map((x) => `<tr><td class="mono">${esc(x.code)}</td><td>${esc(x.name)}</td><td class="r">${x.d ? money(x.d) : ''}</td><td class="r">${x.c ? money(x.c) : ''}</td></tr>`).join('')}</tbody>
        <tfoot><tr class="cd-foot"><td></td><td>Total</td><td class="r">${money(rc.d)}</td><td class="r">${money(rc.c)}</td></tr></tfoot></table></div>${Math.abs(rc.diff) > 0.004 ? `<p class="sd-tally">Debits and credits differ by ₱${money(Math.abs(rc.diff))}: a check does not tally (see its flag).</p>` : ''}` : ''; })()}</div>`;
  } else {
    const tl = list.filter(isTaxable);
    inner = `<div class="panel sd-pan"><div class="cd-orhead"><h3 class="cer-h3">Tax Register · ${esc(monthLabel(m))}</h3><span class="pill">${tl.length}</span><button class="btn sm" type="button" id="sd-txls">Export to Excel</button></div>
      ${tl.length ? `<div class="af-tbl"><table class="af-reg"><thead><tr><th scope="col">Check No.</th><th scope="col">Date</th><th scope="col">Payee</th><th scope="col">VAT / Non-VAT</th><th scope="col">Goods / Services</th><th scope="col" class="r">Gross Amount</th><th scope="col" class="r">Tax Base</th><th scope="col" class="r">Business Tax (5% / 3%)</th><th scope="col" class="r">EWT (1% / 2%)</th><th scope="col" class="r">Tax Amount</th><th scope="col"></th></tr></thead>
        <tbody>${tl.map((c) => { const t = taxOf(c); return `<tr><td class="mono">${esc(c.checkNo)}</td><td>${esc(fmtDate(c.date))}</td><td>${esc(c.payee || '')}</td><td>${vatText(c) || '<span class="pill p-part">Choose</span>'}</td><td>${t.svc ? 'Services' : 'Goods'}</td><td class="r">${money(grossOf(c))}</td><td class="r">${t.base ? money(t.base) : ''}</td><td class="r">${money(t.main)}</td><td class="r">${money(t.one)}</td><td class="r"><b>${money(t.amount)}</b></td>
          <td>${enc ? `<button class="btn sm" type="button" data-sdtax="${esc(c.id)}">Edit</button>` : ''}</td></tr>`; }).join('')}</tbody>
        <tfoot><tr class="cd-foot"><td colspan="7">Total</td><td class="r">${money(r2(tl.reduce((n, c) => n + taxOf(c).main, 0)))}</td><td class="r">${money(r2(tl.reduce((n, c) => n + taxOf(c).one, 0)))}</td><td class="r">${money(r2(tl.reduce((n, c) => n + taxOf(c).amount, 0)))}</td><td></td></tr></tfoot></table></div>`
        : '<div class="empty"><b>No taxable check this month.</b></div>'}</div>`;
    const tv = await taxRemView({ lgu, accounts, jr, settings, enc, refs }); inner += tv.html; lqWire = tv.wire;
  }
  const body = top + tabs + inner;

  const wire = () => {
    wireTop();
    $$('[data-tab]').forEach((b) => { b.onclick = () => go({ tab: b.dataset.tab }); });
    const fileBase = `${agencyName(refs, lgu)} ${acct.accountNo || ''} ${m}`;
    if ($('#sd-xls')) $('#sd-xls').onclick = () => ckdjXlsx({ list, names, office: agencyName(refs, lgu), acct: acctLabel(acct), month: monthLabel(m), file: `Check Disbursements Journal ${fileBase}.xlsx` }).catch((err) => toast(err.message || String(err), 'bad'));
    if ($('#sd-txls')) $('#sd-txls').onclick = () => exportXlsx(`Tax Register ${fileBase}.xlsx`, 'Tax Register', list.filter(isTaxable).map((c) => { const t = taxOf(c); return { 'Check No.': c.checkNo, Date: fmtDate(c.date), Payee: c.payee || '', 'VAT / Non-VAT': vatText(c), 'Goods / Services': t.svc ? 'Services' : 'Goods', 'Gross Amount': grossOf(c), 'Tax Base': t.base || '', 'Business Tax (5% / 3%)': t.main, 'EWT (1% / 2%)': t.one, 'Tax Amount': t.amount }; }));
    const rciData = () => ({ office: agencyName(refs, lgu), acct: acctLabel(acct), month: monthLabel(m), total: totals.a,
      rows: list.map((c) => ({ date: fmtDate(c.date), checkNo: c.checkNo || '', ref: c.cancelled ? '' : c.ref || '', payee: c.payee || '', nature: c.particulars || '', amount: checkAmountOf(c), cancelled: !!c.cancelled })) });
    if (tab === 'rci') wireOut('rc', () => rciSpec(rciData()), `RCI ${fileBase}`, (m) => toast(m, 'bad'));
    const startEdit = (id, sel) => { const c = mine.find((x) => x.id === id); ED.id = c.id; ED.d = loadD(c); focusAfter('#sd-form', sel || 'input', true); ctx.rerender(); };
    $$('[data-sdedit]').forEach((b) => { b.onclick = () => startEdit(b.dataset.sdedit, '.sd-code'); });
    if ($('#sd-fillnext')) $('#sd-fillnext').onclick = () => startEdit($('#sd-fillnext').dataset.id, '.sd-code');
    if ($('#sd-nextm')) $('#sd-nextm').onclick = (e) => { e.preventDefault(); ED.id = ''; ED.d = null; go({ m: $('#sd-nextm').dataset.m }); };
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
      const { id, ...rec } = c; const next = { ...rec, tax: t }; if (next.amountSrc !== 'rci') next.amount = netOf(next);
      await store.save('src_ckdj', id, next, by(refs)); toast(`Tax of Check No. ${c.checkNo} saved.`, 'ok');
    }; });
    if ($('#sd-imp')) $('#sd-imp').onclick = () => importJournal({ refs, lgu, acct, mine, coa, names });
    if ($('#sd-rtpl')) $('#sd-rtpl').onclick = async (e) => { e.preventDefault();
      try { const XLSX = await loadXlsx(); const ws = XLSX.utils.aoa_to_sheet([['Date', 'Check No.', 'DV / Payroll No.', 'Payee', 'Nature of Payment', 'Amount'], ['10/17/2025', '1894917', 'DV 2025-10-041', 'Juan Dela Cruz', 'Cash advance, Barangay Day', 10000], ['10/18/2025', '1894918', '', '', 'Cancelled', '']]);
        ws['!cols'] = [12, 12, 18, 28, 36, 14].map((w) => ({ wch: w })); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'RCI'); XLSX.writeFile(wb, 'RCI Template.xlsx'); } catch (err) { toast(err.message || String(err), 'bad'); } };
    if (enc && tab === 'ckdj') wireEntry({ refs, lgu, acct, mine, coa, names, m, officers, rerender: ctx.rerender });
    if (lqWire) lqWire();
    if (enc && tab === 'rci') wireRci({ refs, lgu, acct, mine, m, rerender: ctx.rerender });
  };
  return { body, wire };
}

/* ---------- Recapitulation of the CkDJ: each account of the month with its debits and credits ---------- */
// Debits first (the expense / asset accounts), then the credits: Cash in Bank (the checks), Due to BIR (the tax), the sundry credits.
const CIB = '1-01-02-010', BIR = '2-02-01-010';
function recapOf(list, names) {
  const dr = new Map(), cr = new Map(), addTo = (m, k, v) => { if (k && v) m.set(k, r2((m.get(k) || 0) + v)); };
  list.filter((c) => !c.cancelled).forEach((c) => {
    (c.lines || []).forEach((l) => addTo(dr, l.code || l.old, +l.gross || 0));
    addTo(cr, CIB, checkAmountOf(c)); addTo(cr, BIR, taxOf(c).amount);
    (c.credits || []).forEach((l) => addTo(cr, l.code, +l.amount || 0));
  });
  const byCode = (a, b) => a[0].localeCompare(b[0], undefined, { numeric: true });
  const first = [CIB, BIR];
  const crs = [...cr.entries()].sort((a, b) => (first.includes(a[0]) ? first.indexOf(a[0]) : 9) - (first.includes(b[0]) ? first.indexOf(b[0]) : 9) || byCode(a, b));
  const rows = [...[...dr.entries()].sort(byCode).map(([k, v]) => ({ code: k, name: names[k] || '', d: v, c: 0 })), ...crs.map(([k, v]) => ({ code: k, name: names[k] || (k === CIB ? 'Cash in Bank - Local Currency, Current Account' : k === BIR ? 'Due to BIR' : ''), d: 0, c: v }))];
  const d = r2(rows.reduce((n, x) => n + x.d, 0)), c = r2(rows.reduce((n, x) => n + x.c, 0));
  return { rows, d, c, diff: r2(d - c) };
}

/* ---------- Excel: the Check Disbursements Journal in the barangay form ---------- */
// DATE · DV No. · Serial No. of Checks · Name of Payee · Nature of Expense · CREDIT: 1-01-02-010 (Cash in Bank), 2-02-01-010 (1% or 2%,
// 3% or 5%), SUNDRY (UACS Object Code, P, Amount) · DEBIT: SUNDRY (UACS Object Code, P, Amount). One row per account line.
async function ckdjXlsx({ list, names, office, acct, month, file }) {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('CkDJ', { pageSetup: { orientation: 'landscape', paperSize: 5, fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } } });
  const uacs = (code) => String(code || '');   // as in the system (e.g. 1-07-04-990)
  const widths = [11, 13, 12, 26, 36, 14, 13, 11, 12, 3, 13, 12, 3, 14]; widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  const thin = { style: 'thin' }, box = { top: thin, left: thin, bottom: thin, right: thin };
  const YEL = null, BLU = null;   // no fill
  const title = (r, t, sz = 11, b = true) => { ws.mergeCells(r, 1, r, 14); const c = ws.getCell(r, 1); c.value = t; c.font = { bold: b, size: sz }; c.alignment = { horizontal: 'center' }; };
  title(1, 'CHECK DISBURSEMENTS JOURNAL', 13); title(2, office); title(3, acct, 11, false); title(4, month, 11, false);
  const H = 6;   // header rows 6–8
  const head = (r1, c1, r2, c2, v, fill) => { if (r1 !== r2 || c1 !== c2) ws.mergeCells(r1, c1, r2, c2); const c = ws.getCell(r1, c1); c.value = v; c.font = { bold: true, size: 10 }; c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    for (let r = r1; r <= r2; r++) for (let k = c1; k <= c2; k++) { const x = ws.getCell(r, k); x.border = box; if (fill) x.fill = fill; } };
  ['DATE', 'DV No.', 'Serial No. of Checks', 'Name of Payee', 'Nature of Expense'].forEach((t, i) => head(H, i + 1, H + 2, i + 1, t));
  head(H, 6, H, 11, 'CREDIT', YEL); head(H, 12, H, 14, 'DEBIT', BLU);
  head(H + 1, 6, H + 2, 6, '1-01-02-010 (Cash in Bank)', YEL); head(H + 1, 7, H + 1, 8, '2-02-01-010 (Due to BIR)', YEL); head(H + 1, 9, H + 1, 11, 'SUNDRY', YEL); head(H + 1, 12, H + 1, 14, 'SUNDRY', BLU);
  [['1% or 2%', 7], ['3% or 5%', 8], ['UACS Object Code', 9], ['P', 10], ['Amount', 11]].forEach(([t, k]) => head(H + 2, k, H + 2, k, t, YEL));
  [['UACS Object Code', 12], ['P', 13], ['Amount', 14]].forEach(([t, k]) => head(H + 2, k, H + 2, k, t, BLU));
  ws.getRow(H + 2).height = 30;
  let r = H + 3; const first = r;
  const put = (row, k, v, money2) => { const c = ws.getCell(row, k); if (v !== '' && v !== null && v !== undefined) c.value = v; if (money2) { c.numFmt = '#,##0.00;(#,##0.00);"-"'; c.alignment = { horizontal: 'right' }; } };
  list.forEach((c) => {
    const t = taxOf(c), deb = c.cancelled ? [] : (c.lines || []), cr = c.cancelled ? [] : (c.credits || []), n = Math.max(deb.length, cr.length, 1);
    for (let i = 0; i < n; i++) {
      if (i === 0) {
        put(r, 1, fmtDate(c.date)); put(r, 2, c.cancelled ? '' : c.ref || ''); put(r, 3, c.checkNo || ''); put(r, 4, c.cancelled ? '' : c.payee || ''); put(r, 5, c.cancelled ? 'Cancelled' : c.particulars || '');
        if (!c.cancelled) { put(r, 6, checkAmountOf(c), true); if (t.one) put(r, 7, t.one, true); if (t.main) put(r, 8, t.main, true); }
      }
      if (cr[i]) { put(r, 9, uacs(cr[i].code)); put(r, 11, r2(cr[i].amount), true); }
      if (deb[i]) { put(r, 12, uacs(deb[i].code || deb[i].old)); put(r, 14, r2(deb[i].gross), true); }
      for (let k = 1; k <= 14; k++) { const x = ws.getCell(r, k); x.border = box; x.font = { size: 11 }; if (k === 5 || k === 4) x.alignment = { ...(x.alignment || {}), wrapText: true, vertical: 'top' }; }
      r++;
    }
  });
  if (!list.length) { ws.mergeCells(r, 1, r, 14); ws.getCell(r, 1).value = 'No check this month.'; ws.getCell(r, 1).alignment = { horizontal: 'center' }; r++; }
  // Total
  ws.mergeCells(r, 1, r, 5); ws.getCell(r, 1).value = 'TOTAL';
  const col = (k) => String.fromCharCode(64 + k);
  [6, 7, 8, 11, 14].forEach((k) => { const c = ws.getCell(r, k); c.value = { formula: `SUM(${col(k)}${first}:${col(k)}${r - 1})`, result: r2(list.reduce((s, x) => s + (k === 6 ? checkAmountOf(x) : k === 7 ? taxOf(x).one : k === 8 ? taxOf(x).main : k === 11 ? creditsOf(x) : (x.cancelled ? 0 : grossOf(x))), 0)) }; c.numFmt = '#,##0.00;(#,##0.00);"-"'; });
  for (let k = 1; k <= 14; k++) { const x = ws.getCell(r, k); x.border = box; x.font = { bold: true, size: 11 }; }
  // Recapitulation below the entries: Account Code (D), Account Title (E), Debit (F), Credit (G).
  const rc = recapOf(list, names);
  if (rc.rows.length) {
    r += 3; ws.getCell(r, 4).value = 'RECAPITULATION'; ws.getCell(r, 4).font = { bold: true, size: 11 }; r++;
    const NUM = '#,##0.00;(#,##0.00);""';
    const line = (vals, bold, hdr) => { vals.forEach((v, i) => { const c = ws.getCell(r, 4 + i); if (v !== '' && v !== null && v !== undefined) c.value = v; c.border = box; c.font = { bold: !!bold, size: 11 };
      if (i === 0) c.alignment = { horizontal: 'center' }; else if (i >= 2 && !hdr) { c.numFmt = NUM; c.alignment = { horizontal: 'right' }; } else if (hdr && i >= 2) c.alignment = { horizontal: 'center' }; }); r++; };
    line(['Account Code', 'Account Title', 'Debit', 'Credit'], true, true);
    rc.rows.forEach((x) => line([x.code, x.name, x.d || '', x.c || '']));
    line(['', 'Total', rc.d, rc.c], true);
    if (Math.abs(rc.diff) > 0.004) { r++; const c = ws.getCell(r, 1); c.value = `***Debits and credits differ by ${money(Math.abs(rc.diff))}: a check does not tally.`; c.font = { italic: true, size: 11, color: { argb: 'FFC00000' } }; }
  }
  ws.views = [{ state: 'frozen', ySplit: H + 2 }];
  ws.pageSetup.printTitlesRow = `${H}:${H + 2}`;
  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a'); a.href = url; a.download = file; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ---------- the tax window (Tax Register) ---------- */
// VAT or Non-VAT sets the base (gross ÷ 1.12, or gross) and the business tax (5% creditable VAT, or 3% percentage tax);
// Goods or Services sets the EWT (1% or 2%) on the same base. Both are computed and may be typed over (rounding).
async function taxModal(c) {
  const t0 = c.tax || {}, g = grossOf(c);
  let out = null;
  const comp = (vat, svc) => { const base = vat ? r2(g / 1.12) : g; return { base, main: r2(base * (vat ? 5 : 3) / 100), one: r2(base * (svc ? 2 : 1) / 100) }; };
  const cur = taxOf(c), set = t0.vat === true || t0.vat === false;
  const mainL = (vat) => (vat === false ? 'Percentage Tax 3%' : 'VAT 5%'), oneL = (svc) => (svc ? 'EWT 2%' : 'EWT 1%');
  await modal({ title: `Tax · Check No. ${c.checkNo || ''}${c.payee ? ' · ' + c.payee : ''}`, body: `
    <div class="sd-taxw"><div class="field"><span class="cd-lbl">Payee is</span><div class="sd-vat"><label class="cer-tick"><input type="radio" name="sd-vat" value="1" ${t0.vat === true ? 'checked' : ''}> VAT</label><label class="cer-tick"><input type="radio" name="sd-vat" value="0" ${t0.vat === false ? 'checked' : ''}> Non-VAT</label></div></div>
      <div class="field"><span class="cd-lbl">Payment for</span><div class="sd-vat"><label class="cer-tick"><input type="radio" name="sd-svc" value="0" ${t0.svc ? '' : 'checked'}> Goods</label><label class="cer-tick"><input type="radio" name="sd-svc" value="1" ${t0.svc ? 'checked' : ''}> Services</label></div></div>
      <div class="field"><span class="cd-lbl">Gross Amount</span><div class="input cd-ro r">${money(g)}</div></div>
      <div class="field"><span class="cd-lbl">Tax Base</span><div class="input cd-ro r" id="tw-base">${cur.base ? money(cur.base) : '—'}</div></div>
      <div class="field"><label for="tw-main" id="tw-ml">${mainL(t0.vat)}</label><input class="input r" id="tw-main" inputmode="decimal" value="${set || cur.main ? money(cur.main) : ''}"></div>
      <div class="field"><label for="tw-one" id="tw-ol">${oneL(t0.svc)}</label><input class="input r" id="tw-one" inputmode="decimal" value="${set || cur.one ? money(cur.one) : ''}"></div>
      <div class="field"><span class="cd-lbl">Tax Amount</span><div class="input cd-ro r" id="tw-tot">${money(cur.amount)}</div></div></div>
    <p class="af-note">VAT payee: base = gross ÷ 1.12, VAT 5%. Non-VAT: base = gross, percentage tax 3%. Plus the EWT on the same base: goods 1%, services 2%. Type over an amount to match the voucher.</p>`,
    onOpen: (bg) => {
      const tot = () => { $('#tw-tot', bg).textContent = money(r2((num($('#tw-main', bg).value) || 0) + (num($('#tw-one', bg).value) || 0))); };
      const pick = () => { const v = $('[name="sd-vat"]:checked', bg), sv = $('[name="sd-svc"]:checked', bg)?.value === '1';
        $('#tw-ol', bg).textContent = oneL(sv); if (!v) return; const vat = v.value === '1', x = comp(vat, sv);
        $('#tw-base', bg).textContent = money(x.base); $('#tw-ml', bg).textContent = mainL(vat); $('#tw-main', bg).value = money(x.main); $('#tw-one', bg).value = money(x.one); tot(); };
      $$('[name="sd-vat"], [name="sd-svc"]', bg).forEach((r) => { r.onchange = pick; });
      ['#tw-main', '#tw-one'].forEach((k) => { $(k, bg).oninput = tot; });
    },
    buttons: [{ label: 'Cancel', value: null }, { label: 'Save Tax', cls: 'primary', value: 'ok', check: (bg) => {
      const sel = $('[name="sd-vat"]:checked', bg); if (!sel) return bad('Choose VAT or Non-VAT.');
      const vat = sel.value === '1', svc = $('[name="sd-svc"]:checked', bg)?.value === '1', x = comp(vat, svc), main = num($('#tw-main', bg).value), one = num($('#tw-one', bg).value);
      if (main === null || one === null) return bad('Enter the amounts.');
      out = { taxable: true, vat, svc, main: main === x.main ? null : main, one: one === x.one ? null : one };
      if (r2(main + one) > g) return bad('The tax is more than the gross amount.');
      return true;
    } }] });
  return out;
}

/* ---------- shared bits of the two entry lines ---------- */
const noEntry = (c) => !c.cancelled && !hasEntry(c);
// The month (other than m) with checks that have no entry yet: the first one after m, else the first before.
function blankMonth(mine, m) {
  const by = new Map(); mine.filter(noEntry).forEach((c) => { const k = String(c.date || '').slice(0, 7); if (k && k !== m) by.set(k, (by.get(k) || 0) + 1); });
  const ks = [...by.keys()].sort(), k = ks.find((x) => x > m) || ks[0];
  return k ? { m: k, n: by.get(k) } : null;
}
// A check loaded in the entry line: with no entry yet, the gross amount starts as the check amount (most have no tax).
function loadD(c) {
  const d = JSON.parse(JSON.stringify({ ...blankCheck('', ''), ...c }));
  if (c.cancelled) d.particulars = 'Cancelled';
  if (!d.lines.length) d.lines = [{ ...blankLine(), gross: !c.cancelled && hasAmount(c) ? r2(c.amount) : '' }];
  return d;
}
const blankCheck = (date, checkNo) => ({ coa: 3, date, checkNo, ref: '', payee: '', particulars: '', amount: '', lines: [blankLine()], credits: [], tax: { taxable: false }, cancelled: false, officerId: '', note: '' });
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
function wireCommon(c, save, order, quick) {
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
    if (quick && quick(e)) { save(); return; }
    const els = order(), i = els.indexOf(e.target);
    if ((e.target.id === 'sd-part' && isCancelText(e.target.value)) || i < 0 || i === els.length - 1) { save(); return; }
    els[i + 1].focus();
  };
}
async function saveCheck(c, rec, wasNew, next) {
  const id = ED.id || newId('ckdj');
  ED.id = next ? next.id : ''; ED.d = next ? loadD(next) : wasNew ? blankCheck(rec.date, nextNo(rec.checkNo)) : null;
  focusAfter('#sd-form', next ? '.sd-code' : '#sd-ref', !!next);
  await store.save('src_ckdj', id, rec, by(c.refs));
  toast(`Check No. ${rec.checkNo} saved.${next ? ` Next: Check No. ${next.checkNo}.` : ''}`, 'ok');
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
  // Sundry credits (retention, liquidated damages…): any account of the Chart of Accounts, like the debit lines.
  const crl = (l, i) => `<div class="sd-crl" data-cr="${i}"><input class="input mono sd-ccode" list="sd-coa" value="${esc(l.code)}" placeholder="Credit account" aria-label="Credit account" title="${esc(l.name || '')}">
      <input class="input r sd-camt" inputmode="decimal" value="${l.amount === '' || l.amount === undefined ? '' : esc(money(l.amount))}" aria-label="Credit amount"><button class="btn sm sd-xc" type="button" aria-label="Remove credit">✕</button></div>`;
  const tx = d.tax || {};
  const fixed = d.amountSrc === 'rci';
  return `<div class="panel sd-pan" id="sd-form">${editHead(d, editing)}
    <div class="sd-line">${headHtml(d, m, 'Particulars')}
      <div class="sd-f sd-w-amt"><label title="${fixed ? 'From the Report of Checks Issued' : 'Gross − Tax'}">Check Amount${fixed ? ' ·RCI' : ''}</label><div class="input cd-ro r" id="sd-chk"></div></div>
      <div class="sd-f sd-w-tax"><label for="sd-tax">Tax</label><button type="button" class="input cd-ro r sd-taxbtn" id="sd-tax" title="Tax Register">0.00</button></div>
      <div class="sd-f sd-w-yn"><label for="sd-taxable">Taxable</label><select class="input" id="sd-taxable"><option value="0" ${tx.taxable ? '' : 'selected'}>No</option><option value="1" ${tx.taxable ? 'selected' : ''}>Yes</option></select></div>
      <div class="sd-f sd-w-btn"><label>&nbsp;</label><button class="btn primary" type="button" id="sd-save">${editing ? 'Save' : 'Enter'}</button></div>
    </div>
    <div class="sd-entry2">
      <div class="sd-box"><div class="sd-boxh"><b>Debit</b><span id="sd-dtot"></span></div>
        <div class="sd-acch"><label>Account</label><label class="r">Gross Amount</label><span></span></div>
        <div class="sd-accts">${d.lines.map(ln).join('')}<button type="button" class="sd-add" id="sd-addln">+ debit account</button></div></div>
      <div class="sd-box"><div class="sd-boxh"><b>Credit · Sundry</b><span id="sd-ctot"></span></div>
        ${(d.credits || []).length ? '<div class="sd-acch"><label>Account</label><label class="r">Amount</label><span></span></div>' : ''}
        <div class="sd-accts">${(d.credits || []).map(crl).join('')}<button type="button" class="sd-add" id="sd-addcr">+ credit account</button>${(d.credits || []).length ? '' : ' <small class="dim">retention, liquidated damages, other deductions</small>'}</div></div>
    </div>
    <div class="sd-tally" id="sd-tally" hidden></div>
    <div class="sd-offrow" id="sd-offbox" hidden><span id="sd-offtxt"></span> <a href="#" class="cd-link" id="sd-offchg">${d.officerId ? 'change' : 'change'}</a>
      <select class="input" id="sd-off" ${d.officerId ? '' : 'hidden'}><option value="">Match from the Payee</option>${officers.map((o) => `<option value="${esc(o.id)}" ${o.id === d.officerId ? 'selected' : ''}>AO: ${esc(o.name)}${o.designation ? ' · ' + esc(o.designation) : ''}</option>`).join('')}</select></div>
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
    d.credits = $$('.sd-crl[data-cr]').map((el) => { const code = toCode($('.sd-ccode', el).value); return { code, name: names[code] || '', amount: num($('.sd-camt', el).value) ?? '' }; });
    const taxable = $('#sd-taxable').value === '1';
    if (!taxable) d.tax = { taxable: false };
    else { d.tax = { ...d.tax, taxable: true }; if (grossOf(d) !== g0) { d.tax.main = null; d.tax.one = null; } }   // a new gross: the tax is computed again
  };
  const net = () => netOf(d);
  const paint = () => {
    read();
    $$('.sd-ln').forEach((el, i) => { const l = d.lines[i]; $('.sd-code', el).title = l.name || (l.code ? 'Not in the Chart of Accounts' : ''); $('.sd-code', el).classList.toggle('sd-bad', !!l.code && !l.name); });
    const off = d.cancelled;
    ['#sd-ref', '#sd-payee', '#sd-taxable'].forEach((k) => { $(k).disabled = off; });
    $$('.sd-ln input, #sd-addln, .sd-crl input, .sd-xc, #sd-addcr').forEach((el) => { el.disabled = off; });
    $$('.sd-crl[data-cr]').forEach((el, i) => { const l = d.credits[i]; $('.sd-ccode', el).title = l.name || (l.code ? 'Not in the Chart of Accounts' : ''); $('.sd-ccode', el).classList.toggle('sd-bad', !!l.code && !l.name); });
    $('#sd-dtot').textContent = off ? '' : money(grossOf(d)); $('#sd-ctot').textContent = off || !creditsOf(d) ? '—' : money(creditsOf(d));
    $('#sd-form').classList.toggle('sd-cancelled', off);
    $('#sd-tax').textContent = money(taxOf(d).amount) || '0.00';
    $('#sd-tax').classList.toggle('sd-need', !off && d.tax.taxable && d.tax.vat !== true && d.tax.vat !== false);
    $('#sd-chk').textContent = off ? '0.00' : money(fixed ? r2(d.amount) : net());
    const tl = $('#sd-tally'), diff = fixed && !off && grossOf(d) ? r2(net() - r2(d.amount)) : 0, cr = creditsOf(d);
    const eq = `Gross ${money(grossOf(d))} − Tax ${money(taxOf(d).amount)}${cr ? ` − Sundry ${money(cr)}` : ''}`;
    tl.hidden = off || !(diff || (cr && grossOf(d))); tl.classList.toggle('sd-ok', !diff);
    tl.textContent = diff ? `${eq} = ₱${money(net())}; the check is ₱${money(r2(d.amount))} (difference ₱${money(diff)}).` : cr && grossOf(d) ? `✓ ${eq} = Check ${money(fixed ? r2(d.amount) : net())}` : '';
    $('#sd-offbox').hidden = off || !d.lines.some((l) => CA_CODES.includes(l.code));
    // The person of the cash advance is the payee; an AO is matched by name (or picked with change).
    const ao = d.officerId ? c.officers.find((o) => o.id === d.officerId) : matchAo(d.payee, c.officers, lgu.id);
    $('#sd-offtxt').innerHTML = ao ? `Cash advance of <b>AO: ${esc(ao.name)}</b> ✓ <small class="dim">${d.officerId ? 'picked' : 'matched from the Payee'}; in the cash exam</small>`
      : `Cash advance of <b>${esc(d.payee || 'the payee')}</b> <small class="dim">not an AO: in the Liquidation Journal and Unliquidated Cash Advances</small>`;
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
      const crs = d.credits.filter((l) => l.code || l.amount !== '');
      if (crs.some((l) => !l.code)) return bad('Enter the account of each credit.');
      if (crs.some((l) => !names[l.code])) return bad(`${crs.find((l) => !names[l.code]).code} is not in the Chart of Accounts.`);
      if (crs.some((l) => !(+l.amount > 0))) return bad('Enter the amount of each credit.');
      d.credits = crs;
      if (net() < 0) return bad('The tax and the credits are more than the gross amount.');
    } else { lines = []; d.credits = []; }
    const cur = ED.id ? mine.find((x) => x.id === ED.id) : null;
    const rec = { ...(cur ? (({ id, ...r }) => r)(cur) : {}), coa: 3, lguId: lgu.id, acctId: acct.id, date: d.date, checkNo: d.checkNo, ref: d.cancelled ? '' : d.ref, payee: d.cancelled ? '' : d.payee, particulars: d.cancelled ? 'Cancelled' : d.particulars,
      lines: lines.map((l) => ({ code: l.code, name: names[l.code], gross: r2(l.gross) })), credits: d.credits.map((l) => ({ code: l.code, name: names[l.code], amount: r2(l.amount) })), tax: d.cancelled ? { taxable: false } : d.tax, cancelled: d.cancelled,
      officerId: lines.some((l) => CA_CODES.includes(l.code)) ? d.officerId : '', note: d.note || (cur && cur.note) || '' };
    // Encoded here first: the check amount is gross − tax (it shows in the RCI); from the RCI: it stays as typed there.
    if (fixed && !d.cancelled) { rec.amount = r2(d.amount); rec.amountSrc = 'rci'; } else { rec.amount = d.cancelled ? 0 : net(); rec.amountSrc = 'ckdj'; }
    // Filling a check that had no entry: the next one of the month with no entry opens (date and check No. order).
    let next = null;
    if (cur && noEntry(cur)) {
      const ord = mine.filter((x) => String(x.date || '').startsWith(m)).sort((a, b) => String(a.date).localeCompare(String(b.date)) || chkNo(a.checkNo) - chkNo(b.checkNo));
      const i = ord.findIndex((x) => x.id === cur.id);
      next = [...ord.slice(i + 1), ...ord.slice(0, i)].find((x) => x.id !== cur.id && noEntry(x)) || null;
    }
    await saveCheck(c, rec, !ED.id, next);
  };
  $$('.sd-ln input').forEach((el) => { el.oninput = paint; el.onchange = () => { if (el.classList.contains('sd-code')) el.value = toCode(el.value); paint(); }; });
  $$('.sd-xl').forEach((b) => { b.onclick = () => { read(); d.lines.splice(+b.closest('.sd-ln').dataset.ln, 1); rerender(); }; });
  $$('.sd-crl input').forEach((el) => { el.oninput = paint; el.onchange = () => { if (el.classList.contains('sd-ccode')) el.value = toCode(el.value); paint(); }; });
  $$('.sd-camt').forEach((el) => { el.onblur = () => { const v = num(el.value); if (v !== null) el.value = money(v); paint(); }; });
  $$('.sd-xc').forEach((b) => { b.onclick = () => { read(); d.credits.splice(+b.closest('.sd-crl').dataset.cr, 1); rerender(); }; });
  $('#sd-addcr').onclick = () => { read(); d.credits.push({ code: '', name: '', amount: '' }); rerender(); setTimeout(() => { const all = $$('.sd-ccode'); if (all.length) all[all.length - 1].focus(); }, 0); };
  ['#sd-date', '#sd-no', '#sd-ref', '#sd-payee', '#sd-part'].forEach((k) => { $(k).oninput = paint; });
  $('#sd-off').onchange = paint;
  $('#sd-offchg').onclick = (e) => { e.preventDefault(); $('#sd-off').hidden = false; $('#sd-off').focus(); };
  $('#sd-taxable').onchange = async () => { paint(); if ($('#sd-taxable').value === '1' && d.tax.vat !== true && d.tax.vat !== false) await openTax(); };
  $('#sd-tax').onclick = () => { if ($('#sd-taxable').value === '1') openTax(); };
  $('#sd-addln').onclick = () => { read(); d.lines.push(blankLine()); rerender(); setTimeout(() => { const all = $$('.sd-code'); if (all.length) all[all.length - 1].focus(); }, 0); };
  // Enter in an account or gross box saves when the entry is complete and gross − tax = the check amount (from the RCI).
  const quick = (e) => { if (!fixed || !e.target.matches('.sd-code, .sd-gross, .sd-ccode, .sd-camt')) return false; read();
    return !d.cancelled && d.lines.length > 0 && d.lines.every((l) => l.code && names[l.code] && +l.gross > 0) && d.credits.every((l) => l.code && names[l.code] && +l.amount > 0) && Math.abs(net() - r2(d.amount)) < 0.005; };
  wireCommon(c, save, () => ['#sd-date', '#sd-no', '#sd-ref', '#sd-payee', '#sd-part', ...$$('.sd-ln').flatMap((el, i) => [`.sd-ln[data-ln="${i}"] .sd-code`, `.sd-ln[data-ln="${i}"] .sd-gross`]), ...$$('.sd-crl[data-cr]').flatMap((el, i) => [`.sd-crl[data-cr="${i}"] .sd-ccode`, `.sd-crl[data-cr="${i}"] .sd-camt`]), '#sd-taxable'].map((k) => $(k)).filter((el) => el && !el.disabled), quick);
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
    const cols = [['date', /^date/i], ['no', /check\s*no/i], ['ref', /reference|dv|payroll/i], ['payee', /payee/i], ['part', /particular|nature/i], ['chk', /check\s*amount/i], ['amt', /^\s*amount\s*(\(.*\))?\s*$/i], ['tax', /tax\s*amount/i], ['ccode', /credit\s*(account\s*)?code/i], ['camt', /credit\s*amount/i], ['code', /^(?!.*credit).*account\s*code/i], ['name', /^(?!.*credit).*account\s*name/i], ['gross', /gross/i], ['note', /note/i], ['taxyn', /^\s*(tax|taxable)\s*$/i]];
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
      const g = byNo.get(n) || { n, no: noTxt, date: '', ref: '', payee: '', part: '', tax: 0, taxyn: false, note: '', lines: [], credits: [], rows: [] };
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
      { const cc = String(get(row, 'ccode') ?? '').trim(), ca = num(get(row, 'camt')); if (cc || ca) g.credits.push({ code: cc, name: names[cc] || '', amount: ca || 0 }); }
      byNo.set(n, g);
    });
    const byChk = new Map(mine.map((c) => [chkNo(c.checkNo), c]));
    // The same check typed in Cash Advances (not changed here: a note says what differs).
    const cas = (await store.list('cer_cashadv')).filter((r) => !r.deleted && r.data.lguId === lgu.id).map((r) => r.data);
    const add = [], upd = [];
    const same = (a, b) => String(a ?? '').trim().replace(/\s+/g, ' ').toUpperCase() === String(b ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
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
          if (!(cur.credits || []).length && (g.credits || []).length) fill.credits = g.credits.map((l) => ({ code: l.code, name: l.name, amount: r2(l.amount) }));
        }
        // Corrections: what the file says differently from what is in (shown for the auditor to tick; nothing changes unticked).
        const fix = {}, diffs = [], warn = [];
        const fCx = /cancel/i.test(g.part) && !g.lines.some((l) => l.gross) && !g.amount;
        if (g.date && g.date !== cur.date) { fix.date = g.date; diffs.push(['Date', fmtDate(cur.date), fmtDate(g.date)]); }
        if (fCx !== !!cur.cancelled) {
          diffs.push(['Status', cur.cancelled ? 'Cancelled' : 'Issued', fCx ? 'Cancelled' : 'Issued']); fix.cancelled = fCx;
          if (fCx) Object.assign(fix, { particulars: 'Cancelled', payee: '', ref: '', ...(rci && !hasEntry(cur) ? { amount: 0 } : {}) });
          else Object.assign(fix, { particulars: g.part || '', payee: g.payee || '', ref: g.ref || '', ...(rci && g.amount > 0 && !hasEntry(cur) ? { amount: g.amount, amountSrc: 'rci' } : {}) });
        } else if (!fCx) {
          if (g.payee && cur.payee && !same(g.payee, cur.payee)) { fix.payee = g.payee; diffs.push(['Payee', cur.payee, g.payee]); }
          if (g.ref && cur.ref && !same(g.ref, cur.ref)) { fix.ref = g.ref; diffs.push(['DV / Payroll No.', cur.ref, g.ref]); }
          if (g.part && cur.particulars && !same(g.part, cur.particulars)) { fix.particulars = g.part; diffs.push(['Nature of payment', cur.particulars, g.part]); }
          if (rci && g.amount > 0 && (hasAmount(cur) || hasEntry(cur)) && Math.abs(checkAmountOf(cur) - g.amount) > 0.004) {
            if (hasEntry(cur)) warn.push(`Amount ₱${money(g.amount)} in the file, ₱${money(checkAmountOf(cur))} from its CkDJ entries: fix it in the CkDJ.`);
            else { fix.amount = g.amount; fix.amountSrc = 'rci'; diffs.push(['Amount', money(checkAmountOf(cur)), money(g.amount)]); }
          }
        }
        const ca = cas.find((a) => chkNo(a.checkNo) === g.n);
        if (ca && !fCx && ((g.date && ca.date !== g.date) || (rci && g.amount > 0 && Math.abs((+ca.amount || 0) - g.amount) > 0.004)))
          warn.push(`Also in Cash Advances (${fmtDate(ca.date)}, ₱${money(ca.amount)}): update it there if it is wrong.`);
        if (Object.keys(fill).length || diffs.length || warn.length) upd.push({ cur, fill, fix, diffs, warn, no: g.no });
        else problems.push({ line: g.rows[0], why: `Check No. ${g.no} is already in, nothing different.` });
        return;
      }
      const cancelled = /cancel/i.test(g.part) && !g.lines.some((l) => l.gross) && !g.amount;
      if (rci && !cancelled && !(g.amount > 0)) { problems.push({ line: g.rows[0], why: `Check No. ${g.no}: the amount is missing.` }); return; }
      const unknown = [...g.lines, ...(g.credits || [])].filter((l) => l.code && !names[l.code]).map((l) => l.code);
      add.push({ ...g, cancelled, unknown });
    });
    return { add, upd, problems, rci };
  };
  const show = (bg, p) => {
    const box = $('#sj-res', bg);
    if (p.error) { box.innerHTML = `<div class="msg bad">${esc(p.error)}</div>`; return; }
    const nFix = p.upd.filter((u) => u.diffs.length).length, nFill = p.upd.filter((u) => Object.keys(u.fill).length).length;
    const fixHtml = nFix || p.upd.some((u) => u.warn.length) ? `<div class="sj-fix"><b>Corrections found (${nFix})</b> <span class="dim">The file differs from what is in. Ticked ones are corrected on Import; untick to keep what is in.</span>
      <div class="af-tbl"><table class="af-reg"><thead><tr><th></th><th>Check No.</th><th>What changes</th><th>Now in the system</th><th>In the file</th></tr></thead><tbody>
      ${p.upd.map((u, i) => { const notes = u.warn.length ? `<tr class="sj-note"><td></td><td colspan="4">${u.warn.map((w) => `<span class="pill p-flag">${esc(w)}</span>`).join(' ')}</td></tr>` : '';
        return u.diffs.length ? u.diffs.map((d, j) => `<tr>${j === 0 ? `<td rowspan="${u.diffs.length}"><input type="checkbox" data-sjfix="${i}" checked aria-label="Correct check No. ${esc(u.no)}"></td><td rowspan="${u.diffs.length}" class="mono">${esc(u.no)}</td>` : ''}<td>${esc(d[0])}</td><td>${esc(d[1] || '—')}</td><td><b>${esc(d[2] || '—')}</b></td></tr>`).join('') + notes
          : u.warn.length ? `<tr><td></td><td class="mono">${esc(u.no)}</td><td colspan="3"><span class="dim">nothing to correct here</span></td></tr>${notes}` : ''; }).join('')}</tbody></table></div></div>` : '';
    const cx = p.add.filter((x) => x.cancelled).length, unk = p.add.filter((x) => x.unknown.length).length, ca = p.add.filter((x) => x.lines.some((l) => CA_CODES.includes(l.code))).length;
    box.innerHTML = `<div class="oi-sum"><b>${p.add.length} check${p.add.length === 1 ? '' : 's'} to add${p.rci ? ' (RCI: fill the entries in the CkDJ later)' : ''}</b>${nFix ? `<span>${nFix} with corrections</span>` : ''}${nFill ? `<span>${nFill} already in: blanks filled</span>` : ''}${cx ? `<span>${cx} cancelled</span>` : ''}${ca ? `<span>${ca} cash advance${ca > 1 ? 's' : ''} (the payee is the person; AOs matched by name)</span>` : ''}${unk ? `<span class="warn-t">${unk} with an account code not in the Chart of Accounts</span>` : ''}</div>
      ${fixHtml}${p.problems.length ? `<div class="af-probs"><b>Not imported (${p.problems.length})</b>${p.problems.slice(0, 60).map((q) => `<div>Row ${q.line} — ${esc(q.why)}</div>`).join('')}</div>` : ''}`;
  };
  const v = await modal({ title: `Import Check Disbursements · ${acctLabel(acct)}`, wide: true,
    body: `<p class="af-note">An RCI (Date, Check No., DV / Payroll No., Payee, Nature of Payment, Amount; see the RCI Template) or the Check Register sheet of the barangay template (Date, Check No., Reference No., Payee, Particulars, Tax Amount, Account Code, Gross Amount; optional Credit Account Code, Credit Amount for sundry credits). Rows with the same check No. become one check. A check No. already in: its blanks are filled, and what the file says differently (date, payee, DV No., nature of payment, amount, cancelled) is listed for you to correct.</p>
      <div class="field"><label for="sj-file">Excel file</label><input class="input" type="file" id="sj-file" accept=".xlsx,.xlsm,.xls,.csv"></div><div id="sj-res"></div>`,
    onOpen: (bg) => { $('#sj-file', bg).onchange = async (e) => { const fl = e.target.files[0]; if (!fl) return; $('#sj-res', bg).innerHTML = '<p class="af-note">Reading…</p>'; try { plan = await read(fl); show(bg, plan); } catch (err) { plan = null; $('#sj-res', bg).innerHTML = `<div class="msg bad">${esc(err.message || String(err))}</div>`; } }; },
    buttons: [{ label: 'Cancel', value: null }, { label: 'Import', cls: 'primary', value: 'go', check: (bg) => { if (!plan || plan.error) { toast('Choose the Excel file first.', 'bad'); return false; }
      plan.upd.forEach((u, i) => { const cb = $(`[data-sjfix="${i}"]`, bg); u.apply = !!(cb && cb.checked); });
      if (!plan.add.length && !plan.upd.some((u) => Object.keys(u.fill).length || (u.apply && u.diffs.length))) { toast('Nothing to import.', 'bad'); return false; } return true; } }] });
  if (v !== 'go') return;
  for (const g of plan.add) {
    if (plan.rci) { await store.save('src_ckdj', newId('ckdj'), { coa: 3, lguId: lgu.id, acctId: acct.id, date: g.date, checkNo: g.no, ref: g.cancelled ? '' : g.ref, payee: g.cancelled ? '' : g.payee, particulars: g.cancelled ? 'Cancelled' : g.part,
      amount: g.cancelled ? 0 : g.amount, amountSrc: 'rci', lines: [], tax: { taxable: false }, cancelled: g.cancelled, officerId: '', note: g.note || '' }, by(refs), { quiet: true }); continue; }
    await store.save('src_ckdj', newId('ckdj'), { coa: 3, lguId: lgu.id, acctId: acct.id, date: g.date, checkNo: g.no, ref: g.ref, payee: g.payee, particulars: g.part, lines: g.cancelled ? [] : g.lines.map((l) => ({ code: l.code, name: l.name, gross: r2(l.gross) })),
      credits: g.cancelled ? [] : g.credits.map((l) => ({ code: l.code, name: l.name, amount: r2(l.amount) })),
      tax: g.cancelled || !(g.tax || g.taxyn) ? { taxable: false } : { taxable: true, vat: null, main: g.tax, one: 0 }, cancelled: g.cancelled, officerId: '', note: g.note }, by(refs), { quiet: true });
  }
  let nFixed = 0, nFilled = 0;
  for (const u of plan.upd) {
    const fx = u.apply && u.diffs.length ? u.fix : {};
    if (!Object.keys(u.fill).length && !Object.keys(fx).length) continue;
    const { id, ...rec } = u.cur; await store.save('src_ckdj', id, { ...rec, ...u.fill, ...fx }, by(refs), { quiet: true });
    if (Object.keys(fx).length) nFixed++; else nFilled++;
  }
  const { emitChange } = await import('../../js/store.js'); emitChange('local');
  toast(`${plan.add.length} check${plan.add.length === 1 ? '' : 's'} added${nFixed ? `, ${nFixed} corrected` : ''}${nFilled ? `, ${nFilled} blanks filled` : ''}.`, 'ok');
}
