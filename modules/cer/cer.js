// Cash Examination Report module (AMS) – practice copy.
// Built so far: Audit Setup, Accountable Forms, Collections & Deposits, Cash Advances, Bank Statements, Cash Count, Verification, Reports (GF 74-A, SAAF, Statements of Accountability).
// Other reports come next.
//
// Records:
//   cer_officers  one accountable officer of an auditee           { lguId, name, designation }
//   cer_audits    one cash examination = auditee + cash count date { lguId, countDate, preparedBy, reviewedBy }
//   cer_exams     one officer's exam record inside a cash examination
//                 { auditId, officerId, functions[], forms[], bond{maxCash, amount, riskNo, from, to, none (the officer has no fidelity bond)}, remitToLO (collections remitted to the Liquidating Officer, not deposited), records ('complete' | 'cashbook': no SCD / RCD, collections by OR range and deposits by OR series), lastExamDate, lastExamSource, caRestFund (fund of the beginning cash advance not itemized),
//                   balances{ key: { amount, source } }, endBalances{} (filled later by the examination) }
import { inScope } from '../../js/scope.js';
import { getCycle, cacheCycles } from '../../js/cycle.js';
import { store, newId, emitChange } from '../../js/store.js';
import { esc, modal, toast, $, $$ } from '../../js/ui.js';
import { roleLine } from '../../js/views/admin.js';
import { moduleFrame } from '../../js/frame.js';

// Load this module's look once.
if (!document.querySelector('link[data-cer]')) {
  const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'modules/cer/cer.css'; l.dataset.cer = '1'; document.head.appendChild(l);
}

/* ---------- lists ---------- */
// Accountability functions. Barangay Treasurer: collecting and disbursing (kept as separate computations).
const FUNCS_LGU = [['collecting', 'Collecting'], ['disbursing', 'Disbursing'], ['special', 'Special Disbursing'], ['liquidating', 'Liquidating'], ['custodian', 'Custodian'], ['pettycash', 'Petty Cash Custodian']];
const FUNCS_BRGY = [['collecting', 'Collecting'], ['disbursing', 'Disbursing (Cash Advances)'], ['pettycash', 'Petty Cash Custodian']];
const FUNC_NAME = { collecting: 'Collecting', disbursing: 'Disbursing', special: 'Special Disbursing', liquidating: 'Liquidating', custodian: 'Custodian', pettycash: 'Petty Cash Custodian' };
// Accountable forms an officer collects with (starting list; more come with Accountable Forms).
export const FORMS = [['af51', 'Accountable Form 51 – LGU'], ['af51b', 'Accountable Form 51 – Barangay'], ['ctci', 'CTC – Individual'], ['ctcc', 'CTC – Corporate'],
  ['af52', 'AF 52 – Certificate of Transfer of Large Cattle'], ['af53', 'AF 53 – Certificate of Ownership of Large Cattle'], ['af54', 'AF 54 – Marriage License'], ['af56', 'AF 56 – Real Property Tax (RPT)'], ['cash', 'Cash Tickets']];
export const FORM_NAME = Object.fromEntries(FORMS);
// AF 51 has a barangay and an LGU version: an auditee sees only its own. Older barangay setups saved with the LGU AF 51 are read as the barangay one.
export const formsForLgu = (lgu) => FORMS.filter(([k]) => (isBrgy(lgu) ? k !== 'af51' : k !== 'af51b'));
export const fixBrgyForm = (lgu, k) => (isBrgy(lgu) && k === 'af51' ? 'af51b' : k);
const DESIG_BRGY = ['Barangay Treasurer'];
const DESIG_LGU = ['Municipal Treasurer', 'Provincial Treasurer', 'Collecting Officer', 'Liquidating Officer', 'Disbursing Officer', 'Special Disbursing Officer', 'Accountable Forms Custodian'];

/* ---------- who may do what ---------- */
export const hasRole = (refs, ...r) => !!refs.me && (refs.me.data.roles || []).some((x) => r.includes(x));
const seesAll = (refs) => hasRole(refs, 'admin', 'sa', 'osa');
// Audit Setup is the auditors' work (Team Member, ATL, SA, Admin). Team Staff (JO) and OSA Staff view it only.
export const isAuditor = (refs) => hasRole(refs, 'member', 'atl', 'sa', 'admin');
export const by = (refs) => refs.me?.data.email || '';
const munOf = (refs, lgu) => (lgu.data.kind === 'barangay' ? lgu.data.parentId : lgu.data.kind === 'municipality' ? lgu.id : '');
// Visible to this person and within the working scope (AMS Dashboard, "Working on").
export function mayView(refs, lgu) {
  if (!lgu) return false;
  if (!inScope(refs, lgu)) return false;
  if (seesAll(refs)) return true;
  const d = refs.me?.data; if (!d || !(d.teamIds || []).includes(lgu.data.teamId)) return false;
  if ((d.roles || []).includes('atl')) return true;
  const mun = munOf(refs, lgu);
  return !(d.munIds || []).length || !mun || d.munIds.includes(mun);
}
const mayEdit = (refs, lgu) => isAuditor(refs) && mayView(refs, lgu);

