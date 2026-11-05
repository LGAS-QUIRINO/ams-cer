// CER · Cashbook (barangays; design approved 5 Nov 2026), for the period covered by the cash exam.
// Generated from the records already encoded, in the layout of the barangay Cashbook:
//   Cash in Local Treasury  collections (ORs) − deposits / remittances; beginning = undeposited collections in Audit Setup
//   Cash in Bank            deposits of the account's fund + bank credits − checks issued (Check Disbursements Journal); beginning typed
//   Cash Advance            cash advance checks of this officer − liquidations / refunds; beginning = Audit Setup
//   Petty Cash              petty cash checks (1-01-01-020) − PCV payments; beginning typed
// Typed here (cer_settings id cashbook|<examId>|<acctId>): begBank, begPc, other[{ id, date, type: bankCr | bankDr | pcv, part, ref, amount }].
// The Cash in Bank ending is the Balance per Cashbook of the bank reconciliation.
import { store, newId } from '../../js/store.js';
import { esc, modal, toast, $, $$ } from '../../js/ui.js';
import { by, hasRole, mayView, agencyName, fmtDate, money, num } from './cer.js';
import { loadForms, orIn, FORM_SHORT } from './forms.js';
import { listT, loadJournal, checkAmountOf, chkNo } from '../src/journal.js';
import { tagSameDay, depRefText } from './collections.js';
import { accountability } from './verify.js';

const r2 = (n) => Math.round((+n || 0) * 100) / 100;
const flat = (r) => ({ id: r.id, ...r.data });
const canEncode = (refs) => hasRole(refs, 'staff', 'member', 'atl', 'sa', 'admin');
const acctLabel = (x) => `${x.bank || 'Bank'} · ${x.accountNo || '—'} · ${x.fund}`;
const PC_CODE = '1-01-01-020';
const SHORT = { af51: 'AF 51', af51b: 'AF 51', ctci: 'CTC', ctcc: 'CTC Corp.' };
const CA_ONLY = ['1-03-03-010', '1-03-03-020'];
const OTHER = { bankCr: 'Bank credit (IRA, interest…)', bankDr: 'Bank debit (bank charges…)', pcv: 'Petty cash payment (PCV)' };
const go = (params) => { const q = new URLSearchParams(location.hash.split('?')[1] || ''); Object.entries(params).forEach(([k, v]) => (v ? q.set(k, v) : q.delete(k))); location.hash = '#/cer/cashbook?' + q.toString(); };
const bad = (m) => { toast(m, 'bad'); return false; };

