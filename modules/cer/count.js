// CER · Cash Count (design approved 18 Oct 2026), following the GF 74-A.
// Per accountable officer of a cash examination, at the cut-off (done first, from what the officer presents):
//   1. Cut-off                 the remaining accountable forms presented: booklet (dropdown of the officer's booklets, or typed when
//                              not in the register) and its unused numbers; checks by unused range. Only recorded here (the ending);
//                              Verification compares it with the beginning and the encoded ORs once encoding is complete.
//   2. Cash on Hand            bills by number of pieces; coins as one amount.
//   3. Cash Items              checks, paid vouchers / payrolls not yet liquidated, etc.: presented, allowed (auditor), disallowed.
//   4. Split by Accountability counted together, then split: Collections | Cash Advance, against the balance per books.
//
// Records:
//   cer_cashcount  id = examId  { examId, bills{ '1000': pcs, … }, coins, items[{ particulars, appliesTo: 'col'|'ca', presented, allowed, advanceId }], split{ col, ca } (typed; blank = automatic) }
// Cash items of the cash advance: one line per check of the AO still unliquidated as of the cut-off (both funds; liquidations
// and refunds dated after the cut-off not counted), already listed; only what is typed as presented counts (advanceId).
import { listT } from '../src/journal.js';
import { store, newId } from '../../js/store.js';
import { esc, toast, $, $$ } from '../../js/ui.js';
import { hasRole, isAuditor, by, mayView, agencyName, fmtDate, money, num, formsForLgu } from './cer.js';
import { loadForms, unusedFormsOf, notPresentedOf, exportXlsx, cutoffOf, cutoffChoices, bookletName, parseCutRanges, FORM_SHORT, rangesText, countRanges } from './forms.js';
import { figuresOf, fundsOf, kindOfForm, tagSameDay, ctcSplit, ctcBalance, ctcBegShare } from './collections.js';
import { accountsOf, caFund, restFund, fundOrder } from './funds.js';

const canCount = (refs) => hasRole(refs, 'staff', 'member', 'atl', 'sa', 'admin');
const BILLS = [1000, 500, 200, 100, 50, 20];
const r2 = (n) => Math.round(n * 100) / 100;
const flat = (r) => ({ id: r.id, ...r.data });
const bad = (m) => { toast(m, 'bad'); return false; };
const go = (params) => { const q = new URLSearchParams(location.hash.split('?')[1] || ''); Object.entries(params).forEach(([k, v]) => (v ? q.set(k, v) : q.delete(k))); location.hash = location.hash.split('?')[0] + '?' + q.toString(); };
const BEG_CA = ['ca', 'sdo', 'pcf'];
const DRAFT = { key: '', data: null, editSplit: false };
const OPEN = { cut: true, cash: false };   // which tab is shown; 1 Remaining Forms when the screen is opened
export const resetTabs = () => { OPEN.cut = true; OPEN.cash = false; };   // unsaved count survives a screen refresh; split boxes shown

// A liquidation counts in the cash exam when dated from the last cash exam to the count, or ticked "count even if outside the scope".
const liqCounts = (exam, audit) => { const from = exam.lastExamDate || '', to = audit.countDate; return (l) => (!!l.date && (!from || l.date >= from) && l.date <= to) || !!l.countAnyway; };
// Balance per books of each accountability, as of the cash count.
export function booksOf(refs, f, o, exam, audit, advs, liqs) {
  const out = [];
  const fns = exam.functions || [];
  if (fns.includes('collecting') || fns.includes('liquidating') || f.ors.some((x) => x.officerId === o.id)) {
    const lgu = refs.lgu[audit.lguId];
    const fig = figuresOf(f, o, fundsOf(f, audit.lguId), audit.countDate, lgu, exam);
    const forms = exam.forms || [];
    // One column per report type: barangays AF 51 (SCD) and CTC (SCR); LGU and PLGU one Collections (RCD).
    fig.kinds.forEach((kind) => {
      const chains = Object.values(fig.chains).filter((c) => c.kind === kind);
      const used = forms.some((x) => kindOfForm(lgu, x) === kind) || chains.some((c) => c.figs.length || c.pend.nOrs || c.pend.dep || c.pend.beg);
      if (!used && fig.kinds.length > 1) return;
      const bal = r2(chains.reduce((n, c) => n + c.pend.end, 0));
      const label = kind === 'SCD' ? 'AF 51 (SCD)' : kind === 'SCR' ? 'CTC (SCR)' : fns.includes('liquidating') && !fns.includes('collecting') ? 'Collections (Liquidating)' : 'Collections (RCD)';
      if (kind === 'RCD' && ctcSplit(lgu, exam, f, o)) {   // LGU: AF 51 and CTC in one RCD, each its own column
        const c = ctcBalance(fig, ctcBegShare(exam.balances));
        out.push({ key: 'col-RCD', kind, part: 'or', label: 'AF 51 (RCD)', books: r2(bal - c), note: 'Undeposited AF 51 collections, from Collections & Deposits' });
        out.push({ key: 'col-CTC', kind, part: 'ctc', label: 'CTC (RCD)', books: c, note: 'Undeposited CTC collections, from Collections & Deposits (deposits split by each RCD\'s CTC share)' });
        return;
      }
      out.push({ key: 'col-' + kind, kind, label, books: bal, note: kind === 'SCR' ? 'Unremitted CTC, from Collections & Deposits' : 'Undeposited collections, from Collections & Deposits' });
    });
  }
  const mine = advs.filter((a) => a.officerId === o.id && !a.beg);   // beginning checks are inside the beginning balance
  if (fns.some((k) => ['disbursing', 'special', 'pettycash'].includes(k)) || mine.length) {
    const beg = BEG_CA.reduce((n, k) => n + (+(exam.balances?.[k]?.amount) || 0), 0);
    const liqIn = liqCounts(exam, audit);   // as in Verification: dated within the scope, or "count even if outside the scope"
    const bal = r2(beg + mine.reduce((n, a) => n + (+a.amount || 0), 0) - liqs.filter((l) => l.officerId === o.id && liqIn(l)).reduce((n, l) => n + (+l.amount || 0), 0));
    out.push({ key: 'ca', label: fns.includes('pettycash') && !fns.includes('disbursing') ? 'Petty Cash Fund' : 'Cash Advance', books: bal, note: 'Unliquidated, from Cash Advances' });
  }
  return out;
}