/* ---------- small helpers ---------- */
const isBrgy = (lgu) => !!lgu && lgu.data.kind === 'barangay';
export function agencyName(refs, lgu) {
  if (!lgu) return '';
  const d = lgu.data;
  return d.kind === 'barangay' ? `BLGU - ${d.name}` : d.kind === 'municipality' ? `LGU - ${d.name}` : `PLGU - ${d.name}`;
}
function addressOf(refs, lgu) {
  if (!lgu) return '';
  const d = lgu.data;
  if (d.kind === 'barangay') return `${refs.lgu[d.parentId]?.data.name || ''}, Quirino`;
  if (d.kind === 'municipality') return `${d.name}, Quirino`;
  return 'Cabarroguis, Quirino';
}
export const fmtDate = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[2]}/${m[3]}/${m[1]}` : ''; };
export const money = (n) => (n === null || n === undefined || n === '' || isNaN(n)) ? '' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const num = (s) => { const v = parseFloat(String(s ?? '').replace(/[,₱\s]/g, '')); return isNaN(v) ? null : Math.round(v * 100) / 100; };
const userLine = (u) => u ? [u.data.name, u.data.position, u.data.designation].filter(Boolean).join(' · ') : '';
const funcsFor = (lgu) => (isBrgy(lgu) ? FUNCS_BRGY : FUNCS_LGU);

/* ---------- data ---------- */
export async function loadCer() {
  const [officers, audits, exams, cyc0] = await Promise.all([store.list('cer_officers'), store.list('cer_audits'), store.list('cer_exams'), store.get('cer_settings', 'cycles')]);
  const flat = (r) => ({ id: r.id, ...r.data });
  const A = audits.map(flat);
  cyclesOf(A, cyc0 && !cyc0.deleted ? cyc0.data : null);
  // Barangays: AF 51 is always deposited (CTC remitted to the MTO), so an exam saved earlier as "remitted to the LO" reads as deposited.
  const brgyAudit = new Set(A.filter((x) => /^brgy-/.test(x.lguId || '')).map((x) => x.id));
  return { officers: officers.map(flat), audits: A, exams: exams.map(flat).map((e) => (e.remitToLO && brgyAudit.has(e.auditId) ? { ...e, remitToLO: false } : e)) };
}
// This officer's latest exam before the given cash count date (any cash examination).
function prevExam(cer, officerId, countDate, examId) {
  if (!officerId || !countDate) return null;
  const date = (e) => cer.audits.find((a) => a.id === e.auditId)?.countDate || '';
  const e = cer.exams.filter((x) => x.officerId === officerId && x.id !== examId && date(x) && date(x) < countDate)
    .sort((a, b) => date(b).localeCompare(date(a)))[0];
  return e ? { ...e, countDate: date(e) } : null;
}
// Beginning balance rows, following the ticked functions and forms. Collecting and disbursing stay separate.
function balanceRows(st) {
  const f = st.functions || [], rows = [];
  if (f.includes('collecting')) (st.forms || []).forEach((k) => rows.push({ key: 'col-' + k, label: FORM_NAME[k] || k, fn: 'Collecting' }));
  if (f.includes('liquidating')) rows.push({ key: 'liq', label: 'Collections and Deposits (from collecting officers)', fn: 'Liquidating' });
  if (f.includes('disbursing')) rows.push({ key: 'ca', label: 'Cash Advances', fn: 'Disbursing' });
  if (f.includes('special')) rows.push({ key: 'sdo', label: 'Cash Advances – Special Disbursing', fn: 'Special Disbursing' });
  if (f.includes('pettycash')) rows.push({ key: 'pcf', label: 'Petty Cash Fund', fn: 'Petty Cash Custodian' });
  return rows;
}
// Bond checks, worded for the auditor. Each: { kind: 'bad' | 'warn', text }.
export function bondChecks(st) {
  const b = st.bond || {}, out = [];
  const amt = num(b.amount), max = num(b.maxCash);
  if (b.none) return [{ kind: 'warn', text: '<strong>The officer has no fidelity bond.</strong>' + (max !== null ? ` Maximum cash accountability ₱${money(max)}.` : '') }];
  if (!b.amount && !b.riskNo && !b.from && !b.to) out.push({ kind: 'warn', text: '<strong>No fidelity bond entered.</strong> Enter the bond details, or note that the officer has no bond.' });
  if (b.to && st.countDate && b.to < st.countDate) out.push({ kind: 'bad', text: `<strong>Expired fidelity bond.</strong> Bond ended ${fmtDate(b.to)}, before the cash count on ${fmtDate(st.countDate)}.` });
  if (b.from && st.countDate && b.from > st.countDate) out.push({ kind: 'warn', text: `<strong>Bond not yet effective.</strong> It starts ${fmtDate(b.from)}, after the cash count on ${fmtDate(st.countDate)}.` });
  if (b.from && b.to && b.from > b.to) out.push({ kind: 'warn', text: '<strong>Check the bond dates.</strong> Effective From is later than Effective To.' });
  if (amt !== null && max !== null && amt < max) out.push({ kind: 'warn', text: `<strong>Bond lower than the maximum cash accountability.</strong> Bond ₱${money(amt)}, maximum cash accountability ₱${money(max)}.` });
  return out;
}

/* ---------- page frame ---------- */
function navItems() {
  return [
    { key: 'setup', label: 'Audit Setup', icon: 'pen', href: '#/cer/setup' },
    { key: 'count', label: 'Cash Count (Cut-off)', icon: 'grid', href: '#/cer/count' },
    { section: true, label: 'SOURCE RECORDS' },
    { key: 'forms', label: 'Accountable Forms', icon: 'library', href: '#/cer/forms' },
    { key: 'collections', label: 'Collections & Deposits', icon: 'inbox', href: '#/cer/collections' },
    { key: 'advances', label: 'Cash Advances', icon: 'swap', href: '#/cer/advances' },
    { key: 'banks', label: 'Bank Statements', icon: 'building', href: '#/cer/banks' },
    { key: 'cashbook', label: 'Cashbook', icon: 'book', href: '#/cer/cashbook' },
    { section: true, label: 'EXAMINATION' },
    { key: 'verify', label: 'Verification', icon: 'book', href: '#/cer/verify' },
    { key: 'reports', label: 'Reports', icon: 'overview', href: '#/cer/reports' }];
}

// Unsaved Audit Setup changes survive a screen refresh (e.g. a sync) until saved or left.
let DRAFT = null;   // { key, st, dirty }
let LASTPART = '';   // the CER screen last shown
let FM = null, FX = null;   // Accountable Forms module and its data (for the Beginning Inventory of Accountable Forms)
let CA = [];   // cash advance records (for the beginning checks of the cash advance balances)
// Beginning cash advance balances: a lump sum, the checks unliquidated at the last cash exam, or both.
// The checks are saved as cash advances marked beginning { beg: true, begKey, begExamId }; the balance is the larger of the lump sum and the checks.
const BEG_CA = { ca: 'Cash Advances', sdo: 'Cash Advances – Special Disbursing', pcf: 'Petty Cash Fund' };
const begChecksOf = (st, k) => (st.examId ? CA.filter((a) => a.beg && a.begExamId === st.examId && (a.begKey || 'ca') === k) : []);
const sumOf = (list) => Math.round(list.reduce((n, a) => n + (+a.amount || 0), 0) * 100) / 100;
function begLine(st, k, lump) {
  const ch = begChecksOf(st, k), sum = sumOf(ch), l = +lump || 0;
  const n = `${ch.length} check${ch.length === 1 ? '' : 's'}`;
  if (!ch.length) return '<span class="dim">No check itemized: shown as one beginning balance in Cash Advances.</span>';
  if (!l) return `₱${money(sum)} · from ${n}`;
  if (sum > l + 0.004) return `₱${money(sum)} · from ${n} (more than the ₱${money(l)} typed; the checks are used)`;
  const rest = Math.round((l - sum) * 100) / 100;
  return `₱${money(l)} · ${n} ₱${money(sum)}${rest > 0.004 ? ` + ₱${money(rest)} not itemized` : ''}`;
}
// Folding sections (accordion). Which ones are open is kept per screen, so a refresh after a save keeps them as they were.
const OPEN = {};
const ST_PILL = { ok: '<span class="acc-pill ok">✓ Complete</span>', need: '<span class="acc-pill need">Needs input</span>', warn: '<span class="acc-pill warn">⚠ Check</span>', info: '' };
const stHtml = (stat) => ST_PILL[stat] || '';
const acc = (id, title, [sum, stat], body, open) => `<details class="acc" data-acc="${id}" ${open ? 'open' : ''}>
  <summary><span class="acc-t">${title}</span><span class="acc-s" data-sum="${id}">${sum}</span><span class="acc-st" data-st="${id}">${stHtml(stat)}</span>
    <svg class="acc-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary>
  <div class="acc-b">${body}</div></details>`;
const ACC_ORDER = ['exam', 'officer', 'bond', 'period', 'bal', 'forms'];
// One-line summary and status of each section: [summaryHtml, 'ok' | 'need' | 'warn' | 'info'].
function heads(refs, cer, st) {
  const lgu = refs.lgu[st.lguId], o = cer.officers.find((x) => x.id === st.officerId);
  const prev = prevExam(cer, st.officerId, st.countDate, st.examId);
  const lastExam = prev ? prev.countDate : st.lastExamDate;
  const rev = refs.user[st.reviewedBy]?.data.name;
  const h = {};
  h.exam = lgu && st.countDate ? [`${esc(agencyName(refs, lgu))} · count ${esc(fmtDate(st.countDate))}${rev ? ' · reviewed by ' + esc(rev) : ''}`, 'ok'] : ['Auditee and cash count date', 'need'];
  const fnOk = st.officerId && (st.functions || []).length && (!(st.functions || []).includes('collecting') || (st.forms || []).length);
  h.officer = [o ? `${esc(o.name)}${(st.functions || []).length ? ' · ' + esc(st.functions.map((k) => FUNC_NAME[k]).join(', ')) : ''}` : 'Officer, functions and forms', fnOk ? 'ok' : 'need'];
  const b = st.bond || {}, w = bondChecks(st);
  h.bond = b.none ? ['No fidelity bond (noted)', 'ok'] : [b.amount || b.to ? `${b.amount ? '₱' + esc(b.amount) + ' bond' : 'Bond'}${b.to ? ' · valid to ' + esc(fmtDate(b.to)) : ''}${w.length ? ' · ' + w.length + ' to check' : ''}` : (w.length ? 'No bond entered' : 'Bond details'), w.some((x) => x.kind === 'bad') ? 'warn' : b.amount || b.riskNo || b.from || b.to ? 'ok' : 'need'];
  h.period = [lastExam && st.countDate ? `${esc(fmtDate(lastExam))} to ${esc(fmtDate(st.countDate))}` : 'Last cash exam date', lastExam && st.countDate ? 'ok' : 'need'];
  const rows = balanceRows(st);
  if (!rows.length) h.bal = [(st.functions || []).length ? 'None (forms only)' : 'Tick the officer\'s functions first', (st.functions || []).length ? 'ok' : 'need'];
  else {
    let total = 0, missing = 0;
    rows.forEach((r) => { const carried = prev && prev.endBalances && prev.endBalances[r.key] !== undefined && prev.endBalances[r.key] !== null;
      let v = carried ? Number(prev.endBalances[r.key]) : num(st.balances[r.key]);
      if (BEG_CA[r.key]) { const s = sumOf(begChecksOf(st, r.key)); if (s) v = Math.max(v || 0, s); }
      if (v === null || v === undefined) missing++; else total += v; });
    h.bal = [`₱${money(total)}${missing ? ` · ${missing} not entered` : ''}`, missing ? 'need' : 'ok'];
  }
  if (!o) h.forms = ['Choose the officer first', 'info'];
  else if (!lastExam) h.forms = ['Set the last cash exam date first', 'info'];
  else { const r = FM && FX ? FM.beginningFormsOf(FX, o.id, lastExam) : [];
    const mv = r.reduce((n, x) => n + FM.countRanges(x.unused) * FM.faceOf(x.b), 0);
    h.forms = [r.length ? `${r.length} booklet${r.length > 1 ? 's' : ''} · ${r.reduce((n, x) => n + FM.countRanges(x.unused), 0)} unused pcs${mv ? ` · ₱${money(mv)} with money value` : ''} as of ${esc(fmtDate(lastExam))}` : `None on hand as of ${esc(fmtDate(lastExam))}`, r.length ? 'ok' : 'info']; }
  return h;
}
// Opens the first section that still needs input, the first time a screen is shown.
function openState(key, h) {
  if (!OPEN[key]) { const first = ACC_ORDER.find((k) => h[k] && h[k][1] === 'need'); OPEN[key] = new Set(first ? [first] : []); }
  return OPEN[key];
}
let guardOn = false;
function installGuard() {
  if (guardOn) return; guardOn = true;
  document.addEventListener('click', async (e) => {
    const a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a || !DRAFT || !DRAFT.dirty || a.dataset.soon !== undefined) return;
    const to = a.getAttribute('href');
    if (to === '#' || to === location.hash) return;
    e.preventDefault(); e.stopPropagation();
    const go = await modal({ title: 'Leave without saving?', body: '<p style="margin:0">Your changes to the Audit Setup are not saved yet.</p>',
      buttons: [{ label: 'Stay', value: false }, { label: 'Leave without saving', cls: 'primary', value: true }] });
    if (go) { DRAFT = null; location.hash = to; }
  }, true);
  window.addEventListener('beforeunload', (e) => { if (DRAFT && DRAFT.dirty) { e.preventDefault(); e.returnValue = ''; } });
}

export async function render(ctx) {
  const { app, refs, q, parts } = ctx;
  installGuard();
  const me = refs.me ? refs.me.data : { name: ctx.session.name || ctx.session.email };
  const roleText = [refs.me?.data.position, roleLine(refs)].filter(Boolean).join(' · ');
  if (parts[0] === 'forms' || parts[0] === 'collections' || parts[0] === 'advances' || parts[0] === 'banks' || parts[0] === 'count' || parts[0] === 'verify' || parts[0] === 'reports' || parts[0] === 'cashbook') {
    // Accountable Forms (Forms Register, Accountable Officer view, RAAF Reconciliation) and Collections & Deposits.
    DRAFT = null;
    // Opening Collections & Deposits from another screen starts on tab 1 (SCD); redraws on the same screen keep the tab.
    if (parts[0] === 'collections' && LASTPART !== 'collections') (await import('./collections.js')).resetTabs();
    if (parts[0] === 'advances' && LASTPART !== 'advances') (await import('./advances.js')).resetTabs();
    if (parts[0] === 'banks' && LASTPART !== 'banks') (await import('./banks.js')).resetTabs();
    if (parts[0] === 'count' && LASTPART !== 'count') (await import('./count.js')).resetTabs();
    LASTPART = parts[0];
    const { body, crumb, wire } = parts[0] === 'forms' ? await (await import('./forms.js')).formsView(ctx)
      : parts[0] === 'collections' ? await (await import('./collections.js')).collectionsView(ctx) : parts[0] === 'advances' ? await (await import('./advances.js')).advancesView(ctx) : parts[0] === 'banks' ? await (await import('./banks.js')).banksView(ctx) : parts[0] === 'count' ? await (await import('./count.js')).countView(ctx) : parts[0] === 'verify' ? await (await import('./verify.js')).verifyView(ctx) : parts[0] === 'cashbook' ? await (await import('./cashbook.js')).cashbookView(ctx) : await (await import('./reports.js')).reportsView(ctx);
    app.innerHTML = moduleFrame({ title: 'Cash<br>Examination', items: navItems(), active: parts[0], crumb, me, roleText, body });
    tidyTop();
    $$('[data-soon]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); toast(`${a.dataset.soon} comes next. It is not built yet.`); }; });
    if (wire) wire();
    return;
  }
  LASTPART = 'setup';
  const cer = await loadCer();
  const view = 'setup';
  const open = q.get('a') || (q.get('new') ? 'new' : '');
  // Beginning Inventory of Accountable Forms reads the same booklet records as Accountable Forms.
  if (open) { FM = await import('./forms.js'); FX = await FM.loadForms(); CA = (await (await import('../src/journal.js')).listAdvances()).map((r) => ({ id: r.id, ...r.data })); }
  const body = open ? setupHtml(refs, cer, q) : listHtml(refs, cer);
  app.innerHTML = moduleFrame({ title: 'Cash<br>Examination', items: navItems(), active: view, crumb: open ? 'Audit Setup' : 'Audit Setup · Cash Examinations', me, roleText, body });
  tidyTop();
  $$('[data-soon]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); toast(`${a.dataset.soon} comes next. It is not built yet.`); }; });
  { const hb = $('#cer-hol'); if (hb) hb.onclick = () => holidaysModal(refs, isAuditor(refs)); }
  { const nc = $('#cer-newcyc'); if (nc) nc.onclick = () => newCycle(refs); }
  if (open) wireSetup(refs, cer, q, ctx.rerender);
  else if (parts[0] && parts[0] !== 'setup') history.replaceState(null, '', '#/cer/setup');
}

// The screen's big title repeats the top bar: it is taken out, and its explanation moves to a small ⓘ beside the
// top bar label (hover, or click/tap to open). Titles that say something new (e.g. an officer's name) stay.
function tidyTop() {
  const crumb = $('.mtop .crumb'), hello = $('.mcontent > .hello');
  if (!crumb || !hello) return;
  const h1 = $('h1', hello);
  if (!h1 || !crumb.textContent.toLowerCase().includes(h1.textContent.trim().toLowerCase())) return;
  const p = h1.nextElementSibling && h1.nextElementSibling.tagName === 'P' ? h1.nextElementSibling : null;
  const tip = p ? p.innerHTML : '';
  h1.remove(); if (p) p.remove();
  if (!hello.textContent.trim() && !$('a, button, select, input', hello)) hello.remove();
  else hello.classList.add('hello-slim');
  if (!tip) return;
  crumb.insertAdjacentHTML('beforeend', `<button class="crumb-i" type="button" aria-label="About this screen" aria-expanded="false" title="${esc(p.textContent.trim())}">ⓘ</button><div class="crumb-tip" hidden>${tip}</div>`);
  const btn = $('.crumb-i', crumb), box = $('.crumb-tip', crumb);
  btn.onclick = (e) => { e.stopPropagation(); box.hidden = !box.hidden; btn.setAttribute('aria-expanded', String(!box.hidden)); };
  document.addEventListener('click', (e) => { if (!box.hidden && !box.contains(e.target)) { box.hidden = true; btn.setAttribute('aria-expanded', 'false'); } });
}

/* ================= Cycles: each round of cash counts in one group ================= */
// cer_settings 'cycles' { list: [{ id, name (optional, typed), created }], current }; cer_audits.cycleId.
// A cash examination without a cycle is grouped with those of nearby count dates (less than 45 days apart).
const CYC = { list: [], current: '', of: {} };
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthRange = (a, b) => {
  if (!a) return '';
  const [y1, m1] = a.split('-').map(Number), [y2, m2] = (b || a).split('-').map(Number);
  if (y1 === y2 && m1 === m2) return `${MON[m1 - 1]} ${y1}`;
  return y1 === y2 ? `${MON[m1 - 1]} – ${MON[m2 - 1]} ${y1}` : `${MON[m1 - 1].slice(0, 3)} ${y1} – ${MON[m2 - 1].slice(0, 3)} ${y2}`;
};
function cyclesOf(audits, saved) {
  const own = (saved?.list || []).map((c) => ({ ...c, auto: false }));
  const ids = new Set(own.map((c) => c.id));
  const loose = audits.filter((a) => !a.cycleId || (!ids.has(a.cycleId) && !/^auto-/.test(a.cycleId))).sort((a, b) => String(a.countDate).localeCompare(String(b.countDate)));
  const autos = []; let cur = null, last = '';
  loose.forEach((a) => {
    const d = a.countDate || '';
    if (!cur || !last || !d || (Date.parse(d) - Date.parse(last)) / 864e5 > 45) { cur = { id: `auto-${d || 'none'}`, auto: true }; autos.push(cur); }
    a.cycleId = cur.id; last = d || last;
  });
  audits.filter((a) => /^auto-/.test(a.cycleId || '') && !autos.some((c) => c.id === a.cycleId)).forEach((a) => { if (!autos.some((c) => c.id === a.cycleId)) autos.push({ id: a.cycleId, auto: true }); });
  const all = [...own, ...autos].map((c) => {
    const ds = audits.filter((a) => a.cycleId === c.id).map((a) => a.countDate).filter(Boolean).sort();
    return { ...c, from: ds[0] || '', to: ds[ds.length - 1] || '', n: ds.length, name: c.name || monthRange(ds[0], ds[ds.length - 1]) || 'New cycle (no cash count yet)' };
  }).sort((a, b) => String(b.to || b.created || '9999').localeCompare(String(a.to || a.created || '9999')));
  CYC.list = all;
  CYC.current = all.some((c) => c.id === saved?.current) ? saved.current : all[0]?.id || '';
  CYC.of = Object.fromEntries(audits.map((a) => [a.id, a.cycleId]));
  cacheCycles({ list: all.map((c) => ({ id: c.id, name: c.name })), current: CYC.current });
}
export const cycles = () => CYC;
// The cash examination being worked on (this device): the last one opened on any screen, with its officer. Every screen opens
// on it until another is picked; one outside the Working on / Cycle shown is not used (the screen's own default instead).
const PICK = 'ams.cerpick';
export const getPick = () => { try { return JSON.parse(localStorage.getItem(PICK) || '{}') || {}; } catch { return {}; } };
export const pickAudit = (audits, q) => audits.find((a) => a.id === q.get('a')) || audits.find((a) => a.id === getPick().a) || audits[0];
export const pickExam = (exams, q, audit) => { const p = getPick(); return exams.find((e) => e.id === q.get('e')) || (audit && p.a === audit.id ? exams.find((e) => e.id === p.e) : null) || null; };
export function remember(refs, audit, exam) {
  if (!audit) return;
  const o = exam && (exam.o || null);
  const label = [agencyName(refs, refs.lgu[audit.lguId]), fmtDate(audit.countDate), o ? o.name : ''].filter(Boolean).join(' · ');
  try { localStorage.setItem(PICK, JSON.stringify({ a: audit.id, e: exam ? exam.id : '', label })); } catch { /* private window */ }
}
// In the cycle shown (header select): Current by default, one cycle, or All.
export function cycleOk(a) {
  const s = getCycle(), id = CYC.of[a.id] || a.cycleId;
  if (s === 'all') return true;
  if (s === 'cur') return !CYC.current || id === CYC.current;
  return !CYC.list.some((c) => c.id === s) || id === s;
}
async function newCycle(refs) {
  let name = '';
  const v = await modal({ title: 'Start a New Cycle', body: `<p class="af-note">A new round of cash examinations. The cash examinations you add from now on go into it; the earlier ones stay in their own cycle.</p>
      <div class="field"><label for="cy-name">Name (optional)</label><input class="input" id="cy-name" placeholder="Leave blank: named by its count dates, e.g. May – June 2026"></div>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Start Cycle', cls: 'primary', value: 'go', check: (bg) => { name = String($('#cy-name', bg).value || '').trim(); return true; } }] });
  if (v !== 'go') return;
  const rec = await store.get('cer_settings', 'cycles'); const data = rec && !rec.deleted ? rec.data : { list: [] };
  const id = newId('cyc');
  await store.save('cer_settings', 'cycles', { list: [...(data.list || []), { id, name, created: new Date().toISOString().slice(0, 10) }], current: id }, by(refs));
  toast('New cycle started: the next cash examinations go into it.', 'ok');
}

