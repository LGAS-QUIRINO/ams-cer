// CER · Cash Advances (design approved 18 Oct 2026).
// Two parts, per accountable officer of a cash examination:
//   1. Cash Advance  each check issued to the officer as a cash advance: date, check No., particulars, amount.
//   2. Liquidation   each liquidation (LR No. or other reference, e.g. JEV; a refund with its OR No.), for one check.
// Unliquidated = beginning balance (Audit Setup) + cash advances − liquidations. Each check shows its own balance and status.
// Shared with Records Management later: the checks will come from the disbursements (RCI) encoded there.
//
// Records:
//   cer_cashadv   one cash advance  { lguId, officerId, date, checkNo, particulars, amount }
//   cer_liquid    one liquidation   { lguId, officerId, date, ref, particulars, amount, advanceId }
import { store, newId } from '../../js/store.js';
import { esc, modal, toast, $, $$ } from '../../js/ui.js';
import { hasRole, by, mayView, agencyName, fmtDate, money, num } from './cer.js';
import { exportXlsx } from './forms.js';

const canEncode = (refs) => hasRole(refs, 'staff', 'member', 'atl', 'sa', 'admin');
const r2 = (n) => Math.round(n * 100) / 100;
const flat = (r) => ({ id: r.id, ...r.data });
const strip = (x) => { const { id, ...rest } = x; return rest; };
const bad = (m) => { toast(m, 'bad'); return false; };
const go = (params) => { const q = new URLSearchParams(location.hash.split('?')[1] || ''); Object.entries(params).forEach(([k, v]) => (v ? q.set(k, v) : q.delete(k))); location.hash = location.hash.split('?')[0] + '?' + q.toString(); };
const OPEN = { ca: true, lq: true };
const LAST = { caDate: '', lqDate: '', focus: '' };
// Beginning balance: the officer's cash advance balances in Audit Setup (disbursing, special disbursing, petty cash fund).
const BEG_KEYS = ['ca', 'sdo', 'pcf'];

function figures(advs, liqs) {
  const list = advs.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.checkNo).localeCompare(String(b.checkNo), undefined, { numeric: true }))
    .map((a) => {
      const mine = liqs.filter((l) => l.advanceId === a.id);
      const liq = r2(mine.reduce((n, l) => n + (+l.amount || 0), 0));
      const bal = r2((+a.amount || 0) - liq);
      const st = bal < -0.004 ? ['p-flag', 'Over-liquidated'] : bal <= 0.004 ? ['p-done', 'Fully liquidated'] : liq > 0 ? ['p-part', 'Partly liquidated'] : ['p-stock', 'Not yet liquidated'];
      return { ...a, liq, bal, st, n: mine.length };
    });
  return list;
}

