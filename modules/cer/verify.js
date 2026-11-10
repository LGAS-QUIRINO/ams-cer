// CER · Verification (design approved 18 Oct 2026).
// Puts everything encoded together for the auditor, per accountable officer, within the scope of audit (last cash exam to the count):
//   1. Statement of Accountability  GF 74-A part D: per nature of funds (barangays AF 51 (SCD), CTC (SCR); LGU Collections (RCD);
//                                   Cash Advance): balance last exam + debits − credits = balance; inventory (Cash Count); shortage / (overage).
//                                   By Month: the same, month by month (Annex C / D).
//   2. Reconciliation with the officer's books (Annex E – G): cashbook balance and unrecorded items, typed.
//   3. Findings: every flag of the examination is here only (the other screens just record). Shown once the auditor ticks
//      "Encoding complete" for the officer (until then a progress line); the auditor decides each one (Cleared, Noted, For AOM).
//
// Records:
//   cer_verify  id = examId  { examId, recon{ <column>: { cashbook, unrecBeg, unrecDebit, unrecCredit } },
//                              decisions{ <finding key>: { decision, remarks } }, complete, completeBy, completeAt, ready, readyBy, readyAt }
import { cnpData, fnpData } from './cnp.js';
import { listT } from '../src/journal.js';
import { store } from '../../js/store.js';
import { esc, toast, $, $$ } from '../../js/ui.js';
import { hasRole, isAuditor, by, mayView, cycleOk, loadCer, pickAudit, pickExam, remember, getPick, agencyName, fmtDate, money, num, bondChecks, holidaysOf, addBankingDays } from './cer.js';
import { bankFindings } from './banks.js';
import { loadForms, orIn, cutoffFindings, checkUsage, exportXlsx } from './forms.js';
import { figuresOf, fundsOf, kindOfForm, repName, tagSameDay, partOk, ctcBegShare, ctcAlloc, depPart } from './collections.js';
import { booksOf, compute } from './count.js';