/* ================= Cash Examinations list ================= */
function listHtml(refs, cer) {
  DRAFT = null;
  const rows = cer.audits.filter((a) => mayView(refs, refs.lgu[a.lguId]) && cycleOk(a))
    .sort((a, b) => String(b.countDate).localeCompare(String(a.countDate)) || agencyName(refs, refs.lgu[a.lguId]).localeCompare(agencyName(refs, refs.lgu[b.lguId])));
  const groups = CYC.list.map((c) => ({ c, rows: rows.filter((a) => (CYC.of[a.id] || a.cycleId) === c.id) })).filter((g) => g.rows.length || g.c.id === CYC.current);
  const cols = 'grid-template-columns:120px minmax(170px,1.1fr) minmax(220px,1.6fr) minmax(170px,1fr)';
  const canNew = isAuditor(refs);
  return `<div class="hello"><div><h1>Audit Setup</h1><p>One cash examination per auditee and count date. Each accountable officer has a separate exam record.</p></div>
      <div class="btn-row"><button class="btn" type="button" id="cer-hol">Holidays</button>${canNew ? '<button class="btn" type="button" id="cer-newcyc">Start New Cycle</button><a class="btn primary" href="#/cer/setup?new=1">+ New Cash Examination</a>' : ''}</div></div>
    <div class="panel">
      <div class="panel-head"><h2>Cash Examinations</h2><span class="pill">${rows.length}</span></div>
      ${rows.length || groups.length ? groups.map((g) => `<details class="cyc-grp" ${g.c.id === CYC.current || groups.length === 1 ? 'open' : ''}><summary><b>${esc(g.c.name)}</b>${g.c.id === CYC.current ? ' <span class="pill p-done">Current cycle</span>' : ''} <span class="dim">· ${g.rows.length} cash examination${g.rows.length === 1 ? '' : 's'} · ${((n) => `${n} officer${n === 1 ? '' : 's'}`)(new Set(g.rows.flatMap((a) => cer.exams.filter((e) => e.auditId === a.id).map((e) => e.officerId))).size)}</span></summary>
        ${g.rows.length ? `<div class="t-head" style="${cols}"><span>Cash Count</span><span>Auditee</span><span>Accountable Officers</span><span>Prepared by</span></div>` : '<p class="af-note" style="margin:8px 0">No cash examination in this cycle yet: add one with <b>+ New Cash Examination</b>.</p>'}
        ${g.rows.map((a) => {
          const lgu = refs.lgu[a.lguId];
          const offs = cer.exams.filter((e) => e.auditId === a.id).map((e) => cer.officers.find((o) => o.id === e.officerId)).filter(Boolean);
          return `<a class="t-row click" style="${cols}" href="#/cer/setup?a=${esc(a.id)}">
            <span><b>${esc(fmtDate(a.countDate))}</b></span>
            <span>${esc(agencyName(refs, lgu))}<small style="display:block">${esc(addressOf(refs, lgu))}</small></span>
            <span>${offs.length ? offs.map((o) => `${esc(o.name)} <small>· ${esc(o.designation || '')}</small>`).join('<br>') : '<small>No officer yet</small>'}</span>
            <span><small>${esc(refs.user[a.preparedBy]?.data.name || '')}</small></span></a>`;
        }).join('')}</details>`).join('')
      : `<div class="empty"><b>No cash examinations yet.</b>${canNew ? 'Start one with <b>+ New Cash Examination</b>.' : 'The auditors set these up.'}</div>`}
    </div>`;
}

/* ================= Audit Setup form ================= */
function blankExam(lgu) {
  const brgy = isBrgy(lgu);
  return { examId: '', officerId: '', functions: brgy ? ['collecting', 'disbursing'] : [], forms: brgy ? ['af51b', 'ctci'] : [],
    bond: { maxCash: '', amount: '', riskNo: '', from: '', to: '' }, lastExamDate: '', balances: {}, begSer: {}, begOrs: {}, depositRule: 'next', caRestFund: '', remitToLO: false, records: 'complete' };
}
function stateFrom(refs, cer, q) {
  const audit = cer.audits.find((x) => x.id === q.get('a')) || null;
  const exams = audit ? cer.exams.filter((e) => e.auditId === audit.id) : [];
  const want = q.get('o');
  const exam = want === 'new' ? null : (exams.find((e) => e.id === want) || exams[0] || null);
  if (audit) remember(refs, audit, exam ? { ...exam, o: cer.officers.find((x) => x.id === exam.officerId) } : null);
  const lgu = audit ? refs.lgu[audit.lguId] : null;
  const st = {
    auditId: audit ? audit.id : '', lguId: audit ? audit.lguId : '', countDate: audit ? audit.countDate : '', cycleId: audit ? (CYC.of[audit.id] || audit.cycleId || '') : CYC.current,
    preparedBy: (audit && audit.preparedBy) || autoPreparer(refs, lgu), reviewedBy: (audit && audit.reviewedBy) || autoReviewer(refs, lgu),
    ...blankExam(lgu)
  };
  if (exam) {
    Object.assign(st, { examId: exam.id, officerId: exam.officerId, functions: [...(exam.functions || [])], forms: [...new Set((exam.forms || []).map((k) => fixBrgyForm(lgu, k)))],
      bond: { maxCash: '', amount: '', riskNo: '', from: '', to: '', ...(exam.bond || {}) }, lastExamDate: exam.lastExamDate || '', depositRule: exam.depositRule || 'next', caRestFund: exam.caRestFund || '', remitToLO: !!exam.remitToLO && !isBrgy(lgu), records: exam.records || 'complete',
      balances: Object.fromEntries(Object.entries(exam.balances || {}).map(([k, v]) => [k === 'col-af51' && isBrgy(lgu) ? 'col-af51b' : k, (() => { const x = v && v.lump !== undefined ? v.lump : v && v.amount; return x !== null && x !== undefined ? money(x) : ''; })()])),
      begSer: Object.fromEntries(Object.entries(exam.balances || {}).filter(([, v]) => v && v.series).map(([k, v]) => [k === 'col-af51' && isBrgy(lgu) ? 'col-af51b' : k, v.series])),
      begOrs: Object.fromEntries(Object.entries(exam.balances || {}).filter(([, v]) => v && (v.begOrs || v.series)).map(([k, v]) => [k === 'col-af51' && isBrgy(lgu) ? 'col-af51b' : k,
        v.begOrs || parseRangesTxt(v.series).map(([a, z]) => ({ date: '', from: a, to: z, amount: '' }))])) });
    ['maxCash', 'amount'].forEach((k) => { if (st.bond[k] !== '' && st.bond[k] !== null) st.bond[k] = money(st.bond[k]); });
  }
  return { st, audit, exams, exam };
}

