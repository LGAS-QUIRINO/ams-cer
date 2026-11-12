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
//                  found{ <item key>: bankDate }, otherChecks[{ id, date, checkNo, payee, amount }], lines[] (imported; saved in parts <id>#lines<k> { part, recId, k, lines }, lineParts = how many),
//                  opening (bank balance at the last cash exam), account (account No. read from it), covFrom / covTo (coverage imported),
//                  lineOf{ <item key>: line i } (which imported line each item matched; unmatched lines count as bank credits / debits),
//                  noAuto[] (item keys unticked by hand: never matched again automatically),
//                  begMark{ <line key>: 1 | 0 } (a line marked by hand as outstanding at the last cash exam, or unmarked) }
// Outstanding at the last cash exam: a cheque issued before the last cash exam clears in the period. It is already deducted in
// the beginning book balance, so it is neither a bank debit nor an outstanding check now. Found by itself when its number is
// before the first check of the period in its checkbook (and not in the CkDJ); any line can be marked or unmarked by hand
// (a deposit in transit then, too).
import { listT, bankChecksOf, checkAmountOf, chkNo, transfersInto, typedTransfer } from '../src/journal.js';
import { caAcct } from './funds.js';
import { remOf, remAcctId, remText, recordFromLine } from '../src/taxrem.js';
import { store, newId } from '../../js/store.js';
import { esc, modal, toast, $, $$ } from '../../js/ui.js';
import { hasRole, by, mayView, cycleOk, loadCer, pickAudit, pickExam, remember, getPick, agencyName, fmtDate, money, num } from './cer.js';
import { exportXlsx, lastChecksOf } from './forms.js';
import { repName, depRefText, tagSameDay } from './collections.js';

export const DEFAULT_FUNDS = ['General Fund', 'Special Education Fund', 'Trust Fund'];
const canEncode = (refs) => hasRole(refs, 'staff', 'member', 'atl', 'sa', 'admin');
const r2 = (n) => Math.round(n * 100) / 100;
const flat = (r) => ({ id: r.id, ...r.data });
const strip = (x) => { const { id, ...rest } = x; return rest; };
// A deposit's key: its report, date and amount (and the how-manyth such deposit), so editing its reference keeps the match.
// Keys of older matches (with the reference in them) are moved over; matches of items no longer in the books are dropped.
function depItems(r) {
  const seen = {};
  return (r.deposits || []).map((d) => { const b = `${d.date}|${d.amount}`; seen[b] = (seen[b] || 0) + 1;
    return { d, key: `dep|${r.id}|${d.date}|${d.amount}|${seen[b]}`, old: `dep|${r.id}|${d.date}|${d.ref}|${d.amount}` }; });
}
// Bank credits and debits typed in the Cashbook (IRA, interest, bank charges) of the exams of this audit, for this account.
function cashbookItems(settings, examIds, acctId) {
  const out = [];
  settings.filter((s) => s.id.startsWith('cashbook|') && examIds.has(s.id.split('|')[1]) && s.id.split('|')[2] === acctId).forEach((s) => (s.other || []).filter((x) => x.type === 'bankCr' || x.type === 'bankDr').forEach((x) => {
    out.push({ key: `cb|${x.id}`, kind: x.type === 'bankCr' ? 'dep' : 'chk', cb: true, label: x.type === 'bankCr' ? 'Bank credit' : 'Bank debit', date: x.date, ref: [x.part, x.ref].filter(Boolean).join(' · '), amount: +x.amount || 0, from: 'Cashbook' });
  }));
  return out;
}
function tidyFound(rec, items) {
  const found = { ...(rec.found || {}) }, lineOf = { ...(rec.lineOf || {}) }; let changed = false;
  items.forEach((x) => { if (x.old && x.old !== x.key && found[x.old] && !found[x.key]) { found[x.key] = found[x.old]; if (x.old in lineOf) lineOf[x.key] = lineOf[x.old]; delete found[x.old]; delete lineOf[x.old]; changed = true; } });
  const keys = new Set(items.map((x) => x.key));
  Object.keys(found).forEach((k) => { if (!keys.has(k)) { delete found[k]; delete lineOf[k]; changed = true; } });
  Object.keys(lineOf).forEach((k) => { if (!found[k]) { delete lineOf[k]; changed = true; } });
  return { found, lineOf, changed };
}
// The statement lines are kept in parts (records <recId>#lines<k> in cer_bankrec): one Google Sheet cell holds 50,000 characters at most.
const PART = '#lines';
export const isPart = (r) => String(r.id).includes(PART);
export function withLines(rec, all) {
  if (!rec || !rec.lineParts) return rec;
  const lines = [];
  for (let k = 0; k < rec.lineParts; k++) { const p = all.find((x) => x.id === `${rec.id}${PART}${k}`); if (p) lines.push(...(p.lines || [])); }
  return { ...rec, lines };
}
async function saveRec(recId, data, who) {
  const { lines, ...main } = data;
  if (lines !== undefined) {
    const parts = []; let cur = [], size = 0;
    lines.forEach((l) => { const n = JSON.stringify(l).length; if (cur.length && size + n > 30000) { parts.push(cur); cur = []; size = 0; } cur.push(l); size += n; });
    if (cur.length) parts.push(cur);
    const old = +main.lineParts || 0;
    for (let k = 0; k < parts.length; k++) await store.save('cer_bankrec', `${recId}${PART}${k}`, { part: true, recId, k, lines: parts[k] }, who, { quiet: true });
    for (let k = parts.length; k < old; k++) await store.save('cer_bankrec', `${recId}${PART}${k}`, { part: true, recId, k, lines: [] }, who, { quiet: true, deleted: true });
    main.lineParts = parts.length;
  }
  await store.save('cer_bankrec', recId, main, who);
}
const bad = (m) => { toast(m, 'bad'); return false; };
// Coverage of the cash exam: the last cash exam date (after its cut-off) (earliest among its officers) up to the cash count date.
export const covOf = (audit, exams) => { const ds = exams.filter((e) => e.auditId === audit.id && e.lastExamDate).map((e) => e.lastExamDate).sort(); return { from: ds[0] || '', to: audit.countDate }; };
// The imported lines within the coverage as it is now (it may have changed since the import); the beginning balance follows.
export function inCov(rec, cov) {
  const all = rec.lines || [];
  if (!all.length) return rec;
  const lines = all.filter((l) => (!cov.from || l.date >= cov.from) && l.date <= cov.to);
  if (lines.length === all.length && rec.covStart === 'on' && (rec.covFrom || '') === cov.from) return rec;
  const before = all.filter((l) => cov.from && l.date < cov.from && l.bal !== null && l.bal !== undefined).pop();
  const first = lines[0];
  const opening = before ? before.bal : first && first.bal !== null && first.bal !== undefined ? r2(first.bal - (first.credit || 0) + (first.debit || 0)) : rec.opening;
  return { ...rec, lines, opening, covFrom: cov.from, covTo: cov.to };
}
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const go = (params) => { const q = new URLSearchParams(location.hash.split('?')[1] || ''); Object.entries(params).forEach(([k, v]) => (v ? q.set(k, v) : q.delete(k))); location.hash = location.hash.split('?')[0] + '?' + q.toString(); };
const OPEN = { st: true, dc: false, rc: false };   // which tab is shown; 1 Bank Statement when the screen is opened
export const resetTabs = () => { OPEN.st = true; OPEN.dc = false; OPEN.rc = false; };
const UI = { manual: false, edit: false, only: false };   // manual statement fields shown · part 2 in tick mode · part 1 lines not in the books only
const SOURCES = ['Soft copy (imported)', 'PDF', 'Printed', 'Bank confirmation'];