const r2 = (n) => Math.round(n * 100) / 100;
const flat = (r) => ({ id: r.id, ...r.data });
const bad = (m) => { toast(m, 'bad'); return false; };
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const go = (params) => { const q = new URLSearchParams(location.hash.split('?')[1] || ''); Object.entries(params).forEach(([k, v]) => (v ? q.set(k, v) : q.delete(k))); location.hash = location.hash.split('?')[0] + '?' + q.toString(); };
const DECISIONS = ['To decide', 'Cleared', 'Noted', 'For AOM'];
const BEG_CA = ['ca', 'sdo', 'pcf'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const UI = { view: 'sum' };
const fmtAmt = (n) => (n < -0.004 ? `(${money(-n)})` : money(n));

// The statement of accountability of one officer (shared with Reports): columns, movements within the scope, balances, inventory.
// The ending balances of an examination (balance per books at the count, per accountability), saved on its exam record as
// endBalances { <Audit Setup balance key>: amount }: the next cash exam of the officer shows them as its beginning (carried).
export function endingOf(exam, st, lgu) {
  const out = {}, forms = exam.forms || [], fns = exam.functions || [];
  st.forEach((b) => {
    if (b.key === 'ca') { const k = fns.includes('disbursing') ? 'ca' : fns.includes('special') ? 'sdo' : fns.includes('pettycash') ? 'pcf' : 'ca'; out[k] = r2(b.balance); return; }
    const mine = forms.filter((x) => kindOfForm(lgu, x) === b.kind && partOk(b.part || '', x));
    if (mine.length && fns.includes('collecting')) { mine.forEach((x, i) => { out['col-' + x] = i ? 0 : r2(b.balance); }); return; }
    if (fns.includes('liquidating')) out.liq = r2((out.liq || 0) + b.balance);
  });
  return out;
}
async function saveEnding(refs, exam, st, lgu) {
  const r = await store.get('cer_exams', exam.id); if (!r || r.deleted) return;
  await store.save('cer_exams', exam.id, { ...r.data, endBalances: endingOf(r.data, st, lgu), endAt: new Date().toISOString().slice(0, 10) }, by(refs), { quiet: true });
}
export function accountability(refs, f, audit, exam, advs, liqs, counts) {
  const lgu = refs.lgu[audit.lguId];
  const from = exam.lastExamDate || '', to = audit.countDate;
  const o = exam.o;
  const inScope = (d) => !!d && (!from || d >= from) && d <= to;   // from the last cash exam date (after its cut-off)
  const orOk = (x) => orIn(f, x, from, to);
  // A liquidation counts when dated within the scope, or when the auditor ticked "Count even if outside the scope".
  const liqIn = (l) => inScope(l.date) || !!l.countAnyway;
  const bal = exam.balances || {};
  const fig = figuresOf(f, o, fundsOf(f, audit.lguId), to, lgu, exam);
  const books = booksOf(refs, f, o, exam, audit, advs, liqs);   // the columns, same as Cash Count
  const count = counts.find((c) => c.id === exam.id) || null;
  const inv = count ? compute({ bills: count.bills || {}, coins: count.coins || 0, items: count.items || [], split: count.split || {} }, books).inv : null;

  // Movements per column, each { date, debit, credit }.
  const moves = {};
  books.forEach((b) => {
    const m = [];
    let beg = 0;
    if (b.key === 'ca') {
      beg = BEG_CA.reduce((n, k) => n + (+(bal[k]?.amount) || 0), 0);
      advs.filter((a) => a.officerId === o.id && !a.beg && inScope(a.date)).forEach((a) => m.push({ date: a.date, debit: +a.amount || 0, credit: 0 }));
      liqs.filter((l) => l.officerId === o.id && liqIn(l)).forEach((l) => m.push({ date: l.date, debit: 0, credit: +l.amount || 0 }));
    } else {
      const kind = b.kind, part = b.part || '', bs = ctcBegShare(bal);
      // Beginning: the collection balances in Audit Setup of the forms that go to this report type (LGU: CTC apart from AF 51).
      beg = Object.entries(bal).filter(([k]) => k.startsWith('col-') && kindOfForm(lgu, k.slice(4)) === kind && partOk(part, k.slice(4))).reduce((n, [, v]) => n + (+v?.amount || 0), 0)
        + ((kind === 'RCD' || (exam.functions || []).includes('liquidating')) && part !== 'ctc' ? (+(bal.liq?.amount) || 0) : 0);
      f.ors.filter((x) => x.officerId === o.id && x.status !== 'cancelled' && kindOfForm(lgu, x.form) === kind && partOk(part, x.form) && orOk(x)).forEach((x) => m.push({ date: x.date, debit: +x.amount || 0, credit: 0 }));
      Object.values(fig.chains).filter((c) => c.kind === kind).forEach((c) => [...c.figs, c.pend].forEach((g) => {
        const s = part ? ctcAlloc(c, bs) : null;
        (g.rec?.deposits || []).filter((d) => inScope(d.date)).forEach((d) => { const a = part ? depPart(part, d, s) : +d.amount || 0; if (a || !part) m.push({ date: d.date, debit: 0, credit: a }); });
        if (part !== 'ctc') (g.rec?.remittances || []).filter((d) => inScope(d.date)).forEach((d) => m.push({ date: d.date, debit: +d.amount || 0, credit: 0 }));
      }));
    }
    moves[b.key] = { beg: r2(beg), list: m.sort((x, y) => x.date.localeCompare(y.date)) };
  });
  const st = books.map((b) => {
    const mv = moves[b.key];
    const debit = r2(mv.list.reduce((n, x) => n + x.debit, 0)), credit = r2(mv.list.reduce((n, x) => n + x.credit, 0));
    const balance = r2(mv.beg + debit - credit);
    const invd = inv ? r2(inv[b.key] || 0) : null;
    return { ...b, beg: mv.beg, debit, credit, balance, inv: invd, sh: invd === null ? null : r2(balance - invd) };
  });
  const T = (k) => r2(st.reduce((n, x) => n + (x[k] || 0), 0));
  const totSh = inv ? T('sh') : null;

  return { o, lgu, from, to, inScope, orOk, liqIn, bal, fig, books, count, inv, moves, st, T, totSh };
}

export async function verifyView(ctx) {
  const { refs, q } = ctx;
  const f = await loadForms();
  const [reports, advs0, liqs0, counts0, ver0, bank0] = await Promise.all(['cer_reports', 'cer_cashadv', 'cer_liquid', 'cer_cashcount', 'cer_verify', 'cer_bankrec'].map(listT));
  f.reports = tagSameDay(reports.map(flat));
  const advs = advs0.map(flat), liqs = liqs0.map(flat);
  const crumb = 'Verification';
  const hello = `<div class="hello"><div><h1>Verification</h1><p>Everything encoded is put together for the auditor: the statement of accountability, the reconciliation with the officer's books, and the findings to decide on.</p></div></div>`;
  const audits = f.audits.filter((a) => mayView(refs, refs.lgu[a.lguId]) && (cycleOk(a) || a.id === q.get('a'))).sort((a, b) => String(b.countDate).localeCompare(String(a.countDate)));
  if (!audits.length) return { crumb, body: hello + '<div class="panel"><div class="empty"><b>No cash examination yet.</b>The auditors set one up in Audit Setup.</div></div>' };
  const audit = pickAudit(audits, q);
  const lgu = refs.lgu[audit.lguId];
  const exams = f.exams.filter((e) => e.auditId === audit.id).map((e) => ({ ...e, o: f.officers.find((x) => x.id === e.officerId) })).filter((e) => e.o);
  const exam = pickExam(exams, q, audit) || exams[0] || null; remember(refs, audit, exam);
  const from = exam?.lastExamDate || '', to = audit.countDate;
  const top = `<div class="panel cd-bar cc-bar">
      <div class="field"><label for="vf-audit">Cash Examination</label><select class="input" id="vf-audit">${audits.map((a) => `<option value="${esc(a.id)}" ${a.id === audit.id ? 'selected' : ''}>${esc(agencyName(refs, refs.lgu[a.lguId]))} · ${esc(fmtDate(a.countDate))}</option>`).join('')}</select></div>
      <div class="field"><label for="vf-exam">Accountable Officer</label><select class="input" id="vf-exam">${exams.length ? exams.map((e) => `<option value="${esc(e.id)}" ${exam && e.id === exam.id ? 'selected' : ''}>${esc(e.o.name)}${e.o.designation ? ' · ' + esc(e.o.designation) : ''}</option>`).join('') : '<option value="">No officer in this examination</option>'}</select></div>
      <div class="field"><span class="cd-lbl">Scope of Audit</span><div class="cc-cpn"><b>${esc(fmtDate(from) || '—')} to ${esc(fmtDate(to))}</b></div></div></div>`;
  const wireTop = () => {
    $('#vf-audit').onchange = (e) => go({ a: e.target.value, e: '' });
    $('#vf-exam').onchange = (e) => go({ e: e.target.value });
  };
  if (!exam) return { crumb, body: hello + top + '<div class="panel"><div class="empty"><b>No accountable officer in this cash examination.</b>Add the officers in Audit Setup.</div></div>', wire: wireTop };

  const { o, inScope, orOk, liqIn, bal, fig, books, count, inv, moves, st, T, totSh } = accountability(refs, f, audit, exam, advs, liqs, counts0.map(flat));
  // Findings, each with a stable key so the auditor's decision stays with it.
  const findings = [];
  const add = (key, area, text, href) => findings.push({ key, area, text, href });
  st.forEach((x) => { if (x.sh !== null && Math.abs(x.sh) > 0.004) add(`sh|${x.key}`, 'Cash Count', `${x.sh > 0 ? 'Shortage' : 'Overage'} of ₱${money(Math.abs(x.sh))} in ${x.label}: balance of accountability ₱${money(x.balance)}, inventory ₱${money(x.inv)}.`, '#/cer/count'); });
  if (!count) add('nocount', 'Cash Count', 'No cash count saved yet for this officer.', '#/cer/count');
  (count?.items || []).forEach((it, i) => { const a = num(it.allowed ?? it.presented) ?? 0; if ((+it.presented || 0) - a > 0.004) add(`dis|${i}|${it.particulars}`, 'Cash Count', `Cash item disallowed: ${it.particulars}, ₱${money(r2((+it.presented || 0) - a))}.`, '#/cer/count'); });
  Object.values(fig.chains).forEach((c) => [...c.figs, c.pend].forEach((g) => g.issues.forEach((t, i) => (exam.records === 'cashbook' && t.startsWith('Series ')) || add(`rep|${g.id}|${i}|${t.slice(0, 40)}`, 'Collections', `${g.pending ? `Not yet reported (${g.kind})` : repName(g.rec, g.kind)}: ${t}`, '#/cer/collections'))));
  const unrep = Object.values(fig.chains).map((c) => c.pend).filter((g) => g.nOrs);
  unrep.forEach((g) => add(`nyr|${g.id}`, 'Collections', `${g.nOrs} OR${g.nOrs > 1 ? 's' : ''} (₱${money(g.orsTotal)}) not yet in a submitted ${g.kind}, ${g.fund}.`, '#/cer/collections'));
  f.ors.filter((x) => x.officerId === o.id && x.date > to).slice(0, 1).forEach(() => add('afterct', 'Collections', `${f.ors.filter((x) => x.officerId === o.id && x.date > to).length} OR(s) dated after the cash count.`, '#/cer/collections'));
  // Collections by OR range (cashbooks): the collector's cashbook against the Liquidating Officer's, and the beginning.
  cashbookFindings(f, o, exam, from, to).forEach((x) => add(x.key, 'Collections', x.text, '#/cer/collections'));
  { const np = cnpData(f, o, exam, from, to); if (np && np.notPresented > 0.004) add(`cnp|${np.notPresented}`, 'Collections', `₱${money(np.notPresented)}${np.groups.filter((g) => g.notPresented > 0.004).length > 1 ? ` (${np.groups.filter((g) => g.notPresented > 0.004).map((g) => `₱${money(g.notPresented)} ${g.short}`).join('; ')})` : ''} of collections dated before the last cash examination (${fmtDate(from)}) were not remitted as of that date; remitted only in this period (see the working paper: Collections not remitted as of the last cash exam).`, `#/cer/reports?a=${audit.id}&e=${exam.id}&rep=cnp`); }
  // Each beginning OR range (Audit Setup) against the ORs encoded in it, when both are there.
  Object.entries(exam.balances || {}).forEach(([k, v]) => (v?.begOrs || []).forEach((x) => {
    const amt = num(String(x.amount ?? '')); if (amt === null || amt === undefined || amt === '') return;
    const ins = f.ors.filter((y) => y.officerId === o.id && y.form === k.slice(4) && y.status !== 'cancelled' && +y.serial >= +x.from && (y.range ? +y.serialTo : +y.serial) <= +x.to);
    if (!ins.length) return;
    const t = r2(ins.reduce((n, y) => n + (y.items || []).reduce((m, i) => m + (+i.amt || 0), 0), 0));
    if (Math.abs(t - amt) > 0.004) add(`begor|${k}|${x.from}|${t}`, 'Collections', `Beginning ORs ${x.from}–${x.to}: ₱${money(amt)} in Audit Setup; the ORs encoded in it total ₱${money(t)}.`, '#/cer/setup');
  }));
  { const np = cnpData(f, o, exam, from, to); (np?.begCheck || []).filter((b) => Math.abs(b.ors - b.beg) > 0.004).forEach((b) => add(`begser|${b.form}|${b.ors}`, 'Collections', `${b.short} beginning balance ₱${money(b.beg)} (Audit Setup); the ORs encoded in its series ${b.text} total ₱${money(b.ors)}.`, '#/cer/setup')); }
  { const fn = fnpData(f, o, exam, from, to); if (fn && fn.qty) add(`fnp|${fn.qty}`, 'Accountable Forms', `${fn.qty} accountable form${fn.qty > 1 ? 's' : ''} issued before the last cash examination (${fmtDate(from)}) were not presented then${fn.groups.length > 1 ? ` (${fn.groups.map((g) => `${g.qty} ${g.short}`).join('; ')})` : ` (${fn.groups[0].short})`}; their collections were remitted only in this period (see the working paper: Accountable forms not presented at the last cash exam).`, `#/cer/reports?a=${audit.id}&e=${exam.id}&rep=fnp`); }
  cutoffFindings(f, o, exam, from, to).forEach((x) => add(`af|${x.key}`, 'Accountable Forms', x.text, x.key === 'nocut' || x.key.startsWith('np|') || x.key.startsWith('nir|') ? `#/cer/count?a=${audit.id}&e=${exam.id}` : '#/cer/forms'));
  // Late deposits: collections deposited in date order (first in, first out) against the deadline of the officer's rule.
  const hol = await holidaysOf(refs, audit.lguId);
  const brgy = lgu && lgu.data.kind === 'barangay';
  const rule = brgy ? 'brgy' : exam.depositRule === 'weekly' ? 'weekly' : 'next';
  const dueOf = (d) => (rule === 'brgy' ? addBankingDays(d, 5, hol) : rule === 'next' ? addBankingDays(d, 1, hol) : (() => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + 7); return x.toISOString().slice(0, 10); })());
  const ruleText = rule === 'brgy' ? 'within 5 banking days (Barangay Treasurer)' : rule === 'next' ? 'not later than the next banking day' : 'at least once a week, or the next banking day once collections reach ₱10,000';
  Object.values(fig.chains).filter((c) => c.kind !== 'SCR' && !exam.remitToLO).forEach((c) => {   // remitted to the LO: no deposit deadline
    const gs = [...c.figs, c.pend];
    const coll = {}; const put = (d, a) => { if (inScope(d) && a) coll[d] = r2((coll[d] || 0) + a); };
    gs.forEach((g) => { (g.ors || []).filter((x) => x.status !== 'cancelled' && orOk(x)).forEach((x) => put(x.date, +x.amount || 0)); (g.rec?.remittances || []).forEach((m) => put(m.date, +m.amount || 0)); });
    const deps = {}; gs.forEach((g) => (g.rec?.deposits || []).filter((d) => inScope(d.date)).forEach((d) => { deps[d.date] = r2((deps[d.date] || 0) + (+d.amount || 0)); }));
    const queue = []; const begAmt = r2(+(gs[0]?.beg) || 0);
    if (begAmt > 0.004 && from) queue.push({ date: from, amt: begAmt, due: from, beg: true });
    const late = [];
    const dates = [...new Set([...Object.keys(coll), ...Object.keys(deps)])].sort();
    dates.forEach((d) => {
      if (coll[d]) queue.push({ date: d, amt: coll[d], due: dueOf(d) });
      let dep = deps[d] || 0;
      while (dep > 0.004 && queue.length) { const q0 = queue[0]; const take = Math.min(q0.amt, dep); if (d > q0.due) late.push({ ...q0, amt: r2(take), dep: d }); q0.amt = r2(q0.amt - take); dep = r2(dep - take); if (q0.amt <= 0.004) queue.shift(); }
      if (rule === 'weekly' && queue.reduce((n, q1) => n + q1.amt, 0) >= 10000) { const nb = addBankingDays(d, 1, hol); queue.forEach((q1) => { if (nb < q1.due) q1.due = nb; }); }
    });
    queue.filter((q1) => q1.due < to && q1.amt > 0.004).forEach((q1) => late.push({ ...q1, dep: '' }));
    // One finding per deposit (and one for what is still undeposited at the cut-off), listing the collection dates it covered late.
    const byDep = {}; late.forEach((x) => (byDep[x.dep] = byDep[x.dep] || []).push(x));
    Object.entries(byDep).forEach(([dep, xs]) => {
      const amt = r2(xs.reduce((n, x) => n + x.amt, 0));
      const dates = xs.map((x) => (x.beg ? 'the balance at the last cash exam' : fmtDate(x.date)));
      const span = dates.length > 3 ? `${dates[0]} to ${dates[dates.length - 1]} (${dates.length} days)` : dates.join(', ');
      add(`latedep|${c.kind}|${c.fund}|${dep}|${xs.length}|${amt}`, 'Collections', `${dep ? `Deposit of ${fmtDate(dep)}` : 'Undeposited at the cut-off'} (${c.fund}): ₱${money(amt)} of collections of ${span} ${dep ? 'deposited late' : 'past the deadline'}; earliest due ${fmtDate(xs.map((x) => x.due).sort()[0])}. Rule: ${ruleText}.`, '#/cer/collections');
    });
  });
  const mineAdv = advs.filter((a) => a.officerId === o.id && (!a.beg || a.begExamId === exam.id));
  mineAdv.forEach((a) => {
    const l = r2(liqs.filter((x) => x.advanceId === a.id && (x.date <= to || x.countAnyway)).reduce((n, x) => n + (+x.amount || 0), 0)); const left = r2((+a.amount || 0) - l);
    if (a.date <= to && left > 0.004) add(`ca|${a.id}`, 'Cash Advances', `Check No. ${a.checkNo} (₱${money(a.amount)}${a.particulars ? ', ' + a.particulars : ''}) has ₱${money(left)} unliquidated at the count.`, '#/cer/advances');
    if (left < -0.004) add(`caover|${a.id}`, 'Cash Advances', `Check No. ${a.checkNo} is over-liquidated by ₱${money(-left)}.`, '#/cer/advances');
  });
  const myReports = new Set(f.reports.filter((r) => r.officerId === o.id).map((r) => r.id));
  bank0.map(flat).filter((r) => r.auditId === audit.id).forEach((rec) => Object.entries(rec.found || {}).forEach(([k, bd]) => {
    const [t, rid, d, ref, amt] = k.split('|');
    if (t === 'dep' && myReports.has(rid) && d && bd && days(d, bd) > 0) add(`late|${k}`, 'Bank Statements', `${ref || 'Deposit'} of ${fmtDate(d)} (₱${money(+amt)}) reached the bank ${days(d, bd)} day${days(d, bd) > 1 ? 's' : ''} later, on ${fmtDate(bd)}.`, '#/cer/banks');
  }));
  bondChecks({ bond: exam.bond || {}, countDate: to }).forEach((w, i) => add(`bond|${i}`, 'Audit Setup', w.text.replace(/<[^>]+>/g, ''), '#/cer/setup?a=' + audit.id));
  const maxCash = num(exam.bond?.maxCash);
  if (maxCash && T('balance') > maxCash + 0.004) add('maxcash', 'Cash Count', `Accountability at the count, ₱${money(T('balance'))}, is more than the maximum cash accountability of ₱${money(maxCash)}.`, '#/cer/count');
  // Beginning checks of a cash advance balance more than the lump sum typed in Audit Setup.
  ['ca', 'sdo', 'pcf'].forEach((k) => { const b = exam.balances?.[k]; if (!b) return; const lump = +b.lump || 0; const s = r2(advs.filter((a) => a.beg && a.begExamId === exam.id && (a.begKey || 'ca') === k).reduce((n, a) => n + (+a.amount || 0), 0));
    if (lump && s > lump + 0.004) add(`beglump|${k}`, 'Audit Setup', `Beginning checks of the cash advance total ₱${money(s)}, more than the ₱${money(lump)} typed as the balance at the last cash exam.`, '#/cer/setup?a=' + audit.id); });
  // Refunds of cash advances: the OR No. should be an OR in Collections & Deposits with the same amount.
  // Liquidations / refunds outside the scope: counted when ticked; before the last cash exam and not ticked, not counted.
  liqs.filter((l) => l.officerId === o.id && l.date && !inScope(l.date)).forEach((l) => {
    const before = from && l.date < from;
    if (!l.countAnyway && !before) return;   // after the count: a later liquidation, nothing to say
    const what = `${l.type === 'refund' ? 'Refund OR' : 'Liquidation'} ${l.ref || ''}, ${fmtDate(l.date)}, ₱${money(l.amount)}`;
    add(`liqout|${l.id}|${l.countAnyway ? 1 : 0}`, 'Cash Advances', `${what}: ${before ? 'before the last cash exam' : 'after the cash count'}, ${l.countAnyway ? 'counted' : 'not counted'}.`, '#/cer/advances');
  });
  liqs.filter((l) => l.officerId === o.id && l.type === 'refund' && liqIn(l)).forEach((l) => {
    const n = parseInt(String(l.ref || '').replace(/[^\d]/g, ''), 10);
    const hit = n ? f.ors.find((x) => x.lguId === audit.lguId && +x.serial === n && x.status !== 'cancelled') : null;
    if (!hit) add(`refund|${l.id}`, 'Cash Advances', `Refund OR No. ${l.ref} of ${fmtDate(l.date)} (₱${money(l.amount)}) is not found in Collections & Deposits.`, '#/cer/collections');
    else if (Math.abs((+hit.amount || 0) - (+l.amount || 0)) > 0.004) add(`refundamt|${l.id}`, 'Cash Advances', `Refund OR No. ${l.ref}: ₱${money(l.amount)} in Cash Advances, ₱${money(hit.amount)} in Collections & Deposits.`, '#/cer/collections');
  });
  (await bankFindings(audit, refs)).forEach((x) => add(`bank|${x.key}`, 'Bank Statements', x.text, '#/cer/banks?a=' + audit.id));
  // Late deposits per the bank (deposit slip date vs the date the bank credited it) stay under Bank Statements.

  const ver = ver0.map(flat).find((v) => v.id === exam.id) || { recon: {}, decisions: {} };
  // Marked ready before the ending balances were kept: saved now, for the officer's next cash exam.
  if (ver.ready && !exam.endBalances) saveEnding(refs, exam, st, lgu);
  // Progress of the encoding, shown until the auditor ticks "Encoding complete".
  const myOrs = f.ors.filter((x) => x.officerId === o.id && orOk(x));
  const lastOr = myOrs.map((x) => x.date).sort().pop();
  const nRep = f.reports.filter((r) => r.officerId === o.id && !r.pending).length;
  const myAdv = advs.filter((a) => a.officerId === o.id && !a.beg && inScope(a.date)), myLiq = liqs.filter((l) => l.officerId === o.id && liqIn(l));
  const nCut = (f.cutoffs || []).find((c) => c.id === exam.id)?.lines?.length || 0;
  const progress = [`Cut-off: ${nCut ? `${nCut} line${nCut > 1 ? 's' : ''} of remaining forms` : 'not entered'}${count ? ', cash counted' : ', no cash count'}`,
    `Collections & Deposits: ${myOrs.length} OR${myOrs.length === 1 ? '' : 's'}${lastOr ? ` up to ${fmtDate(lastOr)}` : ''} · ${nRep} report${nRep === 1 ? '' : 's'}`,
    `Cash Advances: ${myAdv.length} check${myAdv.length === 1 ? '' : 's'} · ${myLiq.length} liquidation${myLiq.length === 1 ? '' : 's'}`];
  const complete = !!ver.complete;
  const chkInfo = checkUsage(f, o, exam, from, to, advs.filter((a) => a.officerId === o.id));
  const chkHtml = chkInfo.length ? `<div class="vf-info"><b>Checks used</b> <span class="dim">(information only, until Checks Issued is built)</span><ul>${chkInfo.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>` : '';
  const dec = (k) => ver.decisions?.[k] || { decision: 'To decide', remarks: '' };
  const decided = findings.filter((x) => dec(x.key).decision !== 'To decide').length;
  const auditor = isAuditor(refs);
  const dis = auditor ? '' : 'disabled';
  const show = q.get('show') || '';
  const shownF = findings.filter((x) => !show || (show === 'todo' ? dec(x.key).decision === 'To decide' : dec(x.key).decision === 'For AOM'));

  // Statement by month (Annex C / D)
  const months = [];
  if (UI.view === 'month') {
    const keys = [...new Set(books.flatMap((b) => moves[b.key].list.map((x) => x.date.slice(0, 7))))].sort();
    const run = Object.fromEntries(books.map((b) => [b.key, moves[b.key].beg]));
    keys.forEach((m) => months.push({ m, cols: books.map((b) => { const ls = moves[b.key].list.filter((x) => x.date.startsWith(m)); const d = r2(ls.reduce((n, x) => n + x.debit, 0)), c = r2(ls.reduce((n, x) => n + x.credit, 0)); run[b.key] = r2(run[b.key] + d - c); return { d, c, b: run[b.key] }; }) }));
  }
  const crLabel = (b) => (b.key === 'ca' ? 'Liquidations and refunds' : b.kind === 'SCR' ? 'Remittances to MTO' : 'Deposits');
  const drLabel = (b) => (b.key === 'ca' ? 'Cash advances (checks)' : 'Collections (ORs encoded)');
  const statement = !books.length ? '<div class="cd-info">This officer has no collecting or cash advance accountability in Audit Setup.</div>'
    : UI.view === 'month' ? `<div class="af-tbl"><table class="af-reg vf-tbl"><thead><tr><th scope="col" rowspan="2">Month</th>${books.map((b) => `<th scope="colgroup" colspan="3" class="r vf-grp">${esc(b.label)}</th>`).join('')}</tr>
        <tr>${books.map((b) => `<th scope="col" class="r vf-grp">${b.key === 'ca' ? 'Cash Adv.' : 'Collections'}</th><th scope="col" class="r">${b.key === 'ca' ? 'Liquidations' : b.kind === 'SCR' ? 'Remittances' : 'Deposits'}</th><th scope="col" class="r">Balance</th>`).join('')}</tr></thead>
        <tbody><tr class="cc-sec"><td>Balance, ${esc(fmtDate(from) || 'last exam')}</td>${books.map((b) => `<td class="vf-grp"></td><td></td><td class="r">${money(moves[b.key].beg)}</td>`).join('')}</tr>
        ${months.map((m) => `<tr><td>${MONTHS[+m.m.slice(5) - 1]} ${m.m.slice(0, 4)}</td>${m.cols.map((c) => `<td class="r vf-grp">${money(c.d)}</td><td class="r">${money(c.c)}</td><td class="r">${fmtAmt(c.b)}</td>`).join('')}</tr>`).join('')}
        <tr class="cc-tot"><td>Total</td>${st.map((x) => `<td class="r vf-grp">${money(x.debit)}</td><td class="r">${money(x.credit)}</td><td class="r">${fmtAmt(x.balance)}</td>`).join('')}</tr></tbody></table></div>`
    : `<div class="af-tbl"><table class="af-reg vf-tbl"><thead><tr><th scope="col">Nature of Funds</th>${books.map((b) => `<th scope="col" class="r">${esc(b.label)}</th>`).join('')}<th scope="col" class="r">Totals</th></tr></thead>
        <tbody>
          <tr><td>Balance, last examination (${esc(fmtDate(from) || '—')})<small>from Audit Setup</small></td>${st.map((x) => `<td class="r">${money(x.beg)}</td>`).join('')}<td class="r">${money(T('beg'))}</td></tr>
          <tr class="cc-sec"><td colspan="${books.length + 2}">Add: Debits to accountability</td></tr>
          ${st.map((x) => `<tr class="vf-sub"><td>${esc(drLabel(x))} · ${esc(x.label)}</td>${st.map((y) => `<td class="r">${y.key === x.key ? money(x.debit) : ''}</td>`).join('')}<td class="r">${money(x.debit)}</td></tr>`).join('')}
          <tr class="cc-sec"><td colspan="${books.length + 2}">Less: Credits to accountability</td></tr>
          ${st.map((x) => `<tr class="vf-sub"><td>${esc(crLabel(x))} · ${esc(x.label)}</td>${st.map((y) => `<td class="r">${y.key === x.key ? money(x.credit) : ''}</td>`).join('')}<td class="r">${money(x.credit)}</td></tr>`).join('')}
          <tr class="cc-tot"><td>Balance of accountability</td>${st.map((x) => `<td class="r">${fmtAmt(x.balance)}</td>`).join('')}<td class="r">${fmtAmt(T('balance'))}</td></tr>
          <tr><td>Inventory of cash and allowed cash items<small>from Cash Count</small></td>${st.map((x) => `<td class="r">${x.inv === null ? '<span class="dim">—</span>' : money(x.inv)}</td>`).join('')}<td class="r">${inv ? money(T('inv')) : '<span class="dim">—</span>'}</td></tr>
          <tr class="cc-tot"><td>Shortage / (Overage)</td>${st.map((x) => `<td class="r">${x.sh === null ? '—' : `<span class="${Math.abs(x.sh) > 0.004 ? 'warn-t' : ''}">${fmtAmt(x.sh)}</span>`}</td>`).join('')}<td class="r">${totSh === null ? '—' : `<span class="${Math.abs(totSh) > 0.004 ? 'warn-t' : ''}">${fmtAmt(totSh)}</span>`}</td></tr>
        </tbody></table></div>`;

  const rc = (k) => ver.recon?.[k] || {};
  const cell = (k, f2, lbl) => `<input class="input af-sm r vf-rc" data-rc="${k}" data-f="${f2}" inputmode="decimal" aria-label="${esc(lbl)}" value="${rc(k)[f2] !== undefined && rc(k)[f2] !== null && rc(k)[f2] !== '' ? esc(money(rc(k)[f2])) : ''}" ${dis}>`;
  const recon = !books.length ? '' : `<div class="af-tbl"><table class="af-reg vf-tbl"><thead><tr><th scope="col">As of ${esc(fmtDate(to))}</th>${books.map((b) => `<th scope="col" class="r">${esc(b.label)}</th>`).join('')}</tr></thead>
      <tbody>
        <tr><td>Balance per statement of accountability (audit)</td>${st.map((x) => `<td class="r">${fmtAmt(x.balance)}</td>`).join('')}</tr>
        <tr><td>Balance per cashbook</td>${books.map((b) => `<td class="r">${cell(b.key, 'cashbook', `${b.label} cashbook balance`)}</td>`).join('')}</tr>
        <tr class="cc-sec"><td colspan="${books.length + 1}">Add (Deduct): Reconciling items</td></tr>
        <tr class="vf-sub"><td>Unrecorded beginning balance</td>${books.map((b) => `<td class="r">${cell(b.key, 'unrecBeg', `${b.label} unrecorded beginning balance`)}</td>`).join('')}</tr>
        <tr class="vf-sub"><td>Unrecorded collections / cash advances</td>${books.map((b) => `<td class="r">${cell(b.key, 'unrecDebit', `${b.label} unrecorded collections or cash advances`)}</td>`).join('')}</tr>
        <tr class="vf-sub"><td>Less: Unrecorded deposits / remittances / liquidations</td>${books.map((b) => `<td class="r">${cell(b.key, 'unrecCredit', `${b.label} unrecorded deposits, remittances or liquidations`)}</td>`).join('')}</tr>
        <tr class="cc-tot"><td>Adjusted balance per cashbook</td>${books.map((b) => `<td class="r" data-adj="${b.key}"></td>`).join('')}</tr>
        <tr><td><b>Difference</b></td>${books.map((b) => `<td class="r" data-diff="${b.key}"></td>`).join('')}</tr>
      </tbody></table></div>
      ${auditor ? '<div class="cd-actions"><button class="btn primary" type="button" id="vf-saverc">Save Reconciliation</button></div>' : ''}`;

  const findingsHtml = shownF.length ? `<div class="af-tbl"><table class="af-reg vf-find"><thead><tr><th scope="col">Area</th><th scope="col">Finding</th><th scope="col">Decision</th><th scope="col">Auditor's Remarks</th></tr></thead>
      <tbody>${shownF.map((x) => { const d = dec(x.key); return `<tr data-fk="${esc(x.key)}"><td><a class="pill p-part vf-area" href="${esc(x.href)}">${esc(x.area)}</a></td><td>${esc(x.text)}</td>
        <td><select class="input af-sm vf-dec" aria-label="Decision" ${dis}>${DECISIONS.map((v) => `<option ${v === d.decision ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
        <td><input class="input af-sm vf-rem" aria-label="Remarks" value="${esc(d.remarks || '')}" ${dis}></td></tr>`; }).join('')}</tbody></table></div>
      ${auditor ? '<div class="cd-actions"><button class="btn primary" type="button" id="vf-savefd">Save Decisions</button></div>' : ''}`
    : `<div class="empty"><b>${findings.length ? 'No finding matches this filter.' : 'No finding.'}</b>${findings.length ? '' : 'Nothing was flagged in the records encoded for this officer.'}</div>`;

  const body = `${hello}${top}
    <div class="stats">
      <div class="stat"><span>Balance of Accountability</span><b>₱ ${fmtAmt(T('balance'))}</b><small>per audit, as of the count</small></div>
      <div class="stat"><span>Inventory Counted</span><b>${inv ? '₱ ' + money(T('inv')) : '—'}</b><small>${inv ? 'cash + allowed cash items' : 'no cash count saved yet'}</small></div>
      <div class="stat"><span>Shortage / (Overage)</span><b class="${totSh !== null && Math.abs(totSh) > 0.004 ? 'warn' : ''}" style="${totSh !== null && Math.abs(totSh) <= 0.004 ? 'color:var(--ok)' : ''}">${totSh === null ? '—' : '₱ ' + fmtAmt(totSh)}</b><small>${totSh === null ? 'after the cash count' : Math.abs(totSh) <= 0.004 ? 'no shortage or overage' : totSh > 0 ? 'shortage' : 'overage'}</small></div>
      <div class="stat"><span>Findings</span><b class="${complete && findings.length - decided ? 'warn' : ''}">${complete ? findings.length : '—'}</b><small>${complete ? `${decided} decided · ${findings.length - decided} to decide` : 'shown once encoding is complete'}</small></div>
    </div>
    <section class="panel" aria-labelledby="vf-h1"><div class="cc-head"><span class="cd-num">1</span><h2 id="vf-h1">Statement of Accountability</h2><span class="cd-sub">GF 74-A, part D · computed</span>
      <div class="seg" role="group" aria-label="View" style="margin-left:auto"><a href="#" data-view="sum" class="${UI.view === 'sum' ? 'on' : ''}" aria-pressed="${UI.view === 'sum'}">Summary</a><a href="#" data-view="month" class="${UI.view === 'month' ? 'on' : ''}" aria-pressed="${UI.view === 'month'}">By Month (Annex C / D)</a></div></div>
      <div class="cd-body">${statement}<p class="af-note">Only records dated within the scope of audit (${esc(fmtDate(from) || '—')} to ${esc(fmtDate(to))}) are counted. The balance at the last examination comes from Audit Setup.</p></div></section>
    <section class="panel" aria-labelledby="vf-h2"><div class="cc-head"><span class="cd-num">2</span><h2 id="vf-h2">Reconciliation with the Officer's Books</h2><span class="cd-sub">Annex E – G · type from the cashbook</span></div>
      <div class="cd-body">${recon}</div></section>
    <section class="panel" aria-labelledby="vf-h3"><div class="cc-head"><span class="cd-num">3</span><h2 id="vf-h3">Findings</h2><span class="cd-sub">found by the app · decided by the auditor</span>
      <label class="vf-complete" style="margin-left:auto"><input type="checkbox" id="vf-complete" ${complete ? 'checked' : ''} ${auditor ? '' : 'disabled'}> Encoding complete</label>
      ${complete ? `<label class="sr-only" for="vf-show">Show</label><select class="input af-sm" id="vf-show" style="width:auto"><option value="" ${!show ? 'selected' : ''}>All findings (${findings.length})</option><option value="todo" ${show === 'todo' ? 'selected' : ''}>To decide (${findings.length - decided})</option><option value="aom" ${show === 'aom' ? 'selected' : ''}>For AOM</option></select>` : ''}</div>
      <div class="cd-body">${chkHtml}${complete ? `${findingsHtml}<p class="af-note">Nothing is concluded by the app; the auditor decides each finding. Click the area to open the screen it comes from. Untick Encoding complete to go back to encoding.</p>`
        : `<div class="vf-progress"><b>Encoding in progress</b><ul>${progress.map((t) => `<li>${esc(t)}</li>`).join('')}</ul><p class="af-note">The findings (missing ORs, late deposits, bank items, shortage and the rest) show once every record of this officer is encoded. Tick <b>Encoding complete</b> then.</p></div>`}</div></section>
    <div class="panel vf-status"><div><b>Status of this examination</b><span>${!complete ? 'Encoding in progress. Tick Encoding complete in Findings when every record is encoded.' : ver.ready ? `Ready for Reports since ${esc(fmtDate(String(ver.readyAt || '').slice(0, 10)))}${ver.readyBy ? ' · ' + esc(ver.readyBy) : ''}.` : findings.length - decided ? `${findings.length - decided} finding${findings.length - decided > 1 ? 's' : ''} still to decide. Mark it ready once every finding is decided.` : 'Every finding is decided.'}</span></div>
      <div class="btn-row"><button class="btn" type="button" id="vf-xls">Export to Excel</button>${auditor && complete ? (ver.ready ? '<button class="btn" type="button" id="vf-unready">Reopen</button>' : '<button class="btn primary" type="button" id="vf-ready">Mark Ready for Reports</button>') : ''}</div></div>`;

  return { crumb, body, wire: () => { wireTop(); wireVerify({ refs, rerender: ctx.rerender, exam, audit, o, st, books, findings, ver, dec, auditor, months }); } };
}

function wireVerify(c) {
  const { refs, exam, audit, o, st, books, findings, ver, dec, auditor } = c;
  $$('[data-view]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); UI.view = a.dataset.view; c.rerender(); }; });
  if ($('#vf-show')) $('#vf-show').onchange = (e) => go({ show: e.target.value });
  const paintRc = () => books.forEach((b) => {
    const g = (f2) => { const el = $(`[data-rc="${b.key}"][data-f="${f2}"]`); return el ? (num(el.value) || 0) : 0; };
    const has = $(`[data-rc="${b.key}"][data-f="cashbook"]`)?.value.trim();
    const adj = r2(g('cashbook') + g('unrecBeg') + g('unrecDebit') - g('unrecCredit'));
    const s = st.find((x) => x.key === b.key);
    $(`[data-adj="${b.key}"]`).textContent = has ? fmtAmt(adj) : '—';
    const d = r2(s.balance - adj);
    $(`[data-diff="${b.key}"]`).innerHTML = !has ? '<span class="pill p-stock">Type the cashbook</span>' : Math.abs(d) < 0.005 ? '<span class="pill p-done">Agrees</span>' : `<span class="pill p-flag">${fmtAmt(d)}</span>`;
  });
  if (books.length) { paintRc(); $$('.vf-rc').forEach((i) => { i.oninput = paintRc; i.onblur = () => { const v = num(i.value); if (v !== null) i.value = money(v); }; }); }
  const saveVer = async (patch, msg) => { const { id, ...cur } = ver; await store.save('cer_verify', exam.id, { examId: exam.id, recon: {}, decisions: {}, ...cur, ...patch }, by(refs)); toast(msg, 'ok'); };
  const src = $('#vf-saverc');
  if (src) src.onclick = () => {
    const recon = {};
    books.forEach((b) => { recon[b.key] = {}; ['cashbook', 'unrecBeg', 'unrecDebit', 'unrecCredit'].forEach((f2) => { const v = $(`[data-rc="${b.key}"][data-f="${f2}"]`).value.trim(); recon[b.key][f2] = v ? num(v) : null; }); });
    saveVer({ recon }, 'Reconciliation saved.');
  };
  const sfd = $('#vf-savefd');
  if (sfd) sfd.onclick = () => {
    const decisions = { ...(ver.decisions || {}) };
    $$('tr[data-fk]').forEach((tr) => { decisions[tr.dataset.fk] = { decision: $('.vf-dec', tr).value, remarks: $('.vf-rem', tr).value.trim() }; });
    saveVer({ decisions }, 'Decisions saved.');
  };
  const rd = $('#vf-ready');
  if (rd) rd.onclick = () => {
    const left = findings.filter((x) => dec(x.key).decision === 'To decide').length;
    if (left) return bad(`${left} finding${left > 1 ? 's are' : ' is'} still "To decide". Save a decision for each first.`);
    saveVer({ ready: true, readyBy: refs.me?.data.name || by(refs), readyAt: new Date().toISOString() }, 'Marked ready for Reports.');
    saveEnding(refs, exam, st, lgu);   // the next cash exam of this officer starts from these
  };
  const ur = $('#vf-unready'); if (ur) ur.onclick = () => saveVer({ ready: false }, 'Reopened.');
  const cp = $('#vf-complete'); if (cp && auditor) cp.onchange = () => (cp.checked
    ? saveVer({ complete: true, completeBy: refs.me?.data.name || by(refs), completeAt: new Date().toISOString() }, 'Encoding marked complete. The findings are shown.')
    : saveVer({ complete: false, ready: false }, 'Back to encoding. The findings are hidden until encoding is complete.'));
  $('#vf-xls').onclick = () => exportXlsx(`Verification ${o.name} ${audit.countDate}.xlsx`, 'Verification', [
    ...st.map((x) => ({ Part: 'Statement of Accountability', Item: x.label, 'Balance, Last Exam': x.beg, Debits: x.debit, Credits: x.credit, Balance: x.balance, Inventory: x.inv ?? '', 'Shortage/(Overage)': x.sh ?? '' })),
    {}, ...findings.map((x) => ({ Part: 'Finding', Item: x.area, 'Balance, Last Exam': x.text, Debits: dec(x.key).decision, Credits: dec(x.key).remarks }))]);
}

// Lines by OR range from the cashbooks. For a collector: each range of the collector's cashbook against the remittances the
// Liquidating Officer recorded by OR range (LO's cashbook); the beginning per the cashbooks (collected before the last cash
// exam, remitted in the period) against Audit Setup. For an LO: the same, for each collector with lines by OR range.
function cashbookFindings(f, o, exam, from, to) {
  const out = [], add = (key, text) => out.push({ key, text });
  const inS = (d) => !!d && (!from || d >= from) && d <= to;
  const amt = (x) => r2((x.items || []).reduce((n, i) => n + (+i.amt || 0), 0));
  const loName = (r) => f.officers.find((x) => x.id === r.officerId)?.name || 'the Liquidating Officer';
  const one = (col, bal) => {
    const mine = f.ors.filter((x) => x.officerId === col.id && x.range);
    if (!mine.length) return;
    const lo = f.reports.flatMap((r) => (r.remittances || []).filter((m) => m.collectorId === col.id && m.from).map((m) => ({ ...m, lo: loName(r) })));
    const who = col.id === o.id ? '' : `${col.name}: `;
    add(`cbsum|${col.id}`, `${who}collections verified at the summary level, by OR range from the cashbooks; the RCDs / SCDs and the ORs were not examined individually.`);
    if (!lo.length) return;
    const covered = new Set();
    lo.filter((m) => inS(m.date)).forEach((m) => {
      const a = +m.from, z = +(m.to || m.from);
      const inR = mine.filter((x) => +x.serial >= a && +x.serialTo <= z); inR.forEach((x) => covered.add(x.id));
      const sumC = r2(inR.reduce((n, x) => n + amt(x), 0));
      if (!inR.length) add(`cbnolo|${col.id}|${m.date}|${a}`, `${who}${a}–${z} received by ${m.lo} on ${fmtDate(m.date)} (₱${money(m.amount)}) is not in the collector's cashbook.`);
      else if (Math.abs(sumC - (+m.amount || 0)) > 0.004) add(`cbdiff|${col.id}|${m.date}|${a}`, `${who}${a}–${z}: ₱${money(sumC)} in the collector's cashbook, ₱${money(m.amount)} received by ${m.lo} on ${fmtDate(m.date)}.`);
    });
    // Ranges collected in the period (or before it and remitted in it) and not received by the LO by the cut-off.
    mine.filter((x) => inS(x.date) && !covered.has(x.id) && !lo.some((m) => +x.serial >= +m.from && +x.serialTo <= +(m.to || m.from)))
      .forEach((x) => add(`cbnorec|${col.id}|${x.id}`, `${who}${x.serial}–${x.serialTo} collected ${fmtDate(x.date)} (₱${money(amt(x))}) is not among the remittances received by the Liquidating Officer up to the cut-off (unremitted: it should be in the collector's cash).`));
    // The beginning per the cashbooks: collected before the last cash exam and remitted to the LO in the period.
    if (from && bal !== null) {
      const begC = r2(mine.filter((x) => x.beg && lo.some((m) => inS(m.date) && +x.serial >= +m.from && +x.serialTo <= +(m.to || m.from))).reduce((n, x) => n + amt(x), 0));
      if (begC && Math.abs(begC - bal) > 0.004) add(`cbbeg|${col.id}|${begC}|${bal}`, `${who}beginning per the cashbooks (collected before ${fmtDate(from)}, remitted in the period) is ₱${money(begC)}; Audit Setup has ₱${money(bal)}.`);
    }
  };
  const colBeg = Object.entries(exam.balances || {}).filter(([k]) => k.startsWith('col-')).reduce((n, [, v]) => n + (+v?.amount || 0), 0);
  one(o, r2(colBeg));
  // Cashbook only: each deposit / remittance against the collections of its OR series; gaps and overlaps between the series.
  if (exam.records === 'cashbook') {
    if (!f.ors.some((x) => x.officerId === o.id && x.range)) add(`cbsum|${o.id}`, 'collections verified at the summary level from the cashbook; the RCDs / SCDs and the ORs were not examined individually.');
    const deps = f.reports.filter((r) => r.officerId === o.id).flatMap((r) => (r.deposits || []).filter((d) => d.from && inS(d.date))).sort((a, b) => +a.from - +b.from);
    const mx = (x) => (x.range ? +x.serialTo : +x.serial);
    // Remittances received with their series: typed in this officer's records, or typed by the collectors (remitted to this officer).
    const nm = (v) => String(v || '').toLowerCase().replace(/[^a-z]/g, '');
    const recv = [...f.reports.filter((r) => r.officerId === o.id).flatMap((r) => (r.remittances || []).filter((m) => m.from)),
      ...f.reports.filter((r) => r.officerId !== o.id).flatMap((r) => (r.deposits || []).filter((d) => d.toLO && d.from && nm(d.ref) && nm(d.ref) === nm(o.name)).map((d) => ({ ...d, collectorId: r.officerId })))]
      .filter((m, i, all) => all.findIndex((y) => y.collectorId === m.collectorId && String(y.from) === String(m.from)) === i);
    deps.forEach((d, i) => {
      const a = +d.from, z = +(d.to || d.from);
      // Collections of the series: the officer's own ORs in it, plus (an LO who also collects) the remittances received whose series is in it.
      const c = r2(f.ors.filter((x) => x.officerId === o.id && x.status !== 'cancelled' && +x.serial >= a && mx(x) <= z).reduce((n, x) => n + amt(x), 0)
        + recv.filter((m) => +m.from >= a && +(m.to || m.from) <= z).reduce((n, m) => n + (+m.amount || 0), 0));
      if (Math.abs(c - (+d.amount || 0)) > 0.004) add(`serdiff|${o.id}|${d.date}|${a}`, `${a}–${z}: collections ₱${money(c)}, ${d.toLO ? 'remitted' : 'deposited'} ₱${money(d.amount)} on ${fmtDate(d.date)}.`);
      const p = deps[i - 1]; if (!p) return;
      const pz = +(p.to || p.from);
      // A gap counts only on numbers of the officer's own booklets (the next booklet may start far after).
      const gap = f.booklets.filter((b) => b.officerId === o.id && !b.noSerial && b.from <= a - 1 && b.to >= pz + 1).map((b) => [Math.max(b.from, pz + 1), Math.min(b.to, a - 1)]);
      if (a > pz + 1 && gap.length) add(`sergap|${o.id}|${pz}|${a}`, `ORs ${gap.map(([x, y]) => (x === y ? x : `${x}–${y}`)).join(', ')} are in no ${d.toLO ? 'remittance' : 'deposit'} (between the series ${p.from}–${pz} and ${a}–${z}).`);
      else if (a <= pz) add(`serovl|${o.id}|${pz}|${a}`, `The series ${p.from}–${pz} and ${a}–${z} overlap.`);
    });
  }
  if ((exam.functions || []).includes('liquidating')) {
    const ids = new Set(f.reports.filter((r) => r.officerId === o.id).flatMap((r) => (r.remittances || []).map((m) => m.collectorId)));
    f.officers.filter((x) => ids.has(x.id) && x.id !== o.id).forEach((col) => one(col, null));
  }
  return out;
}
