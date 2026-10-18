// CER · Reports, made from the data encoded (no retyping). For now:
//   GF 74-A  Report of Cash Examination (front: cash production notice, cash count, unused forms, certification;
//            back: statement of accountability, certification, signatures)
//   Annex B  SAAF, Statement of Accountability for Accountable Forms
//   Annex C  Statement of Accountability – collections, by month (barangays: AF 51 (SCD) and CTC (SCR); LGU: RCD)
//   Annex D  Statement of Accountability – cash advances, by month
// Other reports follow.
import { store } from '../../js/store.js';
import { esc, $, $$ } from '../../js/ui.js';
import { mayView, agencyName, fmtDate, money, num } from './cer.js';
import { loadForms, saafRows, unusedFormsOf, exportXlsx, countRanges, FORM_SHORT } from './forms.js';
import { accountability } from './verify.js';

const flat = (r) => ({ id: r.id, ...r.data });
const r2 = (n) => Math.round(n * 100) / 100;
const go = (params) => { const q = new URLSearchParams(location.hash.split('?')[1] || ''); Object.entries(params).forEach(([k, v]) => (v ? q.set(k, v) : q.delete(k))); location.hash = location.hash.split('?')[0] + '?' + q.toString(); };
const BILLS = [1000, 500, 200, 100, 50, 20];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const REPORTS = [['74a', 'GF 74-A · Report of Cash Examination'], ['saaf', 'Annex B · SAAF'], ['soac', 'Annex C · Statement of Accountability (Collections)'], ['soad', 'Annex D · Statement of Accountability (Cash Advances)']];
const amt = (n) => (n === null || n === undefined ? '' : n < -0.004 ? `(${money(-n)})` : money(n));