export async function countView(ctx) {
  const { refs, q } = ctx;
  const f = await loadForms();
  const [reports, advs0, liqs0, counts0] = await Promise.all(['cer_reports', 'cer_cashadv', 'cer_liquid', 'cer_cashcount'].map(listT));
  f.reports = tagSameDay(reports.map(flat));
  const advs = advs0.map(flat), liqs = liqs0.map(flat);
  const crumb = 'Cash Count (Cut-off)';
  const hello = `<div class="hello"><div><h1>Cash Count (Cut-off)</h1><p>The ending: what the officer presents at the cut-off. The remaining accountable forms, then cash on hand and cash items. The count is split by accountability and carried to the Report of Cash Examination (GF 74-A).</p></div></div>`;
  const audits = f.audits.filter((a) => mayView(refs, refs.lgu[a.lguId])).sort((a, b) => String(b.countDate).localeCompare(String(a.countDate)));
  if (!audits.length) return { crumb, body: hello + '<div class="panel"><div class="empty"><b>No cash examination yet.</b>The auditors set one up in Audit Setup.</div></div>' };
  const audit = audits.find((a) => a.id === q.get('a')) || audits[0];
  const exams = f.exams.filter((e) => e.auditId === audit.id).map((e) => ({ ...e, o: f.officers.find((x) => x.id === e.officerId) })).filter((e) => e.o);
  const exam = exams.find((e) => e.id === q.get('e')) || exams[0] || null;
  const top = (open = false) => `<div class="panel ${open ? 'cd-head' : 'cd-bar'} cc-bar">${open ? '<div class="cd-headrow">' : ''}
      <div class="field"><label for="cc-audit">Cash Examination</label><select class="input" id="cc-audit">${audits.map((a) => `<option value="${esc(a.id)}" ${a.id === audit.id ? 'selected' : ''}>${esc(agencyName(refs, refs.lgu[a.lguId]))} · ${esc(fmtDate(a.countDate))}</option>`).join('')}</select></div>
      <div class="field"><label for="cc-exam">Accountable Officer</label><select class="input" id="cc-exam">${exams.length ? exams.map((e) => `<option value="${esc(e.id)}" ${exam && e.id === exam.id ? 'selected' : ''}>${esc(e.o.name)}${e.o.designation ? ' · ' + esc(e.o.designation) : ''}</option>`).join('') : '<option value="">No officer in this examination</option>'}</select></div>
</div>`;
  const wireTop = () => {
    $('#cc-audit').onchange = (e) => { DRAFT.key = ''; go({ a: e.target.value, e: '' }); };
    $('#cc-exam').onchange = (e) => { DRAFT.key = ''; go({ e: e.target.value }); };
  };
  if (!exam) return { crumb, body: hello + top() + '<div class="panel"><div class="empty"><b>No accountable officer in this cash examination.</b>Add the officers in Audit Setup.</div></div>', wire: wireTop };

  const o = exam.o;
  const saved = counts0.map(flat).find((c) => c.id === exam.id) || null;
  if (DRAFT.key !== exam.id) DRAFT.key = exam.id, DRAFT.editSplit = false, DRAFT.data = JSON.parse(JSON.stringify({ bills: {}, coins: '', items: [], split: {}, ...(saved || {}) }));
  const d = DRAFT.data;
  const books = booksOf(refs, f, o, exam, audit, advs, liqs);
  const forms = unusedFormsOf(f, o.id, exam);
  const nps = notPresentedOf(f, exam, audit.countDate);
  const enc = canCount(refs);
  const dis = enc ? '' : 'disabled';
  const caChecks = advs.filter((a) => a.officerId === o.id).map((a) => a.checkNo);
  // The AO's cash advances unliquidated as of the cut-off, by fund.
  const caKey = books.find((b) => b.key === 'ca') ? 'ca' : '';
  const open = caKey ? openAdvances(f, o, exam, audit, advs, liqs) : [];
  const itemOf = (id) => d.items.find((it) => it.advanceId === id);
  const orphans = d.items.filter((it) => it.advanceId && !open.some((a) => a.id === it.advanceId));
  const unliqTot = r2(open.reduce((n, a) => n + a.unliq, 0));
  const auditor = isAuditor(refs);
  const editSplit = DRAFT.editSplit || Object.values(d.split || {}).some((v) => v !== '' && v !== null && v !== undefined);
  const choices = cutoffChoices(f, o.id, audit.countDate, exam.id);
  const lgu = refs.lgu[audit.lguId];
  const otherForms = [...formsForLgu(lgu), ['chk', 'Checks']];
  const mv = forms.filter((x) => x.face), nomv = forms.filter((x) => !x.face);

  const billRows = BILLS.map((v) => `<tr><td>₱ ${v.toLocaleString('en-US')}</td><td class="r"><label class="sr-only" for="b${v}">₱${v} pieces</label><input class="input af-sm r cc-pc" id="b${v}" data-bill="${v}" inputmode="numeric" value="${esc(d.bills[v] || '')}" placeholder="0" ${dis}></td><td class="r" data-amt="${v}"></td></tr>`).join('');
  const itemRow = (it, i) => `<tr data-it="${i}"><td>${esc(it.particulars)}</td><td>${esc(books.find((b) => b.key === it.appliesTo)?.label || (it.appliesTo === 'ca' ? 'Cash advance' : 'Collections'))}</td><td class="r">${money(it.presented)}</td>
      <td class="r"><label class="sr-only" for="al${i}">Allowed: ${esc(it.particulars)}</label><input class="input af-sm r cc-al" id="al${i}" inputmode="decimal" value="${esc(money(it.allowed ?? it.presented))}" ${dis}></td><td class="r cc-dis"></td>
      <td class="r">${enc ? `<button class="btn sm" type="button" data-rmit="${i}" aria-label="Remove ${esc(it.particulars)}">Remove</button>` : ''}</td></tr>`;
  const nFormsQty = forms.reduce((n, x) => n + x.qty, 0);
  const body = `${hello}${top(true)}
    <div class="ca-figs"><span>Cash on Hand <b id="cc-s-cash">₱ 0.00</b></span><span>Cash Items Allowed <b id="cc-s-items">₱ 0.00</b><small id="cc-s-items2" hidden></small></span>
      <span>Inventory <b id="cc-s-inv">₱ 0.00</b></span><span>Unused Forms <b>${nFormsQty} pcs</b><small>${forms.length} line${forms.length === 1 ? '' : 's'}</small></span>
      <span class="cc-cpn2">CPN served ${esc(fmtDate(audit.countDate))}</span></div>
    <div class="cd-tabs cc-tabs" role="tablist">
      <button type="button" role="tab" class="cd-tab ${OPEN.cut ? 'on' : ''}" data-tab="cut" aria-selected="${OPEN.cut}" aria-controls="cd-pane-cut"><span class="cd-num">1</span><span class="cd-tabt"><b>Remaining Forms</b><span class="cd-sub">${nFormsQty} pcs · ${forms.length} line${forms.length === 1 ? '' : 's'}</span></span></button>
      <button type="button" role="tab" class="cd-tab ${OPEN.cash ? 'on' : ''}" data-tab="cash" aria-selected="${OPEN.cash}" aria-controls="cd-pane-cash"><span class="cd-num">2</span><span class="cd-tabt"><b>Cash Count</b><span class="cd-sub" id="cc-tabsub">₱ 0.00</span></span></button></div></div>
    <section class="panel cd-pane" id="cd-pane-cut" role="tabpanel" ${OPEN.cut ? '' : 'hidden'}>
      <div class="cd-body">
        ${auditor ? `<div class="cut-entry">
          <div class="field cut-bk"><label for="cut-bk">Booklet</label><select class="input" id="cut-bk"><option value="">— Choose the booklet —</option>${choices.map((b) => `<option value="${esc(b.id)}">${esc(bookletName(b))}</option>`).join('')}<option value="__other">Other (not in the list)…</option></select></div>
          <div class="field cut-oth" hidden><label for="cut-form">Form</label><select class="input" id="cut-form">${otherForms.map(([k, n]) => `<option value="${k}">${esc(n)}</option>`).join('')}</select></div>
          <div class="field cut-oth" hidden><label for="cut-from">Series From</label><input class="input mono r" id="cut-from" inputmode="numeric" autocomplete="off"></div>
          <div class="field cut-oth" hidden><label for="cut-to">Series To</label><input class="input mono r" id="cut-to" inputmode="numeric" autocomplete="off"></div>
          <div class="field cut-ur"><label for="cut-ur" id="cut-url">Unused numbers</label><input class="input mono" id="cut-ur" placeholder="e.g. 3764072, 3764075-3764100" autocomplete="off"></div>
          <label class="cut-np"><input type="checkbox" id="cut-np"> Not presented</label>
          <span class="cut-q">Qty <b id="cut-qty">0</b></span>
          <button class="btn primary" type="button" id="cut-enter">Enter</button>
          <span class="crumb-i" title="The remaining forms as presented at the cut-off. Several ranges can go on one line (a skipped number is then counted as used). Checks: the unused checks; the last check issued is the one before them. A form not in the list: Other. The comparison with the beginning and the ORs encoded is in Verification.">ⓘ</span></div>` : ''}
        ${forms.length ? `<div class="af-tbl"><table class="af-reg cut-tbl"><thead><tr><th scope="col">Form</th><th scope="col">Booklet / Series</th><th scope="col">Unused Numbers</th><th scope="col" class="r">Qty</th>${mv.length ? '<th scope="col" class="r">Face Value (₱)</th>' : ''}<th scope="col"></th></tr></thead>
          <tbody>${forms.map((x) => `<tr><td><b>${esc(x.name)}</b>${x.other ? ' <span class="pill p-stock">Not in the list</span>' : ''}</td><td class="mono">${x.ns ? 'No serial' : `${x.from} – ${x.to}`}</td><td class="mono">${x.ns ? '' : esc(x.text) || '<span class="dim">None (all used)</span>'}</td>
            <td class="r">${x.qty}</td>${mv.length ? `<td class="r">${x.face ? money(x.amount) : ''}</td>` : ''}<td class="r">${auditor ? `<button class="btn sm" type="button" data-rmcut="${esc(x.id)}" aria-label="Remove ${esc(x.name)} ${esc(x.text)}">Remove</button>` : ''}</td></tr>`).join('')}
            <tr class="cc-tot"><td colspan="3">Total</td><td class="r">${nFormsQty}</td>${mv.length ? `<td class="r">${money(mv.reduce((n, x) => n + x.amount, 0))}</td>` : ''}<td></td></tr></tbody></table></div>`
          : nps.length ? '' : '<div class="empty"><b>No remaining forms entered yet.</b>Choose each booklet the officer presents and type its unused numbers.</div>'}
        ${nps.length ? `<div class="af-tbl"><table class="af-reg cut-tbl cut-nptbl"><thead><tr><th scope="col">Not presented at the count</th><th scope="col">Booklet / Series</th><th scope="col">Unused per the register</th><th scope="col" class="r">Qty</th><th scope="col"></th></tr></thead>
          <tbody>${nps.map((x) => `<tr><td><b>${esc(x.name)}</b> <span class="pill p-flag">Not presented</span></td><td class="mono">${x.ns ? 'No serial' : `${x.from} – ${x.to}`}</td><td class="mono">${esc(x.text) || '<span class="dim">—</span>'}</td><td class="r">${x.qty}</td>
            <td class="r">${auditor ? `<button class="btn sm" type="button" data-rmcut="${esc(x.id)}" aria-label="Remove ${esc(x.name)} not presented">Remove</button>` : ''}</td></tr>`).join('')}</tbody></table>
          <p class="af-note">Not counted: they stay in the register balance and show as Not presented in Annex B (SAAF), with a finding in Verification.</p></div>` : ''}
      </div></section>
    <section class="cd-pane cc-cashpane" id="cd-pane-cash" role="tabpanel" ${OPEN.cash ? '' : 'hidden'}>
    <div class="cc-grid2"><div class="cc-left">
      <section class="panel" aria-labelledby="cc-h1"><div class="cc-head"><h2 id="cc-h1">Cash on Hand</h2></div>
        <table class="af-reg cc-tbl"><thead><tr><th scope="col">Denomination</th><th scope="col" class="r">No. of Pcs.</th><th scope="col" class="r">Amount (₱)</th></tr></thead>
        <tbody><tr class="cc-sec"><td colspan="3">Bills</td></tr>${billRows}
          <tr class="cc-sec"><td colspan="3">Coins</td></tr>
          <tr><td>Coins (total amount)</td><td class="r dim">type the amount</td><td class="r"><label class="sr-only" for="cc-coins">Coins amount</label><input class="input af-sm r" id="cc-coins" inputmode="decimal" value="${esc(d.coins === '' || d.coins === undefined || d.coins === null ? '' : money(d.coins))}" placeholder="0.00" ${dis}></td></tr>
          <tr class="cc-tot"><td colspan="2">Total cash on hand</td><td class="r" id="cc-cash"></td></tr></tbody></table>
      </section>
      <section class="panel" aria-labelledby="cc-h2"><div class="cc-head"><h2 id="cc-h2">Cash Items</h2><span class="crumb-i" title="Checks, paid vouchers or payrolls not yet liquidated, and the like, presented in place of cash. The auditor decides what is allowed; disallowed = presented − allowed. Only allowed items count as inventory.">ⓘ</span></div>
        <div class="cd-body">
          ${enc ? `<div class="cd-entry cc-entry">
            <div class="field"><label for="ci-part">${open.length ? 'Other cash item: particulars' : 'Particulars'}</label><input class="input" id="ci-part" list="ci-list" autocomplete="off"><datalist id="ci-list">${caChecks.map((c) => `<option value="Paid vouchers / payroll, Check No. ${esc(c)}">`).join('')}</datalist></div>
            <div class="field"><label for="ci-to">Applies to</label><select class="input" id="ci-to">${books.map((b) => `<option value="${b.key}" ${b.key === 'ca' ? 'selected' : ''}>${esc(b.label)}</option>`).join('') || '<option value="col">Collections</option>'}</select></div>
            <div class="field"><label for="ci-amt">Amount Presented (₱)</label><input class="input r" id="ci-amt" inputmode="decimal" autocomplete="off"></div>
            <button class="btn primary" type="button" id="ci-enter">Enter</button></div>` : ''}
          ${open.length || orphans.length ? caLinesHtml(open, orphans, itemOf, audit, enc, unliqTot) : ''}
          ${d.items.some((it) => !it.advanceId) ? `<div class="af-tbl"><table class="af-reg"><thead><tr><th scope="col">Particulars</th><th scope="col">Applies to</th><th scope="col" class="r">Presented (₱)</th><th scope="col" class="r">Allowed (₱)</th><th scope="col" class="r">Disallowed (₱)</th><th scope="col"></th></tr></thead>
            <tbody>${d.items.map((it, i) => (it.advanceId ? '' : itemRow(it, i))).join('')}<tr class="cc-tot"><td colspan="2">Total cash items (with the cash advance lines)</td><td class="r">${money(d.items.reduce((n, x) => n + (+x.presented || 0), 0))}</td><td class="r" id="cc-alt"></td><td class="r" id="cc-dist"></td><td></td></tr></tbody></table></div>`
            : open.length ? '' : '<p class="af-note">No cash item yet.</p>'}
        </div>
      </section>
    </div>
    <section class="panel cc-right" aria-labelledby="cc-h4"><div class="cc-head"><h2 id="cc-h4">Split by Accountability</h2><span class="crumb-i" title="Cash on hand is split automatically: collections first, up to their balance per books, the rest to the cash advance. Use Edit split when the officer kept them apart. Balances per books use what is encoded up to now in Collections &amp; Deposits and Cash Advances.">ⓘ</span><span id="cc-pill" style="margin-left:auto"></span></div>
      <div class="cd-body">
        ${books.length ? `<div class="af-tbl"><table class="af-reg cc-split"><thead><tr><th scope="col">Nature of Funds</th>${books.map((b) => `<th scope="col" class="r">${esc(b.label)}</th>`).join('')}<th scope="col" class="r">Totals</th></tr></thead>
          <tbody>
            <tr><td>Balance per books</td>${books.map((b) => `<td class="r">${money(b.books)}</td>`).join('')}<td class="r">${money(r2(books.reduce((n, b) => n + b.books, 0)))}</td></tr>
            <tr><td>Cash on hand${enc ? `<button class="cc-splitlnk" type="button" id="cc-editsplit">${editSplit ? 'Automatic split' : 'Edit split'}</button>` : ''}</td>${books.map((b) => editSplit ? `<td class="r"><label class="sr-only" for="sp-${b.key}">Cash on hand for ${esc(b.label)}</label><input class="input af-sm r cc-sp" id="sp-${b.key}" data-sp="${b.key}" inputmode="decimal" value="${d.split[b.key] !== undefined && d.split[b.key] !== null && d.split[b.key] !== '' ? esc(money(d.split[b.key])) : ''}" ${dis}></td>` : `<td class="r" data-spv="${b.key}"></td>`).join('')}<td class="r" id="sp-tot"></td></tr>
            <tr><td>Allowed cash items</td>${books.map((b) => `<td class="r" data-ai="${b.key}"></td>`).join('')}<td class="r" id="ai-tot"></td></tr>
            <tr class="cc-tot"><td>Inventory</td>${books.map((b) => `<td class="r" data-inv="${b.key}"></td>`).join('')}<td class="r" id="inv-tot"></td></tr>
            <tr><td><b>Shortage / (Overage)</b></td>${books.map((b) => `<td class="r" data-sh="${b.key}"></td>`).join('')}<td class="r" id="sh-tot"></td></tr>
          </tbody></table></div>
`
          : '<div class="cd-info">This officer has no collecting or cash advance accountability in Audit Setup.</div>'}
        <div class="cd-actions"><button class="btn" type="button" id="cc-xls">Export to Excel</button><button class="btn" type="button" id="cc-print">Print Cash Count Sheet</button>${enc ? '<button class="btn primary" type="button" id="cc-save">Save Cash Count</button>' : ''}</div>
      </div>
    </section>
    </div></section>
    <div id="cer-print" class="af-print" hidden></div>`;

  return { crumb, body, wire: () => { wireTop(); wireCount({ rerender: ctx.rerender, refs, audit, exam, o, d, books, forms, saved, enc, lgu: refs.lgu[audit.lguId], f, choices, auditor, open, caKey }); } };
}