function setupHtml(refs, cer, q) {
  const key = location.hash;
  const base = stateFrom(refs, cer, q);
  if (!DRAFT || DRAFT.key !== key || !DRAFT.dirty) DRAFT = { key, st: base.st, dirty: false };
  const st = DRAFT.st;
  const audit = base.audit;
  if (q.get('a') && q.get('a') !== 'new' && !audit) return `<div class="msg bad">This cash examination was not found. It may have been removed.</div><a class="btn" href="#/cer/setup">← All Cash Examinations</a>`;
  const lgu = refs.lgu[st.lguId];
  if (audit && !mayView(refs, lgu)) return `<div class="msg bad">This cash examination belongs to another team.</div><a class="btn" href="#/cer/setup">← All Cash Examinations</a>`;
  const edit = audit ? mayEdit(refs, lgu) : isAuditor(refs);
  const dis = edit ? '' : 'disabled';
  const tabs = base.exams.map((e) => ({ id: e.id, o: cer.officers.find((x) => x.id === e.officerId) }));
  const newTab = !base.exam;   // a new officer exam is being set up
  const h = heads(refs, cer, st), opens = openState(key, h);
  return `<div class="hello"><div><h1>Audit Setup</h1><p>One cash examination per auditee and count date. Each accountable officer has a separate exam record.</p></div>
      <div class="btn-row"><a class="btn" href="#/cer/setup">← All Cash Examinations</a><button class="btn" type="button" id="cer-hol">Holidays</button>${edit ? '<button class="btn primary" type="button" id="cer-save">Save Setup</button>' : ''}</div></div>
    ${edit ? '' : '<div class="msg cer-ro">View only. The auditors (Team Member, ATL, SA) set up the cash examination.</div>'}

    <section class="panel acc-panel" aria-label="Cash Examination">
      ${acc('exam', '1. Cash Examination', h.exam, `
        <div class="cer-g3">
          <div class="field"><label for="cer-lgu">Auditee (Agency)</label>
            <select class="input" id="cer-lgu" ${dis} ${audit ? 'disabled' : ''}>${lguOptions(refs, st.lguId)}</select>
            ${audit ? '<span class="hint">Fixed once saved.</span>' : ''}</div>
          <div class="field"><label for="cer-addr">Address / Station</label><input class="input" id="cer-addr" value="${esc(addressOf(refs, lgu))}" readonly disabled></div>
          <div class="field"><label for="cer-date">Cash Count Date</label><input class="input" type="date" id="cer-date" value="${esc(st.countDate)}" ${dis}></div>
          ${CYC.list.length ? `<div class="field"><label for="cer-cyc">Cycle</label><select class="input" id="cer-cyc" ${dis}>${CYC.list.map((c) => `<option value="${esc(c.id)}" ${c.id === st.cycleId ? 'selected' : ''}>${esc(c.name)}${c.id === CYC.current ? ' (current)' : ''}</option>`).join('')}</select></div>` : ''}
        </div>
        <div class="cer-g2">
          <div class="field"><label for="cer-prep">Prepared by (ATM)</label><select class="input" id="cer-prep" ${dis}>${preparerOptions(refs, lgu, st.preparedBy)}</select><span class="hint">The Team Member assigned to the municipality, filled in automatically.</span></div>
          <div class="field"><label for="cer-rev">Reviewed by (ATL)</label><select class="input" id="cer-rev" ${dis}>${reviewerOptions(refs, lgu, st.reviewedBy)}</select><span class="hint">The ATL of the team (Admin → Teams), filled in automatically.</span></div>
        </div>`, opens.has('exam'))}
    </section>

    <section class="panel" aria-labelledby="cer-h2">
      <div class="cer-sec">
        <div class="cer-headrow"><h2 id="cer-h2" class="cer-h2">2. Accountable Officers Examined</h2>
          ${edit && audit && !newTab ? `<a class="btn" href="#/cer/setup?a=${esc(audit.id)}&o=new">+ Add Officer</a>` : ''}</div>
        ${tabs.length || newTab ? `<div class="cer-tabs" role="tablist" aria-label="Officers">
          ${tabs.map((t) => `<a role="tab" aria-selected="${t.id === st.examId}" class="${t.id === st.examId ? 'on' : ''}" href="#/cer/setup?a=${esc(audit.id)}&o=${esc(t.id)}">${esc(t.o ? t.o.name : 'Officer')}${t.o && t.o.designation ? ' · ' + esc(t.o.designation) : ''}</a>`).join('')}
          ${newTab ? `<a role="tab" aria-selected="true" class="on" href="${esc(key)}">${tabs.length ? 'New officer' : 'Officer'}</a>` : ''}</div>` : ''}
        <div id="cer-off">${officerHtml(refs, cer, st, edit)}</div>
        ${edit && st.examId ? `<div class="cer-foot"><button class="btn sm" type="button" id="cer-remove">Remove this officer from the examination</button></div>` : ''}
      </div>
    </section>`;
}

function lguOptions(refs, sel) {
  const vis = refs.lgus.filter((l) => l.data.active !== false && mayView(refs, l));
  const prov = vis.filter((l) => l.data.kind === 'province');
  const muns = refs.lgus.filter((l) => l.data.kind === 'municipality').sort((a, b) => a.data.name.localeCompare(b.data.name));
  const opt = (l, label) => `<option value="${esc(l.id)}" ${l.id === sel ? 'selected' : ''}>${esc(label)}</option>`;
  let html = `<option value="">— Choose the auditee —</option>`;
  if (prov.length) html += `<optgroup label="Province">${prov.map((l) => opt(l, agencyName(refs, l))).join('')}</optgroup>`;
  muns.forEach((m) => {
    const inside = vis.filter((l) => l.id === m.id || (l.data.kind === 'barangay' && l.data.parentId === m.id))
      .sort((a, b) => (a.data.kind === 'municipality' ? -1 : b.data.kind === 'municipality' ? 1 : a.data.name.localeCompare(b.data.name)));
    if (inside.length) html += `<optgroup label="${esc(m.data.name)}">${inside.map((l) => opt(l, agencyName(refs, l))).join('')}</optgroup>`;
  });
  return html;
}
// Prepared by: the Team Member (ATM) assigned to the auditee's municipality in Users & Roles (only when exactly one is ticked for it).
// Reviewed by: the Audit Team Leader of the team in Admin → Teams. Both can still be chosen in Audit Setup.
export function autoPreparer(refs, lgu) {
  if (!lgu) return '';
  const mun = lgu.data.kind === 'barangay' ? lgu.data.parentId : lgu.data.kind === 'municipality' ? lgu.id : '';
  const list = refs.users.filter((u) => u.data.status !== 'disabled' && (u.data.roles || []).includes('member') && (u.data.teamIds || []).includes(lgu.data.teamId) && mun && (u.data.munIds || []).includes(mun));
  return list.length === 1 ? list[0].id : '';
}
export const autoReviewer = (refs, lgu) => (lgu ? refs.team[lgu.data.teamId]?.data.atlUserId || '' : '');
function preparerOptions(refs, lgu, sel) {
  const team = lgu ? lgu.data.teamId : '';
  const list = refs.users.filter((u) => u.data.status !== 'disabled' && (u.data.roles || []).includes('member') && (!team || (u.data.teamIds || []).includes(team)))
    .sort((a, b) => String(a.data.name).localeCompare(String(b.data.name)));
  const keep = sel && !list.some((u) => u.id === sel) && refs.user[sel] ? [refs.user[sel]] : [];
  return `<option value="">${list.length || keep.length ? '— Choose the ATM —' : 'No Team Member in Users & Roles yet'}</option>` +
    [...keep, ...list].map((u) => `<option value="${esc(u.id)}" ${u.id === sel ? 'selected' : ''}>${esc(userLine(u))}</option>`).join('');
}
function reviewerOptions(refs, lgu, sel) {
  const team = lgu ? lgu.data.teamId : '';
  const list = refs.users.filter((u) => u.data.status !== 'disabled' && (
    (u.data.roles || []).includes('sa') || ((u.data.roles || []).includes('atl') && (!team || (u.data.teamIds || []).includes(team)))))
    .sort((a, b) => String(a.data.name).localeCompare(String(b.data.name)));
  const keep = sel && !list.some((u) => u.id === sel) && refs.user[sel] ? [refs.user[sel]] : [];
  return `<option value="">${list.length || keep.length ? '— Choose the ATL or SA —' : 'No ATL or SA in Users & Roles yet'}</option>` +
    [...keep, ...list].map((u) => `<option value="${esc(u.id)}" ${u.id === sel ? 'selected' : ''}>${esc(userLine(u))}</option>`).join('');
}

