// CER · Cash Advances (design approved 18 Oct 2026).
// Two parts, per accountable officer of a cash examination:
//   1. Cash Advance  each check issued to the officer as a cash advance: date, check No., particulars, amount.
//   2. Liquidation   each liquidation (LR No. or other reference, e.g. JEV; a refund with its OR No.), for one check.
// Unliquidated = beginning balance (Audit Setup) + cash advances − liquidations. Each check shows its own balance and status.
// Shared with Records Management later: the checks will come from the disbursements (RCI) encoded there.
//
// Records:
//   cer_cashadv   one cash advance  { lguId, officerId, date, checkNo, particulars, amount }
//   cer_liquid    one liquidation   { lguId, officerId, date, ref, particulars, amount, advanceId, type: 'liq' | 'refund' (refund: ref = OR No.),
//                                    countAnyway (ticked: counted in the cash exam although dated outside the scope) }
import { listT } from '../src/journal.js';
import { store, newId } from '../../js/store.js';
import { esc, modal, toast, $, $$ } from '../../js/ui.js';
import { hasRole, by, mayView, agencyName, fmtDate, money, num } from './cer.js';
import { exportXlsx, loadXlsx, excelDate } from './forms.js';
import { emitChange } from '../../js/store.js';

const canEncode = (refs) => hasRole(refs, 'staff', 'member', 'atl', 'sa', 'admin');
const r2 = (n) => Math.round(n * 100) / 100;
const flat = (r) => ({ id: r.id, ...r.data });
const strip = (x) => { const { id, ...rest } = x; return rest; };
const bad = (m) => { toast(m, 'bad'); return false; };
const go = (params) => { const q = new URLSearchParams(location.hash.split('?')[1] || ''); Object.entries(params).forEach(([k, v]) => (v ? q.set(k, v) : q.delete(k))); location.hash = location.hash.split('?')[0] + '?' + q.toString(); };
const OPEN = { ca: true, lq: false };   // which tab is shown (one at a time); 1 Cash Advance when the screen is opened
export const resetTabs = () => { OPEN.ca = true; OPEN.lq = false; };
const LAST = { caDate: '', lqDate: '', lqType: 'liq', focus: '' };
// Beginning balance: the officer's cash advance balances in Audit Setup (disbursing, special disbursing, petty cash fund).
const BEG_KEYS = ['ca', 'sdo', 'pcf'];

function figures(advs, liqs) {
  const list = advs.slice().sort((a, b) => (b.rest ? 1 : 0) - (a.rest ? 1 : 0) || String(a.date).localeCompare(String(b.date)) || String(a.checkNo).localeCompare(String(b.checkNo), undefined, { numeric: true }))
    .map((a) => {
      const mine = liqs.filter((l) => l.advanceId === a.id);
      const liq = r2(mine.reduce((n, l) => n + (+l.amount || 0), 0));
      const bal = r2((+a.amount || 0) - liq);
      const st = bal < -0.004 ? ['p-stock', 'Over-liquidated'] : bal <= 0.004 ? ['p-done', 'Fully liquidated'] : liq > 0 ? ['p-part', 'Partly liquidated'] : ['p-stock', 'Not yet liquidated'];
      return { ...a, liq, bal, st, n: mine.length };
    });
  return list;
}