// The AO's cash advances still unliquidated as of the cut-off: the checks of the period, the beginning checks and the
// beginning balance not itemized; liquidations and refunds dated after the cut-off are not counted. With their fund.
function openAdvances(f, o, exam, audit, advs, liqs) {
  const ctx = { booklets: f.booklets, accounts: accountsOf(f.settings, audit.lguId), jr: f.ckdj };
  const cut = audit.countDate;
  const liqIn = liqCounts(exam, audit);
  const L = liqs.filter((l) => l.officerId === o.id && liqIn(l));
  const liqOf = (id) => r2(L.filter((l) => l.advanceId === id).reduce((n, l) => n + (+l.amount || 0), 0));
  const begChecks = advs.filter((a) => a.officerId === o.id && a.beg && a.begExamId === exam.id);
  const beg = r2(BEG_CA.reduce((n, k) => n + (+(exam.balances?.[k]?.amount) || 0), 0));
  const rest = r2(beg - begChecks.reduce((n, a) => n + (+a.amount || 0), 0));
  const list = [...begChecks, ...advs.filter((a) => a.officerId === o.id && !a.beg && a.date && a.date <= cut)].map((a) => ({ ...a, fund: caFund(a, ctx), unliq: r2((+a.amount || 0) - liqOf(a.id)) }));
  if (rest > 0.004 || L.some((l) => l.advanceId === '__beg')) list.unshift({ id: '__beg', rest: true, checkNo: '', date: exam.lastExamDate || '', particulars: 'Beginning balance (not itemized)', amount: Math.max(rest, 0), fund: restFund(exam, ctx), unliq: r2(Math.max(rest, 0) - liqOf('__beg')) });
  const ord = fundOrder(ctx);
  return list.filter((a) => a.unliq > 0.004).sort((a, b) => ord(a.fund, b.fund) || (b.rest ? 1 : 0) - (a.rest ? 1 : 0) || String(a.date).localeCompare(String(b.date)));
}
const caLabel = (a) => (a.rest ? 'Beginning balance (not itemized)' : `Check No. ${a.checkNo}${a.beg ? ' (beginning)' : ''} · ${fmtDate(a.date)}${a.particulars ? ' · ' + a.particulars : ''}`);
function caLinesHtml(open, orphans, itemOf, audit, enc, unliqTot) {
  const dis = enc ? '' : 'disabled';
  const v = (x) => (x === '' || x === undefined || x === null ? '' : esc(money(x)));
  let lastF = '';
  const rows = open.map((a) => { const it = itemOf(a.id) || {};
    const fh = a.fund !== lastF ? `<tr class="cc-sec"><td colspan="5">${esc(a.fund)}</td></tr>` : ''; lastF = a.fund;
    return `${fh}<tr data-ca="${esc(a.id)}"><td><b>${a.rest ? 'Beginning balance' : `Check No. ${esc(a.checkNo)}`}</b><br><small class="dim">${a.rest ? 'not itemized' : `${esc(fmtDate(a.date))}${a.beg ? ' · beginning' : ''}${a.particulars ? ' · ' + esc(a.particulars) : ''}`}</small>${enc ? ` <button class="cc-fill" type="button" data-cafill="${esc(a.id)}" title="Presented = the unliquidated amount">Fill</button>` : ''}<span class="cc-caflag"></span></td><td class="r">${money(a.unliq)}</td>
      <td class="r"><input class="input af-sm r cc-cap" inputmode="decimal" aria-label="Presented: ${esc(caLabel(a))}" value="${v(it.presented)}" placeholder="—" ${dis}></td>
      <td class="r"><input class="input af-sm r cc-caa" inputmode="decimal" aria-label="Allowed: ${esc(caLabel(a))}" value="${it.presented !== undefined && it.presented !== '' ? v(it.allowed ?? it.presented) : ''}" ${dis}></td>
      <td class="r cc-cad"></td></tr>`; }).join('');
  const orph = orphans.map((it) => `<tr data-caorph="${esc(it.advanceId)}"><td>${esc(it.particulars)} <span class="pill p-flag">Liquidated on or before the cut-off: remove?</span></td><td class="r">–</td><td class="r">${money(it.presented)}</td><td class="r">${money(it.allowed ?? it.presented)}</td>
      <td class="r">${enc ? `<button class="btn sm" type="button" data-carm="${esc(it.advanceId)}">Remove</button>` : ''}</td></tr>`).join('');
  return `<div class="cc-cahead"><b>Cash Advance</b> · unliquidated as of the cut-off (${esc(fmtDate(audit.countDate))}): <b>₱${money(unliqTot)}</b> <span class="dim" id="cc-canot"></span></div>
    <div class="af-tbl"><table class="af-reg cc-catbl"><colgroup><col style="width:34%"><col style="width:16%"><col style="width:18%"><col style="width:18%"><col style="width:14%"></colgroup><thead><tr><th scope="col">Check</th><th scope="col" class="r">Unliqui&shy;dated</th><th scope="col" class="r">Presented</th><th scope="col" class="r">Allowed</th><th scope="col" class="r">Disal&shy;lowed</th></tr></thead>
    <tbody>${rows}${orph}</tbody></table></div>
    <p class="af-note">Type what the officer presents for each check (paid vouchers, payrolls…). A line left blank counts as nothing presented.</p>`;
}