export async function banksView(ctx) {
  const { refs, q } = ctx;
  const [audits0, settings0, reports0, advs0, recs0, officers0, exams0, books0, cut0, jr0, liq0] = await Promise.all(['cer_audits', 'cer_settings', 'cer_reports', 'cer_cashadv', 'cer_bankrec', 'cer_officers', 'cer_exams', 'cer_booklets', 'cer_cutoff', 'src_ckdj', 'cer_liquid'].map(listT));
  await loadCer();   // the cycles
  const audits = audits0.map(flat).filter((a) => mayView(refs, refs.lgu[a.lguId]) && (cycleOk(a) || a.id === q.get('a'))).sort((a, b) => String(b.countDate).localeCompare(String(a.countDate)));
  const settings = Object.fromEntries(settings0.map((s) => [s.id, s.data]));
  const crumb = 'Bank Statements';
  const hello = (extra = '') => `<div class="hello"><div><h1>Bank Statements</h1><p>Confirm each deposit and check in the bank statement, then reconcile the bank and book balances as of the cash count.</p></div>${extra}</div>`;
  if (!audits.length) return { crumb, body: hello() + '<div class="panel"><div class="empty"><b>No cash examination yet.</b>The auditors set one up in Audit Setup.</div></div>' };
  const audit = pickAudit(audits, q); { const p = getPick(); remember(refs, audit, p.a === audit?.id ? { id: p.e, o: { name: (p.label || '').split(' · ')[2] || '' } } : null); }
  const lgu = refs.lgu[audit.lguId];
  const funds = settings['funds|' + audit.lguId]?.list || DEFAULT_FUNDS;
  const accounts = settings['banks|' + audit.lguId]?.list || [];
  const enc = canEncode(refs);
  const acct = accounts.find((x) => x.id === q.get('acct')) || accounts[0] || null;
  const recId = acct ? `${audit.id}|${acct.id}` : '';
  const recsAll = recs0.map(flat), rec0 = recsAll.find((r) => r.id === recId);
  const cov = covOf(audit, exams0.map(flat));
  const rec = inCov({ asOf: audit.countDate, ending: null, source: SOURCES[1], book: null, bankItems: [], found: {}, otherChecks: [], lines: [], ...(withLines(rec0, recsAll) || {}) }, cov);
  const asOf = audit.countDate;   // always the cash count date
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
  // Collectors who remit to the Liquidating Officer (Audit Setup): their remittances are not bank deposits.
  const toLOs = new Set(exams0.map(flat).filter((e) => e.auditId === audit.id && e.remitToLO).map((e) => e.officerId));
  tagSameDay(reports0.map(flat)).filter((r) => r.lguId === audit.lguId && r.fund === acct.fund && r.kind !== 'SCR' && !toLOs.has(r.officerId)).forEach((r) => depItems(r).filter(({ d }) => !d.toLO).forEach(({ d, key, old }) => {
    items.push({ key, old, kind: 'dep', date: d.date, ref: depRefText(d), amount: +d.amount || 0,
      from: `${r.pending ? 'Not yet reported' : repName(r)} · ${officers.find((o) => o.id === r.officerId)?.name || ''}` });
  }));
  // Refunds of cash advances deposited in this account with no OR (Liquidation Journal): deposits to find in the statement.
  depRefunds(liq0.map(flat), audit.lguId, acct, accounts).forEach((l) => items.push({ key: `rf|${l.id}`, kind: 'dep', label: 'Refund', date: l.date, ref: l.ref || '', amount: +l.amount || 0,
    from: `Liquidation Journal · ${officers.find((o) => o.id === l.officerId)?.name || ''}` }));
  // Cash advance checks of this account only (the fund of the check's checkbook; not identified → the first account).
  const fxB = { booklets: books0.map(flat), accounts, jr: jr0.map(flat) }; const caOfAcct = (a) => { const ac = caAcct(a, fxB); return ac ? ac.id === acct.id : acct.id === accounts[0]?.id; };
  advs0.map(flat).filter((a) => a.lguId === audit.lguId && !a.beg && caOfAcct(a)).forEach((a) => items.push({ key: `chk|${a.id}`, kind: 'chk', date: a.date, ref: a.checkNo, amount: +a.amount || 0,
    from: `Cash advance · ${officers.find((o) => o.id === a.officerId)?.name || ''}` }));
  // Checks in the Check Disbursements Journal of this account (cash advances come with Cash Advances above).
  const jrChecks = bankChecksOf(jr0.map(flat), acct.id), jrNos = new Set(jrChecks.map((c) => chkNo(c.checkNo)));
  jrChecks.forEach((c) => items.push({ key: `jr|${c.id}`, kind: 'chk', date: c.date, ref: c.checkNo, amount: checkAmountOf(c), from: `Journal${c.payee ? ' · ' + c.payee : ''}` }));
  (rec.otherChecks || []).filter((c) => !jrNos.has(chkNo(c.checkNo))).forEach((c) => items.push({ key: `oth|${c.id}`, kind: 'chk', date: c.date, ref: c.checkNo, amount: +c.amount || 0, from: `Typed here${c.payee ? ' · ' + c.payee : ''}`, other: c }));
  items.push(...cashbookItems(settings0.map(flat), new Set(exams0.map(flat).filter((e) => e.auditId === audit.id).map((e) => e.id)), acct.id));
  // Transfers into this account (a check of another account paid to this fund): a deposit in transit until in the statement.
  { const cbCr = items.filter((x) => x.cb && x.kind === 'dep');
    transfersInto(jr0.map(flat), acct, audit.lguId).filter((c) => !cbCr.some((x) => typedTransfer(c, { date: x.date, amount: x.amount, text: x.ref })))
      .forEach((c) => items.push({ key: `tr|${c.id}`, kind: 'dep', label: 'Transfer in', date: c.date, ref: `Check No. ${c.checkNo}${c.payee ? ' · ' + c.payee : ''}`, amount: checkAmountOf(c), from: 'CkDJ' })); }
  // Taxes withheld paid to the BIR from this account (ETPS / eFPS debits; no check).
  (remOf(settings, audit.lguId).list || []).filter((r) => remAcctId(r, accounts) === acct.id).forEach((r) => items.push({ key: `tx|${r.id}`, kind: 'chk', cb: true, win: 3, label: 'Tax payment', date: r.date, ref: remText(r).replace('Remittance of taxes withheld · ', ''), amount: +r.amount || 0, from: 'Tax Remittances' }));
  // Matches kept in step with the books (a deposit edited or removed).
  const tidy = tidyFound(rec, items); rec.found = tidy.found; rec.lineOf = tidy.lineOf;
  const list = items.filter((x) => x.date && x.date <= asOf && !foundElsewhere.has(x.key)).sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.kind.localeCompare(b.kind));
  // Cut-off (Cash Count): the last check written in each checkbook at the count. A check numbered after it, in the same checkbook,
  // was issued after the cut-off: not an outstanding check of this examination.
  const examIds = new Set(exams0.map(flat).filter((e) => e.auditId === audit.id).map((e) => e.id));
  const cuts = lastChecksOf({ cutoffs: cut0.map(flat), booklets: books0.map(flat) }, examIds);
  const afterCut = (x) => { if (x.kind !== 'chk' || x.cb) return false; const n = +chqKey(x.ref); return !!n && cuts.some((c) => n >= c.from && n <= c.to && n > c.last); };
  // Items encoded after the upload: matched against the statement already uploaded (unmatched by hand stay unmatched).
  const auto = (() => {
    const lns = rec.lines || []; if (!lns.length || !enc) return null;
    const found = { ...(rec.found || {}) }, lineOf = { ...(rec.lineOf || {}) };
    const used = new Set(Object.entries(lineOf).filter(([k]) => found[k]).map(([, i]) => i));
    // Ticked by hand (no line): linked to the statement line of the same amount on the bank date typed, so that line is not
    // counted again as a bank credit or debit.
    let linkedN = 0;
    list.filter((x) => found[x.key] && !(x.key in lineOf)).forEach((x) => {
      const l = lns.find((y) => !used.has(y.i) && y.date === found[x.key] && Math.abs((x.kind === 'dep' ? y.credit : y.debit) - x.amount) < 0.005)
        || lns.find((y) => !used.has(y.i) && Math.abs((x.kind === 'dep' ? y.credit : y.debit) - x.amount) < 0.005 && Math.abs(days(found[x.key], y.date)) <= 3);
      if (l) { used.add(l.i); lineOf[x.key] = l.i; linkedN++; }
    });
    const n = linkedN + matchItems(list.filter((x) => !found[x.key] && !(rec.noAuto || []).includes(x.key)), lns, found, lineOf, used);
    return n || tidy.changed ? { n, found, lineOf } : null;
  })();
  list.forEach((x) => { x.after = afterCut(x) && !rec.found[x.key]; });
  // Checks issued before the period (before the last cash exam): in the reconciliation only when they cleared in this statement
  // (outstanding at the last cash exam) or are ticked "Still outstanding"; the rest are taken as cleared before the period.
  list.forEach((x) => { x.pre = preCheck(x, cov.from, rec); });
  const preList = list.filter((x) => x.pre), books = list.filter((x) => !x.pre);
  const result = (x) => {
    const bd = rec.found[x.key];
    if (x.after) return ['p-stock', 'Issued after the cut-off'];
    if (!bd && nmByKey[x.key]) { const l = nmByKey[x.key]; return ['p-nm', 'Not Matched', `The bank shows ₱${money(l.debit)} for check ${l.chq} on ${fmtDate(l.date)}`]; }
    if (!bd && x.cb) return ['p-part', 'Not in the bank'];
    if (!bd && x.kind === 'chk' && (rec.stillOut || {})[x.key]) return ['p-part', 'Outstanding check', 'Issued before the period; ticked Still outstanding'];
    if (!bd) return x.kind === 'dep' ? ['p-part', 'Deposit in transit'] : ['p-part', 'Outstanding check'];
    if (x.kind === 'dep') { const late = bd && x.date ? days(x.date, bd) : 0; return late > 0 ? ['p-flag', `In the bank · ${late} day${late > 1 ? 's' : ''} later`] : ['p-done', 'In the bank']; }
    return ['p-done', 'Cleared'];
  };
  const dit = r2(list.filter((x) => x.kind === 'dep' && !rec.found[x.key]).reduce((n, x) => n + x.amount, 0));
  const oc = r2(list.filter((x) => x.kind === 'chk' && !rec.found[x.key] && !x.after && !x.pre).reduce((n, x) => n + x.amount, 0));
  // Bank-only items: the imported lines not matched to a deposit or check in the books, by their side
  // (credit → bank credit, debit → bank debit), plus any typed by hand (statements not imported).
  const linked = new Set(Object.entries(rec.lineOf || {}).filter(([k]) => rec.found[k]).map(([, i]) => i));
  const cand = (rec.lines || []).filter((l) => !(rec.lineOf ? linked.has(l.i) : l.matched) && !l.added && l.date <= asOf);
  const begSet = begLinesOf(rec, cand, jr0.map(flat), acct, books0.map(flat), cov);
  const begLines = cand.filter((l) => begSet.has(l.i));
  const unmatched = cand.filter((l) => !begSet.has(l.i));
  // Not Matched: a bank line whose cheque number is a check in the books, but with another amount.
  const nmByLine = {}, nmByKey = {};
  unmatched.filter((l) => l.debit && l.chq).forEach((l) => { const x = list.find((y) => y.kind === 'chk' && !y.cb && !rec.found[y.key] && !nmByKey[y.key] && chqKey(y.ref) && chqKey(y.ref) === chqKey(l.chq) && Math.abs(y.amount - l.debit) >= 0.005); if (x) { nmByLine[l.i] = x; nmByKey[x.key] = l; } });
  const bItems = (rec.bankItems || []).filter((b) => !b.date || b.date <= asOf);
  const sum = (a, f) => r2(a.reduce((n, x) => n + (+f(x) || 0), 0));
  const unCr = sum(unmatched, (l) => l.credit), unDr = sum(unmatched, (l) => l.debit);
  const credits = r2(unCr + sum(bItems.filter((b) => b.type === 'credit'), (b) => b.amount));
  const debits = r2(unDr + sum(bItems.filter((b) => b.type === 'debit'), (b) => b.amount));
  const hasEnd = rec.ending !== null && rec.ending !== undefined && rec.ending !== '';
  // Barangays: the Balance per Cashbook comes from the Cashbook (Cash in Bank ending) unless typed here.
  const typedBook = rec.book !== null && rec.book !== undefined && rec.book !== '';
  const cbEnd = typedBook ? null : await (await import('./cashbook.js')).cashbookEnding(refs, audit, acct).catch(() => null);
  if (!typedBook && cbEnd !== null && cbEnd !== undefined) rec.book = cbEnd;
  const hasBook = rec.book !== null && rec.book !== undefined && rec.book !== '';
  const fromCb = !typedBook && hasBook;
  const adjBank = hasEnd ? r2(+rec.ending + dit - oc) : null;
  const adjBook = hasBook ? r2(+rec.book + credits - debits) : null;
  const diff = adjBank !== null && adjBook !== null ? r2(adjBank - adjBook) : null;
  const recPill = diff === null ? '<span class="pill p-stock">Not yet reconciled</span>' : Math.abs(diff) < 0.005 ? '<span class="pill p-done">Agrees</span>' : `<span class="pill p-flag">Difference ₱${money(diff)}</span>`;
  const nFound = books.filter((x) => rec.found[x.key]).length;
  // Beginning + credits − debits = ending, from the imported lines (the coverage of the cash exam).
  const lns = rec.lines || [];
  const proof = lns.length && rec.opening !== null && rec.opening !== undefined ? (() => {
    const cr = r2(lns.reduce((n, l) => n + (l.credit || 0), 0)), dr = r2(lns.reduce((n, l) => n + (l.debit || 0), 0));
    const last = lns.filter((l) => l.bal !== null && l.bal !== undefined).pop(), endB = last ? last.bal : rec.ending;
    const d = endB === null || endB === undefined ? null : r2(+rec.opening + cr - dr - endB);
    return `<div class="bk-proof"><span>Beginning${rec.covFrom ? ` (${esc(fmtDate(rec.covFrom))})` : ''} <b>₱ ${money(rec.opening)}</b></span><span>+ Credits <b>₱ ${money(cr)}</b></span><span>− Debits <b>₱ ${money(dr)}</b></span><span>= Ending${rec.covTo ? ` (${esc(fmtDate(rec.covTo))})` : ''} <b>₱ ${money(r2(+rec.opening + cr - dr))}</b></span>
      ${d === null ? '' : Math.abs(d) < 0.005 ? '<span class="pill p-done">Adds up to the ending balance</span>' : `<span class="pill p-flag">Differs from the ending balance by ₱${money(d)}</span>`}${rec.account ? `<span class="dim">Account No. ${esc(rec.account)}</span>` : ''}</div>`;
  })() : '';
  // The beginning: bank balance at the last cash exam − checks outstanding then + deposits in transit then = Cashbook beginning.
  const begProof = lns.length && rec.opening !== null && rec.opening !== undefined ? (() => {
    const bo = r2(begLines.reduce((n, l) => n + (l.debit || 0), 0)), bd = r2(begLines.reduce((n, l) => n + (l.credit || 0), 0));
    const nO = begLines.filter((l) => l.debit).length, nD = begLines.filter((l) => l.credit).length, adj = r2(+rec.opening - bo + bd);
    const exs = exams0.map(flat).filter((e) => e.auditId === audit.id), ex = exs.find((e) => /treasurer/i.test(officers.find((o) => o.id === e.officerId)?.designation || '')) || exs[0];
    const cbb = ex ? num(settings[`cashbook|${ex.id}|${acct.id}`]?.begBank) : null;
    const d = cbb === null || cbb === undefined ? null : r2(adj - cbb);
    return `<div class="bk-proof bk-begproof"><span>Bank, last cash exam <b>₱ ${money(rec.opening)}</b></span><span>− Outstanding checks then (${nO}) <b>₱ ${money(bo)}</b></span><span>+ Deposits in transit then (${nD}) <b>₱ ${money(bd)}</b></span><span>= <b>₱ ${money(adj)}</b></span>
      ${d === null ? '<span class="dim">Cashbook beginning not typed yet</span>' : `<span>Cashbook beginning <b>₱ ${money(cbb)}</b></span>${Math.abs(d) < 0.005 ? '<span class="pill p-done">Agrees</span>' : `<span class="pill p-flag">Differs by ₱${money(d)}</span>`}`}
      <span class="dim">Only those that cleared within the coverage are known.</span></div>`;
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
  // The book item matched: its reference alone when it already says what it is (e.g. "Cash Deposit Slip"), else "Deposit …" / "Check …".
  const pillText = (x) => { const lb = x.label || (x.kind === 'dep' ? 'Deposit' : 'Check'), r = String(x.ref || '').trim(); return !r ? lb : new RegExp(`\\b${lb.split(' ')[0]}`, 'i').test(r) ? r : `${lb} · ${r}`; };
  const inBooks = (l) => { const x = byLine[l.i]; if (x) return `<span class="pill p-done">${esc(pillText(x))}</span>`;
    if (!rec.lineOf && l.matched) return '<span class="pill p-done">Matched</span>';
    const k = esc(lineKey(l));
    if (begSet.has(l.i)) return `<span class="pill p-beg" title="Issued before the last cash exam: already in the beginning book balance">${l.credit ? 'Deposit in transit at the last cash exam' : 'Outstanding at the last cash exam'}</span>${enc ? ` <button type="button" class="bk-lnk" data-begmk="${k}" data-v="0" title="Not outstanding at the last cash exam">undo</button>` : ''}`;
    const tx = enc && l.debit && !l.chq ? ` <button type="button" class="bk-lnk" data-taxln="${l.i}" title="An online payment of taxes withheld (ETPS / eFPS)">record as tax payment</button>` : '';
    const mk = tx + (enc ? ` <button type="button" class="bk-lnk" data-begmk="${k}" data-v="1" title="${l.credit ? 'A deposit in transit at the last cash exam' : 'A check outstanding at the last cash exam'}: already in the beginning book balance">at last exam?</button>` : '');
    if (nmByLine[l.i]) return `<span class="pill p-nm" title="Check ${esc(nmByLine[l.i].ref)}: ₱${money(nmByLine[l.i].amount)} in the books">Not Matched</span>${mk}`;
    return (l.debit && l.chq ? '<span class="pill p-stock">Check, not yet encoded</span>' : '<span class="pill p-stock">Not in the books</span>') + mk; };
  const shown = lns.filter((l) => l.date <= asOf).filter((l) => !UI.only || unmatched.includes(l));
  const stmtTbl = imported ? `<div class="bk-tools"><span class="dim">${cov.from ? `Coverage ${esc(fmtDate(cov.from))} – ${esc(fmtDate(cov.to))}` : '<span class="pill p-flag">No last cash exam date</span>'} · ${lns.length} line${lns.length === 1 ? '' : 's'} · ${lns.length - unmatched.length - begLines.length} found in the books${begLines.length ? ` · ${begLines.length} outstanding at the last cash exam` : ''} · ${unmatched.length} not in the books</span>
        <label class="cer-chip"><input type="checkbox" id="bk-only" ${UI.only ? 'checked' : ''}> Not in the books only</label></div>
      <div class="af-tbl bk-stmtwrap"><table class="af-reg bk-stmt"><thead><tr>${heads.map((h) => `<th scope="col"${numCol(h) ? ' class="r"' : ''}>${esc(h)}</th>`).join('')}<th scope="col">In the books</th></tr></thead>
      <tbody>${!UI.only && rec.opening !== null && rec.opening !== undefined ? `<tr class="bk-open">${heads.map((h, k) => `<td${numCol(h) ? ' class="r"' : ''}>${/balance/i.test(h) ? `<b>${money(rec.opening)}</b>` : k === 1 ? '<b>Beginning balance</b>' : ''}</td>`).join('')}<td class="dim">as of the last cash exam</td></tr>` : ''}
        ${shown.map((l) => `<tr${unmatched.includes(l) ? ' class="bk-unrow"' : ''}>${cellsOf(l).map((v, k) => `<td${numCol(heads[k] || '') ? ' class="r"' : /cheque|check/i.test(heads[k] || '') ? ' class="mono"' : ''}>${esc(v)}</td>`).join('')}<td>${inBooks(l)}</td></tr>`).join('')}</tbody></table></div>
      <p class="af-note">The statement as the bank gives it, from the last cash exam date to the cash count. Lines not in the books count in the reconciliation as they are: credits as bank credits, debits as bank debits. Interest and service charges are expected; anything else is for the auditor to look into (a deposit or check not yet encoded matches on the next import).</p>` : '';
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
    ${proof}${begProof}
    ${imported && !manual ? stmtTbl : ''}
    ${manual ? manualBox : ''}
    ${imported && manual ? stmtTbl : ''}`;

  // ---- 2 Deposits and Checks: the results; ticking only for a PDF / printed statement or to correct a match ----
  const tick = manual || UI.edit;
  const dcBody = `${books.length ? `<div class="af-tbl"><table class="af-reg bk-items"><thead><tr>${tick ? '<th scope="col">In Bank</th>' : ''}<th scope="col">Type</th><th scope="col">Date (Books)</th><th scope="col">Reference</th><th scope="col">From</th><th scope="col" class="r">Amount (₱)</th><th scope="col">Date (Bank)</th><th scope="col">Result</th><th scope="col"></th></tr></thead>
      <tbody>${books.map((x) => { const bd = rec.found[x.key] || ''; const rs = result(x); return `<tr data-key="${esc(x.key)}">${tick ? `<td><input type="checkbox" class="bk-chk" ${bd ? 'checked' : ''} ${dis} aria-label="In bank: ${esc(x.ref || x.kind)}"></td>` : ''}
        <td>${x.label || (x.kind === 'dep' ? 'Deposit' : 'Check')}</td><td>${esc(fmtDate(x.date))}</td><td class="mono">${esc(x.ref)}</td><td>${esc(x.from)}</td><td class="r">${money(x.amount)}</td>
        <td>${tick ? `<input class="input af-sm bk-bd" type="date" value="${esc(bd)}" ${dis} aria-label="Date in the bank">` : esc(fmtDate(bd))}</td><td><span class="pill ${rs[0]}" ${rs[2] ? `title="${esc(rs[2])}"` : ''}>${rs[1]}</span></td>
        <td class="r">${enc && x.other ? `<button class="btn sm" type="button" data-rmoth="${esc(x.other.id)}" aria-label="Remove check ${esc(x.ref)}">Remove</button>` : ''}${enc && (rec.stillOut || {})[x.key] && !bd ? `<button class="bk-lnk" type="button" data-stillout="${esc(x.key)}" data-v="0">undo Still outstanding</button>` : ''}</td></tr>`; }).join('')}</tbody></table></div>`
      : `<div class="empty"><b>No deposit or check of ${esc(acct.fund)} up to ${esc(fmtDate(asOf))}.</b>Deposits come from Collections &amp; Deposits; checks from Cash Advances.</div>`}
    ${preList.length ? `<details class="bk-pre"><summary>Checks issued before the period, not in this statement (${preList.length} · ₱${money(r2(preList.reduce((n, x) => n + x.amount, 0)))}): taken as cleared before ${esc(fmtDate(cov.from))}</summary>
      <div class="af-tbl"><table class="af-reg"><thead><tr><th scope="col">Date (Books)</th><th scope="col">Check No.</th><th scope="col">From</th><th scope="col" class="r">Amount</th><th scope="col"></th></tr></thead>
      <tbody>${preList.map((x) => `<tr><td>${esc(fmtDate(x.date))}</td><td class="mono">${esc(x.ref)}</td><td>${esc(x.from)}</td><td class="r">${money(x.amount)}</td>
        <td class="r">${enc ? `<button class="btn sm" type="button" data-stillout="${esc(x.key)}" data-v="1" title="Not yet cleared at all (e.g. a stale check still with the payee): an outstanding check of this period">Still outstanding</button>` : ''}</td></tr>`).join('')}</tbody></table></div></details>` : ''}
    <div class="cd-actions">${enc ? `<button class="btn" type="button" id="bk-addchk">+ Other Check</button>${tick ? `${imported ? '<button class="btn" type="button" id="bk-doneedit">Cancel</button>' : ''}<button class="btn primary" type="button" id="bk-savefound">Save</button>` : list.length ? '<button class="btn" type="button" id="bk-edit">Correct a match</button>' : ''}` : ''}</div>
    <p class="af-note">${tick ? 'Tick each item found in the bank and type the bank date (ticking fills in the book date).' : 'Found by the import: deposits matched to credits, checks to debits (by check No., else amount and date).'} Deposits come from Collections &amp; Deposits (${esc(acct.fund)}); checks from Cash Advances. A check that is not a cash advance can be added with + Other Check.</p>`;

  // ---- 3 Bank Reconciliation: the cashbook balance is the one thing to type ----
  const rcBody = `<div class="bk-bookrow">
      <div class="field"><label for="bk-book">Balance per Cashbook (₱)</label><input class="input r" id="bk-book" inputmode="decimal" value="${typedBook ? esc(money(rec.book)) : ''}" placeholder="${fromCb ? esc(money(rec.book)) + ' (Cashbook)' : ''}" ${dis}></div>
      ${enc ? '<button class="btn primary" type="button" id="bk-saverc">Save</button>' : ''}<span class="bk-recres">${recPill}</span></div>
    <div class="cd-g2">
      <div class="cd-sum bk-rc"><b class="cd-sumh">Per Bank</b>
        <div><span>Balance per bank statement</span><span>${hasEnd ? money(rec.ending) : '—'}</span></div>
        <div><span>Add: Deposits in transit</span><span>${money(dit)}</span></div>
        <div><span>Less: Outstanding checks</span><span>(${money(oc)})</span></div>
        <div class="cd-sumt"><span>Adjusted bank balance</span><span>${adjBank === null ? '—' : money(adjBank)}</span></div></div>
      <div class="cd-sum bk-rc"><b class="cd-sumh">Per Books</b>
        <div><span>Balance per cashbook${fromCb ? ' <small class="dim">(from the Cashbook)</small>' : ''}</span><span>${hasBook ? money(rec.book) : '—'}</span></div>
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
  // One chip per bank account: statement imported? checks in the Check Disbursements Journal for the period?
  const jrAll = jr0.map(flat);
  const chips = `<div class="bk-chips">${accounts.map((x) => {
    const r0 = recs0.map(flat).find((r) => r.id === `${audit.id}|${x.id}`), hasSt = !!(r0 && ((r0.lines || []).length || r0.lineParts));
    const nCk = jrAll.filter((c) => c.acctId === x.id && c.lguId === audit.lguId && c.date && (!cov.from || c.date >= cov.from) && c.date <= cov.to).length;
    return `<a class="bk-chip ${x.id === acct.id ? 'on' : ''}" href="#/cer/banks?a=${esc(audit.id)}&acct=${esc(x.id)}"><b>${esc(acctLabel(x))}</b>
      <span class="${hasSt ? 'ok' : 'no'}">${hasSt ? '✓ Statement imported' : '✗ No statement yet'}</span><span class="${nCk ? 'ok' : 'no'}">${nCk ? `✓ CkDJ ${nCk} check${nCk > 1 ? 's' : ''}` : '✗ No CkDJ yet'}</span></a>`;
  }).join('')}</div>`;
  const body = hello(btnAccts) + top(true) + chips + figs + tabs([
    ['st', 'Bank Statement', esc(imported ? `${lns.length} lines · ${unmatched.length} not in the books` : hasEnd ? `${rec.source || ''} · ending ₱${money(rec.ending)}` : 'Import the soft copy'), stBody],
    ['dc', 'Deposits and Checks', `${nFound} of ${books.length} found in the bank`, dcBody],
    ['rc', 'Reconciliation', diff === null ? 'Type the cashbook balance' : Math.abs(diff) < 0.005 ? 'Agrees' : `Difference ₱${money(diff)}`, rcBody]]);

  const ctxw = { refs, audit, acct, recId, rec, rec0, list, auto, asOf, enc, cov, unmatched, accounts, funds, settings, credits, debits, dit, oc, adjBank, adjBook, diff };
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
    ...list.map((x) => ({ Item: x.label || (x.kind === 'dep' ? 'Deposit' : 'Check'), 'Date (Books)': fmtDate(x.date), Reference: x.ref, From: x.from, Amount: x.amount, 'Date (Bank)': fmtDate(rec.found[x.key] || ''), Result: rec.found[x.key] ? (x.kind === 'dep' ? 'In the bank' : 'Cleared') : x.after ? 'Issued after the cut-off' : (x.kind === 'dep' ? 'Deposit in transit' : 'Outstanding check') })),
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
    await saveRec(recId, { ...cur, ...patch }, by(refs));
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
    const noAuto = new Set(rec.noAuto || []);
    $$('tr[data-key]').forEach((tr) => { const k = tr.dataset.key; const bd = $('.bk-bd', tr).value; if ($('.bk-chk', tr).checked && bd) { found[k] = bd; noAuto.delete(k); } else { if (found[k]) noAuto.add(k); delete found[k]; } });
    save({ found, noAuto: [...noAuto] }, 'Saved.');
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
  $$('[data-taxln]').forEach((b) => { b.onclick = () => recordFromLine({ refs, lguId: audit.lguId, settings: c.settings, accounts: c.accounts, acct, line: (rec.lines || []).find((l) => l.i === +b.dataset.taxln) }); });
  $$('[data-stillout]').forEach((b) => { b.onclick = () => save({ stillOut: { ...(rec.stillOut || {}), [b.dataset.stillout]: +b.dataset.v } }, +b.dataset.v ? 'Marked as still outstanding.' : 'Back to cleared before the period.'); });
  $$('[data-begmk]').forEach((b) => { b.onclick = () => save({ begMark: { ...(rec.begMark || {}), [b.dataset.begmk]: +b.dataset.v } }, +b.dataset.v ? 'Marked as outstanding at the last cash exam.' : 'Unmarked.'); });
  if (c.auto && !UI.edit) save({ found: c.auto.found, lineOf: c.auto.lineOf }, c.auto.n ? `${c.auto.n} matched with the uploaded statement.` : '');
}

/* ---------- outstanding at the last cash exam ---------- */
const lineKey = (l) => `${l.date}|${l.debit || 0}|${l.credit || 0}|${chqKey(l.chq)}`;
// A check dated before the period (the last cash exam), not found in this statement and not ticked Still outstanding:
// taken as cleared before the period (not a reconciling item).
const preCheck = (x, from, rec) => x.kind === 'chk' && !x.cb && !!from && !!x.date && x.date < from && !(rec.found || {})[x.key] && !(rec.stillOut || {})[x.key];
function begLinesOf(rec, cand, jr, acct, booklets, cov) {
  const marks = rec.begMark || {}, out = new Set();
  const mine = jr.filter((c) => c.acctId === acct.id);
  const inJr = new Set(mine.map((c) => chkNo(c.checkNo)).filter(Boolean));
  const period = mine.filter((c) => c.date && (!cov.from || c.date >= cov.from)).map((c) => chkNo(c.checkNo)).filter(Boolean);
  const books = booklets.filter((b) => b.form === 'chk');
  const firstOf = (n) => { const b = books.find((x) => +x.from <= n && n <= +x.to); const ps = period.filter((p) => (b ? +b.from <= p && p <= +b.to : p - n < 1000)); return ps.length ? Math.min(...ps) : null; };
  cand.forEach((l) => {
    const m = marks[lineKey(l)];
    if (m === 0) return;
    if (m === 1) { out.add(l.i); return; }
    const n = +chqKey(l.chq);
    if (!l.debit || !n || inJr.has(n)) return;
    const f = firstOf(n); if (f && n < f) out.add(l.i);
  });
  return out;
}

/* ---------- import a soft copy ---------- */
// Check Nos. compared by digits only, without leading zeros (bank 0001749813 = books 1749813).
// Refunds of cash advances deposited in the bank with no OR (Liquidation Journal), of this account (none named: the first account).
const depRefunds = (liqs, lguId, acct, accounts) => liqs.filter((l) => l.lguId === lguId && l.type === 'refund' && l.deposited && (l.depAcctId || accounts[0]?.id) === acct.id && l.date);
const chqKey = (v) => String(v ?? '').replace(/\D/g, '').replace(/^0+/, '');
// Matches the book items to the bank lines: a check No. in the Cheque Number column wins; otherwise deposits to credits and
// checks to debits of the same amount, nearest date (bank on or after the book date: within 15 days for a deposit, a year for a check).
// found / lineOf / used are filled in; returns how many items were matched.
function matchItems(list, lines, found, lineOf, used) {
  let n = 0;
  const take = (x, l) => { used.add(l.i); found[x.key] = l.date; lineOf[x.key] = l.i; n++; };
  const tryMatch = (x, pick) => {
    if (found[x.key]) return;
    const cands = lines.filter((l) => !used.has(l.i) && Math.abs((x.kind === 'dep' ? l.credit : l.debit) - x.amount) < 0.005 && l.date && (!x.date || (days(x.date, l.date) >= -(x.win || 1) && days(x.date, l.date) <= (x.win || (x.kind === 'dep' ? 15 : 366)))));
    const l = pick(cands, x); if (l) take(x, l);
  };
  list.filter((x) => x.kind === 'chk' && !x.cb && !found[x.key]).forEach((x) => {
    const k = chqKey(x.ref); if (!k) return;
    const same = lines.filter((l) => !used.has(l.i) && l.debit && l.chq && chqKey(l.chq) === k);
    const l = same.find((y) => Math.abs(y.debit - x.amount) < 0.005);
    if (l) take(x, l);
    else same.forEach((y) => { y.note = `Check No. ${x.ref} is ₱${money(x.amount)} in the books`; });
  });
  list.filter((x) => x.kind === 'chk' && x.cb).forEach((x) => tryMatch(x, (cs) => cs.sort((a, b) => Math.abs(days(x.date, a.date)) - Math.abs(days(x.date, b.date)))[0]));
  list.filter((x) => x.kind === 'chk' && !x.cb).forEach((x) => tryMatch(x, (cs) => cs.find((l) => x.ref && !l.chq && chqKey(l.desc).includes(chqKey(x.ref))) || cs.filter((l) => !l.chq || !chqKey(x.ref)).sort((a, b) => Math.abs(days(x.date, a.date)) - Math.abs(days(x.date, b.date)))[0]));
  // Deposits: when several bank credits fit, the one whose description agrees with the deposit (check deposit ↔ CHECK / CHQ /
  // ONUS; cash deposit ↔ CASH) comes first, then the nearest date.
  const isChkTxt = (t) => /check|cheque|chq|\bchk\b|onus|on-us|clearing/i.test(String(t || '')), isCashTxt = (t) => /cash/i.test(String(t || ''));
  const kindOfDep = (x) => { const t = `${x.label || ''} ${x.ref || ''}`; return x.key.startsWith('tr|') || isChkTxt(t) ? 'chk' : isCashTxt(t) ? 'cash' : ''; };
  const kindOfLine = (l) => (isChkTxt(l.desc) ? 'chk' : isCashTxt(l.desc) ? 'cash' : '');
  const off = (x, l) => { const a = kindOfDep(x), b = kindOfLine(l); return a && b && a !== b ? 1 : 0; };
  list.filter((x) => x.kind === 'dep').sort((a, b) => (kindOfDep(a) ? 0 : 1) - (kindOfDep(b) ? 0 : 1)).forEach((x) => tryMatch(x, (cs) => cs.sort((a, b) => off(x, a) - off(x, b) || Math.abs(days(x.date, a.date)) - Math.abs(days(x.date, b.date)))[0]));
  return n;
}
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
      // Only the coverage of the cash exam: from the last cash exam date up to the cash count date.
      const { from, to } = c.cov;
      const lines = st.lines.filter((l) => (!from || l.date >= from) && l.date <= to);
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
      // Matches typed by hand stay; the import's own matches are made again against the new lines.
      const found = Object.fromEntries(Object.entries(rec.found || {}).filter(([k]) => !(rec.lineOf && k in rec.lineOf)));
      const used = new Set(), lineOf = {};
      matchItems(list.filter((x) => !(rec.noAuto || []).includes(x.key)), lines, found, lineOf, used);
      lines.forEach((l) => { l.matched = used.has(l.i); });
      // Beginning = the bank balance at the last cash exam (the line before the coverage, or worked back from the first line in it);
      // ending = the bank balance at the cash count (the last line in the coverage).
      const before = st.lines.filter((l) => from && l.date < from && l.bal !== null).pop();
      const first = lines[0];
      const opening = before ? before.bal : first.bal !== null ? r2(first.bal - first.credit + first.debit) : st.opening;
      const last = lines.filter((l) => l.bal !== null).pop();
      UI.manual = false; UI.edit = false; UI.only = false;
      const patch = { found, lineOf, lines, heads: st.heads, source: 'Soft copy (imported)', opening, account: st.account || '', covFrom: from, covTo: to, covStart: 'on', asOf: to, bankItems: [] };
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
export async function accountsModal(refs, lguId, accounts, funds, enc) {
  const list = accounts.map((x) => ({ ...x }));
  // Fund: pick from the list or type a new one (e.g. 5% BDRRM).
  const fundChoices = [...new Set(['General Fund', '5% BDRRM', '20% Development Fund', ...funds, ...accounts.map((x) => x.fund).filter(Boolean)])];
  const v = await modal({ title: `Bank Accounts · ${agencyName(refs, refs.lgu[lguId])}`, wide: true,
    body: `<p class="hint" style="margin:0">Each bank account of the auditee and its fund. Barangays usually have one account per fund; the LGU may have several.</p>
      <div class="af-tbl"><table class="af-reg cd-edit"><thead><tr><th scope="col">Bank</th><th scope="col">Account No.</th><th scope="col">Fund</th><th scope="col"></th></tr></thead><tbody id="ba-rows"></tbody></table></div>
      <datalist id="ba-funds">${fundChoices.map((f) => `<option value="${esc(f)}">`).join('')}</datalist>
      ${enc ? '<button class="btn sm" type="button" id="ba-add">+ Add Account</button>' : ''}`,
    onOpen: (bg) => {
      const draw = () => {
        $('#ba-rows', bg).innerHTML = list.map((x, i) => `<tr data-i="${i}"><td><input class="input" data-k="bank" value="${esc(x.bank || '')}" placeholder="e.g. Land Bank, Maddela" aria-label="Bank" ${enc ? '' : 'disabled'}></td>
          <td><input class="input mono" data-k="accountNo" value="${esc(x.accountNo || '')}" aria-label="Account No." ${enc ? '' : 'disabled'}></td>
          <td><input class="input" data-k="fund" list="ba-funds" value="${esc(x.fund || '')}" placeholder="Choose or type" aria-label="Fund" ${enc ? '' : 'disabled'}></td>
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
  const clean = list.filter((x) => x.bank || x.accountNo).map((x) => ({ id: x.id || newId('ba'), bank: String(x.bank || '').trim(), accountNo: String(x.accountNo || '').trim(), fund: String(x.fund || '').trim() || funds[0] }));
  await store.save('cer_settings', 'banks|' + lguId, { list: clean }, by(refs));
  toast('Bank accounts saved.', 'ok');
}

/* ---------- for Verification: the bank accounts of the auditee, as findings ---------- */
export async function bankFindings(audit, refs) {
  const [settings0, reports0, advs0, recs0, exams0, books0, cut0, jr0, liq0] = await Promise.all(['cer_settings', 'cer_reports', 'cer_cashadv', 'cer_bankrec', 'cer_exams', 'cer_booklets', 'cer_cutoff', 'src_ckdj', 'cer_liquid'].map(listT));
  const accounts = (settings0.map(flat).find((x) => x.id === 'banks|' + audit.lguId) || {}).list || [];
  const examIds = new Set(exams0.map(flat).filter((e) => e.auditId === audit.id).map((e) => e.id));
  const cuts = lastChecksOf({ cutoffs: cut0.map(flat), booklets: books0.map(flat) }, examIds);
  const out = [], add = (key, text) => out.push({ key, text });
  const asOf = audit.countDate;
  for (const acct of accounts) {
    const recsAll = recs0.map(flat), rec0 = recsAll.find((r) => r.id === `${audit.id}|${acct.id}`);
    const rec = rec0 ? inCov(withLines(rec0, recsAll), covOf(audit, exams0.map(flat))) : rec0;
    const name = acctLabel(acct);
    { const cv = covOf(audit, exams0.map(flat)); const nCk = jr0.map(flat).filter((c) => c.acctId === acct.id && c.lguId === audit.lguId && c.date && (!cv.from || c.date >= cv.from) && c.date <= cv.to).length;
      if (!nCk) add(`bkck|${acct.id}`, `${name}: no checks in the Check Disbursements Journal for the period (Source Documents).`); }
    if (!rec) { add(`bk0|${acct.id}`, `${name}: no bank statement or reconciliation yet.`); continue; }
    const items = [];
    const toLOs = new Set(exams0.map(flat).filter((e) => e.auditId === audit.id && e.remitToLO).map((e) => e.officerId));
    reports0.map(flat).filter((r) => r.lguId === audit.lguId && r.fund === acct.fund && r.kind !== 'SCR' && !toLOs.has(r.officerId)).forEach((r) => depItems(r).filter(({ d }) => !d.toLO).forEach(({ d, key, old }) => items.push({ key, old, kind: 'dep', date: d.date, ref: d.ref || '', amount: +d.amount || 0 })));
    advs0.map(flat).filter((a) => a.lguId === audit.lguId && !a.beg && (() => { const ac = caAcct(a, { booklets: books0.map(flat), accounts, jr: jr0.map(flat) }); return ac ? ac.id === acct.id : acct.id === accounts[0]?.id; })()).forEach((a) => items.push({ key: `chk|${a.id}`, kind: 'chk', date: a.date, ref: a.checkNo, amount: +a.amount || 0 }));
    const jrChecks = bankChecksOf(jr0.map(flat), acct.id), jrNos = new Set(jrChecks.map((c) => chkNo(c.checkNo)));
    jrChecks.forEach((c) => items.push({ key: `jr|${c.id}`, kind: 'chk', date: c.date, ref: c.checkNo, amount: checkAmountOf(c) }));
    depRefunds(liq0.map(flat), audit.lguId, acct, accounts).forEach((l) => items.push({ key: `rf|${l.id}`, kind: 'dep', label: 'Refund', date: l.date, ref: l.ref || '', amount: +l.amount || 0 }));
    (rec.otherChecks || []).filter((c) => !jrNos.has(chkNo(c.checkNo))).forEach((c) => items.push({ key: `oth|${c.id}`, kind: 'chk', date: c.date, ref: c.checkNo, amount: +c.amount || 0 }));
    items.push(...cashbookItems(settings0.map(flat), examIds, acct.id));
    (remOf(Object.fromEntries(settings0.map((x) => [x.id, x.data])), audit.lguId).list || []).filter((r) => remAcctId(r, accounts) === acct.id).forEach((r) => items.push({ key: `tx|${r.id}`, kind: 'chk', cb: true, win: 3, date: r.date, ref: remText(r), amount: +r.amount || 0 }));
    { const cbCr = items.filter((x) => x.cb && x.kind === 'dep');
      transfersInto(jr0.map(flat), acct, audit.lguId).filter((c) => !cbCr.some((x) => typedTransfer(c, { date: x.date, amount: x.amount, text: x.ref })))
        .forEach((c) => items.push({ key: `tr|${c.id}`, kind: 'dep', date: c.date, ref: `Check No. ${c.checkNo}`, amount: checkAmountOf(c) })); }
    const tidy = tidyFound(rec, items); const found = tidy.found; rec.found = tidy.found; rec.lineOf = tidy.lineOf;
    const list = items.filter((x) => x.date && x.date <= asOf);
    const after = (x) => { const n = +chqKey(x.ref); return x.kind === 'chk' && !x.cb && !!n && cuts.some((c) => n >= c.from && n <= c.to && n > c.last); };
    const cvF = covOf(audit, exams0.map(flat)).from;
    const dits = list.filter((x) => x.kind === 'dep' && !found[x.key]), ocs = list.filter((x) => x.kind === 'chk' && !found[x.key] && !after(x) && !preCheck(x, cvF, rec));
    const dit = r2(dits.reduce((n, x) => n + x.amount, 0)), oc = r2(ocs.reduce((n, x) => n + x.amount, 0));
    const linked = new Set(Object.entries(rec.lineOf || {}).filter(([k]) => found[k]).map(([, i]) => i));
    const cand = (rec.lines || []).filter((l) => !(rec.lineOf ? linked.has(l.i) : l.matched) && !l.added && l.date <= asOf);
    const begS = begLinesOf(rec, cand, jr0.map(flat), acct, books0.map(flat), covOf(audit, exams0.map(flat)));
    const un = cand.filter((l) => !begS.has(l.i));
    const sum = (a, g) => r2(a.reduce((n, x) => n + (+g(x) || 0), 0));
    const bi = (rec.bankItems || []).filter((b) => !b.date || b.date <= asOf);
    const unCr = sum(un, (l) => l.credit), unDr = sum(un, (l) => l.debit);
    const credits = r2(unCr + sum(bi.filter((b) => b.type === 'credit'), (b) => b.amount)), debits = r2(unDr + sum(bi.filter((b) => b.type === 'debit'), (b) => b.amount));
    // Not Matched: the cheque number is in the books with another amount.
    const nmSeen = new Set();
    un.filter((l) => l.debit && l.chq).forEach((l) => { const x = list.find((y) => y.kind === 'chk' && !y.cb && !found[y.key] && !nmSeen.has(y.key) && chqKey(y.ref) && chqKey(y.ref) === chqKey(l.chq) && Math.abs(y.amount - l.debit) >= 0.005);
      if (x) { nmSeen.add(x.key); add(`bkamt|${acct.id}|${l.i}|${x.amount}`, `${name}: cheque ${l.chq} of ${fmtDate(l.date)} is ₱${money(l.debit)} in the bank; the books show ₱${money(x.amount)}.`); } });
    if (un.length) add(`bkun|${acct.id}|${un.length}|${unCr}|${unDr}`, `${name}: ${un.length} bank line${un.length > 1 ? 's' : ''} not in the books (credits ₱${money(unCr)}, debits ₱${money(unDr)}). Interest and service charges are expected; look into the rest (Bank Statements, tab 1, "Not in the books only").`);
    if (dits.length) add(`bkdit|${acct.id}|${dits.length}|${dit}`, `${name}: ${dits.length} deposit${dits.length > 1 ? 's' : ''} in transit, ₱${money(dit)}: ${dits.slice(0, 6).map((x) => `${x.ref || 'deposit'} ${fmtDate(x.date)}`).join(', ')}${dits.length > 6 ? '…' : ''}.`);
    if (ocs.length) add(`bkoc|${acct.id}|${ocs.length}|${oc}`, `${name}: ${ocs.length} outstanding check${ocs.length > 1 ? 's' : ''}, ₱${money(oc)}: ${ocs.slice(0, 6).map((x) => x.ref).join(', ')}${ocs.length > 6 ? '…' : ''}.`);
    if (rec.book === null || rec.book === undefined || rec.book === '') { const e = await (await import('./cashbook.js')).cashbookEnding(refs, audit, acct).catch(() => null); if (e !== null && e !== undefined) rec.book = e; }
    const hasEnd = rec.ending !== null && rec.ending !== undefined && rec.ending !== '', hasBook = rec.book !== null && rec.book !== undefined && rec.book !== '';
    if (!hasEnd || !hasBook) add(`bkrc0|${acct.id}`, `${name}: bank reconciliation not complete (${!hasEnd ? 'no bank balance' : 'no cashbook balance'}).`);
    else { const d = r2((+rec.ending + dit - oc) - (+rec.book + credits - debits)); if (Math.abs(d) >= 0.005) add(`bkrc|${acct.id}|${d}`, `${name}: adjusted bank and adjusted book balances differ by ₱${money(d)}.`); }
  }
  return out;
}
