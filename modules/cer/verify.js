// CER · Verification (design approved 18 Oct 2026).
// Puts everything encoded together for the auditor, per accountable officer, within the scope of audit (last cash exam to the count):
//   1. Statement of Accountability  GF 74-A part D: per nature of funds (barangays AF 51 (SCD), CTC (SCR); LGU Collections (RCD);
//                                   Cash Advance): balance last exam + debits − credits = balance; inventory (Cash Count); shortage / (overage).
//                                   By Month: the same, month by month (Annex C / D).
//   2. Reconciliation with the officer's books (Annex E – G): cashbook balance and unrecorded items, typed.
//   3. Findings: gathered from every screen; the auditor decides each one (Cleared, Noted, For AOM) with remarks.
//
// Records:
//   cer_verify  id = examId  { examId, recon{ <column>: { cashbook, unrecBeg, unrecDebit, unrecCredit } },
//                              decisions{ <finding key>: { decision, remarks } }, ready, readyBy, readyAt }
import { store } from '../../js/store.js';
import { esc, toast, $, $$ } from '../../js/ui.js';
import { hasRole, isAuditor, by, mayView, agencyName, fmtDate, money, num, bondChecks } from './cer.js';
import { loadForms, unusedFormsOf, skippedOf, FORM_SHORT, rangesText, exportXlsx } from './forms.js';
import { figuresOf, fundsOf, kindOfForm, repName } from './collections.js';
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
export function accountability(refs, f, audit, exam, advs, liqs, counts) {
  const lgu = refs.lgu[audit.lguId];
  const from = exam.lastExamDate || '', to = audit.countDate;
  const o = exam.o;
  const inScope = (d) => !!d && (!from || d > from) && d <= to;
  const bal = exam.balances || {};
  const fig = figuresOf(f, o, fundsOf(f, audit.lguId), to, lgu);
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
      advs.filter((a) => a.officerId === o.id && inScope(a.date)).forEach((a) => m.push({ date: a.date, debit: +a.amount || 0, credit: 0 }));
      liqs.filter((l) => l.officerId === o.id && inScope(l.date)).forEach((l) => m.push({ date: l.date, debit: 0, credit: +l.amount || 0 }));
    } else {
      const kind = b.kind;
      // Beginning: the collection balances in Audit Setup of the forms that go to this report type.
      beg = Object.entries(bal).filter(([k]) => k.startsWith('col-') && kindOfForm(lgu, k.slice(4)) === kind).reduce((n, [, v]) => n + (+v?.amount || 0), 0)
        + (kind === 'RCD' || (exam.functions || []).includes('liquidating') ? (+(bal.liq?.amount) || 0) : 0);
      f.ors.filter((x) => x.officerId === o.id && x.status !== 'cancelled' && kindOfForm(lgu, x.form) === kind && inScope(x.date)).forEach((x) => m.push({ date: x.date, debit: +x.amount || 0, credit: 0 }));
      Object.values(fig.chains).filter((c) => c.kind === kind).forEach((c) => [...c.figs, c.pend].forEach((g) => {
        (g.rec?.deposits || []).filter((d) => inScope(d.date)).forEach((d) => m.push({ date: d.date, debit: 0, credit: +d.amount || 0 }));
        (g.rec?.remittances || []).filter((d) => inScope(d.date)).forEach((d) => m.push({ date: d.date, debit: +d.amount || 0, credit: 0 }));
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

  return { o, lgu, from, to, inScope, bal, fig, books, count, inv, moves, st, T, totSh };
}

export async function verifyView(ctx) {
  const { refs, q } = ctx;
  const f = await loadForms();
  const [reports, advs0, liqs0, counts0, ver0, bank0] = await Promise.all(['cer_reports', 'cer_cashadv', 'cer_liquid', 'cer_cashcount', 'cer_verify', 'cer_bankrec'].map((t) => store.list(t)));
  f.reports = reports.map(flat);
  const advs = advs0.map(flat), liqs = liqs0.map(flat);
  const crumb = 'Verification';
  const hello = `<div class="hello"><div><h1>Verification</h1><p>Everything encoded is put together for the auditor: the statement of accountability, the reconciliation with the officer's books, and the findings to decide on.</p></div></div>`;
  const audits = f.audits.filter((a) => mayView(refs, refs.lgu[a.lguId])).sort((a, b) => String(b.countDate).localeCompare(String(a.countDate)));
  if (!audits.length) return { crumb, body: hello + '<div class="panel"><div class="empty"><b>No cash examination yet.</b>The auditors set one up in Audit Setup.</div></div>' };
  const audit = audits.find((a) => a.id === q.get('a')) || audits[0];
  const lgu = refs.lgu[audit.lguId];
  const exams = f.exams.filter((e) => e.auditId === audit.id).map((e) => ({ ...e, o: f.officers.find((x) => x.id === e.officerId) })).filter((e) => e.o);
  const exam = exams.find((e) => e.id === q.get('e')) || exams[0] || null;
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

  const { o, inScope, bal, fig, books, count, inv, moves, st, T, totSh } = accountability(refs, f, audit, exam, advs, liqs, counts0.map(flat));
  // Findings, each with a stable key so the auditor's decision stays with it.
  const findings = [];
  const add = (key, area, text, href) => findings.push({ key, area, text, href });
  st.forEach((x) => { if (x.sh !== null && Math.abs(x.sh) > 0.004) add(`sh|${x.key}`, 'Cash Count', `${x.sh > 0 ? 'Shortage' : 'Overage'} of ₱${money(Math.abs(x.sh))} in ${x.label}: balance of accountability ₱${money(x.balance)}, inventory ₱${money(x.inv)}.`, '#/cer/count'); });
  if (!count) add('nocount', 'Cash Count', 'No cash count saved yet for this officer.', '#/cer/count');
  (count?.items || []).forEach((it, i) => { const a = num(it.allowed ?? it.presented) ?? 0; if ((+it.presented || 0) - a > 0.004) add(`dis|${i}|${it.particulars}`, 'Cash Count', `Cash item disallowed: ${it.particulars}, ₱${money(r2((+it.presented || 0) - a))}.`, '#/cer/count'); });
  Object.values(fig.chains).forEach((c) => [...c.figs, c.pend].forEach((g) => g.issues.forEach((t, i) => add(`rep|${g.id}|${i}|${t.slice(0, 40)}`, 'Collections', `${g.pending ? `Not yet reported (${g.kind})` : repName(g.rec, g.kind)}: ${t}`, '#/cer/collections'))));
  const unrep = Object.values(fig.chains).map((c) => c.pend).filter((g) => g.nOrs);
  unrep.forEach((g) => add(`nyr|${g.id}`, 'Collections', `${g.nOrs} OR${g.nOrs > 1 ? 's' : ''} (₱${money(g.orsTotal)}) not yet in a submitted ${g.kind}, ${g.fund}.`, '#/cer/collections'));
  f.ors.filter((x) => x.officerId === o.id && x.date > to).slice(0, 1).forEach(() => add('afterct', 'Collections', `${f.ors.filter((x) => x.officerId === o.id && x.date > to).length} OR(s) dated after the cash count.`, '#/cer/collections'));
  f.booklets.filter((b) => b.officerId === o.id && b.status === 'issued').forEach((b) => { const sk = skippedOf(b); if (sk.length) add(`skip|${b.id}|${rangesText(sk)}`, 'Accountable Forms', `${FORM_SHORT[b.form] || b.form} ${rangesText(sk)} skipped between used numbers (booklet ${b.from} – ${b.to}).`, '#/cer/forms'); });
  unusedFormsOf(f, o.id, exam, to).forEach((x) => { if (x.status[1] === 'Not seen' || x.status[1] === 'For checking' || x.status[1] === 'Not yet checked') add(`pc|${x.id}|${x.status[1]}`, 'Accountable Forms', `${x.name} ${x.ns ? "(no serial)" : x.from + " – " + x.to}: Physical Check ${x.status[1].toLowerCase()}.`, '#/cer/forms'); });
  const mineAdv = advs.filter((a) => a.officerId === o.id);
  mineAdv.forEach((a) => {
    const l = r2(liqs.filter((x) => x.advanceId === a.id && x.date <= to).reduce((n, x) => n + (+x.amount || 0), 0)); const left = r2((+a.amount || 0) - l);
    if (a.date <= to && left > 0.004) add(`ca|${a.id}`, 'Cash Advances', `Check No. ${a.checkNo} (₱${money(a.amount)}${a.particulars ? ', ' + a.particulars : ''}) has ₱${money(left)} unliquidated at the count.`, '#/cer/advances');
    if (left < -0.004) add(`caover|${a.id}`, 'Cash Advances', `Check No. ${a.checkNo} is over-liquidated by ₱${money(-left)}.`, '#/cer/advances');
  });
  const myReports = new Set(f.reports.filter((r) => r.officerId === o.id).map((r) => r.id));
  bank0.map(flat).filter((r) => r.auditId === audit.id).forEach((rec) => Object.entries(rec.found || {}).forEach(([k, bd]) => {
    const [t, rid, d, ref, amt] = k.split('|');
    if (t === 'dep' && myReports.has(rid) && d && bd && days(d, bd) > 0) add(`late|${k}`, 'Deposits', `${ref || 'Deposit'} of ${fmtDate(d)} (₱${money(+amt)}) reached the bank ${days(d, bd)} day${days(d, bd) > 1 ? 's' : ''} later, on ${fmtDate(bd)}.`, '#/cer/banks');
  }));
  bondChecks({ bond: exam.bond || {}, countDate: to }).forEach((w, i) => add(`bond|${i}`, 'Audit Setup', w.text.replace(/<[^>]+>/g, ''), '#/cer/setup?a=' + audit.id));

  const ver = ver0.map(flat).find((v) => v.id === exam.id) || { recon: {}, decisions: {} };
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
      <div class="stat"><span>Findings</span><b class="${findings.length - decided ? 'warn' : ''}">${findings.length}</b><small>${decided} decided · ${findings.length - decided} to decide</small></div>
    </div>
    <section class="panel" aria-labelledby="vf-h1"><div class="cc-head"><span class="cd-num">1</span><h2 id="vf-h1">Statement of Accountability</h2><span class="cd-sub">GF 74-A, part D · computed</span>
      <div class="seg" role="group" aria-label="View" style="margin-left:auto"><a href="#" data-view="sum" class="${UI.view === 'sum' ? 'on' : ''}" aria-pressed="${UI.view === 'sum'}">Summary</a><a href="#" data-view="month" class="${UI.view === 'month' ? 'on' : ''}" aria-pressed="${UI.view === 'month'}">By Month (Annex C / D)</a></div></div>
      <div class="cd-body">${statement}<p class="af-note">Only records dated within the scope of audit (${esc(fmtDate(from) || '—')} to ${esc(fmtDate(to))}) are counted. The balance at the last examination comes from Audit Setup.</p></div></section>
    <section class="panel" aria-labelledby="vf-h2"><div class="cc-head"><span class="cd-num">2</span><h2 id="vf-h2">Reconciliation with the Officer's Books</h2><span class="cd-sub">Annex E – G · type from the cashbook</span></div>
      <div class="cd-body">${recon}</div></section>
    <section class="panel" aria-labelledby="vf-h3"><div class="cc-head"><span class="cd-num">3</span><h2 id="vf-h3">Findings</h2><span class="cd-sub">found by the app · decided by the auditor</span>
      <label class="sr-only" for="vf-show">Show</label><select class="input af-sm" id="vf-show" style="margin-left:auto;width:auto"><option value="" ${!show ? 'selected' : ''}>All findings (${findings.length})</option><option value="todo" ${show === 'todo' ? 'selected' : ''}>To decide (${findings.length - decided})</option><option value="aom" ${show === 'aom' ? 'selected' : ''}>For AOM</option></select></div>
      <div class="cd-body">${findingsHtml}<p class="af-note">Nothing is concluded by the app; the auditor decides each finding. Click the area to open the screen it comes from.</p></div></section>
    <div class="panel vf-status"><div><b>Status of this examination</b><span>${ver.ready ? `Ready for Reports since ${esc(fmtDate(String(ver.readyAt || '').slice(0, 10)))}${ver.readyBy ? ' · ' + esc(ver.readyBy) : ''}.` : findings.length - decided ? `${findings.length - decided} finding${findings.length - decided > 1 ? 's' : ''} still to decide. Mark it ready once every finding is decided.` : 'Every finding is decided.'}</span></div>
      <div class="btn-row"><button class="btn" type="button" id="vf-xls">Export to Excel</button>${auditor ? (ver.ready ? '<button class="btn" type="button" id="vf-unready">Reopen</button>' : '<button class="btn primary" type="button" id="vf-ready">Mark Ready for Reports</button>') : ''}</div></div>`;

  return { crumb, body, wire: () => { wireTop(); wireVerify({ refs, rerender: ctx.rerender, exam, audit, o, st, books, findings, ver, dec, auditor, months }); } };
}

function wireVerify(c) {
  const { refs, exam, audit, o, st, books, findings, ver, dec, auditor } = c;
  $$('[data-view]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); UI.view = a.dataset.view; c.rerender(); }; });
  $('#vf-show').onchange = (e) => go({ show: e.target.value });
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
  };
  const ur = $('#vf-unready'); if (ur) ur.onclick = () => saveVer({ ready: false }, 'Reopened.');
  $('#vf-xls').onclick = () => exportXlsx(`Verification ${o.name} ${audit.countDate}.xlsx`, 'Verification', [
    ...st.map((x) => ({ Part: 'Statement of Accountability', Item: x.label, 'Balance, Last Exam': x.beg, Debits: x.debit, Credits: x.credit, Balance: x.balance, Inventory: x.inv ?? '', 'Shortage/(Overage)': x.sh ?? '' })),
    {}, ...findings.map((x) => ({ Part: 'Finding', Item: x.area, 'Balance, Last Exam': x.text, Debits: dec(x.key).decision, Credits: dec(x.key).remarks }))]);
}