// The rows and balances of one officer's Cashbook for one bank account.
export function cashbookOf({ refs, f, audit, exam, acct, advs, liqs, jr, cb }) {
  const from = exam.lastExamDate || '', to = audit.countDate, o = exam.o;
  const inS = (d) => !!d && (!from || d >= from) && d <= to;
  const A = accountability(refs, f, audit, exam, advs, liqs, []);
  const beg = { clt: r2(Object.entries(A.moves).filter(([k]) => k.startsWith('col-')).reduce((n, [, m]) => n + (m.beg || 0), 0)), cib: r2(num(cb.begBank) || 0), ca: r2(A.moves.ca ? A.moves.ca.beg : 0), pc: r2(num(cb.begPc) || 0) };
  const rows = [];
  const row = (date, part, ref, v) => rows.push({ date, part, ref, cltC: 0, cltD: 0, cibD: 0, cibK: 0, ca: 0, pc: 0, ...v });
  // Collections: one line per day and form, with the OR numbers.
  const byDay = {};
  f.ors.filter((x) => x.officerId === o.id && x.status !== 'cancelled' && orIn(f, x, from, to)).forEach((x) => { const k = `${x.date}|${x.form}`; (byDay[k] = byDay[k] || []).push(x); });
  Object.entries(byDay).forEach(([k, xs]) => { const [date, form] = k.split('|'); const ns = xs.map((x) => +x.serial).sort((a, b) => a - b);
    row(date, `Collections (${SHORT[form] || FORM_SHORT[form] || form})`, `${ns[0]}${ns.length > 1 ? '–' + ns[ns.length - 1] : ''}`, { cltC: r2(xs.reduce((n, x) => n + (+x.amount || 0), 0)) }); });
  // Deposits (and, for the SCR, remittances to the MTO).
  f.reports.filter((r) => r.officerId === o.id).forEach((r) => (r.deposits || []).filter((d) => inS(d.date)).forEach((d) => {
    const rem = r.kind === 'SCR', toBank = !rem && r.fund === acct.fund;
    row(d.date, rem ? `Remittance to MTO${d.ref ? ' · ' + d.ref : ''}` : 'Deposit', rem ? '' : depRefText(d), { cltD: +d.amount || 0, cibD: toBank ? +d.amount || 0 : 0 });
  }));
  // Checks of this account (Check Disbursements Journal).
  const jrNos = new Set();
  jr.filter((c) => c.lguId === audit.lguId && c.acctId === acct.id && inS(c.date)).forEach((c) => {
    jrNos.add(chkNo(c.checkNo));
    if (c.cancelled) { row(c.date, 'Cancelled', String(c.checkNo), {}); return; }
    const ls = c.lines || [], mineCa = c.officerId === o.id;
    row(c.date, [c.payee, c.particulars].filter(Boolean).join(' · '), [c.checkNo, c.ref].filter(Boolean).join(' · '), {
      cibK: checkAmountOf(c), ca: mineCa ? r2(ls.filter((l) => CA_ONLY.includes(l.code)).reduce((n, l) => n + (+l.gross || 0), 0)) : 0,
      pc: r2(ls.filter((l) => l.code === PC_CODE).reduce((n, l) => n + (+l.gross || 0), 0)) });
  });
  // Cash advances typed in Cash Advances (not in the journal).
  advs.filter((a) => a.officerId === o.id && !a.beg && !a.fromJournal && inS(a.date)).forEach((a) => {
    const inJr = jrNos.has(chkNo(a.checkNo));
    if (inJr) return;
    row(a.date, `Cash advance${a.particulars ? ' · ' + a.particulars : ''}`, a.checkNo ? String(a.checkNo) : '', { ca: +a.amount || 0, cibK: +a.amount || 0 });
  });
  // Liquidations and refunds.
  liqs.filter((l) => l.officerId === o.id && (inS(l.date) || l.countAnyway)).forEach((l) => row(l.date, l.type === 'refund' ? 'Refund of cash advance' : `Liquidation${l.particulars && !/^liquidation$/i.test(l.particulars) ? ' · ' + l.particulars : ''}`, l.ref || '', { ca: -(+l.amount || 0) }));
  // Typed here: bank credits and debits, petty cash payments.
  (cb.other || []).filter((x) => inS(x.date)).forEach((x) => row(x.date, x.part || OTHER[x.type], x.ref || '',
    { otherId: x.id, ...(x.type === 'bankCr' ? { cibD: +x.amount || 0 } : x.type === 'bankDr' ? { cibK: +x.amount || 0 } : { pc: -(+x.amount || 0) }) }));
  rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const run = { ...beg };
  rows.forEach((r) => {
    if (r.cltC || r.cltD) { run.clt = r2(run.clt + r.cltC - r.cltD); r.cltB = run.clt; }
    if (r.cibD || r.cibK) { run.cib = r2(run.cib + r.cibD - r.cibK); r.cibB = run.cib; }
    if (r.ca) { run.ca = r2(run.ca + r.ca); r.caB = run.ca; }
    if (r.pc) { run.pc = r2(run.pc + r.pc); r.pcB = run.pc; }
  });
  const sum = (k) => r2(rows.reduce((n, r) => n + (r[k] || 0), 0));
  return { from, to, beg, end: run, rows, tot: { cltC: sum('cltC'), cltD: sum('cltD'), cibD: sum('cibD'), cibK: sum('cibK') } };
}