export function compute(d, books) {
  const cash = r2(BILLS.reduce((n, v) => n + v * (parseInt(d.bills[v], 10) || 0), 0) + (num(d.coins) || 0));
  const allowed = (it) => { const a = num(it.allowed ?? it.presented); return a === null ? 0 : a; };
  const ai = {}; books.forEach((b) => { ai[b.key] = r2(d.items.filter((it) => (it.appliesTo === b.key) || (!books.some((x) => x.key === it.appliesTo) && b === (it.appliesTo === 'ca' ? books[books.length - 1] : books[0]))).reduce((n, it) => n + allowed(it), 0)); });
  const typed = (k) => d.split[k] !== undefined && d.split[k] !== null && d.split[k] !== '';
  const sp = {}; let left = cash;
  books.filter((b) => typed(b.key)).forEach((b) => { sp[b.key] = num(d.split[b.key]) || 0; left = r2(left - sp[b.key]); });
  const auto = books.filter((b) => !typed(b.key));
  auto.forEach((b, i) => {
    if (i === auto.length - 1) { sp[b.key] = r2(Math.max(0, left)); left = r2(left - sp[b.key]); return; }
    const want = Math.max(0, r2(b.books - ai[b.key]));
    sp[b.key] = r2(Math.min(Math.max(0, left), want)); left = r2(left - sp[b.key]);
  });
  const inv = {}, sh = {}; books.forEach((b) => { inv[b.key] = r2(sp[b.key] + ai[b.key]); sh[b.key] = r2(b.books - inv[b.key]); });
  const itemsAllowed = r2(d.items.reduce((n, it) => n + allowed(it), 0));
  const itemsPresented = r2(d.items.reduce((n, it) => n + (+it.presented || 0), 0));
  return { cash, ai, sp, inv, sh, itemsAllowed, itemsPresented, unsplit: left };
}

