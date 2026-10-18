// CER · Bank Statements (design approved 18 Oct 2026).
// Per bank account of the auditee (barangays: one per fund; the LGU may have several), as of the cash count:
//   1. Bank Statement     soft copy imported (Excel / CSV) or the ending balance typed (PDF, printed, bank confirmation),
//                         plus the bank-only items (bank credits such as interest, bank debits such as service charges).
//   2. Deposits and Checks every deposit (Collections & Deposits) and check (Cash Advances, or typed here) ticked when found
//                         in the bank: In the bank (and how many days later), Deposit in transit, Cleared, Outstanding check.
//   3. Bank Reconciliation adjusted bank balance (bank + deposits in transit − outstanding checks) against
//                         adjusted book balance (cashbook + bank credits − bank debits).
//
// Records:
//   cer_settings 'banks|<lguId>'   { list: [{ id, bank, accountNo, fund }] }
//   cer_bankrec  id <auditId>|<accountId>
//                { auditId, accountId, lguId, asOf, ending, source, book, bankItems[{ date, type: 'credit'|'debit', particulars, amount }],
//                  found{ <item key>: bankDate }, otherChecks[{ id, date, checkNo, payee, amount }], lines[] (imported, for reference) }
import { store, newId } from '../../js/store.js';
import { esc, modal, toast, $, $$ } from '../../js/ui.js';
import { hasRole, by, mayView, agencyName, fmtDate, money, num } from './cer.js';
import { exportXlsx } from './forms.js';

const DEFAULT_FUNDS = ['General Fund', 'Special Education Fund', 'Trust Fund'];
const canEncode = (refs) => hasRole(refs, 'staff', 'member', 'atl', 'sa', 'admin');
const r2 = (n) => Math.round(n * 100) / 100;
const flat = (r) => ({ id: r.id, ...r.data });
const strip = (x) => { const { id, ...rest } = x; return rest; };
const bad = (m) => { toast(m, 'bad'); return false; };
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const go = (params) => { const q = new URLSearchParams(location.hash.split('?')[1] || ''); Object.entries(params).forEach(([k, v]) => (v ? q.set(k, v) : q.delete(k))); location.hash = location.hash.split('?')[0] + '?' + q.toString(); };
const OPEN = { st: true, dc: true, rc: true };
const SOURCES = ['Soft copy (imported)', 'PDF', 'Printed', 'Bank confirmation'];