// The treasurer's Cash in Bank ending for a bank account (for the reconciliation); null when not a barangay.
export async function cashbookEnding(refs, audit, acct) {
  const lgu = refs.lgu[audit.lguId]; if (!lgu || lgu.data.kind !== 'barangay') return null;
  const f = await loadForms();
  const [reports, advs0, liqs0, set0] = await Promise.all(['cer_reports', 'cer_cashadv', 'cer_liquid', 'cer_settings'].map(listT));
  f.reports = tagSameDay(reports.map(flat));
  const exams = f.exams.filter((e) => e.auditId === audit.id).map((e) => ({ ...e, o: f.officers.find((x) => x.id === e.officerId) })).filter((e) => e.o);
  const exam = exams.find((e) => /treasurer/i.test(e.o.designation || '')) || exams[0]; if (!exam) return null;
  const cb = (set0.map(flat).find((s) => s.id === `cashbook|${exam.id}|${acct.id}`)) || {};
  return cashbookOf({ refs, f, audit, exam, acct, advs: advs0.map(flat), liqs: liqs0.map(flat), jr: await loadJournal(), cb }).end.cib;
}

export async function cashbookView(ctx) {
  const { refs, q } = ctx;
  const crumb = 'Cashbook';
  const f = await loadForms();
  const [reports, advs0, liqs0, set0] = await Promise.all(['cer_reports', 'cer_cashadv', 'cer_liquid', 'cer_settings'].map(listT));
  f.reports = tagSameDay(reports.map(flat));
  const settings = Object.fromEntries(set0.map((s) => [s.id, s.data]));
  const audits = f.audits.filter((a) => mayView(refs, refs.lgu[a.lguId]) && refs.lgu[a.lguId]?.data.kind === 'barangay').sort((a, b) => String(b.countDate).localeCompare(String(a.countDate)));
  if (!audits.length) return { crumb, body: '<div class="panel"><div class="empty"><b>No cash examination of a barangay yet.</b> The Cashbook is for barangays.</div></div>' };
  const audit = audits.find((a) => a.id === q.get('a')) || audits[0];
  const lgu = refs.lgu[audit.lguId];
  const exams = f.exams.filter((e) => e.auditId === audit.id).map((e) => ({ ...e, o: f.officers.find((x) => x.id === e.officerId) })).filter((e) => e.o);
  const exam = exams.find((e) => e.id === q.get('e')) || exams.find((e) => /treasurer/i.test(e.o.designation || '')) || exams[0] || null;
  const accounts = settings['banks|' + audit.lguId]?.list || [];
  const acct = accounts.find((x) => x.id === q.get('acct')) || accounts[0] || null;
  const enc = canEncode(refs);
  const top = `<div class="panel cb-top">
      <div class="field"><label for="cb-audit">Cash Examination</label><select class="input" id="cb-audit">${audits.map((a) => `<option value="${esc(a.id)}" ${a.id === audit.id ? 'selected' : ''}>${esc(agencyName(refs, refs.lgu[a.lguId]))} · ${esc(fmtDate(a.countDate))}</option>`).join('')}</select></div>
      <div class="field"><label for="cb-exam">Accountable Officer</label><select class="input" id="cb-exam">${exams.map((e) => `<option value="${esc(e.id)}" ${exam && e.id === exam.id ? 'selected' : ''}>${esc(e.o.name)}</option>`).join('') || '<option value="">No officer</option>'}</select></div>
      <div class="field"><label for="cb-acct">Bank Account</label><select class="input" id="cb-acct">${accounts.map((x) => `<option value="${esc(x.id)}" ${acct && x.id === acct.id ? 'selected' : ''}>${esc(acctLabel(x))}</option>`).join('') || '<option value="">No bank account yet</option>'}</select></div>
      <a class="btn sm" href="#/src?l=${esc(audit.lguId)}${acct ? '&acct=' + esc(acct.id) : ''}" title="Check Disbursements Journal (Source Documents)">CkDJ</a>
      ${exam && acct ? '<button class="btn sm" type="button" id="cb-xls">Export to Excel</button>' : ''}</div>`;
  const wireTop = () => {
    $('#cb-audit').onchange = (e) => go({ a: e.target.value, e: '', acct: '' });
    $('#cb-exam').onchange = (e) => go({ e: e.target.value });
    $('#cb-acct').onchange = (e) => go({ acct: e.target.value });
  };
  if (!exam) return { crumb, body: top + '<div class="panel"><div class="empty"><b>No accountable officer in this cash examination.</b></div></div>', wire: wireTop };
  if (!acct) return { crumb, body: top + `<div class="panel"><div class="empty"><b>No bank account for ${esc(agencyName(refs, lgu))} yet.</b> Add it in Bank Statements → Bank Accounts.</div></div>`, wire: wireTop };

  const cbId = `cashbook|${exam.id}|${acct.id}`;
  const cb = settings[cbId] || {};
  const advs = advs0.map(flat), liqs = liqs0.map(flat), jr = await loadJournal();
  const C = cashbookOf({ refs, f, audit, exam, acct, advs, liqs, jr, cb });
  const m = (v) => (v ? money(v) : '');
  const sg = (v) => (!v ? '' : v < 0 ? `(${money(-v)})` : money(v));
  const begIn = (k, v) => (enc ? `<input class="input r cb-beg" data-beg="${k}" inputmode="decimal" value="${esc(money(v))}" aria-label="Beginning balance">` : money(v));
  const body = top + `<div class="panel sd-pan"><div class="cd-orhead"><h3 class="cer-h3">Cashbook · ${esc(fmtDate(C.from))} to ${esc(fmtDate(C.to))}</h3>
      ${enc ? '<button class="btn sm" type="button" id="cb-add">+ Other entry</button>' : ''}</div>
    <div class="af-tbl"><table class="af-reg cb-tbl"><thead>
      <tr><th rowspan="2">Date</th><th rowspan="2">Particulars</th><th rowspan="2">Reference</th><th colspan="3" class="c">Cash in Local Treasury</th><th colspan="3" class="c">Cash in Bank</th><th colspan="2" class="c">Cash Advance</th><th colspan="2" class="c">Petty Cash</th><th rowspan="2"></th></tr>
      <tr><th class="r">Collection</th><th class="r">Deposit</th><th class="r">Balance</th><th class="r">Deposit</th><th class="r">Check Issued</th><th class="r">Balance</th><th class="r">Receipt (Disb.)</th><th class="r">Balance</th><th class="r">Receipt (Payments)</th><th class="r">Balance</th></tr></thead>
      <tbody><tr class="cb-beg-row"><td>${esc(fmtDate(C.from))}</td><td><b>Bal. Beginning</b></td><td></td><td></td><td></td><td class="r">${money(C.beg.clt)}</td><td></td><td></td><td class="r">${begIn('begBank', C.beg.cib)}</td><td></td><td class="r">${money(C.beg.ca)}</td><td></td><td class="r">${begIn('begPc', C.beg.pc)}</td><td></td></tr>
      ${C.rows.map((r) => `<tr><td>${esc(fmtDate(r.date))}</td><td>${esc(r.part)}</td><td>${esc(r.ref)}</td><td class="r">${m(r.cltC)}</td><td class="r">${m(r.cltD)}</td><td class="r">${r.cltB !== undefined ? money(r.cltB) : ''}</td>
        <td class="r">${m(r.cibD)}</td><td class="r">${m(r.cibK)}</td><td class="r">${r.cibB !== undefined ? money(r.cibB) : ''}</td><td class="r">${sg(r.ca)}</td><td class="r">${r.caB !== undefined ? money(r.caB) : ''}</td><td class="r">${sg(r.pc)}</td><td class="r">${r.pcB !== undefined ? money(r.pcB) : ''}</td>
        <td>${enc && r.otherId ? `<button class="btn sm" type="button" data-cbx="${esc(r.otherId)}" aria-label="Remove entry">✕</button>` : ''}</td></tr>`).join('')}
      <tr class="cd-foot"><td>${esc(fmtDate(C.to))}</td><td>Totals</td><td></td><td class="r">${money(C.tot.cltC)}</td><td class="r">${money(C.tot.cltD)}</td><td></td><td class="r">${money(C.tot.cibD)}</td><td class="r">${money(C.tot.cibK)}</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
      <tr class="cd-foot"><td>${esc(fmtDate(C.to))}</td><td><b>Bal. Ending</b></td><td></td><td></td><td></td><td class="r"><b>${money(C.end.clt)}</b></td><td></td><td></td><td class="r"><b>${money(C.end.cib)}</b></td><td></td><td class="r"><b>${money(C.end.ca)}</b></td><td></td><td class="r"><b>${money(C.end.pc)}</b></td><td></td></tr></tbody></table></div>
    <p class="af-note">Made from Collections &amp; Deposits, the Check Disbursements Journal and Cash Advances. Type only the Cash in Bank and Petty Cash beginning balances and the other entries. The Cash in Bank ending is the Balance per Cashbook in the bank reconciliation.</p></div>`;

  const save = async (patch, msg) => { await store.save('cer_settings', cbId, { ...cb, ...patch }, by(refs)); if (msg) toast(msg, 'ok'); };
  const wire = () => {
    wireTop();
    $$('.cb-beg').forEach((i) => { i.onchange = () => { const v = num(i.value); if (v === null && i.value.trim()) return bad('Type an amount.'); save({ [i.dataset.beg]: v ?? 0 }, 'Beginning balance saved.'); }; i.onkeydown = (e) => { if (e.key === 'Enter') i.blur(); }; });
    $$('[data-cbx]').forEach((b) => { b.onclick = () => save({ other: (cb.other || []).filter((x) => x.id !== b.dataset.cbx) }, 'Entry removed.'); });
    if ($('#cb-add')) $('#cb-add').onclick = async () => {
      let out = null;
      await modal({ title: '+ Other entry', body: `<div class="cd-g2">
          <div class="field"><label for="cbo-date">Date</label><input class="input" type="date" id="cbo-date"></div>
          <div class="field"><label for="cbo-type">Entry</label><select class="input" id="cbo-type">${Object.entries(OTHER).map(([k, t]) => `<option value="${k}">${t}</option>`).join('')}</select></div>
          <div class="field"><label for="cbo-part">Particulars</label><input class="input" id="cbo-part" placeholder="e.g. IRA"></div>
          <div class="field"><label for="cbo-ref">Reference</label><input class="input" id="cbo-ref" placeholder="e.g. Bank Credit Advice, PCV No."></div>
          <div class="field"><label for="cbo-amt">Amount (₱)</label><input class="input r" id="cbo-amt" inputmode="decimal"></div></div>`,
        buttons: [{ label: 'Cancel', value: null }, { label: 'Add', cls: 'primary', value: 'ok', check: (bg) => {
          const v = { id: newId('cbo'), date: $('#cbo-date', bg).value, type: $('#cbo-type', bg).value, part: $('#cbo-part', bg).value.trim(), ref: $('#cbo-ref', bg).value.trim(), amount: num($('#cbo-amt', bg).value) };
          if (!v.date) return bad('Enter the date.'); if (!(v.amount > 0)) return bad('Enter the amount.');
          if (v.date < C.from || v.date > C.to) return bad(`The date must be within ${fmtDate(C.from)} to ${fmtDate(C.to)}.`);
          out = v; return true; } }] });
      if (out) save({ other: [...(cb.other || []), out] }, 'Entry added.');
    };
    if ($('#cb-xls')) $('#cb-xls').onclick = () => exportCashbook({ C, lgu: agencyName(refs, lgu), officer: exam.o.name, acct }).catch((e) => toast(e.message || String(e), 'bad'));
  };
  return { crumb, body, wire };
}