function wireCount(c) {
  const { refs, audit, exam, o, d, books, enc } = c;
  const paint = () => {
    const k = compute(d, books);
    BILLS.forEach((v) => { const el = $(`[data-amt="${v}"]`); if (el) el.textContent = money(v * (parseInt(d.bills[v], 10) || 0)); });
    $('#cc-cash').textContent = money(k.cash);
    $('#cc-s-cash').textContent = '₱ ' + money(k.cash);
    $('#cc-s-items').textContent = '₱ ' + money(k.itemsAllowed);
    $('#cc-s-items2').textContent = `${d.items.length} item${d.items.length === 1 ? '' : 's'} · ₱${money(r2(k.itemsPresented - k.itemsAllowed))} disallowed`;
    $('#cc-s-inv').textContent = '₱ ' + money(r2(k.cash + k.itemsAllowed));
    { const tsh = books.length ? r2(books.reduce((n, b) => n + k.sh[b.key], 0)) : 0; const ts = $('#cc-tabsub'); if (ts) ts.textContent = `₱ ${money(r2(k.cash + k.itemsAllowed))}${books.length && Math.abs(tsh) > 0.004 ? (tsh > 0 ? ` · shortage ₱${money(tsh)}` : ` · overage ₱${money(-tsh)}`) : ''}`; }
    $$('tr[data-it]').forEach((tr) => { const it = d.items[+tr.dataset.it]; $('.cc-dis', tr).textContent = money(r2((+it.presented || 0) - (num(it.allowed ?? it.presented) || 0))); });
    if ($('#cc-alt')) { $('#cc-alt').textContent = money(k.itemsAllowed); $('#cc-dist').textContent = money(r2(k.itemsPresented - k.itemsAllowed)); }
    books.forEach((b) => {
      const spv = $(`[data-spv="${b.key}"]`); if (spv) spv.textContent = money(k.sp[b.key]);
      const sp = $(`#sp-${b.key}`); if (sp && document.activeElement !== sp && (d.split[b.key] === undefined || d.split[b.key] === '' || d.split[b.key] === null)) sp.placeholder = money(k.sp[b.key]);
      $(`[data-ai="${b.key}"]`).textContent = money(k.ai[b.key]);
      $(`[data-inv="${b.key}"]`).textContent = money(k.inv[b.key]);
      const s = k.sh[b.key]; $(`[data-sh="${b.key}"]`).innerHTML = `<b class="${Math.abs(s) > 0.004 ? 'warn-t' : ''}">${s < -0.004 ? `(${money(-s)})` : money(s)}</b>`;
    });
    if (!books.length) return;
    const tot = (o2) => r2(books.reduce((n, b) => n + o2[b.key], 0));
    $('#sp-tot').textContent = money(tot(k.sp)); $('#ai-tot').textContent = money(tot(k.ai)); $('#inv-tot').textContent = money(tot(k.inv));
    const st = tot(k.sh); $('#sh-tot').innerHTML = `<b class="${Math.abs(st) > 0.004 ? 'warn-t' : ''}">${st < -0.004 ? `(${money(-st)})` : money(st)}</b>`;
    $('#cc-pill').innerHTML = Math.abs(k.unsplit) > 0.004 ? `<span class="pill p-flag">₱${money(k.unsplit)} of the cash is not split</span>`
      : Math.abs(st) <= 0.004 ? '<span class="pill p-done">No shortage or overage</span>' : st > 0 ? `<span class="pill p-flag">Shortage ₱${money(st)}</span>` : `<span class="pill p-flag">Overage ₱${money(-st)}</span>`;
  };
  const refresh = () => c.rerender();
  $$('.cd-tab').forEach((t) => { t.onclick = () => {
    Object.keys(OPEN).forEach((k) => { OPEN[k] = k === t.dataset.tab; });
    $$('.cd-tab').forEach((x) => { const on = x === t; x.classList.toggle('on', on); x.setAttribute('aria-selected', String(on)); $('#cd-pane-' + x.dataset.tab).hidden = !on; });
  }; });
  paint();
  // Remaining forms at the cut-off: each line saved as entered (cer_cutoff, one record per officer's exam).
  if (c.auditor) wireCut(c);
  $$('[data-bill]').forEach((i) => { i.oninput = () => { d.bills[i.dataset.bill] = i.value.replace(/[^\d]/g, ''); paint(); }; });
  const coins = $('#cc-coins');
  if (coins) { coins.oninput = () => { d.coins = coins.value; paint(); }; coins.onblur = () => { const v = num(coins.value); if (v !== null) coins.value = money(v); }; }
  $$('.cc-al').forEach((i) => { i.oninput = () => { d.items[+i.closest('tr').dataset.it].allowed = i.value; paint(); }; i.onblur = () => { const v = num(i.value); if (v !== null) i.value = money(v); }; });
  const es = $('#cc-editsplit');
  if (es) es.onclick = () => { if (es.textContent === 'Edit split') DRAFT.editSplit = true; else { DRAFT.editSplit = false; d.split = {}; } refresh(); };
  $$('.cc-sp').forEach((i) => { i.oninput = () => { d.split[i.dataset.sp] = i.value.trim(); paint(); }; i.onblur = () => { const v = num(i.value); if (v !== null) i.value = money(v); }; });
  $$('[data-rmit]').forEach((b) => { b.onclick = () => { d.items.splice(+b.dataset.rmit, 1); refresh(); }; });
  // Cash advance lines: typing Presented adds the cash item (Allowed follows it until typed); blank removes it.
  const caPaint = () => {
    let notYet = 0;
    $$('tr[data-ca]').forEach((tr) => { const a = c.open.find((x) => x.id === tr.dataset.ca), it = d.items.find((x) => x.advanceId === a.id);
      const p = it ? +it.presented || 0 : 0, al = it ? num(it.allowed ?? it.presented) || 0 : 0;
      $('.cc-cad', tr).textContent = it ? money(r2(p - al)) : ''; notYet += Math.max(0, r2(a.unliq - p));
      $('.cc-caflag', tr).innerHTML = p > a.unliq + 0.004 ? '<br><span class="pill p-flag">More than unliquidated</span>' : ''; });
    const n = $('#cc-canot'); if (n) n.textContent = notYet > 0.004 ? `· not yet presented ₱${money(r2(notYet))}` : '· all presented';
  };
  const setCa = (id, pres, allowedTxt) => {
    const a = c.open.find((x) => x.id === id); let it = d.items.find((x) => x.advanceId === id);
    if (pres === null) { if (it) d.items.splice(d.items.indexOf(it), 1); return null; }
    if (!it) { it = { advanceId: id, particulars: `Paid vouchers / payroll, ${caLabel(a)}`, appliesTo: c.caKey, presented: pres, allowed: pres }; d.items.push(it); }
    else { const synced = r2(num(it.allowed ?? it.presented) || 0) === r2(+it.presented || 0); it.presented = pres; if (allowedTxt !== undefined) it.allowed = allowedTxt; else if (synced) it.allowed = pres; }
    return it;
  };
  $$('tr[data-ca]').forEach((tr) => {
    const id = tr.dataset.ca, pi = $('.cc-cap', tr), ai = $('.cc-caa', tr);
    pi.oninput = () => { const v = num(pi.value); const it = setCa(id, v && v > 0 ? v : null); ai.value = it ? money(num(it.allowed ?? it.presented) || 0) : ''; paint(); caPaint(); };
    pi.onblur = () => { const v = num(pi.value); if (v !== null) pi.value = money(v); };
    ai.oninput = () => { const it = d.items.find((x) => x.advanceId === id); if (!it) { ai.value = ''; return; } it.allowed = ai.value; paint(); caPaint(); };
    ai.onblur = () => { const v = num(ai.value); if (v !== null) ai.value = money(v); };
  });
  $$('[data-cafill]').forEach((b) => { b.onclick = () => { const a = c.open.find((x) => x.id === b.dataset.cafill), tr = b.closest('tr'); const it = setCa(a.id, a.unliq); it.allowed = a.unliq;
    $('.cc-cap', tr).value = money(a.unliq); $('.cc-caa', tr).value = money(a.unliq); paint(); caPaint(); }; });
  $$('[data-carm]').forEach((b) => { b.onclick = () => { const it = d.items.find((x) => x.advanceId === b.dataset.carm); if (it) d.items.splice(d.items.indexOf(it), 1); refresh(); }; });
  caPaint();
  const ce = $('#ci-enter');
  if (ce) {
    const add = () => {
      const p = $('#ci-part').value.trim(), a = num($('#ci-amt').value);
      if (!p) return bad('Type the particulars of the cash item.');
      if (!a || a <= 0) return bad('Enter the amount presented.');
      d.items.push({ particulars: p, appliesTo: $('#ci-to').value, presented: a, allowed: a });
      refresh();
    };
    ce.onclick = add; $('#ci-amt').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
  }
  const data = () => ({ examId: exam.id, bills: Object.fromEntries(Object.entries(d.bills).filter(([, v]) => v !== '' && v !== '0').map(([k, v]) => [k, parseInt(v, 10) || 0])),
    coins: num(d.coins) || 0, items: d.items.map((it) => ({ particulars: it.particulars, appliesTo: it.appliesTo, presented: +it.presented || 0, allowed: num(it.allowed ?? it.presented) ?? 0, ...(it.advanceId ? { advanceId: it.advanceId } : {}) })),
    split: Object.fromEntries(Object.entries(d.split).filter(([, v]) => v !== '' && v !== null && v !== undefined).map(([k, v]) => [k, num(v) || 0])) });
  const save = $('#cc-save');
  if (save) save.onclick = async () => {
    const k = compute(d, books);
    if (Math.abs(k.unsplit) > 0.004) return bad(`₱${money(k.unsplit)} of the cash on hand is not split. Check the typed amounts.`);
    if (d.items.some((it) => (num(it.allowed ?? it.presented) ?? 0) > (+it.presented || 0) + 0.004)) return bad('An allowed amount is more than what was presented.');
    save.disabled = true;
    try { DRAFT.key = ''; await store.save('cer_cashcount', exam.id, data(), by(refs)); toast('Cash Count saved.', 'ok'); } finally { save.disabled = false; }
  };
  $('#cc-xls').onclick = () => {
    const k = compute(d, books);
    exportXlsx(`Cash Count ${o.name} ${audit.countDate}.xlsx`, 'Cash Count', [
      ...BILLS.map((v) => ({ Part: 'Cash on hand', Item: `₱${v}`, Pieces: parseInt(d.bills[v], 10) || 0, Amount: v * (parseInt(d.bills[v], 10) || 0) })),
      { Part: 'Cash on hand', Item: 'Coins', Pieces: '', Amount: num(d.coins) || 0 }, { Part: 'Cash on hand', Item: 'Total', Pieces: '', Amount: k.cash },
      ...d.items.map((it) => ({ Part: 'Cash item', Item: it.particulars, Pieces: '', Amount: +it.presented || 0, Allowed: num(it.allowed ?? it.presented) ?? 0, 'Applies to': books.find((b) => b.key === it.appliesTo)?.label || it.appliesTo })),
      ...c.forms.map((x) => ({ Part: 'Unused forms', Item: `${x.name} ${x.from}–${x.to}`, Pieces: x.qty, Amount: x.face ? x.amount : '', Allowed: '', 'Applies to': x.text })),
      ...books.map((b) => ({ Part: 'Split', Item: b.label, Pieces: '', Amount: b.books, Allowed: k.inv[b.key], 'Applies to': `Shortage/(Overage) ${money(k.sh[b.key])}` }))]);
  };
  $('#cc-print').onclick = () => {
    const k = compute(d, books);
    const p = $('#cer-print');
    p.innerHTML = `<h2>Cash Count Sheet</h2>
      <p><b>${esc(o.name)}</b>, ${esc(o.designation || '')} · ${esc(agencyName(refs, c.lgu))} · cash count of ${esc(fmtDate(audit.countDate))}</p>
      <table><thead><tr><th>Denomination</th><th>No. of Pcs.</th><th>Amount</th></tr></thead><tbody>
      ${BILLS.map((v) => `<tr><td>₱${v.toLocaleString('en-US')}</td><td>${parseInt(d.bills[v], 10) || 0}</td><td>${money(v * (parseInt(d.bills[v], 10) || 0))}</td></tr>`).join('')}
      <tr><td>Coins</td><td></td><td>${money(num(d.coins) || 0)}</td></tr><tr><td><b>Total cash on hand</b></td><td></td><td><b>${money(k.cash)}</b></td></tr></tbody></table>
      <table><thead><tr><th>Cash items</th><th>Presented</th><th>Allowed</th><th>Disallowed</th></tr></thead><tbody>
      ${d.items.length ? d.items.map((it) => { const a = num(it.allowed ?? it.presented) ?? 0; return `<tr><td>${esc(it.particulars)}</td><td>${money(it.presented)}</td><td>${money(a)}</td><td>${money(r2((+it.presented || 0) - a))}</td></tr>`; }).join('') : '<tr><td colspan="4">None</td></tr>'}</tbody></table>
      <table><thead><tr><th>Unused accountable forms</th><th>Qty</th><th>Inclusive serial No.</th></tr></thead><tbody>
      ${c.forms.length ? c.forms.map((x) => `<tr><td>${esc(x.name)}${x.face ? ` (₱${money(x.amount)})` : ''}</td><td>${x.qty}</td><td>${esc(x.text)}</td></tr>`).join('') : '<tr><td colspan="3">None</td></tr>'}</tbody></table>
      <table><thead><tr><th></th>${books.map((b) => `<th>${esc(b.label)}</th>`).join('')}</tr></thead><tbody>
      <tr><td>Balance per books</td>${books.map((b) => `<td>${money(b.books)}</td>`).join('')}</tr>
      <tr><td>Inventory of cash and allowed cash items</td>${books.map((b) => `<td>${money(k.inv[b.key])}</td>`).join('')}</tr>
      <tr><td><b>Shortage / (Overage)</b></td>${books.map((b) => `<td><b>${money(k.sh[b.key])}</b></td>`).join('')}</tr></tbody></table>
      <p>Counted in the presence of the accountable officer. Prepared by ${esc(refs.me?.data.name || '')}.</p>`;
    document.body.classList.add('af-printing'); p.hidden = false; window.print(); p.hidden = true; document.body.classList.remove('af-printing');
  };
}