export async function advancesView(ctx) {
  const { refs, q } = ctx;
  const [audits0, exams0, officers0, advs0, liqs0] = await Promise.all(['cer_audits', 'cer_exams', 'cer_officers', 'cer_cashadv', 'cer_liquid'].map(listT));
  const audits = audits0.map(flat).filter((a) => mayView(refs, refs.lgu[a.lguId])).sort((a, b) => String(b.countDate).localeCompare(String(a.countDate)));
  const officers = officers0.map(flat);
  const crumb = 'Cash Advances';
  const hello = `<div class="hello"><div><h1>Cash Advances</h1><p>Each cash advance (a check issued to the officer) and the liquidations under it. Unliquidated = cash advances − liquidations.</p></div></div>`;
  if (!audits.length) return { crumb, body: hello + '<div class="panel"><div class="empty"><b>No cash examination yet.</b>The auditors set one up in Audit Setup; its accountable officers are listed here.</div></div>' };
  const audit = audits.find((a) => a.id === q.get('a')) || audits[0];
  const exams = exams0.map(flat).filter((e) => e.auditId === audit.id).map((e) => ({ ...e, o: officers.find((x) => x.id === e.officerId) })).filter((e) => e.o);
  const exam = exams.find((e) => e.id === q.get('e')) || exams[0] || null;
  const top = (open = false) => `<div class="panel ${open ? 'cd-head' : 'cd-bar'}">${open ? '<div class="cd-headrow">' : ''}
      <div class="field"><label for="cd-audit">Cash Examination</label><select class="input" id="cd-audit">${audits.map((a) => `<option value="${esc(a.id)}" ${a.id === audit.id ? 'selected' : ''}>${esc(agencyName(refs, refs.lgu[a.lguId]))} · ${esc(fmtDate(a.countDate))}</option>`).join('')}</select></div>
      <div class="field"><label for="cd-exam">Accountable Officer</label><select class="input" id="cd-exam">${exams.length ? exams.map((e) => `<option value="${esc(e.id)}" ${exam && e.id === exam.id ? 'selected' : ''}>${esc(e.o.name)}${e.o.designation ? ' · ' + esc(e.o.designation) : ''}</option>`).join('') : '<option value="">No officer in this examination</option>'}</select></div></div>`;
  const wireTop = () => {
    $('#cd-audit').onchange = (e) => go({ a: e.target.value, e: '' });
    $('#cd-exam').onchange = (e) => go({ e: e.target.value });
  };
  if (!exam) return { crumb, body: hello + top() + '<div class="panel"><div class="empty"><b>No accountable officer in this cash examination.</b>Add the officers in Audit Setup.</div></div>', wire: wireTop };

  const o = exam.o;
  const allAdv = advs0.map(flat).filter((a) => a.officerId === o.id);
  const advs = allAdv.filter((a) => !a.beg);   // cash advances during the period
  // Beginning checks: entered in Audit Setup, unliquidated as of the last cash exam (amount = what was still unliquidated).
  const begChecks = allAdv.filter((a) => a.beg && a.begExamId === exam.id);
  const liqs = liqs0.map(flat).filter((l) => l.officerId === o.id);
  // Scope of this cash exam: from the last cash exam date (after its cut-off) up to the count date.
  const scope = { from: exam.lastExamDate || '', to: audit.countDate };
  const outOf = (d) => !!d && ((scope.from && d < scope.from) || d > scope.to);
  const beg = r2(BEG_KEYS.reduce((n, k) => n + (+(exam.balances?.[k]?.amount) || 0), 0));
  const begSum = r2(begChecks.reduce((n, a) => n + (+a.amount || 0), 0));
  const rest = r2(beg - begSum);
  // What is not itemized is listed as one row, like a cash advance, so liquidations of older advances can be put against it.
  const begRow = rest > 0.004 || liqs.some((l) => l.advanceId === '__beg') ? [{ id: '__beg', beg: true, rest: true, date: exam.lastExamDate || '', checkNo: 'Beginning', particulars: 'Beginning balance (not itemized)', amount: Math.max(rest, 0) }] : [];
  const list = figures([...begRow, ...begChecks, ...advs], liqs);
  const totCa = r2(advs.reduce((n, a) => n + (+a.amount || 0), 0));
  const totLq = r2(liqs.reduce((n, l) => n + (+l.amount || 0), 0));
  const unliq = r2(beg + totCa - totLq);
  const open = list.filter((a) => a.bal > 0.004);
  const openChecks = open.filter((a) => !a.beg).length;
  const enc = canEncode(refs);
  const fns = exam.functions || [];
  const noFn = !['disbursing', 'special', 'pettycash'].some((k) => fns.includes(k));
  // Parts 1–2 as tabs, like Collections & Deposits: the chosen part shows below.
  const tabs = (list) => { const on = list.find(([k]) => OPEN[k])?.[0] || 'ca';
    return `<div class="cd-tabs ca-tabs" role="tablist">${list.map(([k, t, sub], i) => `<button type="button" role="tab" class="cd-tab ${k === on ? 'on' : ''}" data-tab="${k}" aria-selected="${k === on}" aria-controls="cd-pane-${k}"><span class="cd-num">${i + 1}</span><span class="cd-tabt"><b>${t}</b><span class="cd-sub">${sub}</span></span></button>`).join('')}</div></div>
      ${list.map(([k, , , inner]) => `<section class="panel cd-pane" id="cd-pane-${k}" role="tabpanel" ${k === on ? '' : 'hidden'}><div class="cd-body">${inner}</div></section>`).join('')}`; };
  const advLabel = (a) => (a.rest ? `Beginning balance (not itemized) · ₱${money(a.bal)} left` : `${a.checkNo}${a.beg ? ' (Beginning)' : ''} · ${a.particulars || fmtDate(a.date)} · ₱${money(a.bal)} left`);
  const sorted = list.slice().reverse();   // latest first in the table

  const caBody = `${enc ? `<div class="cd-entry ca-entry">
        <div class="field"><label for="ca-date">Date</label><input class="input" type="date" id="ca-date" value="${esc(LAST.caDate)}"></div>
        <div class="field"><label for="ca-check">Check No.</label><input class="input mono" id="ca-check" autocomplete="off"></div>
        <div class="field"><label for="ca-part">Particulars</label><input class="input" id="ca-part" autocomplete="off"></div>
        <div class="field"><label for="ca-amt">Amount (₱)</label><input class="input r" id="ca-amt" inputmode="decimal" autocomplete="off"></div>
        <button class="btn primary" type="button" id="ca-enter">Enter</button></div>
      <div class="ca-tools"><a href="#" class="cd-link" data-tpl="ca">Template</a><button class="btn sm" type="button" data-imp="ca">Import from Excel</button></div>` : ''}
    ${list.length ? `<div class="af-tbl"><table class="af-reg"><thead><tr><th scope="col">Date</th><th scope="col">Check No.</th><th scope="col">Particulars</th><th scope="col" class="r">Amount (₱)</th><th scope="col" class="r">Liquidated (₱)</th><th scope="col" class="r">Balance (₱)</th><th scope="col">Status</th><th scope="col" class="r"></th></tr></thead>
      <tbody>${sorted.map((a) => `<tr${a.beg ? ' class="cd-begrow"' : ''}><td>${esc(fmtDate(a.date))}</td><td class="mono">${a.rest ? '<span class="dim">—</span>' : `<b>${esc(a.checkNo)}</b>${a.beg ? ' <span class="pill blue ca-begtag">Beginning</span>' : ''}${a.fromJournal ? ' <span class="pill sd-ca">Journal</span>' : a.inJournal ? ' <span class="pill p-part" title="Also in the Check Disbursements Journal: delete this one to use the journal">Also in the journal</span>' : ''}`}</td><td>${esc(a.particulars || '')}</td><td class="r">${money(a.amount)}</td><td class="r">${money(a.liq)}</td><td class="r"><b>${money(a.bal)}</b></td>
        <td><span class="pill ${a.st[0]}">${a.st[1]}</span></td><td class="r">${a.beg && !a.rest ? `<a class="btn sm" href="#/cer/setup?a=${esc(audit.id)}&o=${esc(exam.id)}" title="Beginning checks are edited in Audit Setup, Beginning Balances">Setup</a>` : a.fromJournal ? `<a class="btn sm" href="#/src?l=${esc(a.lguId)}" title="Edited in Source Documents, Check Disbursements Journal">Journal</a>` : enc && !a.beg ? `<button class="btn sm" type="button" data-eca="${esc(a.id)}" aria-label="Edit check ${esc(a.checkNo)}">Edit</button>` : ''}</td></tr>`).join('')}</tbody>
      <tfoot><tr class="cd-foot"><td colspan="3">Total</td><td class="r">${money(r2(beg + totCa))}</td><td class="r">${money(r2(list.reduce((n, a) => n + a.liq, 0)))}</td><td class="r">${money(r2(list.reduce((n, a) => n + a.bal, 0)))}</td><td></td><td></td></tr></tfoot></table></div>`
      : `<div class="empty"><b>No cash advance encoded for this officer yet.</b>${enc ? 'Enter each check issued to the officer as a cash advance.' : ''}</div>`}
    ${noFn ? '<p class="af-note">This officer has no Disbursing, Special Disbursing or Petty Cash Custodian function ticked in Audit Setup.</p>' : ''}`;

  const lqRows = liqs.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const lqBody = `${enc ? (list.length ? `<div class="cd-entry lq-entry">
        <div class="field"><label for="lq-type">Type</label><select class="input" id="lq-type"><option value="liq" ${LAST.lqType !== 'refund' ? 'selected' : ''}>Liquidation</option><option value="refund" ${LAST.lqType === 'refund' ? 'selected' : ''}>Refund</option></select></div>
        <div class="field"><label for="lq-date">Date</label><input class="input" type="date" id="lq-date" value="${esc(LAST.lqDate)}"></div>
        <div class="field"><label for="lq-ref" id="lq-refl">${LAST.lqType === 'refund' ? 'OR No.' : 'LR No. / Reference'}</label><input class="input mono" id="lq-ref" placeholder="${LAST.lqType === 'refund' ? 'OR No. of the refund' : 'LR, JEV or other'}" autocomplete="off"></div>
        <div class="field"><label for="lq-part">Particulars</label><input class="input" id="lq-part" autocomplete="off"></div>
        <div class="field"><label for="lq-amt">Amount (₱)</label><input class="input r" id="lq-amt" inputmode="decimal" autocomplete="off"></div>
        <div class="field"><label for="lq-for">For Check No.</label><select class="input" id="lq-for">${(open.length ? open : list).map((a) => `<option value="${esc(a.id)}">${esc(advLabel(a))}</option>`).join('')}${open.length && open.length < list.length ? `<optgroup label="Fully liquidated">${list.filter((a) => a.bal <= 0.004).map((a) => `<option value="${esc(a.id)}">${esc(advLabel(a))}</option>`).join('')}</optgroup>` : ''}</select></div>
        <button class="btn primary" type="button" id="lq-enter">Enter</button></div>
      <div class="ca-tools"><a href="#" class="cd-link" data-tpl="lq">Template</a><button class="btn sm" type="button" data-imp="lq">Import from Excel</button></div>` : '<div class="cd-info">Encode the cash advance first, then its liquidations.</div>') : ''}
    ${lqRows.length ? `<div class="af-tbl"><table class="af-reg"><thead><tr><th scope="col">Date</th><th scope="col">Type</th><th scope="col">LR No. / OR No.</th><th scope="col">Particulars</th><th scope="col" class="r">Amount (₱)</th><th scope="col">For Check No.</th><th scope="col" class="r"></th></tr></thead>
      <tbody>${lqRows.map((l) => { const a = list.find((x) => x.id === l.advanceId); return `<tr><td>${esc(fmtDate(l.date))}${outOf(l.date) ? (l.countAnyway ? '<br><span class="pill p-done">Outside the scope · counted</span>' : '<br><span class="pill p-flag">Outside the scope</span>') : ''}</td><td>${l.type === 'refund' ? '<span class="pill p-done">Refund</span>' : 'Liquidation'}</td><td class="mono">${esc(l.ref || '')}</td><td>${esc(l.particulars || '')}</td><td class="r">${money(l.amount)}</td>
        <td class="mono">${a ? (a.rest ? 'Beginning balance' : esc(a.checkNo) + (a.beg ? ' <span class="pill blue ca-begtag">Beginning</span>' : '')) : '<span class="dim">—</span>'}</td><td class="r">${enc ? `<button class="btn sm" type="button" data-elq="${esc(l.id)}" aria-label="Edit liquidation ${esc(l.ref || '')}">Edit</button>` : ''}</td></tr>`; }).join('')}</tbody>
      <tfoot><tr class="cd-foot"><td colspan="4">Total${liqs.some((l) => l.type === 'refund') ? ` <span class="dim">(refunds ₱${money(r2(liqs.filter((l) => l.type === 'refund').reduce((n, l) => n + (+l.amount || 0), 0)))})</span>` : ''}</td><td class="r">${money(totLq)}</td><td></td><td></td></tr></tfoot></table></div>`
      : '<div class="empty"><b>No liquidation encoded yet.</b></div>'}
    ${begChecks.length ? '<p class="af-note">Checks tagged Beginning were unliquidated as of the last cash exam; their amount is what was still unliquidated then. They are entered in Audit Setup, Beginning Balances.</p>' : ''}<p class="af-note">For Check No. starts on the oldest open cash advance; pick another when the LR names it. A liquidation larger than what is left on its check is flagged. A refund of an excess cash advance: choose Refund and type its OR No.</p>`;

  const openTxt = `${openChecks} open${list.some((a) => a.beg && a.bal > 0.004) ? ' + beginning' : ''}`;
  const figs = `<div class="ca-figs"><span>Beginning <b>₱ ${money(beg)}</b><small>as of ${esc(fmtDate(exam.lastExamDate)) || 'the last cash exam'}${begChecks.length ? ` · ${begChecks.length} check${begChecks.length === 1 ? '' : 's'}${rest > 0.004 ? ` + ₱${money(rest)} not itemized` : ''}` : ''}</small></span>
      <span>Cash Advances <b>₱ ${money(totCa)}</b></span><span>Liquidations <b class="ok">₱ ${money(totLq)}</b></span><span class="ca-unliq">Unliquidated <b>₱ ${money(unliq)}</b><small>${openTxt}</small></span></div>`;
  const body = `${hello}${top(true)}${figs}
    ${tabs([['ca', 'Cash Advance', `${advs.length} check${advs.length === 1 ? '' : 's'} · ₱ ${money(totCa)}`, caBody], ['lq', 'Liquidation', `${liqs.length} entr${liqs.length === 1 ? 'y' : 'ies'} · ₱ ${money(totLq)}`, lqBody]])}
    <div class="btn-row cd-actions"><button class="btn" type="button" id="ca-xls">Export to Excel</button></div>`;

  return { crumb, body, wire: () => {
    wireTop();
    $$('.cd-tab').forEach((t) => { t.onclick = () => {
      Object.keys(OPEN).forEach((k) => { OPEN[k] = k === t.dataset.tab; });
      $$('.cd-tab').forEach((x) => { const on = x === t; x.classList.toggle('on', on); x.setAttribute('aria-selected', String(on)); $('#cd-pane-' + x.dataset.tab).hidden = !on; });
    }; });
    $('#ca-xls').onclick = () => exportXlsx(`Cash Advances ${o.name} ${audit.countDate}.xlsx`, 'Cash Advances', [
      ...list.map((a) => ({ Entry: a.rest ? 'Beginning Balance (not itemized)' : a.beg ? 'Beginning Check' : 'Cash Advance', Date: fmtDate(a.date), 'Check No.': a.checkNo, 'LR No. / Reference': '', Particulars: a.particulars || '', 'Cash Advance': a.amount, Liquidation: '', 'Balance of the Check': a.bal, Status: a.st[1] })),
      ...liqs.slice().sort((x, y) => String(x.date).localeCompare(String(y.date))).map((l) => ({ Entry: 'Liquidation', Date: fmtDate(l.date), 'Check No.': (() => { const a = list.find((x) => x.id === l.advanceId); return a ? (a.rest ? 'Beginning balance' : a.checkNo) : ''; })(), 'LR No. / Reference': l.ref || '', Particulars: (l.type === 'refund' ? 'Refund · ' : '') + (l.particulars || ''), 'Cash Advance': '', Liquidation: l.amount, 'Balance of the Check': '', Status: '' })),
      { Entry: 'Unliquidated', Date: fmtDate(audit.countDate), 'Check No.': '', 'LR No. / Reference': '', Particulars: `Beginning ${money(beg)} + cash advances ${money(totCa)} − liquidations ${money(totLq)}`, 'Cash Advance': '', Liquidation: '', 'Balance of the Check': unliq, Status: '' }]);
    if (!enc) return;
    const base = { lguId: audit.lguId, officerId: o.id };
    const enterOn = (ids, btn) => ids.forEach((id) => { const el = $(id); if (el) el.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $(btn).click(); } }; });
    const amtBlur = (id) => { const el = $(id); if (el) el.onblur = () => { const v = num(el.value); if (v !== null) el.value = money(v); }; };
    // Cash advance
    const ce = $('#ca-enter');
    if (ce) {
      amtBlur('#ca-amt'); enterOn(['#ca-check', '#ca-part', '#ca-amt'], '#ca-enter');
      ce.onclick = async () => {
        const v = { date: $('#ca-date').value, checkNo: $('#ca-check').value.trim(), particulars: $('#ca-part').value.trim(), amount: num($('#ca-amt').value) };
        const err = checkAdv(v, allAdv, ''); if (err) return bad(err);
        LAST.caDate = v.date; LAST.focus = 'ca';
        await store.save('cer_cashadv', newId('cerca'), { ...base, ...v }, by(refs));
        toast(`Check No. ${v.checkNo} saved.`, 'ok');
      };
    }
    // Liquidation
    const le = $('#lq-enter');
    if (le) {
      amtBlur('#lq-amt'); enterOn(['#lq-ref', '#lq-part', '#lq-amt'], '#lq-enter');
      $('#lq-type').onchange = (e) => { const rf = e.target.value === 'refund'; LAST.lqType = e.target.value; $('#lq-refl').textContent = rf ? 'OR No.' : 'LR No. / Reference'; $('#lq-ref').placeholder = rf ? 'OR No. of the refund' : 'LR, JEV or other'; };
      le.onclick = async () => {
        const v = { type: $('#lq-type').value, date: $('#lq-date').value, ref: $('#lq-ref').value.trim(), particulars: $('#lq-part').value.trim(), amount: num($('#lq-amt').value), advanceId: $('#lq-for').value };
        const err = checkLiq(v); if (err) return bad(err);
        if (!(await okOver(list.find((a) => a.id === v.advanceId), v.amount, 0))) return;
        LAST.lqDate = v.date; LAST.lqType = v.type; LAST.focus = 'lq';
        await store.save('cer_liquid', newId('cerlq'), { ...base, ...v }, by(refs));
        toast('Liquidation saved.', 'ok');
      };
    }
    $$('[data-tpl]').forEach((a) => { a.onclick = async (e) => { e.preventDefault(); try { const XLSX = await loadXlsx();
      const head = a.dataset.tpl === 'ca' ? ['Date', 'Check No.', 'Particulars', 'Amount'] : ['Type', 'Date', 'LR No. / Reference', 'Particulars', 'Amount', 'For Check No.'];
      const ws = XLSX.utils.aoa_to_sheet([head]); ws['!cols'] = head.map((h) => ({ wch: h === 'Particulars' ? 40 : 16 }));
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, a.dataset.tpl === 'ca' ? 'Cash Advances' : 'Liquidations'); XLSX.writeFile(wb, a.dataset.tpl === 'ca' ? 'Cash Advance Import Template.xlsx' : 'Liquidation Import Template.xlsx');
    } catch (err) { toast(err.message || String(err), 'bad'); } }; });
    $$('[data-imp]').forEach((b) => { b.onclick = () => importRows(b.dataset.imp, { refs, base, allAdv, list, o }); });
    $$('[data-eca]').forEach((b) => { b.onclick = () => editAdv(refs, list.find((a) => a.id === b.dataset.eca), allAdv, liqs); });
    $$('[data-elq]').forEach((b) => { b.onclick = () => editLiq(refs, liqs.find((l) => l.id === b.dataset.elq), list, outOf); });
    if (LAST.focus) { const el = $(LAST.focus === 'ca' ? '#ca-check' : '#lq-ref'); if (el) el.focus(); LAST.focus = ''; }
  } };
}