// Amount in words, e.g. 35,000 → "Thirty Five Thousand Pesos Only".
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function under1000(n) {
  const h = Math.floor(n / 100), r = n % 100;
  return [h ? ONES[h] + ' Hundred' : '', r < 20 ? ONES[r] : TENS[Math.floor(r / 10)] + (r % 10 ? ' ' + ONES[r % 10] : '')].filter(Boolean).join(' ');
}
export function inWords(x) {
  const n = Math.abs(r2(+x || 0)); const p = Math.floor(n), c = Math.round((n - p) * 100);
  if (!p && !c) return 'Zero Pesos Only';
  const parts = []; let rest = p;
  [[1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand'], [1, '']].forEach(([u, name]) => { const k = Math.floor(rest / u); rest %= u; if (k) parts.push(under1000(k) + (name ? ' ' + name : '')); });
  return `${parts.join(' ')}${p ? (p === 1 ? ' Peso' : ' Pesos') : ''}${c ? `${p ? ' and ' : ''}${c}/100` : ''} Only`.trim();
}

export async function reportsView(ctx) {
  const { refs, q } = ctx;
  const f = await loadForms();
  const [reports, advs0, liqs0, counts0, ver0] = await Promise.all(['cer_reports', 'cer_cashadv', 'cer_liquid', 'cer_cashcount', 'cer_verify'].map((t) => store.list(t)));
  f.reports = reports.map(flat);
  const advs = advs0.map(flat), liqs = liqs0.map(flat), counts = counts0.map(flat);
  const crumb = 'Reports';
  const hello = `<div class="hello"><div><h1>Reports</h1><p>Made from the records encoded: nothing is typed again. Print or export each one. More reports follow.</p></div></div>`;
  const audits = f.audits.filter((a) => mayView(refs, refs.lgu[a.lguId])).sort((a, b) => String(b.countDate).localeCompare(String(a.countDate)));
  if (!audits.length) return { crumb, body: hello + '<div class="panel"><div class="empty"><b>No cash examination yet.</b>The auditors set one up in Audit Setup.</div></div>' };
  const audit = audits.find((a) => a.id === q.get('a')) || audits[0];
  const exams = f.exams.filter((e) => e.auditId === audit.id).map((e) => ({ ...e, o: f.officers.find((x) => x.id === e.officerId) })).filter((e) => e.o);
  const exam = exams.find((e) => e.id === q.get('e')) || exams[0] || null;
  const rep = REPORTS.some(([k]) => k === q.get('rep')) ? q.get('rep') : '74a';
  const top = `<div class="panel cd-bar rp-bar">
      <div class="field"><label for="rp-audit">Cash Examination</label><select class="input" id="rp-audit">${audits.map((a) => `<option value="${esc(a.id)}" ${a.id === audit.id ? 'selected' : ''}>${esc(agencyName(refs, refs.lgu[a.lguId]))} · ${esc(fmtDate(a.countDate))}</option>`).join('')}</select></div>
      <div class="field"><label for="rp-exam">Accountable Officer</label><select class="input" id="rp-exam">${exams.length ? exams.map((e) => `<option value="${esc(e.id)}" ${exam && e.id === exam.id ? 'selected' : ''}>${esc(e.o.name)}${e.o.designation ? ' · ' + esc(e.o.designation) : ''}</option>`).join('') : '<option value="">No officer in this examination</option>'}</select></div>
      <div class="field"><label for="rp-rep">Report</label><select class="input" id="rp-rep">${REPORTS.map(([k, l]) => `<option value="${k}" ${k === rep ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div></div>`;
  const wireTop = () => {
    $('#rp-audit').onchange = (e) => go({ a: e.target.value, e: '' });
    $('#rp-exam').onchange = (e) => go({ e: e.target.value });
    $('#rp-rep').onchange = (e) => go({ rep: e.target.value });
  };
  if (!exam) return { crumb, body: hello + top + '<div class="panel"><div class="empty"><b>No accountable officer in this cash examination.</b>Add the officers in Audit Setup.</div></div>', wire: wireTop };

  const A = accountability(refs, f, audit, exam, advs, liqs, counts);
  const ver = ver0.map(flat).find((v) => v.id === exam.id) || null;
  const lgu = A.lgu, o = exam.o;
  const agency = agencyName(refs, lgu);
  const station = lgu.data.kind === 'barangay' ? `${refs.lgu[lgu.data.parentId]?.data.name || ''}, Quirino` : lgu.data.kind === 'municipality' ? `${lgu.data.name}, Quirino` : 'Cabarroguis, Quirino';
  const person = (id) => { const u = refs.user[id]; return u ? { name: u.data.name || '', pos: u.data.position || '', des: u.data.designation || '' } : { name: '', pos: '', des: '' }; };
  const prep = person(audit.preparedBy), rev = person(audit.reviewedBy);
  const sign = (label, p, extra = '') => `<div class="rp-sign"><span>${label}</span><b>${esc(p.name || ' ')}</b><small>${esc([p.pos, p.des].filter(Boolean).join(' · ') || extra)}</small></div>`;
  const ctx2 = { refs, f, audit, exam, o, A, agency, station, prep, rev, sign, ver };
  const doc = rep === '74a' ? gf74a(ctx2) : rep === 'saaf' ? saaf(ctx2) : rep === 'soac' ? soa(ctx2, 'col') : soa(ctx2, 'ca');
  const note = !A.count && rep === '74a' ? '<div class="cd-info">No cash count saved yet for this officer: part B is blank. Save it in Cash Count.</div>' : '';
  const status = ver?.ready ? '<span class="pill p-done">Verification: Ready for Reports</span>' : '<span class="pill p-flag">Verification not yet marked ready</span>';
  const body = `${hello}${top}
    <div class="rp-tools">${status}<div class="btn-row"><button class="btn" type="button" id="rp-xls">Export to Excel</button><button class="btn primary" type="button" id="rp-print">Print</button></div></div>
    ${note}
    <div id="cer-print" class="rp-doc">${doc.html}</div>`;
  return { crumb, body, wire: () => {
    wireTop();
    $('#rp-print').onclick = () => { document.body.classList.add('af-printing', 'rp-printing'); window.print(); document.body.classList.remove('af-printing', 'rp-printing'); };
    $('#rp-xls').onclick = () => exportXlsx(`${REPORTS.find(([k]) => k === rep)[1].split(' · ')[0]} ${o.name} ${audit.countDate}.xlsx`, 'Report', doc.rows);
  } };
}

/* ---------- GF 74-A ---------- */
function gf74a(c) {
  const { audit, exam, o, A, agency, station, prep, sign } = c;
  const cnt = A.count || { bills: {}, coins: 0, items: [] };
  const b = exam.bond || {};
  const bills = BILLS.map((v) => ({ v, n: parseInt(cnt.bills?.[v], 10) || 0 }));
  const cash = r2(bills.reduce((n, x) => n + x.v * x.n, 0) + (+cnt.coins || 0));
  const items = (cnt.items || []).map((it) => { const a = num(it.allowed ?? it.presented) ?? 0; return { ...it, allowed: a, dis: r2((+it.presented || 0) - a) }; });
  const allowed = r2(items.reduce((n, x) => n + x.allowed, 0)), disallowed = r2(items.reduce((n, x) => n + x.dis, 0));
  const forms = unusedFormsOf(c.f, o.id, exam, A.to);
  const formsQty = forms.reduce((n, x) => n + x.qty, 0);
  const total = A.T('balance');
  const head = `<div class="rp-top"><span>General Form No. 74(A)<br>Revised December 22, 1983</span><span class="r">Republic of the Philippines<br><b>COMMISSION ON AUDIT</b></span></div>
    <h2 class="rp-title">REPORT OF CASH EXAMINATION</h2>
    <table class="rp-kv"><tr><td>Name of Accountable Officer</td><td><b>${esc(o.name)}</b></td><td>Position</td><td><b>${esc(o.designation || '')}</b></td></tr>
      <tr><td>Agency</td><td><b>${esc(agency)}</b></td><td>Station</td><td><b>${esc(station)}</b></td></tr>
      <tr><td>Maximum Cash Accountability</td><td>${b.maxCash ? money(b.maxCash) : ''}</td><td>Amount of Bond</td><td>${b.amount ? money(b.amount) : ''}</td></tr>
      <tr><td>Risk No.</td><td>${esc(b.riskNo || '')}</td><td>Effective Date</td><td>${b.from || b.to ? `${esc(fmtDate(b.from))} to ${esc(fmtDate(b.to))}` : ''}</td></tr>
      <tr><td>Auditor / Examiner</td><td><b>${esc(prep.name)}</b></td><td>Official Designation</td><td>${esc(prep.pos)}</td></tr></table>`;
  const front = `${head}
    <h3>A. CASH PRODUCTION NOTICE</h3>
    <p>TO: <b>${esc(o.name)}</b>, ${esc(o.designation || '')} · Date: <b>${esc(fmtDate(audit.countDate))}</b></p>
    <p class="rp-just">DEMAND is hereby made that you produce all your cash, treasury warrants, checks, money orders, cash items, paid vouchers, unused accountable forms, etc., for which you are officially accountable as ${esc(o.designation || '')} of the ${esc(agency)} and any fund, checks, treasury warrants and/or cash items in your possession held by you for deposit and safekeeping.</p>
    <div class="rp-signs">${sign('Noted and complied with', { name: o.name, pos: `Accountable Officer · ${fmtDate(audit.countDate)}` })}${sign('Auditor / Representative', prep)}</div>
    <h3>B. CASH COUNT</h3>
    <div class="rp-two">
      <table class="rp-t"><thead><tr><th colspan="3">Inventory of Cash on Hand</th></tr><tr><th>Denomination</th><th class="r">No. of Pcs.</th><th class="r">Amount</th></tr></thead>
        <tbody>${bills.map((x) => `<tr><td>${x.v.toLocaleString('en-US')}</td><td class="r">${x.n || ''}</td><td class="r">${x.n ? money(x.v * x.n) : ''}</td></tr>`).join('')}
        <tr><td>Coins</td><td></td><td class="r">${+cnt.coins ? money(cnt.coins) : ''}</td></tr>
        <tr class="tot"><td colspan="2">Total As Presented</td><td class="r">₱ ${money(cash)}</td></tr></tbody></table>
      <table class="rp-t"><thead><tr><th colspan="4">Inventory of Cash Items (checks, treasury warrants, money orders, etc.)</th></tr><tr><th>Particulars</th><th class="r">Presented</th><th class="r">Allowed</th><th class="r">Disallowed</th></tr></thead>
        <tbody>${items.length ? items.map((x) => `<tr><td>${esc(x.particulars)}</td><td class="r">${money(x.presented)}</td><td class="r">${money(x.allowed)}</td><td class="r">${money(x.dis)}</td></tr>`).join('') : '<tr><td colspan="4" class="c">None</td></tr>'}
        <tr class="tot"><td>Total As Presented</td><td class="r">${money(r2(allowed + disallowed))}</td><td class="r">${money(allowed)}</td><td class="r">${money(disallowed)}</td></tr></tbody></table>
    </div>
    <p class="rp-line"><b>TOTAL INVENTORY OF CASH AND/OR ALLOWED CASH ITEMS (TO D)</b><b>₱ ${money(r2(cash + allowed))}</b></p>
    <h3>C. INVENTORY OF UNUSED ACCOUNTABLE FORMS</h3>
    <div class="rp-two">
      <table class="rp-t"><thead><tr><th colspan="5">With Money Value</th></tr><tr><th>Name of Form</th><th class="r">Qty.</th><th>Inclusive Serial No.</th><th class="r">Denomination</th><th class="r">Amount</th></tr></thead>
        <tbody><tr><td colspan="5" class="c">None</td></tr><tr class="tot"><td colspan="4">Total</td><td class="r">₱ 0.00</td></tr></tbody></table>
      <table class="rp-t"><thead><tr><th colspan="3">Without Money Value</th></tr><tr><th>Name of Form</th><th class="r">Qty.</th><th>Inclusive Serial No.</th></tr></thead>
        <tbody>${forms.length ? forms.map((x) => `<tr><td>${esc(x.name)}</td><td class="r">${x.qty}</td><td>${esc(x.text) || 'None'}</td></tr>`).join('') : '<tr><td colspan="3" class="c">None</td></tr>'}
        <tr class="tot"><td>Total</td><td class="r">${formsQty}</td><td></td></tr></tbody></table>
    </div>
    <h3>CERTIFICATION</h3>
    <p class="rp-just">I HEREBY CERTIFY on my official oath: (1) That upon demand by the Auditor / Examiner I produced all my cash, treasury warrants, checks, money orders, cash items, paid vouchers, unused accountable forms, etc., for which I am officially accountable; (2) That the inventory of such cash items and unused accountable forms in my possession and produced to the Auditor / Examiner at the time of cash count today, ${esc(fmtDate(audit.countDate))}, is correctly stated above and is broken down as follows:</p>
    <table class="rp-kv rp-cert"><tr><td>1) Cash and / or cash items</td><td class="r">₱ ${money(r2(cash + allowed + disallowed))}</td></tr>
      <tr><td>2) Unused accountable forms with money value</td><td class="r">₱ 0.00</td></tr>
      <tr><td>3) Unused accountable forms without money value</td><td class="r">${formsQty} pcs.</td></tr></table>
    <p class="rp-just">of which (₱ ${money(disallowed)}) was disallowed by the Auditor / Examiner and (3) That said cash, treasury warrants, checks, money orders, cash items, paid vouchers, unused accountable forms, etc., were returned to me intact after the cash count.</p>
    <div class="rp-signs">${sign('Accountable Officer', { name: o.name, pos: o.designation || '' })}${sign('Signed in the presence of', prep)}</div>`;
  const back = `<div class="rp-break"></div>
    <h3>D. STATEMENT OF ACCOUNTABILITY</h3>
    ${soaTable(A)}
    <h3>CERTIFICATION</h3>
    <p class="rp-just">I HEREBY CERTIFY that my accountability for the above funds of ${esc(agency)} at the time of examination on ${esc(fmtDate(audit.countDate))}, is correctly stated above totalling <b>${esc(inWords(total))}</b> (₱ ${amt(total)}).</p>
    <div class="rp-signs">${sign('Accountable Officer', { name: o.name, pos: `${o.designation || ''} · ${agency}` })}</div>
    <p class="rp-just">I HEREBY CERTIFY that the preceding is a true and correct report of the examination of the cash and accounts of <b>${esc(o.name)}, ${esc(o.designation || '')}, ${esc(agency)}, ${esc(station)}</b>.</p>
    <p>Remarks: ${A.totSh === null ? '' : Math.abs(A.totSh) <= 0.004 ? 'No shortage or overage.' : A.totSh > 0 ? `Shortage of ₱${money(A.totSh)}.` : `Overage of ₱${money(-A.totSh)}.`}</p>
    <div class="rp-signs">${sign('Auditor / Examiner', prep)}<div class="rp-sign"><span>Date</span><b>${esc(fmtDate(audit.countDate))}</b><small>&nbsp;</small></div></div>`;
  const rows = [
    ...bills.map((x) => ({ Part: 'B. Cash on hand', Item: `₱${x.v}`, Qty: x.n, Amount: x.v * x.n })), { Part: 'B. Cash on hand', Item: 'Coins', Qty: '', Amount: +cnt.coins || 0 },
    ...items.map((x) => ({ Part: 'B. Cash items', Item: x.particulars, Qty: '', Amount: +x.presented || 0, Allowed: x.allowed, Disallowed: x.dis })),
    ...forms.map((x) => ({ Part: 'C. Unused forms', Item: x.name, Qty: x.qty, Amount: '', Allowed: x.text })),
    ...A.st.map((x) => ({ Part: 'D. Statement of accountability', Item: x.label, Qty: '', Amount: x.balance, Allowed: x.inv ?? '', Disallowed: x.sh ?? '' }))];
  return { html: `<div class="rp-page">${front}${back}</div>`, rows };
}
function soaTable(A) {
  const st = A.st;
  if (!st.length) return '<p>No accountability.</p>';
  const T = A.T;
  return `<table class="rp-t"><thead><tr><th>Nature of Funds</th>${st.map((x) => `<th class="r">${esc(x.label)}</th>`).join('')}<th class="r">Totals</th></tr></thead><tbody>
    <tr><td>Balance, Last Examination ${esc(fmtDate(A.from))}</td>${st.map((x) => `<td class="r">${money(x.beg)}</td>`).join('')}<td class="r">${money(T('beg'))}</td></tr>
    <tr><td>ADD: Debits to Accountability</td>${st.map((x) => `<td class="r">${money(x.debit)}</td>`).join('')}<td class="r">${money(T('debit'))}</td></tr>
    <tr><td>LESS: Credits to Accountability</td>${st.map((x) => `<td class="r">${money(x.credit)}</td>`).join('')}<td class="r">${money(T('credit'))}</td></tr>
    <tr class="tot"><td>BALANCE</td>${st.map((x) => `<td class="r">${amt(x.balance)}</td>`).join('')}<td class="r">${amt(T('balance'))}</td></tr>
    <tr><td>Inventory of Cash and/or allowed cash items</td>${st.map((x) => `<td class="r">${x.inv === null ? '' : money(x.inv)}</td>`).join('')}<td class="r">${A.inv ? money(T('inv')) : ''}</td></tr>
    <tr class="tot"><td>Shortage / (Overage)</td>${st.map((x) => `<td class="r">${x.sh === null ? '' : amt(x.sh)}</td>`).join('')}<td class="r">${A.totSh === null ? '' : amt(A.totSh)}</td></tr></tbody></table>`;
}

/* ---------- Annex B · SAAF ---------- */
function saaf(c) {
  const { f, audit, exam, o, A, agency, station, prep, sign } = c;
  const rows = saafRows(f, o.id, exam, A.from, A.to);
  const cells = (rs) => rs.length ? [rs.map(([a]) => a).join('<br>'), rs.map(([, z]) => z).join('<br>'), countRanges(rs)] : ['', '', ''];
  const groups = [];
  rows.forEach((r) => { const g = groups.find((x) => x.form === r.form) || (groups.push({ form: r.form, name: r.name, rows: [] }), groups[groups.length - 1]); g.rows.push(r); });
  const tot = (k) => rows.reduce((n, r) => n + countRanges(r[k] || []), 0);
  const html = `<div class="rp-page rp-wide"><div class="rp-top"><span></span><span class="r"><b>ANNEX B</b></span></div>
    <h2 class="rp-title">STATEMENT OF ACCOUNTABILITY FOR ACCOUNTABLE FORMS</h2><p class="c">As of ${esc(fmtDate(audit.countDate))}</p>
    <table class="rp-kv"><tr><td>Name of Accountable Officer</td><td><b>${esc(o.name)}</b></td></tr><tr><td>Designation</td><td>${esc(o.designation || '')}</td></tr><tr><td>Office / Station</td><td>${esc(agency)}, ${esc(station)}</td></tr></table>
    <table class="rp-t rp-saaf"><thead><tr><th rowspan="2">Name of Form</th><th colspan="3">Balance Beg.</th><th colspan="3">Received</th><th colspan="3">Issued</th><th colspan="3">Balance End</th><th colspan="3">Balance per Count</th><th rowspan="2" class="r">Difference</th></tr>
      <tr>${'<th>From</th><th>To</th><th class="r">Qty.</th>'.repeat(5)}</tr></thead>
      <tbody>${groups.length ? groups.map((g) => g.rows.map((r, i) => { const pc = r.count === null ? ['', '', ''] : cells(r.count); return `<tr><td>${i ? '' : `<b>${esc(g.name)}</b>`}</td>${[r.beg, r.rec, r.issued, r.end].map((rs) => cells(rs).map((v, j) => `<td class="${j === 2 ? 'r' : ''}">${v}</td>`).join('')).join('')}${pc.map((v, j) => `<td class="${j === 2 ? 'r' : ''}">${v}</td>`).join('')}<td class="r">${r.diff === null ? '' : r.diff}</td></tr>`; }).join('')).join('')
        : '<tr><td colspan="17" class="c">No accountable forms for this officer within the scope of audit.</td></tr>'}
      <tr class="tot"><td>Total</td><td></td><td></td><td class="r">${tot('beg')}</td><td></td><td></td><td class="r">${tot('rec')}</td><td></td><td></td><td class="r">${tot('issued')}</td><td></td><td></td><td class="r">${tot('end')}</td><td></td><td></td><td class="r">${rows.reduce((n, r) => n + (r.count ? countRanges(r.count) : 0), 0)}</td><td class="r">${rows.reduce((n, r) => n + (r.diff || 0), 0)}</td></tr></tbody></table>
    <p class="rp-just">I HEREBY CERTIFY that the above Statement of Accountability for Accountable Forms without Money Value is true and correct.</p>
    <div class="rp-signs">${sign('Prepared by', prep)}${sign('Accountable Officer', { name: o.name, pos: o.designation || '' })}</div></div>`;
  const xr = (rs) => rs.map(([a, z]) => (a === z ? `${a}` : `${a}-${z}`)).join(', ');
  return { html, rows: rows.map((r) => ({ Form: r.name, Booklet: `${r.booklet[0]}-${r.booklet[1]}`, 'Balance Beg.': xr(r.beg), 'Beg. Qty': countRanges(r.beg), Received: xr(r.rec), 'Rec. Qty': countRanges(r.rec),
    Issued: xr(r.issued), 'Iss. Qty': countRanges(r.issued), 'Balance End': xr(r.end), 'End Qty': countRanges(r.end), 'Per Count': r.count ? xr(r.count) : '', 'Count Qty': r.count ? countRanges(r.count) : '', Difference: r.diff ?? '' })) };
}

/* ---------- Annex C / D · Statement of Accountability by month ---------- */
function soa(c, which) {
  const { audit, o, A, agency, station, prep, rev, sign } = c;
  const cols = A.st.filter((x) => (which === 'ca' ? x.key === 'ca' : x.key !== 'ca'));
  const annex = which === 'ca' ? 'ANNEX D' : 'ANNEX C';
  if (!cols.length) return { html: `<div class="rp-page"><p class="c">${which === 'ca' ? 'No cash advance accountability for this officer.' : 'No collection accountability for this officer.'}</p></div>`, rows: [] };
  const months = [...new Set(cols.flatMap((x) => A.moves[x.key].list.map((m) => m.date.slice(0, 7))))].sort();
  const run = Object.fromEntries(cols.map((x) => [x.key, A.moves[x.key].beg]));
  const lines = months.map((m) => ({ m, v: cols.map((x) => { const ls = A.moves[x.key].list.filter((y) => y.date.startsWith(m)); const d = r2(ls.reduce((n, y) => n + y.debit, 0)), cr = r2(ls.reduce((n, y) => n + y.credit, 0)); run[x.key] = r2(run[x.key] + d - cr); return { d, cr, b: run[x.key] }; }) }));
  const multi = cols.length > 1;
  const crName = (x) => (x.key === 'ca' ? 'Liquidations' : x.kind === 'SCR' ? 'Remittances' : 'Deposits');
  const drName = (x) => (x.key === 'ca' ? 'Cash Advances' : 'Collections');
  const tot = (key) => { const ls = A.moves[key].list; return { d: r2(ls.reduce((n, y) => n + y.debit, 0)), cr: r2(ls.reduce((n, y) => n + y.credit, 0)) }; };
  const all = multi ? { beg: r2(cols.reduce((n, x) => n + A.moves[x.key].beg, 0)) } : null;
  const html = `<div class="rp-page rp-wide"><div class="rp-top"><span></span><span class="r"><b>${annex}</b></span></div>
    <p class="c">Republic of the Philippines<br><b>${esc(agency)}</b><br>${esc(station)}</p>
    <p class="c"><b>${esc(o.name)}</b><br>${esc(o.designation || '')}</p>
    <h2 class="rp-title">Statement of Accountability${which === 'ca' ? ' – Cash Advances' : ''}</h2><p class="c">${esc(fmtDate(A.from))} to ${esc(fmtDate(A.to))}</p>
    <table class="rp-t"><thead><tr><th rowspan="2">Particulars</th>${cols.map((x) => `<th colspan="3">${esc(x.label)}</th>`).join('')}${multi ? '<th colspan="3">Total</th>' : ''}</tr>
      <tr>${cols.map((x) => `<th class="r">${drName(x)}</th><th class="r">${crName(x)}</th><th class="r">Balance</th>`).join('')}${multi ? '<th class="r">Collections</th><th class="r">Deposits / Remittances</th><th class="r">Balance</th>' : ''}</tr></thead>
      <tbody><tr><td>Balance, ${esc(fmtDate(A.from))}</td>${cols.map((x) => `<td></td><td></td><td class="r">${money(A.moves[x.key].beg)}</td>`).join('')}${multi ? `<td></td><td></td><td class="r">${money(all.beg)}</td>` : ''}</tr>
      ${lines.map((l) => `<tr><td>${MONTHS[+l.m.slice(5) - 1]} ${l.m.slice(0, 4)}</td>${l.v.map((v) => `<td class="r">${money(v.d)}</td><td class="r">${money(v.cr)}</td><td class="r">${amt(v.b)}</td>`).join('')}${multi ? `<td class="r">${money(r2(l.v.reduce((n, v) => n + v.d, 0)))}</td><td class="r">${money(r2(l.v.reduce((n, v) => n + v.cr, 0)))}</td><td class="r">${amt(r2(l.v.reduce((n, v) => n + v.b, 0)))}</td>` : ''}</tr>`).join('')}
      <tr class="tot"><td>Balance, ${esc(fmtDate(A.to))}</td>${cols.map((x) => { const t = tot(x.key); return `<td class="r">${money(t.d)}</td><td class="r">${money(t.cr)}</td><td class="r">${amt(x.balance)}</td>`; }).join('')}${multi ? `<td class="r">${money(r2(cols.reduce((n, x) => n + tot(x.key).d, 0)))}</td><td class="r">${money(r2(cols.reduce((n, x) => n + tot(x.key).cr, 0)))}</td><td class="r">${amt(r2(cols.reduce((n, x) => n + x.balance, 0)))}</td>` : ''}</tr></tbody></table>
    <div class="rp-signs">${sign('Prepared by', prep)}${sign('Reviewed by', rev)}</div></div>`;
  const rows = [{ Month: `Balance, ${fmtDate(A.from)}`, ...Object.fromEntries(cols.flatMap((x) => [[`${x.label} – ${drName(x)}`, ''], [`${x.label} – ${crName(x)}`, ''], [`${x.label} – Balance`, A.moves[x.key].beg]])) },
    ...lines.map((l) => ({ Month: `${MONTHS[+l.m.slice(5) - 1]} ${l.m.slice(0, 4)}`, ...Object.fromEntries(cols.flatMap((x, i) => [[`${x.label} – ${drName(x)}`, l.v[i].d], [`${x.label} – ${crName(x)}`, l.v[i].cr], [`${x.label} – Balance`, l.v[i].b]])) }))];
  return { html, rows };
}