export async function advancesView(ctx) {
  const { refs, q } = ctx;
  const [audits0, exams0, officers0, advs0, liqs0] = await Promise.all(['cer_audits', 'cer_exams', 'cer_officers', 'cer_cashadv', 'cer_liquid'].map((t) => store.list(t)));
  const audits = audits0.map(flat).filter((a) => mayView(refs, refs.lgu[a.lguId])).sort((a, b) => String(b.countDate).localeCompare(String(a.countDate)));
  const officers = officers0.map(flat);
  const crumb = 'Cash Advances';
  const hello = `<div class="hello"><div><h1>Cash Advances</h1><p>Each cash advance (a check issued to the officer) and the liquidations under it. Unliquidated = cash advances − liquidations.</p></div></div>`;
  if (!audits.length) return { crumb, body: hello + '<div class="panel"><div class="empty"><b>No cash examination yet.</b>The auditors set one up in Audit Setup; its accountable officers are listed here.</div></div>' };
  const audit = audits.find((a) => a.id === q.get('a')) || audits[0];
  const exams = exams0.map(flat).filter((e) => e.auditId === audit.id).map((e) => ({ ...e, o: officers.find((x) => x.id === e.officerId) })).filter((e) => e.o);
  const exam = exams.find((e) => e.id === q.get('e')) || exams[0] || null;
  const top = `<div class="panel cd-bar">
      <div class="field"><label for="cd-audit">Cash Examination</label><select class="input" id="cd-audit">${audits.map((a) => `<option value="${esc(a.id)}" ${a.id === audit.id ? 'selected' : ''}>${esc(agencyName(refs, refs.lgu[a.lguId]))} · ${esc(fmtDate(a.countDate))}</option>`).join('')}</select></div>
      <div class="field"><label for="cd-exam">Accountable Officer</label><select class="input" id="cd-exam">${exams.length ? exams.map((e) => `<option value="${esc(e.id)}" ${exam && e.id === exam.id ? 'selected' : ''}>${esc(e.o.name)}${e.o.designation ? ' · ' + esc(e.o.designation) : ''}</option>`).join('') : '<option value="">No officer in this examination</option>'}</select></div></div>`;
  const wireTop = () => {
    $('#cd-audit').onchange = (e) => go({ a: e.target.value, e: '' });
    $('#cd-exam').onchange = (e) => go({ e: e.target.value });
  };
  if (!exam) return { crumb, body: hello + top + '<div class="panel"><div class="empty"><b>No accountable officer in this cash examination.</b>Add the officers in Audit Setup.</div></div>', wire: wireTop };

  const o = exam.o;
  const advs = advs0.map(flat).filter((a) => a.officerId === o.id);
  const liqs = liqs0.map(flat).filter((l) => l.officerId === o.id);
  const beg = r2(BEG_KEYS.reduce((n, k) => n + (+(exam.balances?.[k]?.amount) || 0), 0));
  // The beginning balance is listed first, like a cash advance, so liquidations of older advances can be put against it.
  const begRow = beg ? [{ id: '__beg', beg: true, date: exam.lastExamDate || '', checkNo: 'Beginning', particulars: 'Balance as of the last cash exam', amount: beg }] : [];
  const list = figures([...begRow, ...advs], liqs);
  const totCa = r2(advs.reduce((n, a) => n + (+a.amount || 0), 0));
  const totLq = r2(liqs.reduce((n, l) => n + (+l.amount || 0), 0));
  const unliq = r2(beg + totCa - totLq);
  const open = list.filter((a) => a.bal > 0.004);
  const openChecks = open.filter((a) => !a.beg).length;
  const enc = canEncode(refs);
  const fns = exam.functions || [];
  const noFn = !['disbursing', 'special', 'pettycash'].some((k) => fns.includes(k));
  const acc = (key, n, title, sub, inner) => `<details class="panel cd-acc" data-acc="${key}" ${OPEN[key] ? 'open' : ''}><summary><span class="cd-num">${n}</span><b>${title}</b><span class="cd-sub">${sub}</span></summary><div class="cd-body">${inner}</div></details>`;
  const advLabel = (a) => (a.beg ? `Beginning balance · ₱${money(a.bal)} left` : `${a.checkNo} · ${a.particulars || fmtDate(a.date)} · ₱${money(a.bal)} left`);
  const sorted = list.slice().reverse();   // latest first in the table

  const caBody = `${enc ? `<div class="cd-entry ca-entry">
        <div class="field"><label for="ca-date">Date</label><input class="input" type="date" id="ca-date" value="${esc(LAST.caDate)}"></div>
        <div class="field"><label for="ca-check">Check No.</label><input class="input mono" id="ca-check" autocomplete="off"></div>
        <div class="field"><label for="ca-part">Particulars</label><input class="input" id="ca-part" autocomplete="off"></div>
        <div class="field"><label for="ca-amt">Amount (₱)</label><input class="input r" id="ca-amt" inputmode="decimal" autocomplete="off"></div>
        <button class="btn primary" type="button" id="ca-enter">Enter</button></div>` : ''}
    ${list.length ? `<div class="af-tbl"><table class="af-reg"><thead><tr><th scope="col">Date</th><th scope="col">Check No.</th><th scope="col">Particulars</th><th scope="col" class="r">Amount (₱)</th><th scope="col" class="r">Liquidated (₱)</th><th scope="col" class="r">Balance (₱)</th><th scope="col">Status</th><th scope="col" class="r"></th></tr></thead>
      <tbody>${sorted.map((a) => `<tr${a.beg ? ' class="cd-begrow"' : ''}><td>${esc(fmtDate(a.date))}</td><td class="mono">${a.beg ? '<span class="dim">—</span>' : `<b>${esc(a.checkNo)}</b>`}</td><td>${esc(a.particulars || '')}</td><td class="r">${money(a.amount)}</td><td class="r">${money(a.liq)}</td><td class="r"><b>${money(a.bal)}</b></td>
        <td><span class="pill ${a.st[0]}">${a.st[1]}</span></td><td class="r">${enc && !a.beg ? `<button class="btn sm" type="button" data-eca="${esc(a.id)}" aria-label="Edit check ${esc(a.checkNo)}">Edit</button>` : ''}</td></tr>`).join('')}</tbody>
      <tfoot><tr class="cd-foot"><td colspan="3">Total</td><td class="r">${money(r2(beg + totCa))}</td><td class="r">${money(r2(list.reduce((n, a) => n + a.liq, 0)))}</td><td class="r">${money(r2(list.reduce((n, a) => n + a.bal, 0)))}</td><td></td><td></td></tr></tfoot></table></div>`
      : `<div class="empty"><b>No cash advance encoded for this officer yet.</b>${enc ? 'Enter each check issued to the officer as a cash advance.' : ''}</div>`}
    ${noFn ? '<p class="af-note">This officer has no Disbursing, Special Disbursing or Petty Cash Custodian function ticked in Audit Setup.</p>' : ''}`;

  const lqRows = liqs.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const lqBody = `${enc ? (list.length ? `<div class="cd-entry lq-entry">
        <div class="field"><label for="lq-date">Date</label><input class="input" type="date" id="lq-date" value="${esc(LAST.lqDate)}"></div>
        <div class="field"><label for="lq-ref">LR No. / Reference</label><input class="input mono" id="lq-ref" placeholder="LR, JEV or other" autocomplete="off"></div>
        <div class="field"><label for="lq-part">Particulars</label><input class="input" id="lq-part" autocomplete="off"></div>
        <div class="field"><label for="lq-amt">Amount (₱)</label><input class="input r" id="lq-amt" inputmode="decimal" autocomplete="off"></div>
        <div class="field"><label for="lq-for">For Check No.</label><select class="input" id="lq-for">${(open.length ? open : list).map((a) => `<option value="${esc(a.id)}">${esc(advLabel(a))}</option>`).join('')}${open.length && open.length < list.length ? `<optgroup label="Fully liquidated">${list.filter((a) => a.bal <= 0.004).map((a) => `<option value="${esc(a.id)}">${esc(advLabel(a))}</option>`).join('')}</optgroup>` : ''}</select></div>
        <button class="btn primary" type="button" id="lq-enter">Enter</button></div>` : '<div class="cd-info">Encode the cash advance first, then its liquidations.</div>') : ''}
    ${lqRows.length ? `<div class="af-tbl"><table class="af-reg"><thead><tr><th scope="col">Date</th><th scope="col">LR No. / Reference</th><th scope="col">Particulars</th><th scope="col" class="r">Amount (₱)</th><th scope="col">For Check No.</th><th scope="col" class="r"></th></tr></thead>
      <tbody>${lqRows.map((l) => { const a = list.find((x) => x.id === l.advanceId); return `<tr><td>${esc(fmtDate(l.date))}</td><td class="mono">${esc(l.ref || '')}</td><td>${esc(l.particulars || '')}</td><td class="r">${money(l.amount)}</td>
        <td class="mono">${a ? (a.beg ? 'Beginning balance' : esc(a.checkNo)) : '<span class="pill p-flag">No check</span>'}${a && a.bal < -0.004 ? ' <span class="pill p-flag">Over-liquidated</span>' : ''}</td><td class="r">${enc ? `<button class="btn sm" type="button" data-elq="${esc(l.id)}" aria-label="Edit liquidation ${esc(l.ref || '')}">Edit</button>` : ''}</td></tr>`; }).join('')}</tbody>
      <tfoot><tr class="cd-foot"><td colspan="3">Total</td><td class="r">${money(totLq)}</td><td></td><td></td></tr></tfoot></table></div>`
      : '<div class="empty"><b>No liquidation encoded yet.</b></div>'}
    <p class="af-note">For Check No. starts on the oldest open cash advance; pick another when the LR names it. A liquidation larger than what is left on its check is flagged. A refund is entered here with its OR No. as the reference.</p>`;

  const body = `${hello}${top}
    <div class="stats">
      <div class="stat"><span>Beginning Balance</span><b>₱ ${money(beg)}</b><small>from Audit Setup, as of ${esc(fmtDate(exam.lastExamDate)) || 'the last cash exam'}</small></div>
      <div class="stat"><span>Cash Advances</span><b>₱ ${money(totCa)}</b><small>${advs.length} check${advs.length === 1 ? '' : 's'}</small></div>
      <div class="stat"><span>Liquidations</span><b style="color:var(--ok)">₱ ${money(totLq)}</b><small>${liqs.length} entr${liqs.length === 1 ? 'y' : 'ies'}</small></div>
      <div class="stat"><span>Unliquidated</span><b style="color:#1d4fb8">₱ ${money(unliq)}</b><small>${openChecks} cash advance${openChecks === 1 ? '' : 's'} open${list.some((a) => a.beg && a.bal > 0.004) ? ' + beginning balance' : ''}</small></div>
    </div>
    ${acc('ca', 1, 'Cash Advance', `${advs.length} check${advs.length === 1 ? '' : 's'} · ₱ ${money(totCa)}`, caBody)}
    ${acc('lq', 2, 'Liquidation', `${liqs.length} entr${liqs.length === 1 ? 'y' : 'ies'} · ₱ ${money(totLq)}`, lqBody)}
    <div class="btn-row cd-actions"><button class="btn" type="button" id="ca-xls">Export to Excel</button></div>`;

  return { crumb, body, wire: () => {
    wireTop();
    $$('details.cd-acc').forEach((d) => { d.ontoggle = () => { OPEN[d.dataset.acc] = d.open; }; });
    $('#ca-xls').onclick = () => exportXlsx(`Cash Advances ${o.name} ${audit.countDate}.xlsx`, 'Cash Advances', [
      ...list.map((a) => ({ Entry: a.beg ? 'Beginning Balance' : 'Cash Advance', Date: fmtDate(a.date), 'Check No.': a.checkNo, 'LR No. / Reference': '', Particulars: a.particulars || '', 'Cash Advance': a.amount, Liquidation: '', 'Balance of the Check': a.bal, Status: a.st[1] })),
      ...liqs.slice().sort((x, y) => String(x.date).localeCompare(String(y.date))).map((l) => ({ Entry: 'Liquidation', Date: fmtDate(l.date), 'Check No.': (() => { const a = list.find((x) => x.id === l.advanceId); return a ? (a.beg ? 'Beginning balance' : a.checkNo) : ''; })(), 'LR No. / Reference': l.ref || '', Particulars: l.particulars || '', 'Cash Advance': '', Liquidation: l.amount, 'Balance of the Check': '', Status: '' })),
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
        const err = checkAdv(v, advs, ''); if (err) return bad(err);
        LAST.caDate = v.date; LAST.focus = 'ca';
        await store.save('cer_cashadv', newId('cerca'), { ...base, ...v }, by(refs));
        toast(`Check No. ${v.checkNo} saved.`, 'ok');
      };
    }
    // Liquidation
    const le = $('#lq-enter');
    if (le) {
      amtBlur('#lq-amt'); enterOn(['#lq-ref', '#lq-part', '#lq-amt'], '#lq-enter');
      le.onclick = async () => {
        const v = { date: $('#lq-date').value, ref: $('#lq-ref').value.trim(), particulars: $('#lq-part').value.trim(), amount: num($('#lq-amt').value), advanceId: $('#lq-for').value };
        const err = checkLiq(v); if (err) return bad(err);
        if (!(await okOver(list.find((a) => a.id === v.advanceId), v.amount, 0))) return;
        LAST.lqDate = v.date; LAST.focus = 'lq';
        await store.save('cer_liquid', newId('cerlq'), { ...base, ...v }, by(refs));
        toast('Liquidation saved.', 'ok');
      };
    }
    $$('[data-eca]').forEach((b) => { b.onclick = () => editAdv(refs, list.find((a) => a.id === b.dataset.eca), advs, liqs); });
    $$('[data-elq]').forEach((b) => { b.onclick = () => editLiq(refs, liqs.find((l) => l.id === b.dataset.elq), list); });
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
  if (!v.ref) return 'Enter the LR No. or another reference (JEV, OR No. for a refund).';
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

async function editLiq(refs, l, list) {
  if (!l) return;
  let act = null;
  const v = await modal({ title: `Edit liquidation ${l.ref || ''}`,
    body: `<div class="cd-g2"><div class="field"><label for="el-date">Date</label><input class="input" type="date" id="el-date" value="${esc(l.date)}"></div>
      <div class="field"><label for="el-ref">LR No. / Reference</label><input class="input mono" id="el-ref" value="${esc(l.ref || '')}"></div>
      <div class="field"><label for="el-part">Particulars</label><input class="input" id="el-part" value="${esc(l.particulars || '')}"></div>
      <div class="field"><label for="el-amt">Amount (₱)</label><input class="input r" id="el-amt" inputmode="decimal" value="${esc(money(l.amount))}"></div>
      <div class="field"><label for="el-for">For Check No.</label><select class="input" id="el-for">${list.map((a) => `<option value="${esc(a.id)}" ${a.id === l.advanceId ? 'selected' : ''}>${esc(a.beg ? `Beginning balance · ₱${money(a.bal)} left` : `${a.checkNo} · ${a.particulars || fmtDate(a.date)} · ₱${money(a.bal)} left`)}</option>`).join('')}</select></div></div>`,
    buttons: [{ label: 'Delete', value: 'del' }, { label: 'Cancel', value: null }, { label: 'Save', cls: 'primary', value: 'save', check: (bg) => {
      const x = { date: $('#el-date', bg).value, ref: $('#el-ref', bg).value.trim(), particulars: $('#el-part', bg).value.trim(), amount: num($('#el-amt', bg).value), advanceId: $('#el-for', bg).value };
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