function checkAdv(v, advs, id) {
  if (!v.date) return 'Enter the date.';
  if (!v.checkNo) return 'Enter the check No.';
  if (!v.amount || v.amount <= 0) return 'Enter the amount.';
  if (advs.some((a) => a.id !== id && String(a.checkNo).trim().toUpperCase() === v.checkNo.toUpperCase())) return `Check No. ${v.checkNo} is already encoded for this officer.`;
  return '';
}
function checkLiq(v) {
  if (!v.date) return 'Enter the date.';
  if (!v.ref) return v.type === 'refund' ? 'Enter the OR No. of the refund.' : 'Enter the LR No. or another reference (e.g. JEV).';
  if (!v.amount || v.amount <= 0) return 'Enter the amount.';
  if (!v.advanceId) return 'Choose the check this liquidation is for.';
  return '';
}
// A liquidation larger than what is left on its check: confirm first (it is flagged as over-liquidated).
async function okOver(a, amount, already) {
  if (!a) return true;
  const left = r2(a.bal + already);
  if (amount <= left + 0.004) return true;
  return modal({ title: 'More than what is left?', body: `<p style="margin:0">Check No. ${esc(a.checkNo)} has ₱${money(left)} left. This liquidation is ₱${money(amount)}. Save it anyway? The check will be flagged as over-liquidated.</p>`,
    buttons: [{ label: 'Go back', value: false }, { label: 'Save', cls: 'primary', value: true }] });
}