export async function banksView(ctx) {
  const { refs, q } = ctx;
  const [audits0, settings0, reports0, advs0, recs0, officers0] = await Promise.all(['cer_audits', 'cer_settings', 'cer_reports', 'cer_cashadv', 'cer_bankrec', 'cer_officers'].map((t) => store.list(t)));
  const audits = audits0.map(flat).filter((a) => mayView(refs, refs.lgu[a.lguId])).sort((a, b) => String(b.countDate).localeCompare(String(a.countDate)));
  const settings = Object.fromEntries(settings0.map((s) => [s.id, s.data]));
  const crumb = 'Bank Statements';
  const hello = (extra = '') => `<div class="hello"><div><h1>Bank Statements</h1><p>Confirm each deposit and check in the bank statement, then reconcile the bank and book balances as of the cash count.</p></div>${extra}</div>`;
  if (!audits.length) return { crumb, body: hello() + '<div class="panel"><div class="empty"><b>No cash examination yet.</b>The auditors set one up in Audit Setup.</div></div>' };
  const audit = audits.find((a) => a.id === q.get('a')) || audits[0];
  const lgu = refs.lgu[audit.lguId];
  const funds = settings['funds|' + audit.lguId]?.list || DEFAULT_FUNDS;
  const accounts = settings['banks|' + audit.lguId]?.list || [];
  const enc = canEncode(refs);
  const acct = accounts.find((x) => x.id === q.get('acct')) || accounts[0] || null;
  const recId = acct ? `${audit.id}|${acct.id}` : '';
  const rec0 = recs0.map(flat).find((r) => r.id === recId);
  const rec = { asOf: audit.countDate, ending: null, source: SOURCES[1], book: null, bankItems: [], found: {}, otherChecks: [], lines: [], ...(rec0 || {}) };
  const asOf = q.get('asof') || rec.asOf || audit.countDate;
  const top = `<div class="panel cd-bar bk-bar">
      <div class="field"><label for="bk-audit">Cash Examination</label><select class="input" id="bk-audit">${audits.map((a) => `<option value="${esc(a.id)}" ${a.id === audit.id ? 'selected' : ''}>${esc(agencyName(refs, refs.lgu[a.lguId]))} · ${esc(fmtDate(a.countDate))}</option>`).join('')}</select></div>
      <div class="field"><label for="bk-acct">Bank Account</label><select class="input" id="bk-acct">${accounts.length ? accounts.map((x) => `<option value="${esc(x.id)}" ${acct && x.id === acct.id ? 'selected' : ''}>${esc(acctLabel(x))}</option>`).join('') : '<option value="">No bank account yet</option>'}</select></div>
      <div class="field"><label for="bk-asof">Statement up to</label><input class="input" type="date" id="bk-asof" value="${esc(asOf)}"></div></div>`;
  const btnAccts = `<div class="btn-row"><button class="btn" type="button" id="bk-accts">Bank Accounts (${accounts.length})</button></div>`;
  const wireTop = () => {
    $('#bk-audit').onchange = (e) => go({ a: e.target.value, acct: '', asof: '' });
    $('#bk-acct').onchange = (e) => go({ acct: e.target.value });
    $('#bk-asof').onchange = (e) => go({ asof: e.target.value });
    $('#bk-accts').onclick = () => accountsModal(refs, audit.lguId, accounts, funds, enc);
  };
  if (!acct) return { crumb, body: hello(btnAccts) + top + `<div class="panel"><div class="empty"><b>No bank account for ${esc(agencyName(refs, lgu))} yet.</b>${enc ? 'Add the accounts with <b>Bank Accounts</b> (bank, account No. and fund).' : ''}</div></div>`, wire: wireTop };

  // Items in the books for this account, up to the statement date.
  const officers = officers0.map(flat);
  const otherAccts = accounts.filter((x) => x.id !== acct.id).map((x) => `${audit.id}|${x.id}`);
  const foundElsewhere = new Set(recs0.map(flat).filter((r) => otherAccts.includes(r.id)).flatMap((r) => Object.keys(r.found || {})));
  const items = [];
  reports0.map(flat).filter((r) => r.lguId === audit.lguId && r.fund === acct.fund).forEach((r) => (r.deposits || []).forEach((d) => {
    const key = `dep|${r.id}|${d.date}|${d.ref}|${d.amount}`;
    items.push({ key, kind: 'dep', date: d.date, ref: d.ref || '', amount: +d.amount || 0,
      from: `${r.pending ? 'Not yet reported' : `${r.kind || 'RCD'} No. ${r.no}`} · ${officers.find((o) => o.id === r.officerId)?.name || ''}` });
  }));
  advs0.map(flat).filter((a) => a.lguId === audit.lguId).forEach((a) => items.push({ key: `chk|${a.id}`, kind: 'chk', date: a.date, ref: a.checkNo, amount: +a.amount || 0,
    from: `Cash advance · ${officers.find((o) => o.id === a.officerId)?.name || ''}` }));
  (rec.otherChecks || []).forEach((c) => items.push({ key: `oth|${c.id}`, kind: 'chk', date: c.date, ref: c.checkNo, amount: +c.amount || 0, from: `Typed here${c.payee ? ' · ' + c.payee : ''}`, other: c }));
  const list = items.filter((x) => x.date && x.date <= asOf && !foundElsewhere.has(x.key)).sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.kind.localeCompare(b.kind));
  const result = (x) => {
    const bd = rec.found[x.key];
    if (!bd) return x.kind === 'dep' ? ['p-part', 'Deposit in transit'] : ['p-part', 'Outstanding check'];
    if (x.kind === 'dep') { const late = bd && x.date ? days(x.date, bd) : 0; return late > 0 ? ['p-flag', `In the bank · ${late} day${late > 1 ? 's' : ''} later`] : ['p-done', 'In the bank']; }
    return ['p-done', 'Cleared'];
  };
  const dit = r2(list.filter((x) => x.kind === 'dep' && !rec.found[x.key]).reduce((n, x) => n + x.amount, 0));
  const oc = r2(list.filter((x) => x.kind === 'chk' && !rec.found[x.key]).reduce((n, x) => n + x.amount, 0));
  const bItems = (rec.bankItems || []).filter((b) => !b.date || b.date <= asOf);
  const credits = r2(bItems.filter((b) => b.type === 'credit').reduce((n, b) => n + (+b.amount || 0), 0));
  const debits = r2(bItems.filter((b) => b.type === 'debit').reduce((n, b) => n + (+b.amount || 0), 0));
  const hasEnd = rec.ending !== null && rec.ending !== undefined && rec.ending !== '';
  const hasBook = rec.book !== null && rec.book !== undefined && rec.book !== '';
  const adjBank = hasEnd ? r2(+rec.ending + dit - oc) : null;
  const adjBook = hasBook ? r2(+rec.book + credits - debits) : null;
  const diff = adjBank !== null && adjBook !== null ? r2(adjBank - adjBook) : null;
  const recPill = diff === null ? '<span class="pill p-stock">Not yet reconciled</span>' : Math.abs(diff) < 0.005 ? '<span class="pill p-done">Agrees</span>' : `<span class="pill p-flag">Difference ₱${money(diff)}</span>`;
  const nFound = list.filter((x) => rec.found[x.key]).length;
  const acc = (key, n, title, sub, inner, extra = '') => `<details class="panel cd-acc" data-acc="${key}" ${OPEN[key] ? 'open' : ''}><summary><span class="cd-num">${n}</span><b>${title}</b><span class="cd-sub">${sub}</span>${extra}</summary><div class="cd-body">${inner}</div></details>`;
  const dis = enc ? '' : 'disabled';
  const unmatched = (rec.lines || []).filter((l) => !l.matched && !l.added);

  const stBody = `${enc ? `<div class="cd-pick"><button class="btn primary" type="button" id="bk-import">Import Soft Copy (Excel / CSV)</button><span class="af-note">or, for a PDF or printed copy, tick each item in part 2 and type the balance below.</span></div>` : ''}
    <div class="cd-g4">
      <div class="field"><label for="bk-date">Statement Date</label><input class="input" type="date" id="bk-date" value="${esc(rec.asOf || asOf)}" ${dis}></div>
      <div class="field"><label for="bk-end">Ending Balance per Bank (₱)</label><input class="input r" id="bk-end" inputmode="decimal" value="${hasEnd ? esc(money(rec.ending)) : ''}" ${dis}></div>
      <div class="field"><label for="bk-src">Source</label><select class="input" id="bk-src" ${dis}>${SOURCES.map((s) => `<option ${s === rec.source ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
      ${enc ? '<div class="field"><span class="cd-lbl">&nbsp;</span><button class="btn primary" type="button" id="bk-savest">Save Statement</button></div>' : ''}
    </div>
    ${unmatched.length ? `<div class="cd-block"><h3 class="cer-h3">Imported lines not matched (${unmatched.length})</h3>
      <div class="af-tbl"><table class="af-reg"><thead><tr><th scope="col">Date</th><th scope="col">Description</th><th scope="col" class="r">Debit (₱)</th><th scope="col" class="r">Credit (₱)</th><th scope="col" class="r"></th></tr></thead>
      <tbody>${unmatched.map((l) => `<tr><td>${esc(fmtDate(l.date))}</td><td>${esc(l.desc)}</td><td class="r">${l.debit ? money(l.debit) : ''}</td><td class="r">${l.credit ? money(l.credit) : ''}</td>
        <td class="r">${enc ? `<button class="btn sm" type="button" data-addline="${esc(l.i)}">Add as bank ${l.credit ? 'credit' : 'debit'}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
      <p class="af-note">Lines in the bank with no deposit or check in the books. Add the bank's own items (interest, service charges); the rest are for the auditor to look into.</p></div>` : ''}
    <div class="cd-block"><h3 class="cer-h3">Bank-only items (in the bank, not in the books)</h3>
      ${enc ? `<div class="cd-entry bk-entry">
        <div class="field"><label for="bi-date">Date</label><input class="input" type="date" id="bi-date"></div>
        <div class="field"><label for="bi-type">Type</label><select class="input" id="bi-type"><option value="credit">Bank credit (e.g. interest)</option><option value="debit">Bank debit (e.g. service charge)</option></select></div>
        <div class="field"><label for="bi-part">Particulars</label><input class="input" id="bi-part" autocomplete="off"></div>
        <div class="field"><label for="bi-amt">Amount (₱)</label><input class="input r" id="bi-amt" inputmode="decimal" autocomplete="off"></div>
        <button class="btn primary" type="button" id="bi-enter">Enter</button></div>` : ''}
      ${(rec.bankItems || []).length ? `<div class="af-tbl"><table class="af-reg"><thead><tr><th scope="col">Date</th><th scope="col">Type</th><th scope="col">Particulars</th><th scope="col" class="r">Amount (₱)</th><th scope="col" class="r"></th></tr></thead>
        <tbody>${rec.bankItems.map((b, i) => `<tr><td>${esc(fmtDate(b.date))}</td><td><span class="pill ${b.type === 'credit' ? 'p-done' : 'p-flag'}">Bank ${b.type}</span></td><td>${esc(b.particulars || '')}</td><td class="r">${money(b.amount)}</td>
          <td class="r">${enc ? `<button class="btn sm" type="button" data-rmbi="${i}" aria-label="Remove ${esc(b.particulars || 'item')}">Remove</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="af-note">None yet.</p>'}</div>`;

  const dcBody = `${list.length ? `<div class="af-tbl"><table class="af-reg bk-items"><thead><tr><th scope="col">In Bank</th><th scope="col">Type</th><th scope="col">Date (Books)</th><th scope="col">Reference</th><th scope="col">From</th><th scope="col" class="r">Amount (₱)</th><th scope="col">Date (Bank)</th><th scope="col">Result</th><th scope="col"></th></tr></thead>
      <tbody>${list.map((x) => { const bd = rec.found[x.key] || ''; const rs = result(x); return `<tr data-key="${esc(x.key)}"><td><input type="checkbox" class="bk-chk" ${bd ? 'checked' : ''} ${dis} aria-label="In bank: ${esc(x.ref || x.kind)}"></td>
        <td>${x.kind === 'dep' ? 'Deposit' : 'Check'}</td><td>${esc(fmtDate(x.date))}</td><td class="mono">${esc(x.ref)}</td><td>${esc(x.from)}</td><td class="r">${money(x.amount)}</td>
        <td><input class="input af-sm bk-bd" type="date" value="${esc(bd)}" ${dis} aria-label="Date in the bank"></td><td><span class="pill ${rs[0]}">${rs[1]}</span></td>
        <td class="r">${enc && x.other ? `<button class="btn sm" type="button" data-rmoth="${esc(x.other.id)}" aria-label="Remove check ${esc(x.ref)}">Remove</button>` : ''}</td></tr>`; }).join('')}</tbody></table></div>`
      : `<div class="empty"><b>No deposit or check of ${esc(acct.fund)} up to ${esc(fmtDate(asOf))}.</b>Deposits come from Collections &amp; Deposits; checks from Cash Advances.</div>`}
    <div class="cd-actions">${enc ? '<button class="btn" type="button" id="bk-addchk">+ Other Check</button><button class="btn primary" type="button" id="bk-savefound">Save</button>' : ''}</div>
    <p class="af-note">Tick each item found in the bank and type the bank date (ticking fills in the book date). Deposits come from Collections &amp; Deposits (${esc(acct.fund)}); checks from Cash Advances. A check that is not a cash advance can be typed here until the disbursements are encoded in Records Management.</p>`;

  const rcBody = `<div class="cd-g2">
      <div class="cd-sum bk-rc"><b class="cd-sumh">Per Bank</b>
        <div><span>Balance per bank statement</span><span>${hasEnd ? money(rec.ending) : '—'}</span></div>
        <div><span>Add: Deposits in transit</span><span>${money(dit)}</span></div>
        <div><span>Less: Outstanding checks</span><span>(${money(oc)})</span></div>
        <div class="cd-sumt"><span>Adjusted bank balance</span><span>${adjBank === null ? '—' : money(adjBank)}</span></div></div>
      <div class="cd-sum bk-rc"><b class="cd-sumh">Per Books</b>
        <div class="bk-book"><label for="bk-book">Balance per cashbook</label><input class="input r" id="bk-book" inputmode="decimal" value="${hasBook ? esc(money(rec.book)) : ''}" ${dis}></div>
        <div><span>Add: Bank credits not in the books</span><span>${money(credits)}</span></div>
        <div><span>Less: Bank debits not in the books</span><span>(${money(debits)})</span></div>
        <div class="cd-sumt"><span>Adjusted book balance</span><span>${adjBook === null ? '—' : money(adjBook)}</span></div></div>
    </div>
    <div class="cd-actions"><span class="af-note" style="margin-right:auto">The two adjusted balances must agree; a difference is flagged for the auditor. The book balance is typed from the cashbook / accounting records.</span>
      <button class="btn" type="button" id="bk-xls">Export to Excel</button>${enc ? '<button class="btn primary" type="button" id="bk-saverc">Save Reconciliation</button>' : ''}</div>`;

  const body = hello(btnAccts) + top + `
    <div class="stats">
      <div class="stat"><span>Balance per Bank</span><b>${hasEnd ? '₱ ' + money(rec.ending) : '—'}</b><small>as of ${esc(fmtDate(rec.asOf || asOf))}</small></div>
      <div class="stat"><span>Deposits in Transit</span><b style="color:#1d4fb8">₱ ${money(dit)}</b><small>${list.filter((x) => x.kind === 'dep' && !rec.found[x.key]).length} not yet in the bank</small></div>
      <div class="stat"><span>Outstanding Checks</span><b style="color:#1d4fb8">₱ ${money(oc)}</b><small>${list.filter((x) => x.kind === 'chk' && !rec.found[x.key]).length} not yet cleared</small></div>
      <div class="stat"><span>Reconciliation</span><b>${diff === null ? '—' : Math.abs(diff) < 0.005 ? '<span style="color:var(--ok)">Agrees</span>' : `<span class="warn">₱ ${money(diff)}</span>`}</b><small>${diff === null ? 'type the bank and book balances' : 'adjusted bank − adjusted book'}</small></div>
    </div>
    ${acc('st', 1, 'Bank Statement', esc(`${acct.fund} · ${rec.source || ''}${(rec.lines || []).length ? ` · ${rec.lines.length} lines imported` : ''}`), stBody)}
    ${acc('dc', 2, 'Deposits and Checks', `${nFound} of ${list.length} found in the bank`, dcBody)}
    ${acc('rc', 3, 'Bank Reconciliation', esc(`${acct.fund} · as of ${fmtDate(rec.asOf || asOf)}`), rcBody, recPill)}`;

  const ctxw = { refs, audit, acct, recId, rec, rec0, list, asOf, enc, accounts, funds, credits, debits, dit, oc, adjBank, adjBook, diff };
  return { crumb, body, wire: () => { wireTop(); wireBanks(ctxw); } };
}
const acctLabel = (x) => `${x.bank || 'Bank'} · ${x.accountNo || '—'} · ${x.fund}`;

function wireBanks(c) {
  const { refs, audit, acct, recId, rec, list, enc } = c;
  $$('details.cd-acc').forEach((d) => { d.ontoggle = () => { OPEN[d.dataset.acc] = d.open; }; });
  $('#bk-xls').onclick = () => exportXlsx(`Bank Reconciliation ${acct.accountNo || acct.fund} ${c.asOf}.xlsx`, 'Bank Reconciliation', [
    ...list.map((x) => ({ Item: x.kind === 'dep' ? 'Deposit' : 'Check', 'Date (Books)': fmtDate(x.date), Reference: x.ref, From: x.from, Amount: x.amount, 'Date (Bank)': fmtDate(rec.found[x.key] || ''), Result: rec.found[x.key] ? (x.kind === 'dep' ? 'In the bank' : 'Cleared') : (x.kind === 'dep' ? 'Deposit in transit' : 'Outstanding check') })),
    ...(rec.bankItems || []).map((b) => ({ Item: b.type === 'credit' ? 'Bank credit' : 'Bank debit', 'Date (Books)': '', Reference: '', From: b.particulars || '', Amount: b.amount, 'Date (Bank)': fmtDate(b.date), Result: 'Not in the books' })),
    {}, { Item: 'Balance per bank', Amount: rec.ending ?? '' }, { Item: 'Add: Deposits in transit', Amount: c.dit }, { Item: 'Less: Outstanding checks', Amount: c.oc }, { Item: 'Adjusted bank balance', Amount: c.adjBank ?? '' },
    { Item: 'Balance per cashbook', Amount: rec.book ?? '' }, { Item: 'Add: Bank credits', Amount: c.credits }, { Item: 'Less: Bank debits', Amount: c.debits }, { Item: 'Adjusted book balance', Amount: c.adjBook ?? '' },
    { Item: 'Difference', Amount: c.diff ?? '' }]);
  if (!enc) return;
  const save = async (patch, msg) => {
    const cur = c.rec0 ? strip(c.rec0) : { auditId: audit.id, accountId: acct.id, lguId: audit.lguId, asOf: rec.asOf, ending: rec.ending, source: rec.source, book: rec.book, bankItems: [], found: {}, otherChecks: [], lines: [] };
    await store.save('cer_bankrec', recId, { ...cur, ...patch }, by(refs));
    if (msg) toast(msg, 'ok');
  };
  $('#bk-savest').onclick = () => {
    const end = $('#bk-end').value.trim();
    if (!$('#bk-date').value) return bad('Enter the statement date.');
    save({ asOf: $('#bk-date').value, ending: end ? num(end) : null, source: $('#bk-src').value }, 'Statement saved.');
  };
  $('#bk-saverc').onclick = () => { const v = $('#bk-book').value.trim(); save({ book: v ? num(v) : null }, 'Reconciliation saved.'); };
  ['#bk-end', '#bk-book', '#bi-amt'].forEach((s) => { const el = $(s); if (el) el.onblur = () => { const v = num(el.value); if (v !== null) el.value = money(v); }; });
  $('#bi-enter').onclick = () => {
    const v = { date: $('#bi-date').value, type: $('#bi-type').value, particulars: $('#bi-part').value.trim(), amount: num($('#bi-amt').value) };
    if (!v.date) return bad('Enter the date.');
    if (!v.amount || v.amount <= 0) return bad('Enter the amount.');
    save({ bankItems: [...(rec.bankItems || []), v].sort((a, b) => a.date.localeCompare(b.date)) }, 'Bank item saved.');
  };
  $$('[data-rmbi]').forEach((b) => { b.onclick = () => { const l = [...rec.bankItems]; l.splice(+b.dataset.rmbi, 1); save({ bankItems: l }, 'Removed.'); }; });
  $$('[data-addline]').forEach((b) => { b.onclick = () => {
    const lines = (rec.lines || []).map((l) => ({ ...l })); const l = lines.find((x) => String(x.i) === b.dataset.addline); if (!l) return;
    l.added = true;
    save({ lines, bankItems: [...(rec.bankItems || []), { date: l.date, type: l.credit ? 'credit' : 'debit', particulars: l.desc, amount: l.credit || l.debit }] }, 'Added as a bank-only item.');
  }; });
  // Ticking a row fills in the bank date with the book date (changed when the bank shows another date).
  $$('tr[data-key]').forEach((tr) => {
    const ck = $('.bk-chk', tr), bd = $('.bk-bd', tr), x = list.find((y) => y.key === tr.dataset.key);
    ck.onchange = () => { if (ck.checked && !bd.value) bd.value = x.date; if (!ck.checked) bd.value = ''; };
    bd.onchange = () => { ck.checked = !!bd.value; };
  });
  $('#bk-savefound').onclick = () => {
    const found = { ...(rec.found || {}) };
    $$('tr[data-key]').forEach((tr) => { const k = tr.dataset.key; const bd = $('.bk-bd', tr).value; if ($('.bk-chk', tr).checked && bd) found[k] = bd; else delete found[k]; });
    save({ found }, 'Saved.');
  };
  $$('[data-rmoth]').forEach((b) => { b.onclick = () => save({ otherChecks: (rec.otherChecks || []).filter((x) => x.id !== b.dataset.rmoth) }, 'Check removed.'); });
  $('#bk-addchk').onclick = async () => {
    let out = null;
    await modal({ title: '+ Other Check', body: `<p class="hint" style="margin:0">A check of ${esc(acct.fund)} that is not a cash advance (e.g. payment to a supplier).</p>
      <div class="cd-g2"><div class="field"><label for="oc-date">Date</label><input class="input" type="date" id="oc-date"></div>
      <div class="field"><label for="oc-no">Check No.</label><input class="input mono" id="oc-no"></div>
      <div class="field"><label for="oc-payee">Payee</label><input class="input" id="oc-payee"></div>
      <div class="field"><label for="oc-amt">Amount (₱)</label><input class="input r" id="oc-amt" inputmode="decimal"></div></div>`,
      buttons: [{ label: 'Cancel', value: null }, { label: 'Add Check', cls: 'primary', value: 'ok', check: (bg) => {
        const v = { id: newId('oc'), date: $('#oc-date', bg).value, checkNo: $('#oc-no', bg).value.trim(), payee: $('#oc-payee', bg).value.trim(), amount: num($('#oc-amt', bg).value) };
        if (!v.date) return bad('Enter the date.'); if (!v.checkNo) return bad('Enter the check No.'); if (!v.amount || v.amount <= 0) return bad('Enter the amount.');
        out = v; return true; } }] });
    if (out) save({ otherChecks: [...(rec.otherChecks || []), out] }, `Check No. ${out.checkNo} added.`);
  };
  $('#bk-import').onclick = () => importStatement(c, save);
}

/* ---------- import a soft copy ---------- */
async function importStatement(c, save) {
  const { rec, list } = c;
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.xlsx,.xls,.csv';
  inp.onchange = async () => {
    const file = inp.files[0]; if (!file) return;
    try {
      const XLSX = await loadXlsx();
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
      const lines = readLines(XLSX, rows);
      if (!lines.length) return bad('No bank lines found. The sheet needs a Date column and Debit / Credit (or Amount) columns.');
      // Match: deposits to credits and checks to debits of the same amount, nearest date (bank on or after the book date: within 15 days for a deposit, a year for a check); a check No. in the description wins.
      const found = { ...(rec.found || {}) };
      const used = new Set();
      const tryMatch = (x, pick) => {
        if (found[x.key]) return;
        const cands = lines.filter((l) => !used.has(l.i) && Math.abs((x.kind === 'dep' ? l.credit : l.debit) - x.amount) < 0.005 && l.date && (!x.date || (days(x.date, l.date) >= -1 && days(x.date, l.date) <= (x.kind === 'dep' ? 15 : 366))));
        const l = pick(cands, x); if (!l) return;
        used.add(l.i); found[x.key] = l.date;
      };
      list.filter((x) => x.kind === 'chk').forEach((x) => tryMatch(x, (cs) => cs.find((l) => x.ref && l.desc.includes(String(x.ref))) || cs.sort((a, b) => Math.abs(days(x.date, a.date)) - Math.abs(days(x.date, b.date)))[0]));
      list.filter((x) => x.kind === 'dep').forEach((x) => tryMatch(x, (cs) => cs.sort((a, b) => Math.abs(days(x.date, a.date)) - Math.abs(days(x.date, b.date)))[0]));
      lines.forEach((l) => { l.matched = used.has(l.i); });
      const last = lines.filter((l) => l.bal !== null).pop();
      const patch = { found, lines, source: 'Soft copy (imported)' };
      if (last) { patch.ending = last.bal; patch.asOf = last.date || rec.asOf; }
      await save(patch, `${lines.length} lines imported · ${used.size} matched${last ? ' · ending balance read' : ''}.`);
    } catch (e) { bad(e.message || String(e)); }
  };
  inp.click();
}
function readLines(XLSX, rows) {
  const find = (h, re) => h.findIndex((x) => re.test(String(x)));
  let hr = -1, col = {};
  for (let r = 0; r < Math.min(rows.length, 25); r++) {
    const h = rows[r].map((x) => String(x).trim());
    const d = find(h, /date/i);
    if (d < 0) continue;
    col = { date: d, desc: find(h, /desc|particular|detail|remark|transaction|reference|check/i), debit: find(h, /debit|withdraw|dr\b/i), credit: find(h, /credit|deposit|cr\b/i), amt: find(h, /^amount$/i), bal: find(h, /balance/i) };
    if (col.debit >= 0 || col.credit >= 0 || col.amt >= 0) { hr = r; break; }
  }
  if (hr < 0) return [];
  const toDate = (v) => {
    if (v instanceof Date) return new Date(v.getTime() - v.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
    if (typeof v === 'number') { const p = XLSX.SSF.parse_date_code(v); return p ? `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}` : ''; }
    const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(String(v).trim()); if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
    const t = Date.parse(v); return isNaN(t) ? '' : new Date(t).toISOString().slice(0, 10);
  };
  const n = (v) => { const x = num(v); return x === null ? 0 : x; };
  return rows.slice(hr + 1).map((row, i) => {
    const date = toDate(row[col.date]); if (!date) return null;
    let debit = col.debit >= 0 ? Math.abs(n(row[col.debit])) : 0, credit = col.credit >= 0 ? Math.abs(n(row[col.credit])) : 0;
    if (col.amt >= 0 && !debit && !credit) { const a = n(row[col.amt]); if (a < 0) debit = -a; else credit = a; }
    if (!debit && !credit) return null;
    return { i, date, desc: col.desc >= 0 ? String(row[col.desc] ?? '').trim() : '', debit: r2(debit), credit: r2(credit), bal: col.bal >= 0 && String(row[col.bal]).trim() !== '' ? num(row[col.bal]) : null };
  }).filter(Boolean);
}
let xlsxReady = null;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!xlsxReady) xlsxReady = new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'lib/xlsx.full.min.js'; sc.onload = () => res(window.XLSX); sc.onerror = () => { xlsxReady = null; rej(new Error('The Excel reader could not load. Check the internet connection and try again.')); }; document.head.appendChild(sc); });
  return xlsxReady;
}