// Section 2 body: one officer's exam record. Redrawn when the auditee, date, officer, functions or forms change.
function officerHtml(refs, cer, st, edit) {
  const lgu = refs.lgu[st.lguId];
  if (!lgu) return '<p class="cer-wait">Choose the auditee first. Its accountable officers are listed here.</p>';
  const dis = edit ? '' : 'disabled';
  const bankAccts = (FX && FX.settings && FX.settings['banks|' + st.lguId]?.list) || [];
  const offs = cer.officers.filter((o) => o.lguId === st.lguId).sort((a, b) => a.name.localeCompare(b.name));
  const o = cer.officers.find((x) => x.id === st.officerId);
  const prev = prevExam(cer, st.officerId, st.countDate, st.examId);
  const funcs = funcsFor(lgu);
  const rows = balanceRows(st);
  const lastFromPrev = !!prev;
  const lastExam = lastFromPrev ? prev.countDate : st.lastExamDate;
  const chk = (list, k) => (list || []).includes(k) ? 'checked' : '';
  const h = heads(refs, cer, st), opens = openState(location.hash, h);
  // When nothing open still needs input, the next section that does opens by itself.
  if (!opens.size) { const nx = ACC_ORDER.find((k) => k !== 'exam' && h[k] && h[k][1] === 'need'); if (nx) opens.add(nx); }
  const begRows = o && lastExam && FM && FX ? FM.beginningFormsOf(FX, o.id, lastExam) : [];
  const moneyForms = begRows.reduce((n, x) => n + FM.countRanges(x.unused) * FM.faceOf(x.b), 0);
  const during = o && FM && FX ? FM.receivedDuringOf(FX, o.id, lastExam, st.countDate) : [];
  const begBody = !o ? '<p class="cer-wait">Choose the accountable officer first.</p>'
    : !lastExam ? '<p class="cer-wait">Set the last cash exam date (Examination Period) first. The beginning forms are the ones on hand on that date.</p>'
    : `${begRows.length ? FM.beginningTableHtml(FX, begRows, edit) : `<p class="cer-wait">No accountable forms in ${esc(o.name)}'s hands as of ${esc(fmtDate(lastExam))} are encoded yet.</p>`}
      <div class="cer-headrow cer-begfoot"><span class="hint">Forms from the custodian go to the Forms Register as issuances still in the officer's hands; checkbooks from the bank stay on this officer's records only.${during.length ? ` ${during.length} booklet${during.length > 1 ? 's' : ''} received after the last cash exam ${during.length > 1 ? 'are' : 'is'} in Accountable Forms.` : ''}${edit && begRows.length ? ' Click a booklet to Edit or Delete it.' : ''}</span>
        ${edit ? '<button class="btn" type="button" id="cer-addbeg">+ Add Beginning Forms</button>' : ''}</div>`;
  return `${acc('officer', 'Officer and Functions', h.officer, `<div class="cer-g3">
      <div class="field"><label for="cer-officer">Accountable Officer</label>
        <select class="input" id="cer-officer" ${dis}><option value="">— Choose the officer —</option>
          ${offs.map((x) => `<option value="${esc(x.id)}" ${x.id === st.officerId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
          ${edit ? '<option value="__new">+ Add new officer…</option>' : ''}</select>
        ${o ? `<span class="hint">Designation: ${esc(o.designation || '—')}${edit ? ` · <a href="#" id="cer-edit-off">Edit officer</a>` : ''}</span>` : ''}</div>
      <fieldset class="field cer-span2"><legend>Accountability functions (tick all that apply)</legend>
        <div class="cer-chips">${funcs.map(([k, label]) => `<label class="cer-chip"><input type="checkbox" data-func="${k}" ${chk(st.functions, k)} ${dis}> ${esc(label)}</label>`).join('')}</div>
        ${isBrgy(lgu) ? '<span class="hint">Barangay Treasurer: collecting and disbursing accountabilities are computed separately.</span>' : ''}</fieldset>
    </div>
    ${(st.functions || []).includes('collecting') ? `<fieldset class="field"><legend>Accountable forms used in collecting</legend>
      <div class="cer-chips">${formsForLgu(lgu).map(([k, label]) => `<label class="cer-chip"><input type="checkbox" data-form="${k}" ${chk(st.forms, k)} ${dis}> ${esc(label)}</label>`).join('')}</div></fieldset>
      <fieldset class="field cer-tolo"><legend>Collection records</legend><div class="cer-chips"><label class="cer-chip"><input type="radio" name="cer-recs" value="complete" ${st.records !== 'cashbook' ? 'checked' : ''} ${dis}> Complete (SCD / RCD with ORs)</label><label class="cer-chip"><input type="radio" name="cer-recs" value="cashbook" ${st.records === 'cashbook' ? 'checked' : ''} ${dis}> Cashbook only (no SCD / RCD)</label></div></fieldset>
      ${isBrgy(lgu) ? `<div class="field cer-tolo"><span class="cer-lbl">Collections are</span><span class="cer-fixed"><b>AF 51 (SCD):</b> Deposited in the bank · <b>CTC (SCR):</b> Remitted to the Municipal Treasurer</span></div>`
        : `<fieldset class="field cer-tolo"><legend>Collections are</legend><div class="cer-chips"><label class="cer-chip"><input type="radio" name="cer-tolo" value="0" ${st.remitToLO ? '' : 'checked'} ${dis}> Deposited in the bank</label><label class="cer-chip"><input type="radio" name="cer-tolo" value="1" ${st.remitToLO ? 'checked' : ''} ${dis}> Remitted to the Liquidating Officer</label></div></fieldset>`}
      ${st.remitToLO ? '<span class="hint">Remitted to the Liquidating Officer: no bank account or deposit rule for this officer; the remittances are entered in Collections &amp; Deposits, part 3.</span>' : isBrgy(lgu) ? '<span class="hint">Deposits: within 5 banking days after receipt (Barangay Treasurer).</span>' : `<div class="field cer-deprule"><label for="cer-deprule">Deposit rule</label><select class="input" id="cer-deprule" ${dis}>
        <option value="next" ${st.depositRule !== 'weekly' ? 'selected' : ''}>Daily, or not later than the next banking day</option>
        <option value="weekly" ${st.depositRule === 'weekly' ? 'selected' : ''}>At least once a week, or as soon as collections reach ₱10,000 (minimal collections / bank far)</option></select>
        <span class="hint">Used by Verification to flag late deposits. Banking days skip weekends and holidays (Holidays).</span></div>`}` : ''}`, opens.has('officer'))}

    ${acc('bond', 'Bond and Limits', h.bond, `
      <div class="cer-g5">
        <div class="field"><label for="b-max">Max. Cash Accountability (₱)</label><input class="input amt" id="b-max" data-bond="maxCash" inputmode="decimal" value="${esc(st.bond.maxCash)}" ${dis}></div>
        <div class="field"><label for="b-amt">Amount of Bond (₱)</label><input class="input amt b-det" id="b-amt" data-bond="amount" inputmode="decimal" value="${esc(st.bond.amount)}" ${dis || (st.bond.none ? 'disabled' : '')}></div>
        <div class="field"><label for="b-risk">Risk No.</label><input class="input b-det" id="b-risk" data-bond="riskNo" value="${esc(st.bond.riskNo)}" ${dis || (st.bond.none ? 'disabled' : '')}></div>
        <div class="field"><label for="b-from">Bond Effective From</label><input class="input b-det" type="date" id="b-from" data-bond="from" value="${esc(st.bond.from)}" ${dis || (st.bond.none ? 'disabled' : '')}></div>
        <div class="field"><label for="b-to">Bond Effective To</label><input class="input b-det" type="date" id="b-to" data-bond="to" value="${esc(st.bond.to)}" ${dis || (st.bond.none ? 'disabled' : '')}></div>
      </div>
      <label class="cer-tick b-none"><input type="checkbox" id="b-none" ${st.bond.none ? 'checked' : ''} ${dis}> The officer has no fidelity bond</label>
      <div id="cer-warn">${warnHtml(st)}</div>`, opens.has('bond'))}

    ${acc('period', 'Examination Period', h.period, `
      <div class="cer-g3">
        <div class="field"><label for="cer-last">Last Cash Exam</label>
          <input class="input" type="date" id="cer-last" value="${esc(lastExam)}" ${lastFromPrev ? 'readonly disabled' : dis}>
          <span class="hint">${lastFromPrev ? 'From this officer\'s previous exam in the system.' : 'Typed for the first exam of this officer in the system.'}</span></div>
        <div class="field"><label for="cer-this">This Cash Exam (count date)</label><input class="input" type="date" id="cer-this" value="${esc(st.countDate)}" readonly disabled></div>
        <div class="field"><span class="cer-lbl">Scope of Audit</span><span class="cer-scope" id="cer-scope">${scopeText(lastExam, st.countDate)}</span></div>
      </div>`, opens.has('period'))}

    ${acc('bal', 'Beginning Balances (cash, as of the last cash exam)', h.bal, `
      ${rows.length ? `<div class="cer-tbl"><table class="cer-bal">
        <thead><tr><th scope="col">Accountability</th><th scope="col">Function</th><th scope="col" class="r">Balance (₱)</th><th scope="col">Source</th></tr></thead>
        <tbody>${rows.map((r) => {
          const carried = prev && prev.endBalances && prev.endBalances[r.key] !== undefined && prev.endBalances[r.key] !== null;
          const val = carried ? money(prev.endBalances[r.key]) : (st.balances[r.key] ?? '');
          const bl = BEG_CA[r.key] ? `<div class="cer-begline"><span data-begline="${r.key}">${begLine(st, r.key, carried ? prev.endBalances[r.key] : num(st.balances[r.key]))}</span>
            <button class="btn sm" type="button" data-begchk="${r.key}" data-edit="${edit ? 1 : 0}">${edit ? 'Beginning checks' : 'View checks'}</button>
            ${r.key === 'ca' && bankAccts.length > 1 ? `<label class="cer-restfund">Not itemized · Fund <select class="input af-sm" data-restfund ${dis}>${bankAccts.map((x) => `<option ${x.fund === (st.caRestFund || bankAccts[0].fund) ? 'selected' : ''}>${esc(x.fund)}</option>`).join('')}</select></label>` : ''}</div>` : '';
          // Collections: the OR series of the ORs making up the balance (presented at the last cash exam), when known.
          // Collections: the ORs making up the balance (itemized like the beginning checks), when known.
          const bo = st.begOrs?.[r.key] || [], boT = Math.round(bo.reduce((n, x) => n + (num(String(x.amount ?? '')) || 0), 0) * 100) / 100;
          const ser = r.key.startsWith('col-') ? `<div class="cer-begline"><span>${bo.length ? `${bo.length} range${bo.length > 1 ? 's' : ''}: ${esc(bo.map((x) => `${x.from}–${x.to}`).join(', '))}${boT ? ` · ₱${money(boT)}` : ''}` : 'ORs not itemized'}</span>
            <button class="btn sm" type="button" data-begors="${r.key}" data-edit="${edit ? 1 : 0}">${edit ? 'Beginning ORs' : 'View ORs'}</button></div>` : '';
          return `<tr><td><b>${esc(r.label)}</b>${bl}${ser}</td><td class="dim">${esc(r.fn)}</td>
            <td class="r"><label class="sr-only" for="bal-${r.key}">${esc(r.label)} balance</label><input class="input amt" id="bal-${r.key}" data-bal="${r.key}" inputmode="decimal" value="${esc(val)}" ${carried ? 'readonly disabled' : dis}></td>
            <td>${carried ? '<span class="pill ok">Carried from last exam</span>' : `<span class="pill blue">${lastFromPrev ? 'Typed' : 'Typed (first exam)'}</span>`}</td></tr>`;
        }).join('')}${moneyForms ? `<tr class="cer-mvrow"><td><b>Unused accountable forms with money value</b></td><td class="dim">Forms</td><td class="r"><b>${money(moneyForms)}</b></td><td><span class="pill">From Beginning Inventory</span></td></tr>` : ''}</tbody></table></div>
        <span class="hint">Rows follow the officer's ticked functions and forms. Collecting and disbursing balances stay separate.${rows.some((r) => BEG_CA[r.key]) ? ' Cash advances: type the lump sum, enter the checks unliquidated at the last cash exam (Beginning checks), or both. What is not itemized stays as one beginning balance in Cash Advances.' : ''}${moneyForms ? ' The forms with money value (AF 52, AF 53, AF 54, Cash Tickets) come from the Beginning Inventory of Accountable Forms below, at face value.' : ''}</span>`
      : `<p class="cer-wait">${(st.functions || []).length === 1 && st.functions[0] === 'custodian' ? 'Custodian accountability is kept in Accountable Forms by quantity, not in pesos.' : 'Tick the officer\'s functions to list the balances.'}</p>`}
      ${(st.functions || []).includes('custodian') && rows.length ? '<span class="hint">Custodian accountability is kept in Accountable Forms by quantity, not in pesos.</span>' : ''}`, opens.has('bal'))}

    ${acc('forms', 'Beginning Inventory of Accountable Forms', h.forms, begBody, opens.has('forms'))}
    ${acc('banks', 'Bank Accounts', [bankAccts.length ? `${bankAccts.length} account${bankAccts.length > 1 ? 's' : ''}: ${bankAccts.map((x) => x.fund).join(', ')}` : st.remitToLO && !(st.functions || []).some((k) => ['disbursing', 'special', 'pettycash', 'liquidating'].includes(k)) ? 'Not needed: remitted to the Liquidating Officer' : 'None yet', bankAccts.length || (st.remitToLO && !(st.functions || []).some((k) => ['disbursing', 'special', 'pettycash', 'liquidating'].includes(k))) ? 'ok' : 'need'], `
      ${bankAccts.length ? `<div class="cer-tbl"><table class="cer-bal"><thead><tr><th scope="col">Bank</th><th scope="col">Account No.</th><th scope="col">Fund</th></tr></thead>
        <tbody>${bankAccts.map((x) => `<tr><td>${esc(x.bank || '')}</td><td class="mono">${esc(x.accountNo || '')}</td><td>${esc(x.fund || '')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="cer-wait">No bank account yet.</p>'}
      <div class="btn-row"><button class="btn sm" type="button" id="cer-banks" ${st.lguId ? '' : 'disabled'}>${edit ? 'Edit Bank Accounts' : 'View Bank Accounts'}</button></div>
      <span class="hint">One account per fund (e.g. General Fund, 5% BDRRM). The same list is used by Bank Statements, the Cashbook and Source Documents.</span>`, opens.has('banks'))}`;
}
const scopeText = (from, to) => (from && to ? `${esc(fmtDate(from))} to ${esc(fmtDate(to))}` : '<span class="dim">Set the last cash exam and the count date</span>');
const warnHtml = (st) => bondChecks(st).map((w) => `<div class="cer-alert ${w.kind}" role="status">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4"/><path d="M12 17h.01"/></svg>
  <span>${w.text}</span></div>`).join('');

function wireSetup(refs, cer, q, rerender) {
  if (!DRAFT) return;
  const st = DRAFT.st;
  // Section headers follow what is typed.
  const refreshHeads = () => { const h = heads(refs, cer, st);
    Object.entries(h).forEach(([k, [sum, stat]]) => { const a = $(`[data-sum="${k}"]`), b = $(`[data-st="${k}"]`); if (a) a.innerHTML = sum; if (b) b.innerHTML = stHtml(stat); }); };
  const touch = () => { DRAFT.dirty = true; refreshHeads(); };
  // One section open at a time: opening one folds the others.
  const wireAcc = () => $$('details.acc').forEach((d) => { d.ontoggle = () => {
    const set = OPEN[location.hash] || (OPEN[location.hash] = new Set());
    if (d.open) { set.clear(); set.add(d.dataset.acc); $$('details.acc').forEach((x) => { if (x !== d && x.open) x.open = false; }); } else set.delete(d.dataset.acc);
  }; });
  const wireBeg = () => {
    const o = cer.officers.find((x) => x.id === st.officerId);
    const prev = prevExam(cer, st.officerId, st.countDate, st.examId), lastExam = prev ? prev.countDate : st.lastExamDate;
    const add = $('#cer-addbeg');
    if (add && o) add.onclick = async () => {
      // Saved straight to the booklet records; the unsaved Audit Setup stays as typed.
      const set = OPEN[location.hash] || (OPEN[location.hash] = new Set()); set.clear(); set.add('forms');
      await FM.addBeginningForms(refs, FX, FM.registerOf(refs, st.lguId), o, lastExam, 'beginning', { forms: st.forms || [], custodian: (st.functions || []).includes('custodian') });
    };
    $$('[data-begchk]').forEach((b) => { b.onclick = () => begChecksModal(refs, cer, st, b.dataset.begchk, b.dataset.edit === '1'); });
    $$('[data-restfund]').forEach((sel) => { sel.onchange = () => { st.caRestFund = sel.value; touch(); }; });
    { const bb = $('#cer-banks'); if (bb) bb.onclick = async () => { const B = await import('./banks.js'); const list = (FX && FX.settings && FX.settings['banks|' + st.lguId]?.list) || []; const funds = (FX && FX.settings && FX.settings['funds|' + st.lguId]?.list) || B.DEFAULT_FUNDS; B.accountsModal(refs, st.lguId, list, funds, isAuditor(refs) || hasRole(refs, 'staff')); }; }
    $$('tr[data-begbk]').forEach((tr) => { const go = () => FM.openBooklet(refs, FX, tr.dataset.begbk); tr.onclick = go; tr.onkeydown = (e) => { if (e.key === 'Enter') go(); }; });
  };
  wireAcc(); wireBeg();
  const flag = () => { const t = $('#b-to'); if (t) t.classList.toggle('flag', !!(st.bond.to && st.countDate && st.bond.to < st.countDate)); };
  const lguSel = $('#cer-lgu'), dateIn = $('#cer-date'), revSel = $('#cer-rev');

  const drawOfficer = () => { const box = $('#cer-off'); if (box) { box.innerHTML = officerHtml(refs, cer, st, true); wireOfficer(); wireAcc(); wireBeg(); refreshHeads(); flag(); } };
  function wireOfficer() {
    const offSel = $('#cer-officer');
    if (offSel) offSel.onchange = async () => {
      if (offSel.value !== '__new') return pickOfficer(offSel.value);
      const v = await officerModal(refs, st.lguId, null);
      if (!v) { offSel.value = st.officerId; return; }
      // The screen refreshes after the officer is saved; the unsaved setup is kept and the new officer is selected.
      const id = newId('cero');
      st.officerId = id; DRAFT.dirty = true;
      await store.save('cer_officers', id, { lguId: st.lguId, ...v }, by(refs));
    };
    const ed = $('#cer-edit-off');
    if (ed) ed.onclick = async (e) => {
      e.preventDefault();
      const o = cer.officers.find((x) => x.id === st.officerId); if (!o) return;
      const v = await officerModal(refs, st.lguId, o);
      if (v) await store.save('cer_officers', o.id, { lguId: o.lguId, ...v }, by(refs));
    };
    $$('[data-func]').forEach((c) => { c.onchange = () => {
      st.functions = $$('[data-func]').filter((x) => x.checked).map((x) => x.dataset.func);
      if (st.functions.includes('collecting') && !st.forms.length && isBrgy(refs.lgu[st.lguId])) st.forms = ['af51b', 'ctci'];
      touch(); drawOfficer();
    }; });
    const dr = $('#cer-deprule'); if (dr) dr.onchange = () => { st.depositRule = dr.value; touch(); };
    $$('[name="cer-recs"]').forEach((r) => { r.onchange = () => { st.records = r.value; touch(); }; });
    $$('[name="cer-tolo"]').forEach((r) => { r.onchange = () => { st.remitToLO = r.value === '1'; touch(); drawOfficer(); }; });
    $$('[data-form]').forEach((c) => { c.onchange = () => { st.forms = $$('[data-form]').filter((x) => x.checked).map((x) => x.dataset.form); touch(); drawOfficer(); }; });
    const nb = $('#b-none'); if (nb) nb.onchange = () => { st.bond.none = nb.checked; $$('.b-det').forEach((x) => { x.disabled = nb.checked; }); touch(); $('#cer-warn').innerHTML = warnHtml(st); flag(); };
    $$('[data-bond]').forEach((i) => {
      i.oninput = () => { st.bond[i.dataset.bond] = i.value; touch(); $('#cer-warn').innerHTML = warnHtml(st); flag(); };
      if (i.classList.contains('amt')) i.onblur = () => { const v = num(i.value); if (v !== null) { i.value = money(v); st.bond[i.dataset.bond] = i.value; } };
    });
    { const cy = $('#cer-cyc'); if (cy) cy.onchange = () => { st.cycleId = cy.value; touch(); }; }
    $$('[data-begors]').forEach((b) => { b.onclick = () => begOrsModal(refs, cer, st, b.dataset.begors, b.dataset.edit === '1', () => drawOfficer()); });
    $$('[data-bal]').forEach((i) => {
      i.oninput = () => { st.balances[i.dataset.bal] = i.value; touch(); const k = i.dataset.bal, ln = $(`[data-begline="${k}"]`); if (ln) ln.innerHTML = begLine(st, k, num(i.value)); };
      i.onblur = () => { const v = num(i.value); if (v !== null) { i.value = money(v); st.balances[i.dataset.bal] = i.value; } };
    });
    const last = $('#cer-last');
    // The browser reports a change at the first digit of the year (2 → 0002): redraw only on leaving the box with a full year,
    // so typing the year is not cut off; while typing, only the Scope of Audit follows.
    if (last && !last.disabled) {
      const full = (v) => /^\d{4}-/.test(v) && +v.slice(0, 4) >= 1900;
      let drawn = last.value;
      last.oninput = () => { if (last.value && !full(last.value)) return; st.lastExamDate = last.value; touch(); $('#cer-scope').innerHTML = scopeText(st.lastExamDate, st.countDate); };
      last.onblur = () => { if (last.value && !full(last.value)) return; if (last.value === drawn) return; drawn = last.value; const set = OPEN[location.hash]; if (set) { set.clear(); set.add('period'); } drawOfficer(); };
    }
  }
  function pickOfficer(id) {
    st.officerId = id;
    // A new exam record starts from the officer's previous exam (functions, forms and bond usually stay the same).
    const prev = !st.examId ? prevExam(cer, id, st.countDate, '') : null;
    if (prev) {
      st.functions = [...(prev.functions || st.functions)]; st.forms = [...(prev.forms || st.forms)];
      st.bond = { maxCash: '', amount: '', riskNo: '', from: '', to: '', ...(prev.bond || {}) };
      ['maxCash', 'amount'].forEach((k) => { if (st.bond[k] !== '' && st.bond[k] !== null) st.bond[k] = money(st.bond[k]); });
    }
    touch(); drawOfficer();
  }

  if (lguSel && !lguSel.disabled) lguSel.onchange = () => {
    st.lguId = lguSel.value; const lgu = refs.lgu[st.lguId];
    Object.assign(st, blankExam(lgu), { examId: st.examId });
    $('#cer-addr').value = addressOf(refs, lgu);
    st.preparedBy = autoPreparer(refs, lgu) || st.preparedBy; st.reviewedBy = autoReviewer(refs, lgu) || st.reviewedBy;
    revSel.innerHTML = reviewerOptions(refs, lgu, st.reviewedBy);
    const ps = $('#cer-prep'); if (ps) ps.innerHTML = preparerOptions(refs, lgu, st.preparedBy);
    touch(); drawOfficer();
  };
  if (dateIn) dateIn.oninput = () => { st.countDate = dateIn.value; touch(); drawOfficer(); };
  if (revSel) revSel.onchange = () => { st.reviewedBy = revSel.value; touch(); };
  { const ps = $('#cer-prep'); if (ps && !ps.disabled) ps.onchange = () => { st.preparedBy = ps.value; touch(); }; }
  if ($('#cer-off') && !$('#cer-officer')?.disabled) wireOfficer();
  flag();

  const saveBtn = $('#cer-save');
  if (saveBtn) saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try { await saveSetup(refs, await loadCer(), st); } finally { saveBtn.disabled = false; }
  };
  const rm = $('#cer-remove');
  if (rm) rm.onclick = async () => {
    const o = cer.officers.find((x) => x.id === st.officerId);
    const ok = await modal({ title: 'Remove this officer?', body: `<p style="margin:0">Remove <b>${esc(o ? o.name : 'this officer')}</b> from the cash examination on ${esc(fmtDate(st.countDate))}? The officer stays in the auditee's list of officers.</p>`,
      buttons: [{ label: 'Cancel', value: false }, { label: 'Remove', cls: 'primary', value: true }] });
    if (!ok) return;
    const rec = await store.get('cer_exams', st.examId);
    if (rec) await store.save('cer_exams', st.examId, rec.data, by(refs), { deleted: true });
    DRAFT = null; toast('Officer removed from this cash examination.', 'ok');
    location.hash = `#/cer/setup?a=${st.auditId}`;
  };
}

// Add or edit an accountable officer of the auditee. Resolves with { name, designation } (null if cancelled).
async function officerModal(refs, lguId, cur) {
  const lgu = refs.lgu[lguId];
  const list = isBrgy(lgu) ? DESIG_BRGY : DESIG_LGU;
  let out = null;
  await modal({ title: cur ? 'Edit Accountable Officer' : 'New Accountable Officer',
    body: `<p class="hint" style="margin:0">${esc(agencyName(refs, lgu))}. The officer is kept for this auditee's next cash examinations.</p>
      <div class="field"><label for="o-name">Full name</label><input class="input upper" id="o-name" value="${esc(cur ? cur.name : '')}" autocomplete="off"></div>
      <div class="field"><label for="o-des">Designation</label><input class="input" id="o-des" list="o-des-list" value="${esc(cur ? cur.designation : (isBrgy(lgu) ? 'Barangay Treasurer' : ''))}" autocomplete="off">
        <datalist id="o-des-list">${list.map((d) => `<option value="${esc(d)}">`).join('')}</datalist>
        <span class="hint">Choose from the list or type the designation.</span></div>`,
    buttons: [{ label: 'Cancel', value: null }, { label: cur ? 'Save' : 'Add Officer', cls: 'primary', value: 'ok', check: (bg) => {
      const name = $('#o-name', bg).value.trim().toUpperCase(), des = $('#o-des', bg).value.trim();
      if (!name) { toast('Enter the officer\'s name.', 'bad'); return false; }
      out = { name, designation: des };
      return true;
    } }] });
  return out;
}

// Beginning checks of a cash advance balance: the checks still unliquidated at the last cash exam, one by one.
// Saved as cash advances marked beginning, so the liquidations in Cash Advances are put against each check.
// "9394901-9394911; 9394915" → [[9394901, 9394911], [9394915, 9394915]]
function parseRangesTxt(t) {
  return String(t || '').split(/[;,]/).map((p) => p.trim()).filter(Boolean).map((p) => { const m = p.replace(/\s/g, '').match(/^(\d+)(?:[-–](\d+))?$/); if (!m) return null; const a = +m[1], z = +(m[2] || m[1]); return z >= a ? [a, z] : null; }).filter(Boolean);
}
// Beginning ORs of a collection balance (Audit Setup): the ORs whose collections were undeposited at the last cash exam,
// itemized by range like the beginning checks. Kept on the balance as begOrs [{ date, from, to, amount }] and series "a-b; c-d".
// Suggested from Collections: the officer's ORs of this form tagged Before the period, not yet listed.
async function begOrsModal(refs, cer, st, k, edit, redraw) {
  const o = cer.officers.find((x) => x.id === st.officerId); if (!o) return;
  const form = k.slice(4), prev = prevExam(cer, st.officerId, st.countDate, st.examId);
  const lastExam = prev ? prev.countDate : st.lastExamDate;
  const bal = num(String(st.balances?.[k] ?? '')) || 0;
  const rows = (st.begOrs?.[k] || []).map((x) => ({ ...x }));
  const ors = (await store.list('cer_ors')).map((r) => ({ id: r.id, ...r.data })).filter((x) => !x.deleted && x.officerId === o.id && x.form === form && x.status !== 'cancelled' && x.date && lastExam && x.date < lastExam);
  const face = (x) => (x.items || []).reduce((n, i) => n + (+i.amt || 0), 0);
  const mx = (x) => (x.range ? +x.serialTo : +x.serial);
  // Suggestions: runs of consecutive numbers among those ORs.
  const runs = []; ors.slice().sort((a, b) => +a.serial - +b.serial).forEach((x) => { const r = runs[runs.length - 1];
    if (r && +x.serial <= r.to + 1) { r.to = Math.max(r.to, mx(x)); r.amount += face(x); if (x.date < r.date) r.date = x.date; } else runs.push({ date: x.date, from: +x.serial, to: mx(x), amount: face(x) }); });
  const covered = (a, z) => rows.some((r) => +r.from <= a && z <= +r.to);
  const cands = () => runs.filter((r) => !covered(r.from, r.to));
  const r2x = (n) => Math.round((+n || 0) * 100) / 100;
  const dis = edit ? '' : 'disabled';
  let box;
  const total = () => r2x(rows.reduce((n, x) => n + (num(String(x.amount ?? '')) || 0), 0));
  const foot = () => { const t = total(), rest = r2x(bal - t);
    return `Itemized ₱${money(t)} · Balance ₱${money(bal)} · ${Math.abs(rest) < 0.005 ? 'fully itemized' : rest > 0 ? `₱${money(rest)} not itemized (previous cash exam)` : `<span class="cer-begover">⚠ more than the balance by ₱${money(-rest)}</span>`}`; };
  const draw = () => {
    const cs = cands();
    $('.bo-srcbox', box).innerHTML = edit && runs.length ? `<div class="bc-src"><div class="bc-srch"><b>From Collections</b> <span class="dim">(ORs tagged Before the period, not yet listed)</span>${cs.length > 1 ? '<button class="btn sm" type="button" id="bo-addall">Add all</button>' : ''}</div>
      ${cs.length ? `<table class="cer-bal"><thead><tr><th>Date</th><th>OR From</th><th>OR To</th><th class="r">Amount</th><th></th></tr></thead><tbody>${cs.map((r, i) => `<tr><td>${esc(fmtDate(r.date))}</td><td class="mono">${r.from}</td><td class="mono">${r.to}</td><td class="r">${money(r.amount)}</td><td class="r"><button class="btn sm" type="button" data-addrun="${i}">Add</button></td></tr>`).join('')}</tbody></table>` : '<p class="dim" style="margin:6px 0 0">All of them are listed below.</p>'}</div>` : '';
    $$('[data-addrun]', box).forEach((b) => { b.onclick = () => { const r = cands()[+b.dataset.addrun]; rows.push({ date: r.date, from: r.from, to: r.to, amount: money(r.amount) }); draw(); }; });
    { const all = $('#bo-addall', box); if (all) all.onclick = () => { cands().forEach((r) => rows.push({ date: r.date, from: r.from, to: r.to, amount: money(r.amount) })); draw(); }; }
    $('.bo-tbl tbody', box).innerHTML = rows.length ? rows.map((x, i) => `<tr data-r="${i}"><td><input class="input" type="date" data-f="date" value="${esc(x.date || '')}" aria-label="Date" ${dis}></td>
        <td><input class="input mono" data-f="from" value="${esc(x.from ?? '')}" inputmode="numeric" aria-label="OR From" ${dis}></td><td><input class="input mono" data-f="to" value="${esc(x.to ?? '')}" inputmode="numeric" aria-label="OR To" ${dis}></td>
        <td><input class="input r" data-f="amount" value="${esc(x.amount ?? '')}" inputmode="decimal" aria-label="Amount" ${dis}></td><td class="r">${edit ? `<button class="btn sm" type="button" data-rmb="${i}" aria-label="Remove">×</button>` : ''}</td></tr>`).join('')
      : `<tr><td colspan="5" class="dim">No range listed.${edit ? ' Add the ORs whose collections were undeposited at the last cash exam, if known; otherwise leave it: the balance stays as "previous cash exam (not itemized)".' : ''}</td></tr>`;
    $('.bo-foot', box).innerHTML = foot();
    $$('.bo-tbl input[data-f]', box).forEach((inp) => { const i = +inp.closest('tr').dataset.r; inp.oninput = () => { rows[i][inp.dataset.f] = inp.value; $('.bo-foot', box).innerHTML = foot(); };
      if (inp.dataset.f === 'amount') inp.onblur = () => { const v = num(inp.value); if (v !== null) { inp.value = money(v); rows[i].amount = inp.value; } }; });
    $$('[data-rmb]', box).forEach((b) => { b.onclick = () => { rows.splice(+b.dataset.rmb, 1); draw(); }; });
  };
  let out = null;
  const v = await modal({ title: `Beginning ORs · ${FORM_NAME[form] || form}`, wide: true,
    body: `<p class="hint" style="margin:0 0 10px">${esc(o.name)} · the ORs whose collections were undeposited at the last cash exam${lastExam ? ` (${esc(fmtDate(lastExam))})` : ''}, with their amounts. They are the beginning balance: not flagged as outside the received booklets, and left out of the "not remitted / not presented" papers.</p>
      <div class="bo-srcbox"></div>
      <div class="cer-tbl"><table class="cer-bal bo-tbl"><thead><tr><th scope="col">Date</th><th scope="col">OR From</th><th scope="col">OR To</th><th scope="col" class="r">Amount (₱)</th><th scope="col"></th></tr></thead><tbody></tbody></table></div>
      <div class="bc-bar">${edit ? '<button class="btn" type="button" id="bo-add">+ Add line</button>' : '<span></span>'}<span class="bo-foot"></span></div>`,
    onOpen: (bg) => { box = bg; draw(); const add = $('#bo-add', bg); if (add) add.onclick = () => { rows.push({ date: lastExam || '', from: '', to: '', amount: '' }); draw(); }; },
    buttons: edit ? [{ label: 'Cancel', value: null }, { label: 'Done', cls: 'primary', value: 'ok', check: () => {
      const list = rows.filter((x) => String(x.from ?? '').trim() || String(x.to ?? '').trim() || String(x.amount ?? '').trim());
      for (const x of list) { const a = parseInt(String(x.from).replace(/\D/g, ''), 10), z = parseInt(String(x.to || x.from).replace(/\D/g, ''), 10);
        if (!a || !z || z < a) { toast('Type OR From and OR To of each line (To not before From).', 'bad'); return false; } x.from = a; x.to = z; }
      out = list.map((x) => ({ date: x.date || '', from: x.from, to: x.to, amount: num(String(x.amount ?? '')) ?? '' })); return true; } }] : [{ label: 'Close', cls: 'primary', value: null }] });
  if (v !== 'ok' || !out) return;
  st.begOrs = st.begOrs || {}; st.begOrs[k] = out;
  st.begSer = st.begSer || {}; st.begSer[k] = out.map((x) => (x.from === x.to ? `${x.from}` : `${x.from}-${x.to}`)).join('; ');
  DRAFT && (DRAFT.dirty = true);
  toast('Beginning ORs listed. Save the Audit Setup to keep them.', 'ok');
  if (redraw) redraw();
}
async function begChecksModal(refs, cer, st, k, edit) {
  if (!st.examId) return toast('Save the Audit Setup first, then enter the beginning checks.', 'bad');
  const o = cer.officers.find((x) => x.id === st.officerId); if (!o) return;
  const prev = prevExam(cer, st.officerId, st.countDate, st.examId);
  const carried = prev && prev.endBalances && prev.endBalances[k] !== undefined && prev.endBalances[k] !== null;
  const lump = carried ? Number(prev.endBalances[k]) : num(st.balances[k]);
  const lastExam = prev ? prev.countDate : st.lastExamDate;
  const liqs = (await store.list('cer_liquid')).map((r) => ({ id: r.id, ...r.data }));
  const others = CA.filter((a) => a.officerId === o.id);
  const rows = begChecksOf(st, k).sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.checkNo).localeCompare(String(b.checkNo), undefined, { numeric: true }))
    .map((a) => ({ ...a, n: liqs.filter((l) => l.advanceId === a.id).length }));
  const removed = [];
  const dis = edit ? '' : 'disabled';
  // From Source Documents: the officer's checks (Cash Advances, RCI / CkDJ) dated on or before the last cash exam, less their
  // liquidations and refunds dated on or before it; those with a balance left, not yet among the beginning checks.
  const ckey = (v) => String(v ?? '').replace(/\D/g, '');
  const srcAll = !lastExam ? [] : (await (await import('../src/journal.js')).listAdvances(true)).map((r) => ({ id: r.id, ...r.data }))
    .filter((a) => !a.deleted && !a.beg && a.officerId === o.id && a.date && a.date <= lastExam)
    .map((a) => { const before = liqs.filter((l) => l.advanceId === a.id && l.date && l.date <= lastExam).reduce((n, l) => n + (+l.amount || 0), 0);
      return { ...a, liqBefore: Math.round(before * 100) / 100, unliq: Math.round(((+a.amount || 0) - before) * 100) / 100 }; })
    .filter((a) => a.unliq > 0.004).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const cands = () => srcAll.filter((a) => !rows.some((r) => r.srcId === a.id || ckey(r.checkNo) === ckey(a.checkNo)));
  const fromSrc = (a) => ({ date: a.date, checkNo: a.checkNo, particulars: a.particulars || '', amount: money(a.unliq), n: 0, srcId: a.id,
    // A check typed in Cash Advances becomes the beginning check itself (its liquidations stay linked); one from the RCI is added.
    ...(String(a.id).startsWith('ckdj|') ? { fromJr: a.id, acctId: a.acctId || '' } : { id: a.id, convert: true, origAmount: a.amount, acctId: a.acctId || '' }) });
  const rowHtml = (a, i) => `<tr data-r="${i}"><td><label class="sr-only" for="bc-d${i}">Date</label><input class="input" type="date" id="bc-d${i}" data-f="date" value="${esc(a.date || '')}" ${dis}></td>
    <td><label class="sr-only" for="bc-c${i}">Check No.</label><input class="input mono" id="bc-c${i}" data-f="checkNo" value="${esc(a.checkNo || '')}" autocomplete="off" ${dis}></td>
    <td><label class="sr-only" for="bc-p${i}">Particulars</label><input class="input" id="bc-p${i}" data-f="particulars" value="${esc(a.particulars || '')}" autocomplete="off" ${dis}></td>
    <td><label class="sr-only" for="bc-a${i}">Unliquidated amount</label><input class="input r" id="bc-a${i}" data-f="amount" inputmode="decimal" value="${num(String(a.amount ?? '')) !== null ? esc(money(num(String(a.amount)))) : ''}" autocomplete="off" ${dis}></td>
    <td class="r">${edit ? `<button class="btn sm" type="button" data-rm="${i}" aria-label="Remove check ${esc(a.checkNo || '')}"${a.n ? ` title="Has ${a.n} liquidation${a.n > 1 ? 's' : ''}"` : ''}>×</button>` : ''}</td></tr>`;
  const foot = () => { const s = sumOf(rows.map((a) => ({ amount: num(String(a.amount)) || 0 })));
    const l = +lump || 0, rest = Math.round((l - s) * 100) / 100;
    return `Checks ₱${money(s)}${l ? ` · Lump sum ₱${money(l)}${s > l + 0.004 ? ` · <span class="cer-begover">⚠ more than the lump sum by ₱${money(s - l)}; ₱${money(s)} will be used</span>` : rest > 0.004 ? ` · ₱${money(rest)} not itemized` : ' · fully itemized'}` : ' · no lump sum typed: the balance is the total of the checks'}`; };
  let box;
  const srcHtml = () => { const cs = cands(); if (!edit || !srcAll.length) return '';
    const t = Math.round(srcAll.reduce((n, a) => n + a.unliq, 0) * 100) / 100, l = +lump || 0;
    return `<div class="bc-src"><div class="bc-srch"><b>From Source Documents</b> <span class="dim">(Cash Advances, RCI / Liquidation Journal) · unliquidated as of ${esc(fmtDate(lastExam))}: ₱${money(t)}${l && Math.abs(t - l) > 0.004 ? ` · <span class="cer-begover">differs from the lump sum ₱${money(l)} by ₱${money(Math.abs(t - l))}</span>` : l ? ' · agrees with the lump sum' : ''}</span>
      ${cs.length > 1 ? '<button class="btn sm" type="button" id="bc-addall">Add all</button>' : ''}</div>
      ${cs.length ? `<table class="cer-bal"><thead><tr><th>Date</th><th>Check No.</th><th>Particulars</th><th class="r">Amount</th><th class="r">Liquidated by ${esc(fmtDate(lastExam))}</th><th class="r">Unliquidated</th><th></th></tr></thead>
        <tbody>${cs.map((a) => `<tr><td>${esc(fmtDate(a.date))}</td><td class="mono">${esc(a.checkNo)}</td><td>${esc(a.particulars || '')}</td><td class="r">${money(a.amount)}</td><td class="r">${money(a.liqBefore)}</td><td class="r"><b>${money(a.unliq)}</b></td>
          <td class="r"><button class="btn sm" type="button" data-addsrc="${esc(a.id)}">Add</button></td></tr>`).join('')}</tbody></table>` : '<p class="dim" style="margin:6px 0 0">All of them are among the beginning checks below.</p>'}</div>`; };
  const draw = () => {
    $('.bc-srcbox', box).innerHTML = srcHtml();
    $$('[data-addsrc]', box).forEach((b) => { b.onclick = () => { rows.push(fromSrc(srcAll.find((a) => a.id === b.dataset.addsrc))); draw(); }; });
    { const all = $('#bc-addall', box); if (all) all.onclick = () => { cands().forEach((a) => rows.push(fromSrc(a))); draw(); }; }
    $('.bc-tbl tbody', box).innerHTML = rows.length ? rows.map(rowHtml).join('') : `<tr><td colspan="5" class="dim">No check entered yet.${edit ? ' Add each check still unliquidated as of the last cash exam.' : ''}</td></tr>`;
    $('.bc-foot', box).innerHTML = foot();
    $$('input[data-f]', box).forEach((inp) => {
      const i = +inp.closest('tr').dataset.r, f = inp.dataset.f;
      inp.oninput = () => { rows[i][f] = inp.value; if (f === 'amount') $('.bc-foot', box).innerHTML = foot(); };
      if (f === 'amount') inp.onblur = () => { const v = num(inp.value); if (v !== null) { inp.value = money(v); rows[i].amount = inp.value; } };
    });
    $$('[data-rm]', box).forEach((b) => { b.onclick = () => { const a = rows[+b.dataset.rm];
      if (a.n) return toast(`Check No. ${a.checkNo} has ${a.n} liquidation${a.n > 1 ? 's' : ''} in Cash Advances. Move or delete them first.`, 'bad');
      rows.splice(+b.dataset.rm, 1); if (a.id) removed.push(a); draw(); }; });
  };
  let out = null;
  const v = await modal({ title: `Beginning checks · ${BEG_CA[k]}`, wide: true,
    body: `<p class="hint" style="margin:0 0 10px">${esc(o.name)} · checks unliquidated as of the last cash exam${lastExam ? ` (${esc(fmtDate(lastExam))})` : ''}. Enter the amount still unliquidated on each check. They show in Cash Advances tagged Beginning, and their liquidations are matched per check.</p>
      <div class="bc-srcbox"></div>
      <div class="cer-tbl"><table class="cer-bal bc-tbl"><thead><tr><th scope="col">Date</th><th scope="col">Check No.</th><th scope="col">Particulars</th><th scope="col" class="r">Unliquidated (₱)</th><th scope="col"></th></tr></thead><tbody></tbody></table></div>
      <div class="bc-bar">${edit ? '<button class="btn" type="button" id="bc-add">+ Add check</button>' : '<span></span>'}<span class="bc-foot"></span></div>`,
    onOpen: (bg) => { box = bg; draw(); const add = $('#bc-add', bg);
      if (add) add.onclick = () => { rows.push({ date: rows.length ? rows[rows.length - 1].date : (lastExam || ''), checkNo: '', particulars: '', amount: '', n: 0 }); draw(); const c = $(`#bc-c${rows.length - 1}`, bg); if (c) c.focus(); }; },
    buttons: edit ? [{ label: 'Cancel', value: null }, { label: 'Save', cls: 'primary', value: 'save', check: () => {
      const list = rows.filter((a) => a.id || String(a.checkNo).trim() || String(a.amount).trim());
      const seen = new Set();
      for (const a of list) {
        const no = String(a.checkNo || '').trim(), amt = num(String(a.amount));
        if (!no) { toast('Enter the check No. of each row.', 'bad'); return false; }
        if (!amt || amt <= 0) { toast(`Enter the unliquidated amount of Check No. ${no}.`, 'bad'); return false; }
        if (!a.date) { toast(`Enter the date of Check No. ${no}.`, 'bad'); return false; }
        const key = no.toUpperCase();
        if (seen.has(key) || others.some((x) => x.id !== a.id && x.id !== a.srcId && !removed.some((r) => r.id === x.id) && String(x.checkNo).trim().toUpperCase() === key)) { toast(`Check No. ${no} is already encoded for this officer.`, 'bad'); return false; }
        seen.add(key);
      }
      out = list.map((a) => ({ ...a, checkNo: String(a.checkNo).trim(), particulars: String(a.particulars || '').trim(), amount: num(String(a.amount)) }));
      return true; } }] : [{ label: 'Close', cls: 'primary', value: null }] });
  if (v !== 'save' || !out) return;
  const who = by(refs);
  for (const a of removed) { const { id, n, ...rec } = a; await store.save('cer_cashadv', id, rec, who, { quiet: true, deleted: true }); }
  for (const a of out) {
    const { id, n, ...rec } = a;
    const data = { ...rec, lguId: st.lguId, officerId: o.id, beg: true, begKey: k, begExamId: st.examId };
    const old = id ? CA.find((x) => x.id === id) : null;
    if (old && !a.convert && ['date', 'checkNo', 'particulars', 'amount'].every((f) => String(old[f] ?? '') === String(data[f] ?? ''))) continue;
    // A check typed in Cash Advances: kept as one record, now the beginning check (its own data kept).
    const base = a.convert ? (await store.get('cer_cashadv', id))?.data || {} : {};
    const { srcId, fromJr, convert, ...clean } = data;
    const nid = id || newId('cerca');
    await store.save('cer_cashadv', nid, { ...base, ...clean }, who, { quiet: true });
    // A check from the RCI: its liquidations (Liquidation Journal) follow it to the beginning check.
    if (fromJr) for (const l of liqs.filter((x) => x.advanceId === fromJr)) { const { id: lid, ...lr } = l; await store.save('cer_liquid', lid, { ...lr, advanceId: nid }, who, { quiet: true }); }
  }
  // The exam's balance follows: the larger of the lump sum and the checks.
  const ex = await store.get('cer_exams', st.examId);
  if (ex && !ex.deleted) {
    const s = sumOf(out), bal = { ...(ex.data.balances || {}) };
    bal[k] = { ...(bal[k] || { source: carried ? 'carried' : 'typed' }), lump, amount: Math.max(lump || 0, s) };
    await store.save('cer_exams', st.examId, { ...ex.data, balances: bal }, who, { quiet: true });
  }
  const set = OPEN[location.hash] || (OPEN[location.hash] = new Set()); set.clear(); set.add('bal');
  toast(`${out.length} beginning check${out.length === 1 ? '' : 's'} saved.`, 'ok');
  emitChange('local');
}

async function saveSetup(refs, cer, st) {
  const lgu = refs.lgu[st.lguId];
  const bad = (m) => { toast(m, 'bad'); return null; };
  if (!lgu) return bad('Choose the auditee.');
  if (!st.countDate) return bad('Enter the cash count date.');
  if (!st.preparedBy) return bad('Choose the ATM in Prepared by.');
  if (!st.reviewedBy) return bad('Choose the ATL in Reviewed by.');
  if (!st.officerId) return bad('Choose the accountable officer.');
  if (!(st.functions || []).length) return bad('Tick at least one accountability function.');
  if (st.functions.includes('collecting') && !(st.forms || []).length) return bad('Tick the accountable forms used in collecting.');
  const other = cer.audits.find((a) => a.id !== st.auditId && a.lguId === st.lguId && a.countDate === st.countDate);
  if (other) return bad(`A cash examination of ${agencyName(refs, lgu)} on ${fmtDate(st.countDate)} already exists. Open it from the list and add the officer there.`);
  const auditId = st.auditId || newId('cera');
  if (cer.exams.some((e) => e.auditId === auditId && e.officerId === st.officerId && e.id !== st.examId)) return bad('This officer is already in this cash examination.');
  const prev = prevExam(cer, st.officerId, st.countDate, st.examId);
  const lastExamDate = prev ? prev.countDate : st.lastExamDate;
  if (!lastExamDate) return bad('Enter the last cash exam date.');
  if (lastExamDate >= st.countDate) return bad('The last cash exam must be before this cash count date.');
  const b = st.bond;
  const bond = b.none ? { maxCash: num(b.maxCash), amount: null, riskNo: '', from: '', to: '', none: true } : { maxCash: num(b.maxCash), amount: num(b.amount), riskNo: String(b.riskNo || '').trim(), from: b.from || '', to: b.to || '' };
  const balances = {};
  balanceRows(st).forEach((r) => {
    const carried = prev && prev.endBalances && prev.endBalances[r.key] !== undefined && prev.endBalances[r.key] !== null;
    balances[r.key] = carried ? { amount: prev.endBalances[r.key], source: 'carried' } : { amount: num(st.balances[r.key]) ?? 0, source: 'typed' };
    if (BEG_CA[r.key]) { const lump = carried ? Number(prev.endBalances[r.key]) : num(st.balances[r.key]); const s = sumOf(begChecksOf(st, r.key));
      balances[r.key] = { ...balances[r.key], lump, amount: Math.max(lump || 0, s) }; }
    const ser = String(st.begSer?.[r.key] || '').trim(); if (ser && r.key.startsWith('col-')) balances[r.key].series = ser;
    if (r.key.startsWith('col-') && (st.begOrs?.[r.key] || []).length) balances[r.key].begOrs = st.begOrs[r.key];
  });
  const oldAudit = cer.audits.find((a) => a.id === auditId);
  await store.save('cer_audits', auditId, { lguId: st.lguId, countDate: st.countDate, preparedBy: st.preparedBy, reviewedBy: st.reviewedBy, cycleId: st.cycleId || oldAudit?.cycleId || CYC.current || '' }, by(refs));
  const examId = st.examId || newId('cere');
  const oldExam = cer.exams.find((e) => e.id === examId);
  await store.save('cer_exams', examId, { auditId, officerId: st.officerId, functions: st.functions, forms: st.functions.includes('collecting') ? st.forms : [],
    bond, lastExamDate, lastExamSource: prev ? 'system' : 'typed', balances, depositRule: st.depositRule || 'next', caRestFund: st.caRestFund || '', remitToLO: !!st.remitToLO && (st.functions || []).includes('collecting') && !isBrgy(refs.lgu[st.lguId]), records: (st.functions || []).includes('collecting') && st.records === 'cashbook' ? 'cashbook' : 'complete', endBalances: oldExam ? (oldExam.endBalances || {}) : {} }, by(refs));
  DRAFT = null;
  toast('Audit Setup saved.', 'ok');
  location.hash = `#/cer/setup?a=${auditId}&o=${examId}`;
  return true;
}

/* ---------- Holidays and banking days (late deposits in Verification) ----------
   cer_settings 'holidays|national' { list: [{ date, name }] } for all auditees; 'holidays|<municipality id>' for the local special
   holidays (fiesta, founding anniversary) of that municipality and its barangays. */
export async function holidaysOf(refs, lguId) {
  const sets = Object.fromEntries((await store.list('cer_settings')).map((x) => [x.id, x.data]));
  const l = refs.lgu[lguId], mun = l && l.data.kind === 'barangay' ? l.data.parentId : lguId;
  return new Set([...(sets['holidays|national']?.list || []), ...(sets['holidays|' + mun]?.list || [])].map((h) => h.date));
}
const iso = (d) => d.toISOString().slice(0, 10);
export const isBankingDay = (date, hol) => { const d = new Date(date + 'T00:00:00Z'), w = d.getUTCDay(); return w !== 0 && w !== 6 && !hol.has(date); };
// The date n banking days after the given date.
export function addBankingDays(date, n, hol) {
  const d = new Date(date + 'T00:00:00Z'); let k = 0;
  while (k < n) { d.setUTCDate(d.getUTCDate() + 1); if (isBankingDay(iso(d), hol)) k++; }
  return iso(d);
}
export function bankingDaysBetween(a, b, hol) {   // banking days after a, up to and including b
  if (!a || !b || b <= a) return 0;
  const d = new Date(a + 'T00:00:00Z'); let k = 0;
  while (iso(d) < b) { d.setUTCDate(d.getUTCDate() + 1); if (isBankingDay(iso(d), hol)) k++; }
  return k;
}
async function holidaysModal(refs, edit) {
  const sets = Object.fromEntries((await store.list('cer_settings')).map((x) => [x.id, x.data]));
  const muns = refs.lgus.filter((l) => l.data.kind === 'municipality').sort((a, b) => a.data.name.localeCompare(b.data.name));
  const lists = { national: [...(sets['holidays|national']?.list || [])] };
  muns.forEach((m) => { lists[m.id] = [...(sets['holidays|' + m.id]?.list || [])]; });
  let cur = 'national';
  const dis = edit ? '' : 'disabled';
  const draw = (bg) => {
    const l = lists[cur].slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    lists[cur] = l;
    $('#hol-rows', bg).innerHTML = l.length ? l.map((h, i) => `<tr data-i="${i}"><td><input class="input" type="date" data-k="date" value="${esc(h.date || '')}" aria-label="Date" ${dis}></td><td><input class="input" data-k="name" value="${esc(h.name || '')}" aria-label="Holiday" ${dis}></td><td>${edit ? '<button class="btn sm cd-x" type="button" aria-label="Remove">✕</button>' : ''}</td></tr>`).join('')
      : '<tr><td colspan="3" class="dim">None yet.</td></tr>';
    $$('tr[data-i]', bg).forEach((tr) => {
      $$('[data-k]', tr).forEach((el) => { el.onchange = el.oninput = () => { lists[cur][+tr.dataset.i][el.dataset.k] = el.value; }; });
      const x = $('.cd-x', tr); if (x) x.onclick = () => { lists[cur].splice(+tr.dataset.i, 1); draw(bg); };
    });
  };
  const v = await modal({ title: 'Holidays', wide: true,
    body: `<p class="hint" style="margin:0 0 10px">Banking days skip Saturdays, Sundays and these holidays. National holidays apply to all auditees; local special holidays (fiesta, founding anniversary) apply to the municipality and its barangays.</p>
      <div class="field" style="max-width:360px"><label for="hol-of">List</label><select class="input" id="hol-of"><option value="national">National holidays (all auditees)</option>${muns.map((m) => `<option value="${esc(m.id)}">Local · ${esc(m.data.name)}</option>`).join('')}</select></div>
      <div class="af-tbl"><table class="af-reg cd-edit"><thead><tr><th scope="col">Date</th><th scope="col">Holiday</th><th scope="col"></th></tr></thead><tbody id="hol-rows"></tbody></table></div>
      ${edit ? '<button class="btn sm" type="button" id="hol-add">+ Add Holiday</button>' : ''}`,
    onOpen: (bg) => { draw(bg); $('#hol-of', bg).onchange = (e) => { cur = e.target.value; draw(bg); };
      const add = $('#hol-add', bg); if (add) add.onclick = () => { lists[cur].push({ date: '', name: '' }); draw(bg); const ins = $$('#hol-rows input[type=date]', bg); const last = ins.find((x) => !x.value); if (last) last.focus(); }; },
    buttons: edit ? [{ label: 'Cancel', value: null }, { label: 'Save Holidays', cls: 'primary', value: 'save' }] : [{ label: 'Close', cls: 'primary', value: null }] });
  if (v !== 'save') return;
  for (const [k, l] of Object.entries(lists)) {
    const clean = l.filter((h) => h.date).map((h) => ({ date: h.date, name: String(h.name || '').trim() }));
    const old = (sets['holidays|' + k]?.list || []);
    if (JSON.stringify(old) === JSON.stringify(clean)) continue;
    await store.save('cer_settings', 'holidays|' + k, { list: clean }, by(refs), { quiet: true });
  }
  emitChange('local');
  toast('Holidays saved.', 'ok');
}