async function editAdv(refs, a, advs, liqs) {
  if (!a) return;
  let act = null;
  const v = await modal({ title: `Edit Check No. ${a.checkNo}`,
    body: `<div class="cd-g2"><div class="field"><label for="ea-date">Date</label><input class="input" type="date" id="ea-date" value="${esc(a.date)}"></div>
      <div class="field"><label for="ea-check">Check No.</label><input class="input mono" id="ea-check" value="${esc(a.checkNo)}"></div>
      <div class="field"><label for="ea-part">Particulars</label><input class="input" id="ea-part" value="${esc(a.particulars || '')}"></div>
      <div class="field"><label for="ea-amt">Amount (₱)</label><input class="input r" id="ea-amt" inputmode="decimal" value="${esc(money(a.amount))}"></div></div>`,
    buttons: [{ label: 'Delete', value: 'del' }, { label: 'Cancel', value: null }, { label: 'Save', cls: 'primary', value: 'save', check: (bg) => {
      const x = { date: $('#ea-date', bg).value, checkNo: $('#ea-check', bg).value.trim(), particulars: $('#ea-part', bg).value.trim(), amount: num($('#ea-amt', bg).value) };
      const err = checkAdv(x, advs, a.id); if (err) return bad(err);
      act = x; return true;
    } }] });
  const { id, liq, bal, st, n, ...rec } = a;
  if (v === 'del') {
    if (n) return bad(`Check No. ${a.checkNo} has ${n} liquidation${n > 1 ? 's' : ''}. Move or delete them first.`);
    const ok = await modal({ title: `Delete Check No. ${a.checkNo}?`, body: '<p style="margin:0">Only for an encoding mistake.</p>', buttons: [{ label: 'Keep', value: false }, { label: 'Delete', cls: 'primary', value: true }] });
    if (ok) { await store.save('cer_cashadv', id, rec, by(refs), { deleted: true }); toast('Cash advance deleted.', 'ok'); }
    return;
  }
  if (v !== 'save' || !act) return;
  await store.save('cer_cashadv', id, { ...rec, ...act }, by(refs)); toast(`Check No. ${act.checkNo} saved.`, 'ok');
}