/* ---------- bank accounts of the auditee ---------- */
async function accountsModal(refs, lguId, accounts, funds, enc) {
  const list = accounts.map((x) => ({ ...x }));
  const v = await modal({ title: `Bank Accounts · ${agencyName(refs, refs.lgu[lguId])}`, wide: true,
    body: `<p class="hint" style="margin:0">Each bank account of the auditee and its fund. Barangays usually have one account per fund; the LGU may have several.</p>
      <div class="af-tbl"><table class="af-reg cd-edit"><thead><tr><th scope="col">Bank</th><th scope="col">Account No.</th><th scope="col">Fund</th><th scope="col"></th></tr></thead><tbody id="ba-rows"></tbody></table></div>
      ${enc ? '<button class="btn sm" type="button" id="ba-add">+ Add Account</button>' : ''}`,
    onOpen: (bg) => {
      const draw = () => {
        $('#ba-rows', bg).innerHTML = list.map((x, i) => `<tr data-i="${i}"><td><input class="input" data-k="bank" value="${esc(x.bank || '')}" placeholder="e.g. Land Bank, Maddela" aria-label="Bank" ${enc ? '' : 'disabled'}></td>
          <td><input class="input mono" data-k="accountNo" value="${esc(x.accountNo || '')}" aria-label="Account No." ${enc ? '' : 'disabled'}></td>
          <td><select class="input" data-k="fund" aria-label="Fund" ${enc ? '' : 'disabled'}>${funds.map((f) => `<option ${f === x.fund ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></td>
          <td>${enc ? '<button class="btn sm cd-x" type="button" aria-label="Remove account">✕</button>' : ''}</td></tr>`).join('');
        $$('tr[data-i]', bg).forEach((tr) => {
          $$('[data-k]', tr).forEach((el) => { el.oninput = el.onchange = () => { list[+tr.dataset.i][el.dataset.k] = el.value; }; });
          const x = $('.cd-x', tr); if (x) x.onclick = () => { list.splice(+tr.dataset.i, 1); draw(); };
        });
      };
      draw();
      const add = $('#ba-add', bg); if (add) add.onclick = () => { list.push({ id: newId('ba'), bank: '', accountNo: '', fund: funds[0] }); draw(); };
      if (!list.length && add) add.click();
    },
    buttons: enc ? [{ label: 'Cancel', value: null }, { label: 'Save Accounts', cls: 'primary', value: 'save' }] : [{ label: 'Close', cls: 'primary', value: null }] });
  if (v !== 'save') return;
  const clean = list.filter((x) => x.bank || x.accountNo).map((x) => ({ id: x.id || newId('ba'), bank: String(x.bank || '').trim(), accountNo: String(x.accountNo || '').trim(), fund: x.fund || funds[0] }));
  await store.save('cer_settings', 'banks|' + lguId, { list: clean }, by(refs));
  toast('Bank accounts saved.', 'ok');
}