function wireCut(c) {
  const { refs, f, exam, o, choices } = c;
  const sel = $('#cut-bk'); if (!sel) return;
  const ur = $('#cut-ur'), qty = $('#cut-qty');
  const isOther = () => sel.value === '__other';
  const bk = () => choices.find((b) => b.id === sel.value) || null;
  const nsNow = () => (isOther() ? $('#cut-form').value === 'cash' && !int($('#cut-from').value) : !!bk()?.noSerial);
  const int = (v) => { const n = parseInt(String(v ?? '').replace(/[^\d]/g, ''), 10); return isNaN(n) ? null : n; };
  const npEl = $('#cut-np'), npOn = () => !!npEl?.checked && !isOther();
  const read = () => {
    if (!sel.value) return { error: 'Choose the booklet.' };
    if (npOn()) return { line: { bookletId: bk().id, ranges: [], np: true } };
    if (isOther()) {
      const form = $('#cut-form').value, a = int($('#cut-from').value), z = int($('#cut-to').value);
      if (nsNow()) { const q = int(ur.value) || 0; return { line: { bookletId: '', form, from: 1, to: q, ns: true, ranges: q ? [[1, q]] : [] } }; }
      if (!a || !z || z < a) return { error: 'Type the series (from and to) of the form.' };
      const p = parseCutRanges(ur.value, a, z, 'the series'); if (p.error) return { error: p.error };
      return { line: { bookletId: '', form, from: a, to: z, ns: false, ranges: p.ranges } };
    }
    const b = bk();
    if (b.noSerial) { const q = int(ur.value) || 0; if (q > b.qty) return { error: `More than the ${b.qty} pieces of the lot.` }; return { line: { bookletId: b.id, ranges: q ? [[b.from, b.from + q - 1]] : [] } }; }
    const p = parseCutRanges(ur.value, b.from, b.to); if (p.error) return { error: p.error };
    return { line: { bookletId: b.id, ranges: p.ranges } };
  };
  const paint = () => {
    $$('.cut-oth').forEach((el) => { el.hidden = !isOther(); });
    if (npEl) { npEl.closest('label').hidden = isOther(); ur.disabled = npOn(); if (npOn()) ur.value = ''; }
    $('#cut-url').textContent = nsNow() ? 'Pieces on hand' : 'Unused numbers';
    ur.placeholder = nsNow() ? 'pcs' : isOther() ? 'e.g. 101, 105-150' : bk() ? `e.g. ${bk().from}-${bk().to}` : 'e.g. 3764072, 3764075-3764100';
    const r = sel.value && ur.value.trim() ? read() : null; qty.textContent = r && r.line ? countRanges(r.line.ranges) : '0';
  };
  sel.onchange = paint; ur.oninput = paint; if (npEl) npEl.onchange = paint; ['#cut-form', '#cut-from', '#cut-to'].forEach((k) => { const el = $(k); if (el) el.oninput = el.onchange = paint; });
  ur.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#cut-enter').click(); } };
  paint();
  const cur = () => { const r = cutoffOf(f, exam.id); return { examId: exam.id, officerId: o.id, lines: r ? [...(r.lines || [])] : [] }; };
  $('#cut-enter').onclick = async () => {
    const r = read(); if (r.error) return bad(r.error);
    const rec = cur();
    // The same numbers cannot be on hand twice.
    const key = (l) => (l.bookletId || `${l.form}|${l.from}|${l.to}`);
    const clash = rec.lines.find((l) => key(l) === key(r.line) && (r.line.ns || l.ranges.some(([a, z]) => r.line.ranges.some(([x, y]) => x <= z && a <= y)) || (!l.ranges.length && !r.line.ranges.length)));
    if (clash) return bad('This booklet is already entered with some of these numbers. Remove that line first to change it.');
    rec.lines.push({ id: newId('cut'), ...r.line });
    await store.save('cer_cutoff', exam.id, rec, by(refs));
    toast('Saved.', 'ok');
    setTimeout(() => { const s2 = $('#cut-bk'); if (s2) s2.focus(); }, 50);
  };
  $$('[data-rmcut]').forEach((b) => { b.onclick = async () => {
    const rec = cur(); rec.lines = rec.lines.filter((l) => l.id !== b.dataset.rmcut);
    await store.save('cer_cutoff', exam.id, rec, by(refs)); toast('Removed.', 'ok');
  }; });
}