async function editLiq(refs, l, list, outOf) {
  if (!l) return;
  let act = null;
  const v = await modal({ title: `Edit liquidation ${l.ref || ''}`,
    body: `<div class="cd-g2"><div class="field"><label for="el-type">Type</label><select class="input" id="el-type"><option value="liq" ${l.type !== 'refund' ? 'selected' : ''}>Liquidation</option><option value="refund" ${l.type === 'refund' ? 'selected' : ''}>Refund (ref = OR No.)</option></select></div>
      <div class="field"><label for="el-date">Date</label><input class="input" type="date" id="el-date" value="${esc(l.date)}"></div>
      <div class="field"><label for="el-ref">LR No. / Reference</label><input class="input mono" id="el-ref" value="${esc(l.ref || '')}"></div>
      <div class="field"><label for="el-part">Particulars</label><input class="input" id="el-part" value="${esc(l.particulars || '')}"></div>
      <div class="field"><label for="el-amt">Amount (₱)</label><input class="input r" id="el-amt" inputmode="decimal" value="${esc(money(l.amount))}"></div>
      <div class="field"><label for="el-for">For Check No.</label><select class="input" id="el-for">${list.map((a) => `<option value="${esc(a.id)}" ${a.id === l.advanceId ? 'selected' : ''}>${esc(a.rest ? `Beginning balance (not itemized) · ₱${money(a.bal)} left` : `${a.checkNo}${a.beg ? ' (Beginning)' : ''} · ${a.particulars || fmtDate(a.date)} · ₱${money(a.bal)} left`)}</option>`).join('')}</select></div></div>
      <label class="cer-tick" id="el-cntbox" ${outOf(l.date) ? '' : 'hidden'}><input type="checkbox" id="el-cnt" ${l.countAnyway ? 'checked' : ''}> Count even if outside the scope</label>`,
    onOpen: (bg) => { $('#el-date', bg).oninput = () => { $('#el-cntbox', bg).hidden = !outOf($('#el-date', bg).value); }; },
    buttons: [{ label: 'Delete', value: 'del' }, { label: 'Cancel', value: null }, { label: 'Save', cls: 'primary', value: 'save', check: (bg) => {
      const x = { type: $('#el-type', bg).value, date: $('#el-date', bg).value, ref: $('#el-ref', bg).value.trim(), particulars: $('#el-part', bg).value.trim(), amount: num($('#el-amt', bg).value), advanceId: $('#el-for', bg).value, countAnyway: outOf($('#el-date', bg).value) && $('#el-cnt', bg).checked };
      const err = checkLiq(x); if (err) return bad(err);
      act = x; return true;
    } }] });
  if (v === 'del') {
    const ok = await modal({ title: 'Delete this liquidation?', body: '<p style="margin:0">Only for an encoding mistake.</p>', buttons: [{ label: 'Keep', value: false }, { label: 'Delete', cls: 'primary', value: true }] });
    if (ok) { await store.save('cer_liquid', l.id, strip(l), by(refs), { deleted: true }); toast('Liquidation deleted.', 'ok'); }
    return;
  }
  if (v !== 'save' || !act) return;
  const a = list.find((x) => x.id === act.advanceId);
  if (!(await okOver(a, act.amount, act.advanceId === l.advanceId ? +l.amount || 0 : 0))) return;
  await store.save('cer_liquid', l.id, { ...strip(l), ...act }, by(refs)); toast('Liquidation saved.', 'ok');
}

