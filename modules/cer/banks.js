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
//                  found{ <item key>: bankDate }, otherChecks[{ id, date, checkNo, payee, amount }], lines[] (imported, for reference),
//                  opening (bank balance at the last cash exam), account (account No. read from it), covFrom / covTo (coverage imported),
//                  lineOf{ <item key>: line i } (which imported line each item matched; unmatched lines count as bank credits / debits) }
import { store, newId } from '../../js/store.js';
import { esc, modal, toast, $, $$ } from '../../js/ui.js';
import { hasRole, by, mayView, agencyName, fmtDate, money, num } from './cer.js';
import { exportXlsx } from './forms.js';
import { repName } from './collections.js';

const DEFAULT_FUNDS = ['General Fund', 'Special Education Fund', 'Trust Fund'];
const canEncode = (refs) => hasRole(refs, 'staff', 'member', 'atl', 'sa', 'admin');
const r2 = (n) => Math.round(n * 100) / 100;
const flat = (r) => ({ id: r.id, ...r.data });
const strip = (x) => { const { id, ...rest } = x; return rest; };
const bad = (m) => { toast(m, 'bad'); return false; };
const nextDay = (d) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const go = (params) => { const q = new URLSearchParams(location.hash.split('?')[1] || ''); Object.entries(params).forEach(([k, v]) => (v ? q.set(k, v) : q.delete(k))); location.hash = location.hash.split('?')[0] + '?' + q.toString(); };
const OPEN = { st: true, dc: false, rc: false };   // which tab is shown; 1 Bank Statement when the screen is opened
export const resetTabs = () => { OPEN.st = true; OPEN.dc = false; OPEN.rc = false; };
const UI = { manual: false, edit: false, only: false };   // manual statement fields shown · part 2 in tick mode · part 1 lines not in the books only
const SOURCES = ['Soft copy (imported)', 'PDF', 'Printed', 'Bank confirmation'];