/* ---------- Excel, in the layout of the barangay Cashbook ---------- */
async function exportCashbook({ C, lgu, officer, acct }) {
  const { loadExcelJS } = await import('./wp.js');
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Cashbook', { pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
  ws.columns = [12, 34, 26, 13, 13, 13, 13, 13, 14, 14, 13, 14, 13].map((w) => ({ width: w }));
  const thin = { style: 'thin' }, box = { top: thin, left: thin, bottom: thin, right: thin };
  const NUM = '#,##0.00;(#,##0.00);""';
  ws.mergeCells('A1:M1'); Object.assign(ws.getCell('A1'), { value: 'CASHBOOK', font: { bold: true, size: 12 }, alignment: { horizontal: 'center' } });
  ws.getCell('A2').value = `Barangay: ${lgu}`; ws.getCell('A3').value = `Barangay Treasurer: ${officer}`;
  ws.getCell('A4').value = `Period: ${fmtDate(C.from)} to ${fmtDate(C.to)}`; ws.getCell('H4').value = `Bank Account: ${acctLabel(acct)}`;
  const h1 = 6, h2 = 7;
  [['A', 'Date'], ['B', 'Particulars'], ['C', 'Reference']].forEach(([c, t]) => { ws.mergeCells(`${c}${h1}:${c}${h2}`); ws.getCell(`${c}${h1}`).value = t; });
  [['D', 'F', 'Cash in Local Treasury'], ['G', 'I', 'Cash in Bank'], ['J', 'K', 'Cash Advance'], ['L', 'M', 'Petty Cash']].forEach(([a, z, t]) => { ws.mergeCells(`${a}${h1}:${z}${h1}`); ws.getCell(`${a}${h1}`).value = t; });
  ['Collection', 'Deposit', 'Balance', 'Deposit', 'Check Issued', 'Balance', 'Receipt (Disbursements)', 'Balance', 'Receipt/ Replenishment (Payments)', 'Balance'].forEach((t, i) => { ws.getCell(h2, 4 + i).value = t; });
  for (const rr of [h1, h2]) for (let c = 1; c <= 13; c++) { const cell = ws.getCell(rr, c); cell.font = { bold: true }; cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; cell.border = box; }
  ws.getRow(h2).height = 44;
  const put = (vals, bold) => { const r = ws.addRow(vals); for (let c = 1; c <= 13; c++) { const cell = r.getCell(c); cell.border = box; if (c >= 4) cell.numFmt = NUM; if (bold) cell.font = { bold: true }; } return r; };
  const d = (iso) => fmtDate(iso);
  put([d(C.from), 'Bal. Beginning', '', null, null, C.beg.clt, null, null, C.beg.cib, null, C.beg.ca, null, C.beg.pc]);
  C.rows.forEach((r) => put([d(r.date), r.part, r.ref, r.cltC || null, r.cltD || null, r.cltB ?? null, r.cibD || null, r.cibK || null, r.cibB ?? null, r.ca || null, r.caB ?? null, r.pc || null, r.pcB ?? null]));
  put([d(C.to), 'Totals', '', C.tot.cltC, C.tot.cltD, null, C.tot.cibD, C.tot.cibK, null, null, null, null, null], true);
  put([d(C.to), 'Bal. Ending', '', null, null, C.end.clt, null, null, C.end.cib, null, C.end.ca, null, C.end.pc], true);
  const last = ws.rowCount + 2;
  ws.mergeCells(`F${last}:M${last}`); Object.assign(ws.getCell(`F${last}`), { value: 'CERTIFICATION:', font: { bold: true }, alignment: { horizontal: 'center' } });
  ws.mergeCells(`B${last + 2}:M${last + 2}`); Object.assign(ws.getCell(`B${last + 2}`), { value: `I hereby certify that the foregoing is a correct and complete record of all my collections, deposits/remittances and balances of my accounts in the Cash - In Local Treasury, Cash in Bank, Cash Advances, and Petty Cash as of ${fmtDate(C.to)}.`, alignment: { horizontal: 'center', wrapText: true } });
  ws.getRow(last + 2).height = 30;
  Object.assign(ws.getCell(`L${last + 5}`), { value: officer, alignment: { horizontal: 'center' }, border: { top: thin } }); ws.mergeCells(`L${last + 5}:M${last + 5}`);
  Object.assign(ws.getCell(`L${last + 6}`), { value: 'Name and Signature', alignment: { horizontal: 'center' } }); ws.mergeCells(`L${last + 6}:M${last + 6}`);
  Object.assign(ws.getCell(`L${last + 8}`), { value: 'Date', alignment: { horizontal: 'center' }, border: { top: thin } }); ws.mergeCells(`L${last + 8}:M${last + 8}`);
  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a'); a.href = url; a.download = `Cashbook ${lgu.replace(/^\s*BLGU\s*-\s*/i, '')} ${C.to}.xlsx`.replace(/[\\/:*?"<>|]/g, '-'); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
}