/* ---------- Import from Excel: cash advance checks, or liquidations ---------- */
async function importRows(kind, c) {
  const { refs, base, allAdv, list, o } = c;
  const isCa = kind === 'ca';
  let plan = null;
  const read = async (file) => {
    const XLSX = await loadXlsx();
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const cols = isCa ? [['date', /date/i], ['no', /check|cheque/i], ['part', /particular|payee|description/i], ['amt', /amount|amt/i]]
      : [['date', /date/i], ['type', /^\s*type\s*$/i], ['for', /for\s*check|check\s*no|cheque/i], ['ref', /lr|ref|jev|or\s*no/i], ['part', /particular|description/i], ['amt', /amount|amt/i]];
    let sheet = null;
    for (const n of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' });
      for (let r = 0; r < Math.min(rows.length, 15) && !sheet; r++) {
        const map = {}; rows[r].forEach((cell, i) => { const t = String(cell || ''); cols.forEach(([k, re]) => { if (map[k] === undefined && Object.values(map).indexOf(i) < 0 && re.test(t)) map[k] = i; }); });
        if (map.date !== undefined && map.amt !== undefined && (isCa ? map.no !== undefined : map.ref !== undefined)) sheet = { rows, header: r, map };
      }
      if (sheet) break;
    }
    if (!sheet) return { error: `No sheet with the columns ${isCa ? 'Date, Check No. and Amount' : 'Date, LR No. / Reference and Amount'} was found. Use the template.` };
    const M = sheet.map, get = (row, k) => (M[k] === undefined ? '' : row[M[k]]);
    const add = [], problems = [];
    const key = (v) => String(v ?? '').replace(/\D/g, '').replace(/^0+/, '');
    const tk = (v) => key(v) || String(v).trim().toUpperCase();   // 0001749805 = 1749805
    const taken = new Set(allAdv.map((a) => tk(a.checkNo)));
    sheet.rows.slice(sheet.header + 1).forEach((row, i) => {
      const line = sheet.header + i + 2;
      const vals = Object.keys(M).map((k) => String(get(row, k) ?? '').trim());
      if (vals.every((v) => !v)) return;
      const date = excelDate(XLSX, get(row, 'date'));
      if (!date) { problems.push({ line, why: 'Date is missing or not a date.' }); return; }
      const aTxt = get(row, 'amt'), amount = typeof aTxt === 'number' ? r2(aTxt) : num(aTxt);
      if (!amount || amount <= 0) { problems.push({ line, why: 'Amount is missing or not a number.' }); return; }
      const particulars = String(get(row, 'part') ?? '').trim().replace(/\s+/g, ' ');
      if (isCa) {
        const checkNo = String(get(row, 'no') ?? '').trim();
        if (!checkNo) { problems.push({ line, why: 'Check No. is missing.' }); return; }
        if (taken.has(tk(checkNo))) { problems.push({ line, why: `Check No. ${checkNo} is already encoded.` }); return; }
        taken.add(tk(checkNo));
        add.push({ date, checkNo, particulars, amount, show: checkNo });
      } else {
        const ref = String(get(row, 'ref') ?? '').trim();
        if (!ref) { problems.push({ line, why: 'LR No. / Reference is missing.' }); return; }
        const forTxt = String(get(row, 'for') ?? '').trim();
        const adv = forTxt ? list.find((a) => !a.rest && key(a.checkNo) && key(a.checkNo) === key(forTxt)) : null;
        const advanceId = adv ? adv.id : (!forTxt || /begin/i.test(forTxt)) && list.some((a) => a.rest) ? '__beg' : '';
        if (!advanceId) { problems.push({ line, why: forTxt ? `Check No. ${forTxt} is not encoded for this officer.` : 'For Check No. is missing.' }); return; }
        const type = /refund/i.test(String(get(row, 'type') ?? '')) ? 'refund' : 'liq';
        add.push({ type, date, ref, particulars, amount, advanceId, show: `${type === 'refund' ? 'Refund OR ' : ''}${ref} → ${adv ? adv.checkNo : 'Beginning balance'}` });
      }
    });
    return { add, problems };
  };
  const show = (bg, p) => {
    const box = $('#ci-res', bg);
    if (p.error) { box.innerHTML = `<div class="msg bad">${esc(p.error)}</div>`; return; }
    box.innerHTML = `<div class="oi-sum"><b>${p.add.length} ${isCa ? 'check' : 'liquidation'}${p.add.length === 1 ? '' : 's'} to add</b> · ₱ ${money(r2(p.add.reduce((n, x) => n + x.amount, 0)))}</div>
      ${p.add.length ? `<div class="af-tbl oi-prev"><table class="af-reg"><thead><tr><th>Date</th><th>${isCa ? 'Check No.' : 'Reference → Check No.'}</th><th>Particulars</th><th class="r">Amount</th></tr></thead><tbody>${p.add.slice(0, 200).map((x) => `<tr><td>${esc(fmtDate(x.date))}</td><td class="mono">${esc(x.show)}</td><td>${esc(x.particulars)}</td><td class="r">${money(x.amount)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${p.problems.length ? `<div class="af-probs"><b>Rows not imported (${p.problems.length})</b>${p.problems.slice(0, 60).map((q) => `<div>Row ${q.line} — ${esc(q.why)}</div>`).join('')}</div>` : ''}`;
  };
  const v = await modal({ title: `Import ${isCa ? 'Cash Advances' : 'Liquidations'} · ${o.name}`, wide: true,
    body: `<p class="af-note">Excel columns: <b>${isCa ? 'Date, Check No., Particulars, Amount' : 'Type, Date, LR No. / Reference, Particulars, Amount, For Check No.'}</b>.${isCa ? ' Only the checks issued to this officer as cash advances.' : ' Type: Liquidation (or blank) or Refund (the reference is then the OR No.). For Check No. must be a cash advance already encoded; blank or "Beginning" goes to the beginning balance (not itemized).'}</p>
      <div class="field"><label for="ci-file">Excel file</label><input class="input" type="file" id="ci-file" accept=".xlsx,.xls,.csv"></div><div id="ci-res"></div>`,
    onOpen: (bg) => { $('#ci-file', bg).onchange = async (e) => { const fl = e.target.files[0]; if (!fl) return; $('#ci-res', bg).innerHTML = '<p class="af-note">Reading…</p>';
      try { plan = await read(fl); show(bg, plan); } catch (err) { plan = null; $('#ci-res', bg).innerHTML = `<div class="msg bad">${esc(err.message || String(err))}</div>`; } }; },
    buttons: [{ label: 'Cancel', value: null }, { label: 'Import', cls: 'primary', value: 'go', check: () => { if (!plan || plan.error) { toast('Choose the Excel file first.', 'bad'); return false; } if (!plan.add.length) { toast('Nothing to import.', 'bad'); return false; } return true; } }] });
  if (v !== 'go') return;
  for (const x of plan.add) {
    const { show: _s, ...rec } = x;
    await store.save(isCa ? 'cer_cashadv' : 'cer_liquid', newId(isCa ? 'cerca' : 'cerlq'), { ...base, ...rec }, by(refs), { quiet: true });
  }
  OPEN.ca = isCa; OPEN.lq = !isCa;
  emitChange('local'); toast(`${plan.add.length} ${isCa ? 'cash advance' : 'liquidation'}${plan.add.length === 1 ? '' : 's'} imported.`, 'ok');
}