export async function banksView(ctx) {
  const { refs, q } = ctx;
  const [audits0, settings0, reports0, advs0, recs0, officers0, exams0] = await Promise.all(['cer_audits', 'cer_settings', 'cer_reports', 'cer_cashadv', 'cer_bankrec', 'cer_officers', 'cer_exams'].map((t) => store.list(t)));
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
  const asOf = audit.countDate;   // always the cash count date
  // Coverage of the cash exam: the day after the last cash exam (earliest among its officers) up to the cash count date.
  const lastDates = exams0.map(flat).filter((e) => e.auditId === audit.id && e.lastExamDate).map((e) => e.lastExamDate).sort();
  const cov = { from: lastDates[0] || '', to: audit.countDate };
  const top = (open = false) => `<div class="panel ${open ? 'cd-head' : 'cd-bar'} bk-bar">${open ? '<div class="cd-headrow">' : ''}
      <div class="field"><label for="bk-audit">Cash Examination</label><select class="input" id="bk-audit">${audits.map((a) => `<option value="${esc(a.id)}" ${a.id === audit.id ? 'selected' : ''}>${esc(agencyName(refs, refs.lgu[a.lguId]))} · ${esc(fmtDate(a.countDate))}</option>`).join('')}</select></div>
      <div class="field"><label for="bk-acct">Bank Account</label><select class="input" id="bk-acct">${accounts.length ? accounts.map((x) => `<option value="${esc(x.id)}" ${acct && x.id === acct.id ? 'selected' : ''}>${esc(acctLabel(x))}</option>`).join('') : '<option value="">No bank account yet</option>'}</select></div>
      </div>`;
  const btnAccts = `<div class="btn-row"><button class="btn" type="button" id="bk-accts">Bank Accounts (${accounts.length})</button></div>`;
  const wireTop = () => {
    $('#bk-audit').onchange = (e) => go({ a: e.target.value, acct: '' });
    $('#bk-acct').onchange = (e) => go({ acct: e.target.value });
    $('#bk-accts').onclick = () => accountsModal(refs, audit.lguId, accounts, funds, enc);
  };
  if (!acct) return { crumb, body: hello(btnAccts) + top() + `<div class="panel"><div class="empty"><b>No bank account for ${esc(agencyName(refs, lgu))} yet.</b>${enc ? 'Add the accounts with <b>Bank Accounts</b> (bank, account No. and fund).' : ''}</div></div>`, wire: wireTop };

  // Items in the books for this account, up to the statement date.
  const officers = officers0.map(flat);
  const otherAccts = accounts.filter((x) => x.id !== acct.id).map((x) => `${audit.id}|${x.id}`);
  const foundElsewhere = new Set(recs0.map(flat).filter((r) => otherAccts.includes(r.id)).flatMap((r) => Object.keys(r.found || {})));
  const items = [];
  reports0.map(flat).filter((r) => r.lguId === audit.lguId && r.fund === acct.fund && r.kind !== 'SCR').forEach((r) => (r.deposits || []).forEach((d) => {
    const key = `dep|${r.id}|${d.date}|${d.ref}|${d.amount}`;
    items.push({ key, kind: 'dep', date: d.date, ref: d.ref || '', amount: +d.amount || 0,
      from: `${r.pending ? 'Not yet reported' : repName(r)} · ${officers.find((o) => o.id === r.officerId)?.name || ''}` });
  }));
  advs0.map(flat).filter((a) => a.lguId === audit.lguId && !a.beg).forEach((a) => items.push({ key: `chk|${a.id}`, kind: 'chk', date: a.date, ref: a.checkNo, amount: +a.amount || 0,
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
  // Bank-only items: the imported lines not matched to a deposit or check in the books, by their side
  // (credit → bank credit, debit → bank debit), plus any typed by hand (statements not imported).
  const linked = new Set(Object.entries(rec.lineOf || {}).filter(([k]) => rec.found[k]).map(([, i]) => i));
  const unmatched = (rec.lines || []).filter((l) => !(rec.lineOf ? linked.has(l.i) : l.matched) && !l.added && l.date <= asOf);
  const bItems = (rec.bankItems || []).filter((b) => !b.date || b.date <= asOf);
  const sum = (a, f) => r2(a.reduce((n, x) => n + (+f(x) || 0), 0));
  const unCr = sum(unmatched, (l) => l.credit), unDr = sum(unmatched, (l) => l.debit);
  const credits = r2(unCr + sum(bItems.filter((b) => b.type === 'credit'), (b) => b.amount));
  const debits = r2(unDr + sum(bItems.filter((b) => b.type === 'debit'), (b) => b.amount));
  const hasEnd = rec.ending !== null && rec.ending !== undefined && rec.ending !== '';
  const hasBook = rec.book !== null && rec.book !== undefined && rec.book !== '';
  const adjBank = hasEnd ? r2(+rec.ending + dit - oc) : null;
  const adjBook = hasBook ? r2(+rec.book + credits - debits) : null;
  const diff = adjBank !== null && adjBook !== null ? r2(adjBank - adjBook) : null;
  const recPill = diff === null ? '<span class="pill p-stock">Not yet reconciled</span>' : Math.abs(diff) < 0.005 ? '<span class="pill p-done">Agrees</span>' : `<span class="pill p-flag">Difference ₱${money(diff)}</span>`;
  const nFound = list.filter((x) => rec.found[x.key]).length;
  // Beginning + credits − debits = ending, from the imported lines (the coverage of the cash exam).
  const lns = rec.lines || [];
  const proof = lns.length && rec.opening !== null && rec.opening !== undefined ? (() => {
    const cr = r2(lns.reduce((n, l) => n + (l.credit || 0), 0)), dr = r2(lns.reduce((n, l) => n + (l.debit || 0), 0));
    const last = lns.filter((l) => l.bal !== null && l.bal !== undefined).pop(), endB = last ? last.bal : rec.ending;
    const d = endB === null || endB === undefined ? null : r2(+rec.opening + cr - dr - endB);
    return `<div class="bk-proof"><span>Beginning${rec.covFrom ? ` (${esc(fmtDate(rec.covFrom))})` : ''} <b>₱ ${money(rec.opening)}</b></span><span>+ Credits <b>₱ ${money(cr)}</b></span><span>− Debits <b>₱ ${money(dr)}</b></span><span>= Ending${rec.covTo ? ` (${esc(fmtDate(rec.covTo))})` : ''} <b>₱ ${money(r2(+rec.opening + cr - dr))}</b></span>
      ${d === null ? '' : Math.abs(d) < 0.005 ? '<span class="pill p-done">Adds up to the ending balance</span>' : `<span class="pill p-flag">Differs from the ending balance by ₱${money(d)}</span>`}${rec.account ? `<span class="dim">Account No. ${esc(rec.account)}</span>` : ''}</div>`;
  })() : '';
  const dis = enc ? '' : 'disabled';
  const imported = !!lns.length;
  const manual = !imported || UI.manual;
  // Which book item each imported line matched (shown in the "In the books" column).
  const byLine = {};
  Object.entries(rec.lineOf || {}).forEach(([k, i]) => { const x = list.find((y) => y.key === k); if (x && rec.found[k]) byLine[i] = x; });

  // ---- 1 Bank Statement: the statement as it is (its own columns), within the coverage of the cash exam ----
  const heads = rec.heads && rec.heads.length ? rec.heads : ['Date', 'Description', 'Debit', 'Credit', 'Balance', 'Cheque Number'];
  const cellsOf = (l) => l.cells || [fmtDate(l.date), l.desc, l.debit ? money(l.debit) : '', l.credit ? money(l.credit) : '', l.bal !== null && l.bal !== undefined ? money(l.bal) : '', l.chq || ''];
  const numCol = (h) => /debit|credit|balance|amount|withdraw|deposit/i.test(h);
  const inBooks = (l) => { const x = byLine[l.i]; if (x) return `<span class="pill p-done">${x.kind === 'dep' ? 'Deposit' : 'Check'} ${esc(x.ref)}</span>`;
    if (!rec.lineOf && l.matched) return '<span class="pill p-done">Matched</span>';
    return `<span class="pill p-flag">Not in the books</span>${l.note ? `<div class="bk-note">⚠ ${esc(l.note)}</div>` : ''}`; };
  const shown = lns.filter((l) => l.date <= asOf).filter((l) => !UI.only || unmatched.includes(l));
  const stmtTbl = imported ? `<div class="bk-tools"><span class="dim">${lns.length} line${lns.length === 1 ? '' : 's'} from ${esc(fmtDate(rec.covFrom ? nextDay(rec.covFrom) : lns[0].date))} to ${esc(fmtDate(rec.covTo || asOf))} · ${lns.length - unmatched.length} found in the books · ${unmatched.length} not in the books</span>
        <label class="cer-chip"><input type="checkbox" id="bk-only" ${UI.only ? 'checked' : ''}> Not in the books only</label></div>
      <div class="af-tbl bk-stmtwrap"><table class="af-reg bk-stmt"><thead><tr>${heads.map((h) => `<th scope="col"${numCol(h) ? ' class="r"' : ''}>${esc(h)}</th>`).join('')}<th scope="col">In the books</th></tr></thead>
      <tbody>${!UI.only && rec.opening !== null && rec.opening !== undefined ? `<tr class="bk-open">${heads.map((h, k) => `<td${numCol(h) ? ' class="r"' : ''}>${/balance/i.test(h) ? `<b>${money(rec.opening)}</b>` : k === 1 ? '<b>Beginning balance</b>' : ''}</td>`).join('')}<td class="dim">as of the last cash exam</td></tr>` : ''}
        ${shown.map((l) => `<tr${unmatched.includes(l) ? ' class="bk-unrow"' : ''}>${cellsOf(l).map((v, k) => `<td${numCol(heads[k] || '') ? ' class="r"' : /cheque|check/i.test(heads[k] || '') ? ' class="mono"' : ''}>${esc(v)}</td>`).join('')}<td>${inBooks(l)}</td></tr>`).join('')}</tbody></table></div>
      <p class="af-note">The statement as the bank gives it, from the day after the last cash exam to the cash count. Lines not in the books count in the reconciliation as they are: credits as bank credits, debits as bank debits. Interest and service charges are expected; anything else is for the auditor to look into (a deposit or check not yet encoded matches on the next import).</p>` : '';
  const manualBox = `<div class="cd-g4">
      <div class="field"><label for="bk-date">Statement Date</label><input class="input" type="date" id="bk-date" value="${esc(rec.asOf || asOf)}" ${dis}></div>
      <div class="field"><label for="bk-end">Ending Balance per Bank (₱)</label><input class="input r" id="bk-end" inputmode="decimal" value="${hasEnd ? esc(money(rec.ending)) : ''}" ${dis}></div>
      <div class="field"><label for="bk-src">Source</label><select class="input" id="bk-src" ${dis}>${SOURCES.filter((x) => x !== SOURCES[0]).map((x) => `<option ${x === rec.source ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
      ${enc ? '<div class="field"><span class="cd-lbl">&nbsp;</span><button class="btn primary" type="button" id="bk-savest">Save Statement</button></div>' : ''}
    </div>
    <div class="cd-block"><h3 class="cer-h3">Bank's own items (interest, service charges)</h3>
      ${enc ? `<div class="cd-entry bk-entry">
        <div class="field"><label for="bi-date">Date</label><input class="input" type="date" id="bi-date"></div>
        <div class="field"><label for="bi-type">Type</label><select class="input" id="bi-type"><option value="credit">Bank credit (e.g. interest)</option><option value="debit">Bank debit (e.g. service charge)</option></select></div>
        <div class="field"><label for="bi-part">Particulars</label><input class="input" id="bi-part" autocomplete="off"></div>
        <div class="field"><label for="bi-amt">Amount (₱)</label><input class="input r" id="bi-amt" inputmode="decimal" autocomplete="off"></div>
        <button class="btn primary" type="button" id="bi-enter">Enter</button></div>` : ''}
      ${(rec.bankItems || []).length ? `<div class="af-tbl"><table class="af-reg"><thead><tr><th scope="col">Date</th><th scope="col">Type</th><th scope="col">Particulars</th><th scope="col" class="r">Amount (₱)</th><th scope="col" class="r"></th></tr></thead>
        <tbody>${rec.bankItems.map((b, i) => `<tr><td>${esc(fmtDate(b.date))}</td><td><span class="pill ${b.type === 'credit' ? 'p-done' : 'p-flag'}">Bank ${b.type}</span></td><td>${esc(b.particulars || '')}</td><td class="r">${money(b.amount)}</td>
          <td class="r">${enc ? `<button class="btn sm" type="button" data-rmbi="${i}" aria-label="Remove ${esc(b.particulars || 'item')}">Remove</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="af-note">None yet.</p>'}</div>
    <p class="af-note">Then tick each deposit and check found in the bank in tab 2.</p>`;
  const stBody = `${enc ? `<div class="cd-pick"><button class="btn primary" type="button" id="bk-import">${imported ? 'Import Again' : 'Import Soft Copy (Excel / CSV)'}</button>
        <label class="cer-chip"><input type="checkbox" id="bk-manual" ${manual && !imported ? 'checked disabled' : manual ? 'checked' : ''}> No soft copy (PDF / printed)</label></div>` : ''}
    ${proof}
    ${imported && !manual ? stmtTbl : ''}
    ${manual ? manualBox : ''}
    ${imported && manual ? stmtTbl : ''}`;

  // ---- 2 Deposits and Checks: the results; ticking only for a PDF / printed statement or to correct a match ----
  const tick = manual || UI.edit;
  const dcBody = `${list.length ? `<div class="af-tbl"><table class="af-reg bk-items"><thead><tr>${tick ? '<th scope="col">In Bank</th>' : ''}<th scope="col">Type</th><th scope="col">Date (Books)</th><th scope="col">Reference</th><th scope="col">From</th><th scope="col" class="r">Amount (₱)</th><th scope="col">Date (Bank)</th><th scope="col">Result</th><th scope="col"></th></tr></thead>
      <tbody>${list.map((x) => { const bd = rec.found[x.key] || ''; const rs = result(x); return `<tr data-key="${esc(x.key)}">${tick ? `<td><input type="checkbox" class="bk-chk" ${bd ? 'checked' : ''} ${dis} aria-label="In bank: ${esc(x.ref || x.kind)}"></td>` : ''}
        <td>${x.kind === 'dep' ? 'Deposit' : 'Check'}</td><td>${esc(fmtDate(x.date))}</td><td class="mono">${esc(x.ref)}</td><td>${esc(x.from)}</td><td class="r">${money(x.amount)}</td>
        <td>${tick ? `<input class="input af-sm bk-bd" type="date" value="${esc(bd)}" ${dis} aria-label="Date in the bank">` : esc(fmtDate(bd))}</td><td><span class="pill ${rs[0]}">${rs[1]}</span></td>
        <td class="r">${enc && x.other ? `<button class="btn sm" type="button" data-rmoth="${esc(x.other.id)}" aria-label="Remove check ${esc(x.ref)}">Remove</button>` : ''}</td></tr>`; }).join('')}</tbody></table></div>`
      : `<div class="empty"><b>No deposit or check of ${esc(acct.fund)} up to ${esc(fmtDate(asOf))}.</b>Deposits come from Collections &amp; Deposits; checks from Cash Advances.</div>`}
    <div class="cd-actions">${enc ? `<button class="btn" type="button" id="bk-addchk">+ Other Check</button>${tick ? `${imported ? '<button class="btn" type="button" id="bk-doneedit">Cancel</button>' : ''}<button class="btn primary" type="button" id="bk-savefound">Save</button>` : list.length ? '<button class="btn" type="button" id="bk-edit">Correct a match</button>' : ''}` : ''}</div>
    <p class="af-note">${tick ? 'Tick each item found in the bank and type the bank date (ticking fills in the book date).' : 'Found by the import: deposits matched to credits, checks to debits (by check No., else amount and date).'} Deposits come from Collections &amp; Deposits (${esc(acct.fund)}); checks from Cash Advances. A check that is not a cash advance can be added with + Other Check.</p>`;

  // ---- 3 Bank Reconciliation: the cashbook balance is the one thing to type ----
  const rcBody = `<div class="bk-bookrow">
      <div class="field"><label for="bk-book">Balance per Cashbook (₱)</label><input class="input r" id="bk-book" inputmode="decimal" value="${hasBook ? esc(money(rec.book)) : ''}" ${dis}></div>
      ${enc ? '<button class="btn primary" type="button" id="bk-saverc">Save</button>' : ''}<span class="bk-recres">${recPill}</span></div>
    <div class="cd-g2">
      <div class="cd-sum bk-rc"><b class="cd-sumh">Per Bank</b>
        <div><span>Balance per bank statement</span><span>${hasEnd ? money(rec.ending) : '—'}</span></div>
        <div><span>Add: Deposits in transit</span><span>${money(dit)}</span></div>
        <div><span>Less: Outstanding checks</span><span>(${money(oc)})</span></div>
        <div class="cd-sumt"><span>Adjusted bank balance</span><span>${adjBank === null ? '—' : money(adjBank)}</span></div></div>
      <div class="cd-sum bk-rc"><b class="cd-sumh">Per Books</b>
        <div><span>Balance per cashbook</span><span>${hasBook ? money(rec.book) : '—'}</span></div>
        <div><span>Add: Bank credits not in the books</span><span>${money(credits)}</span></div>
        <div><span>Less: Bank debits not in the books</span><span>(${money(debits)})</span></div>
        <div class="cd-sumt"><span>Adjusted book balance</span><span>${adjBook === null ? '—' : money(adjBook)}</span></div></div>
    </div>
    <div class="cd-actions"><span class="af-note" style="margin-right:auto">The two adjusted balances must agree; a difference is flagged. The cashbook balance is typed from the cashbook / accounting records.</span>
      <button class="btn" type="button" id="bk-xls">Export to Excel</button></div>`;

  const tabs = (lst) => { const on = lst.find(([k]) => OPEN[k])?.[0] || 'st';
    return `<div class="cd-tabs" role="tablist">${lst.map(([k, t, sub], i) => `<button type="button" role="tab" class="cd-tab ${k === on ? 'on' : ''}" data-tab="${k}" aria-selected="${k === on}" aria-controls="cd-pane-${k}"><span class="cd-num">${i + 1}</span><span class="cd-tabt"><b>${t}</b><span class="cd-sub">${sub}</span></span></button>`).join('')}</div></div>
      ${lst.map(([k, , , inner]) => `<section class="panel cd-pane" id="cd-pane-${k}" role="tabpanel" ${k === on ? '' : 'hidden'}><div class="cd-body">${inner}</div></section>`).join('')}`; };
  const figs = `<div class="ca-figs"><span>Balance per Bank <b>${hasEnd ? '₱ ' + money(rec.ending) : '—'}</b><small>as of ${esc(fmtDate(rec.asOf || asOf))}</small></span>
      <span>Deposits in Transit <b>₱ ${money(dit)}</b></span><span>Outstanding Checks <b>₱ ${money(oc)}</b></span>
      <span class="ca-unliq">Reconciliation <b>${diff === null ? '—' : Math.abs(diff) < 0.005 ? '<span style="color:var(--ok)">Agrees</span>' : `<span class="warn">₱ ${money(diff)}</span>`}</b><small>${diff === null ? 'type the cashbook balance (tab 3)' : 'adjusted bank − adjusted book'}</small></span></div>`;
  const body = hello(btnAccts) + top(true) + figs + tabs([
    ['st', 'Bank Statement', esc(imported ? `${lns.length} lines · ${unmatched.length} not in the books` : hasEnd ? `${rec.source || ''} · ending ₱${money(rec.ending)}` : 'Import the soft copy'), stBody],
    ['dc', 'Deposits and Checks', `${nFound} of ${list.length} found in the bank`, dcBody],
    ['rc', 'Reconciliation', diff === null ? 'Type the cashbook balance' : Math.abs(diff) < 0.005 ? 'Agrees' : `Difference ₱${money(diff)}`, rcBody]]);

  const ctxw = { refs, audit, acct, recId, rec, rec0, list, asOf, enc, cov, unmatched, accounts, funds, credits, debits, dit, oc, adjBank, adjBook, diff };
  return { crumb, body, wire: () => { wireTop(); wireBanks(ctxw); } };
}
const acctLabel = (x) => `${x.bank || 'Bank'} · ${x.accountNo || '—'} · ${x.fund}`;

function wireBanks(c) {
  const { refs, audit, acct, recId, rec, list, enc } = c;
  $$('.cd-tab').forEach((t) => { t.onclick = () => {
    Object.keys(OPEN).forEach((k) => { OPEN[k] = k === t.dataset.tab; });
    $$('.cd-tab').forEach((x) => { const on = x === t; x.classList.toggle('on', on); x.setAttribute('aria-selected', String(on)); $('#cd-pane-' + x.dataset.tab).hidden = !on; });
  }; });
  const rr = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
  const only = $('#bk-only'); if (only) only.onchange = () => { UI.only = only.checked; rr(); };
  $('#bk-xls').onclick = () => exportXlsx(`Bank Reconciliation ${acct.accountNo || acct.fund} ${c.asOf}.xlsx`, 'Bank Reconciliation', [
    ...list.map((x) => ({ Item: x.kind === 'dep' ? 'Deposit' : 'Check', 'Date (Books)': fmtDate(x.date), Reference: x.ref, From: x.from, Amount: x.amount, 'Date (Bank)': fmtDate(rec.found[x.key] || ''), Result: rec.found[x.key] ? (x.kind === 'dep' ? 'In the bank' : 'Cleared') : (x.kind === 'dep' ? 'Deposit in transit' : 'Outstanding check') })),
    ...c.unmatched.map((l) => ({ Item: l.credit ? 'Bank credit' : 'Bank debit', 'Date (Books)': '', Reference: l.chq || '', From: l.desc, Amount: l.credit || l.debit, 'Date (Bank)': fmtDate(l.date), Result: 'Not in the books' })),
    ...(rec.bankItems || []).map((b) => ({ Item: b.type === 'credit' ? 'Bank credit' : 'Bank debit', 'Date (Books)': '', Reference: '', From: b.particulars || '', Amount: b.amount, 'Date (Bank)': fmtDate(b.date), Result: 'Not in the books' })),
    {}, { Item: 'Balance per bank', Amount: rec.ending ?? '' }, { Item: 'Add: Deposits in transit', Amount: c.dit }, { Item: 'Less: Outstanding checks', Amount: c.oc }, { Item: 'Adjusted bank balance', Amount: c.adjBank ?? '' },
    { Item: 'Balance per cashbook', Amount: rec.book ?? '' }, { Item: 'Add: Bank credits', Amount: c.credits }, { Item: 'Less: Bank debits', Amount: c.debits }, { Item: 'Adjusted book balance', Amount: c.adjBook ?? '' },
    { Item: 'Difference', Amount: c.diff ?? '' }]);
  if (!enc) return;
  const man = $('#bk-manual'); if (man && !man.disabled) man.onchange = () => { UI.manual = man.checked; rr(); };
  const ed = $('#bk-edit'); if (ed) ed.onclick = () => { UI.edit = true; rr(); };
  const de = $('#bk-doneedit'); if (de) de.onclick = () => { UI.edit = false; rr(); };
  const save = async (patch, msg) => {
    const cur = c.rec0 ? strip(c.rec0) : { auditId: audit.id, accountId: acct.id, lguId: audit.lguId, asOf: rec.asOf, ending: rec.ending, source: rec.source, book: rec.book, bankItems: [], found: {}, otherChecks: [], lines: [] };
    await store.save('cer_bankrec', recId, { ...cur, ...patch }, by(refs));
    if (msg) toast(msg, 'ok');
  };
  if ($('#bk-savest')) $('#bk-savest').onclick = () => {
    const end = $('#bk-end').value.trim();
    if (!$('#bk-date').value) return bad('Enter the statement date.');
    save({ asOf: $('#bk-date').value, ending: end ? num(end) : null, source: $('#bk-src').value }, 'Statement saved.');
  };
  if ($('#bk-saverc')) $('#bk-saverc').onclick = () => { const v = $('#bk-book').value.trim(); save({ book: v ? num(v) : null }, 'Reconciliation saved.'); };
  ['#bk-end', '#bk-book', '#bi-amt'].forEach((s) => { const el = $(s); if (el) el.onblur = () => { const v = num(el.value); if (v !== null) el.value = money(v); }; });
  if ($('#bi-enter')) $('#bi-enter').onclick = () => {
    const v = { date: $('#bi-date').value, type: $('#bi-type').value, particulars: $('#bi-part').value.trim(), amount: num($('#bi-amt').value) };
    if (!v.date) return bad('Enter the date.');
    if (!v.amount || v.amount <= 0) return bad('Enter the amount.');
    save({ bankItems: [...(rec.bankItems || []), v].sort((a, b) => a.date.localeCompare(b.date)) }, 'Bank item saved.');
  };
  $$('[data-rmbi]').forEach((b) => { b.onclick = () => { const l = [...rec.bankItems]; l.splice(+b.dataset.rmbi, 1); save({ bankItems: l }, 'Removed.'); }; });
  // Ticking a row fills in the bank date with the book date (changed when the bank shows another date).
  $$('tr[data-key]').forEach((tr) => {
    if (!$('.bk-chk', tr)) return;
    const ck = $('.bk-chk', tr), bd = $('.bk-bd', tr), x = list.find((y) => y.key === tr.dataset.key);
    ck.onchange = () => { if (ck.checked && !bd.value) bd.value = x.date; if (!ck.checked) bd.value = ''; };
    bd.onchange = () => { ck.checked = !!bd.value; };
  });
  if ($('#bk-savefound')) $('#bk-savefound').onclick = () => {
    UI.edit = false;
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
// Check Nos. compared by digits only, without leading zeros (bank 0001749813 = books 1749813).
const chqKey = (v) => String(v ?? '').replace(/\D/g, '').replace(/^0+/, '');
async function importStatement(c, save) {
  const { rec, list, acct } = c;
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.xlsx,.xls,.csv';
  inp.onchange = async () => {
    const file = inp.files[0]; if (!file) return;
    try {
      const XLSX = await loadXlsx();
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
      const st = readLines(XLSX, rows);
      if (!st.lines.length) return bad('No bank lines found. The sheet needs a Date column and Debit / Credit (or Amount) columns.');
      // Only the coverage of the cash exam: after the last cash exam, up to the cash count date.
      const { from, to } = c.cov;
      const lines = st.lines.filter((l) => (!from || l.date > from) && l.date <= to);
      const skipped = st.lines.length - lines.length;
      if (!lines.length) return bad(`No bank lines ${from ? `after ${fmtDate(from)} ` : ''}up to ${fmtDate(to)} (the coverage of this cash exam). Check that it is the right statement.`);
      // The statement's account No. against the chosen bank account.
      if (st.account && acct.accountNo && chqKey(st.account) !== chqKey(acct.accountNo)) {
        const go = await modal({ title: 'Another bank account?', body: `<p style="margin:0">This statement is for account <b class="mono">${esc(st.account)}</b>, but the bank account chosen is <b>${esc(acctLabel(acct))}</b>. Import it here anyway?</p>`,
          buttons: [{ label: 'Go back', value: false }, { label: 'Import anyway', cls: 'primary', value: true }] });
        if (!go) return;
      }
      // Match: a check No. in the Cheque Number column (or the description) wins; otherwise deposits to credits and checks to debits
      // of the same amount, nearest date (bank on or after the book date: within 15 days for a deposit, a year for a check).
      const found = { ...(rec.found || {}) };
      const used = new Set(), lineOf = {};
      const tryMatch = (x, pick) => {
        if (found[x.key]) return;
        const cands = lines.filter((l) => !used.has(l.i) && Math.abs((x.kind === 'dep' ? l.credit : l.debit) - x.amount) < 0.005 && l.date && (!x.date || (days(x.date, l.date) >= -1 && days(x.date, l.date) <= (x.kind === 'dep' ? 15 : 366))));
        const l = pick(cands, x); if (!l) return;
        used.add(l.i); found[x.key] = l.date; lineOf[x.key] = l.i;
      };
      list.filter((x) => x.kind === 'chk' && !found[x.key]).forEach((x) => {
        const k = chqKey(x.ref); if (!k) return;
        const same = lines.filter((l) => !used.has(l.i) && l.debit && l.chq && chqKey(l.chq) === k);
        const l = same.find((y) => Math.abs(y.debit - x.amount) < 0.005);
        if (l) { used.add(l.i); found[x.key] = l.date; lineOf[x.key] = l.i; }
        else same.forEach((y) => { y.note = `Check No. ${x.ref} is ₱${money(x.amount)} in the books`; });
      });
      list.filter((x) => x.kind === 'chk').forEach((x) => tryMatch(x, (cs) => cs.find((l) => x.ref && !l.chq && chqKey(l.desc).includes(chqKey(x.ref))) || cs.filter((l) => !l.chq || !chqKey(x.ref)).sort((a, b) => Math.abs(days(x.date, a.date)) - Math.abs(days(x.date, b.date)))[0]));
      list.filter((x) => x.kind === 'dep').forEach((x) => tryMatch(x, (cs) => cs.sort((a, b) => Math.abs(days(x.date, a.date)) - Math.abs(days(x.date, b.date)))[0]));
      lines.forEach((l) => { l.matched = used.has(l.i); });
      // Beginning = the bank balance at the last cash exam (the line before the coverage, or worked back from the first line in it);
      // ending = the bank balance at the cash count (the last line in the coverage).
      const before = st.lines.filter((l) => from && l.date <= from && l.bal !== null).pop();
      const first = lines[0];
      const opening = before ? before.bal : first.bal !== null ? r2(first.bal - first.credit + first.debit) : st.opening;
      const last = lines.filter((l) => l.bal !== null).pop();
      UI.manual = false; UI.edit = false; UI.only = false;
      const patch = { found, lineOf, lines, heads: st.heads, source: 'Soft copy (imported)', opening, account: st.account || '', covFrom: from, covTo: to, asOf: to, bankItems: [] };
      if (last) patch.ending = last.bal;
      await save(patch, `${lines.length} lines in the coverage imported · ${used.size} matched${skipped ? ` · ${skipped} outside the coverage skipped` : ''}${last ? ' · ending balance read' : ''}.`);
    } catch (e) { bad(e.message || String(e)); }
  };
  inp.click();
}
function readLines(XLSX, rows) {
  const find = (h, re) => h.findIndex((x) => re.test(String(x)));
  const txt = (v) => String(v ?? '').trim();
  let hr = -1, col = {};
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const h = rows[r].map(txt);
    const d = find(h, /^(transaction |posting |value )?date/i) >= 0 ? find(h, /^(transaction |posting |value )?date/i) : find(h, /date/i);
    if (d < 0) continue;
    let desc = find(h, /desc|particular|detail|remark|transaction(?! date)|narration/i); if (desc < 0) desc = find(h, /reference/i);
    col = { date: d, desc, chq: find(h, /cheque|check\s*(no|num|#)|chk\s*no/i), debit: find(h, /debit|withdraw|\bdr\b/i), credit: find(h, /credit|deposit|\bcr\b/i), amt: find(h, /^amount/i), bal: find(h, /balance/i) };
    if (col.debit >= 0 || col.credit >= 0 || col.amt >= 0) { hr = r; break; }
  }
  if (hr < 0) return { lines: [], opening: null, account: '', heads: [] };
  // The statement's own columns, kept as they are for display (empty header cells left out).
  const hcols = rows[hr].map((x, k) => [txt(x), k]).filter(([h]) => h);
  // Account No. above the header (e.g. "Account Number | 0732102574").
  let account = '';
  rows.slice(0, hr).forEach((row) => { const k = row.findIndex((x) => /account\s*(no|num|#)/i.test(txt(x))); if (k >= 0 && !account) account = txt(row.slice(k + 1).find((x) => txt(x))); });
  const pad = (x) => String(x).padStart(2, '0');
  const toDate = (v) => {
    if (v instanceof Date) { const d = new Date(v.getTime() - v.getTimezoneOffset() * 6e4); return d.toISOString().slice(0, 10); }
    if (typeof v === 'number') { const p = XLSX.SSF.parse_date_code(v); return p ? `${p.y}-${pad(p.m)}-${pad(p.d)}` : ''; }
    const t = txt(v);
    // mm/dd/yyyy, with or without the time (08/01/2024 15:00:09): the date part only, so an early-morning entry stays on its day.
    let m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:\s|T|$)/.exec(t); if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${pad(m[1])}-${pad(m[2])}`; }
    m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t); if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    const d = new Date(t); return isNaN(d) ? '' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const n = (v) => { const x = num(v); return x === null ? 0 : x; };
  let opening = null;
  const lines = rows.slice(hr + 1).map((row, i) => {
    const all = row.map(txt).join(' ');
    if (/opening balance|beginning balance|balance forward|previous balance/i.test(all)) { if (opening === null && col.bal >= 0) opening = num(row[col.bal]); return null; }
    const date = toDate(row[col.date]); if (!date) return null;
    let debit = col.debit >= 0 ? Math.abs(n(row[col.debit])) : 0, credit = col.credit >= 0 ? Math.abs(n(row[col.credit])) : 0;
    if (col.amt >= 0 && !debit && !credit) { const a = n(row[col.amt]); if (a < 0) debit = -a; else credit = a; }
    if (!debit && !credit) return null;
    const cells = hcols.map(([h, k]) => { const v = row[k]; if (k === col.date) return fmtDate(date) + (typeof v === 'string' && /\d:\d/.test(v) ? ' ' + v.trim().split(/\s+/).slice(1).join(' ') : ''); if (typeof v === 'number' && (k === col.debit || k === col.credit || k === col.bal || k === col.amt)) return money(v); if (v instanceof Date) return fmtDate(toDate(v)); return txt(v); });
    return { i, date, cells, desc: col.desc >= 0 ? txt(row[col.desc]).replace(/\s+/g, ' ') : '', chq: col.chq >= 0 ? txt(row[col.chq]) : '', debit: r2(debit), credit: r2(credit), bal: col.bal >= 0 && txt(row[col.bal]) !== '' ? num(row[col.bal]) : null };
  }).filter(Boolean);
  return { lines, opening, account, heads: hcols.map(([h]) => h) };
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
