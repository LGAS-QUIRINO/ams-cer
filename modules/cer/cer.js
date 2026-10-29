// Cash Examination Report module (AMS) – practice copy.
// Built so far: Audit Setup, Accountable Forms, Collections & Deposits, Cash Advances, Bank Statements, Cash Count, Verification, Reports (GF 74-A, SAAF, Statements of Accountability).
// Other reports come next.
//
// Records:
//   cer_officers  one accountable officer of an auditee           { lguId, name, designation }
//   cer_audits    one cash examination = auditee + cash count date { lguId, countDate, preparedBy, reviewedBy }
//   cer_exams     one officer's exam record inside a cash examination
//                 { auditId, officerId, functions[], forms[], bond{maxCash, amount, riskNo, from, to}, lastExamDate, lastExamSource,
//                   balances{ key: { amount, source } }, endBalances{} (filled later by the examination) }
import { store, newId } from '../../js/store.js';
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
  ['af52', 'AF 52 – Certificate of Transfer of Large Cattle'], ['af53', 'AF 53 – Certificate of Ownership of Large Cattle'], ['af54', 'AF 54 – Marriage License'], ['af56', 'AF 56'], ['cash', 'Cash Tickets']];
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
export function mayView(refs, lgu) {
  if (!lgu) return false;
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
  const [officers, audits, exams] = await Promise.all([store.list('cer_officers'), store.list('cer_audits'), store.list('cer_exams')]);
  const flat = (r) => ({ id: r.id, ...r.data });
  return { officers: officers.map(flat), audits: audits.map(flat), exams: exams.map(flat) };
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
    { section: true, label: 'SOURCE RECORDS' },
    { key: 'forms', label: 'Accountable Forms', icon: 'library', href: '#/cer/forms' },
    { key: 'collections', label: 'Collections & Deposits', icon: 'inbox', href: '#/cer/collections' },
    { key: 'advances', label: 'Cash Advances', icon: 'swap', href: '#/cer/advances' },
    { key: 'banks', label: 'Bank Statements', icon: 'building', href: '#/cer/banks' },
    { section: true, label: 'EXAMINATION' },
    { key: 'count', label: 'Cash Count', icon: 'grid', href: '#/cer/count' },
    { key: 'verify', label: 'Verification', icon: 'book', href: '#/cer/verify' },
    { key: 'reports', label: 'Reports', icon: 'overview', href: '#/cer/reports' }];
}

// Unsaved Audit Setup changes survive a screen refresh (e.g. a sync) until saved or left.
let DRAFT = null;   // { key, st, dirty }
let FM = null, FX = null;   // Accountable Forms module and its data (for the Beginning Inventory of Accountable Forms)
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
  h.bond = [b.amount || b.to ? `${b.amount ? '₱' + esc(b.amount) + ' bond' : 'Bond'}${b.to ? ' · valid to ' + esc(fmtDate(b.to)) : ''}${w.length ? ' · ' + w.length + ' to check' : ''}` : (w.length ? 'No bond entered' : 'Bond details'), w.some((x) => x.kind === 'bad') ? 'warn' : b.amount || b.riskNo || b.from || b.to ? 'ok' : 'need'];
  h.period = [lastExam && st.countDate ? `${esc(fmtDate(lastExam))} to ${esc(fmtDate(st.countDate))}` : 'Last cash exam date', lastExam && st.countDate ? 'ok' : 'need'];
  const rows = balanceRows(st);
  if (!rows.length) h.bal = [(st.functions || []).length ? 'None (forms only)' : 'Tick the officer\'s functions first', (st.functions || []).length ? 'ok' : 'need'];
  else {
    let total = 0, missing = 0;
    rows.forEach((r) => { const carried = prev && prev.endBalances && prev.endBalances[r.key] !== undefined && prev.endBalances[r.key] !== null;
      const v = carried ? Number(prev.endBalances[r.key]) : num(st.balances[r.key]); if (v === null || v === undefined) missing++; else total += v; });
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
  if (parts[0] === 'forms' || parts[0] === 'collections' || parts[0] === 'advances' || parts[0] === 'banks' || parts[0] === 'count' || parts[0] === 'verify' || parts[0] === 'reports') {
    // Accountable Forms (Forms Register, Accountable Officer view, RAAF Reconciliation) and Collections & Deposits.
    DRAFT = null;
    const { body, crumb, wire } = parts[0] === 'forms' ? await (await import('./forms.js')).formsView(ctx)
      : parts[0] === 'collections' ? await (await import('./collections.js')).collectionsView(ctx) : parts[0] === 'advances' ? await (await import('./advances.js')).advancesView(ctx) : parts[0] === 'banks' ? await (await import('./banks.js')).banksView(ctx) : parts[0] === 'count' ? await (await import('./count.js')).countView(ctx) : parts[0] === 'verify' ? await (await import('./verify.js')).verifyView(ctx) : await (await import('./reports.js')).reportsView(ctx);
    app.innerHTML = moduleFrame({ title: 'Cash<br>Examination', items: navItems(), active: parts[0], crumb, me, roleText, body });
    $$('[data-soon]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); toast(`${a.dataset.soon} comes next. It is not built yet.`); }; });
    if (wire) wire();
    return;
  }
  const cer = await loadCer();
  const view = 'setup';
  const open = q.get('a') || (q.get('new') ? 'new' : '');
  // Beginning Inventory of Accountable Forms reads the same booklet records as Accountable Forms.
  if (open) { FM = await import('./forms.js'); FX = await FM.loadForms(); }
  const body = open ? setupHtml(refs, cer, q) : listHtml(refs, cer);
  app.innerHTML = moduleFrame({ title: 'Cash<br>Examination', items: navItems(), active: view, crumb: open ? 'Audit Setup' : 'Audit Setup · Cash Examinations', me, roleText, body });
  $$('[data-soon]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); toast(`${a.dataset.soon} comes next. It is not built yet.`); }; });
  if (open) wireSetup(refs, cer, q, ctx.rerender);
  else if (parts[0] && parts[0] !== 'setup') history.replaceState(null, '', '#/cer/setup');
}

/* ================= Cash Examinations list ================= */
function listHtml(refs, cer) {
  DRAFT = null;
  const rows = cer.audits.filter((a) => mayView(refs, refs.lgu[a.lguId]))
    .sort((a, b) => String(b.countDate).localeCompare(String(a.countDate)) || agencyName(refs, refs.lgu[a.lguId]).localeCompare(agencyName(refs, refs.lgu[b.lguId])));
  const cols = 'grid-template-columns:120px minmax(170px,1.1fr) minmax(220px,1.6fr) minmax(170px,1fr)';
  const canNew = isAuditor(refs);
  return `<div class="hello"><div><h1>Audit Setup</h1><p>One cash examination per auditee and count date. Each accountable officer has a separate exam record.</p></div>
      ${canNew ? '<a class="btn primary" href="#/cer/setup?new=1">+ New Cash Examination</a>' : ''}</div>
    <div class="panel">
      <div class="panel-head"><h2>Cash Examinations</h2><span class="pill">${rows.length}</span></div>
      ${rows.length ? `<div class="t-head" style="${cols}"><span>Cash Count</span><span>Auditee</span><span>Accountable Officers</span><span>Prepared by</span></div>
        ${rows.map((a) => {
          const lgu = refs.lgu[a.lguId];
          const offs = cer.exams.filter((e) => e.auditId === a.id).map((e) => cer.officers.find((o) => o.id === e.officerId)).filter(Boolean);
          return `<a class="t-row click" style="${cols}" href="#/cer/setup?a=${esc(a.id)}">
            <span><b>${esc(fmtDate(a.countDate))}</b></span>
            <span>${esc(agencyName(refs, lgu))}<small style="display:block">${esc(addressOf(refs, lgu))}</small></span>
            <span>${offs.length ? offs.map((o) => `${esc(o.name)} <small>· ${esc(o.designation || '')}</small>`).join('<br>') : '<small>No officer yet</small>'}</span>
            <span><small>${esc(refs.user[a.preparedBy]?.data.name || '')}</small></span></a>`;
        }).join('')}`
      : `<div class="empty"><b>No cash examinations yet.</b>${canNew ? 'Start one with <b>+ New Cash Examination</b>.' : 'The auditors set these up.'}</div>`}
    </div>`;
}

/* ================= Audit Setup form ================= */
function blankExam(lgu) {
  const brgy = isBrgy(lgu);
  return { examId: '', officerId: '', functions: brgy ? ['collecting', 'disbursing'] : [], forms: brgy ? ['af51b', 'ctci'] : [],
    bond: { maxCash: '', amount: '', riskNo: '', from: '', to: '' }, lastExamDate: '', balances: {} };
}
function stateFrom(refs, cer, q) {
  const audit = cer.audits.find((x) => x.id === q.get('a')) || null;
  const exams = audit ? cer.exams.filter((e) => e.auditId === audit.id) : [];
  const want = q.get('o');
  const exam = want === 'new' ? null : (exams.find((e) => e.id === want) || exams[0] || null);
  const lgu = audit ? refs.lgu[audit.lguId] : null;
  const st = {
    auditId: audit ? audit.id : '', lguId: audit ? audit.lguId : '', countDate: audit ? audit.countDate : '',
    preparedBy: audit ? audit.preparedBy : (refs.me ? refs.me.id : ''), reviewedBy: audit ? (audit.reviewedBy || '') : '',
    ...blankExam(lgu)
  };
  if (exam) {
    Object.assign(st, { examId: exam.id, officerId: exam.officerId, functions: [...(exam.functions || [])], forms: [...new Set((exam.forms || []).map((k) => fixBrgyForm(lgu, k)))],
      bond: { maxCash: '', amount: '', riskNo: '', from: '', to: '', ...(exam.bond || {}) }, lastExamDate: exam.lastExamDate || '',
      balances: Object.fromEntries(Object.entries(exam.balances || {}).map(([k, v]) => [k === 'col-af51' && isBrgy(lgu) ? 'col-af51b' : k, v && v.amount !== null && v.amount !== undefined ? money(v.amount) : ''])) });
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
  const prep = refs.user[st.preparedBy];
  const tabs = base.exams.map((e) => ({ id: e.id, o: cer.officers.find((x) => x.id === e.officerId) }));
  const newTab = !base.exam;   // a new officer exam is being set up
  const h = heads(refs, cer, st), opens = openState(key, h);
  return `<div class="hello"><div><h1>Audit Setup</h1><p>One cash examination per auditee and count date. Each accountable officer has a separate exam record.</p></div>
      <div class="btn-row"><a class="btn" href="#/cer/setup">← All Cash Examinations</a>${edit ? '<button class="btn primary" type="button" id="cer-save">Save Setup</button>' : ''}</div></div>
    ${edit ? '' : '<div class="msg cer-ro">View only. The auditors (Team Member, ATL, SA) set up the cash examination.</div>'}

    <section class="panel acc-panel" aria-label="Cash Examination">
      ${acc('exam', '1. Cash Examination', h.exam, `
        <div class="cer-g3">
          <div class="field"><label for="cer-lgu">Auditee (Agency)</label>
            <select class="input" id="cer-lgu" ${dis} ${audit ? 'disabled' : ''}>${lguOptions(refs, st.lguId)}</select>
            ${audit ? '<span class="hint">Fixed once saved.</span>' : ''}</div>
          <div class="field"><label for="cer-addr">Address / Station</label><input class="input" id="cer-addr" value="${esc(addressOf(refs, lgu))}" readonly disabled></div>
          <div class="field"><label for="cer-date">Cash Count Date</label><input class="input" type="date" id="cer-date" value="${esc(st.countDate)}" ${dis}></div>
        </div>
        <div class="cer-g2">
          <div class="field"><label for="cer-prep">Prepared by (logged-in auditor)</label><input class="input" id="cer-prep" value="${esc(userLine(prep) || (refs.me ? '' : 'Signed-in user'))}" readonly disabled></div>
          <div class="field"><label for="cer-rev">Reviewed by</label><select class="input" id="cer-rev" ${dis}>${reviewerOptions(refs, lgu, st.reviewedBy)}</select></div>
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
  if (![...opens].some((k) => h[k] && h[k][1] === 'need')) { const nx = ACC_ORDER.find((k) => k !== 'exam' && h[k] && h[k][1] === 'need'); if (nx) opens.add(nx); }
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
      <div class="cer-chips">${formsForLgu(lgu).map(([k, label]) => `<label class="cer-chip"><input type="checkbox" data-form="${k}" ${chk(st.forms, k)} ${dis}> ${esc(label)}</label>`).join('')}</div></fieldset>` : ''}`, opens.has('officer'))}

    ${acc('bond', 'Bond and Limits', h.bond, `
      <div class="cer-g5">
        <div class="field"><label for="b-max">Max. Cash Accountability (₱)</label><input class="input amt" id="b-max" data-bond="maxCash" inputmode="decimal" value="${esc(st.bond.maxCash)}" ${dis}></div>
        <div class="field"><label for="b-amt">Amount of Bond (₱)</label><input class="input amt" id="b-amt" data-bond="amount" inputmode="decimal" value="${esc(st.bond.amount)}" ${dis}></div>
        <div class="field"><label for="b-risk">Risk No.</label><input class="input" id="b-risk" data-bond="riskNo" value="${esc(st.bond.riskNo)}" ${dis}></div>
        <div class="field"><label for="b-from">Bond Effective From</label><input class="input" type="date" id="b-from" data-bond="from" value="${esc(st.bond.from)}" ${dis}></div>
        <div class="field"><label for="b-to">Bond Effective To</label><input class="input" type="date" id="b-to" data-bond="to" value="${esc(st.bond.to)}" ${dis}></div>
      </div>
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
          return `<tr><td><b>${esc(r.label)}</b></td><td class="dim">${esc(r.fn)}</td>
            <td class="r"><label class="sr-only" for="bal-${r.key}">${esc(r.label)} balance</label><input class="input amt" id="bal-${r.key}" data-bal="${r.key}" inputmode="decimal" value="${esc(val)}" ${carried ? 'readonly disabled' : dis}></td>
            <td>${carried ? '<span class="pill ok">Carried from last exam</span>' : `<span class="pill blue">${lastFromPrev ? 'Typed' : 'Typed (first exam)'}</span>`}</td></tr>`;
        }).join('')}${moneyForms ? `<tr class="cer-mvrow"><td><b>Unused accountable forms with money value</b></td><td class="dim">Forms</td><td class="r"><b>${money(moneyForms)}</b></td><td><span class="pill">From Beginning Inventory</span></td></tr>` : ''}</tbody></table></div>
        <span class="hint">Rows follow the officer's ticked functions and forms. Collecting and disbursing balances stay separate.${moneyForms ? ' The forms with money value (AF 52, AF 53, AF 54, Cash Tickets) come from the Beginning Inventory of Accountable Forms below, at face value.' : ''}</span>`
      : `<p class="cer-wait">${(st.functions || []).length === 1 && st.functions[0] === 'custodian' ? 'Custodian accountability is kept in Accountable Forms by quantity, not in pesos.' : 'Tick the officer\'s functions to list the balances.'}</p>`}
      ${(st.functions || []).includes('custodian') && rows.length ? '<span class="hint">Custodian accountability is kept in Accountable Forms by quantity, not in pesos.</span>' : ''}`, opens.has('bal'))}

    ${acc('forms', 'Beginning Inventory of Accountable Forms', h.forms, begBody, opens.has('forms'))}`;
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
  const wireAcc = () => $$('details.acc').forEach((d) => { d.ontoggle = () => { const set = OPEN[location.hash] || (OPEN[location.hash] = new Set()); if (d.open) set.add(d.dataset.acc); else set.delete(d.dataset.acc); }; });
  const wireBeg = () => {
    const o = cer.officers.find((x) => x.id === st.officerId);
    const prev = prevExam(cer, st.officerId, st.countDate, st.examId), lastExam = prev ? prev.countDate : st.lastExamDate;
    const add = $('#cer-addbeg');
    if (add && o) add.onclick = async () => {
      // Saved straight to the booklet records; the unsaved Audit Setup stays as typed.
      const set = OPEN[location.hash] || (OPEN[location.hash] = new Set()); set.add('forms');
      await FM.addBeginningForms(refs, FX, FM.registerOf(refs, st.lguId), o, lastExam);
    };
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
    $$('[data-form]').forEach((c) => { c.onchange = () => { st.forms = $$('[data-form]').filter((x) => x.checked).map((x) => x.dataset.form); touch(); drawOfficer(); }; });
    $$('[data-bond]').forEach((i) => {
      i.oninput = () => { st.bond[i.dataset.bond] = i.value; touch(); $('#cer-warn').innerHTML = warnHtml(st); flag(); };
      if (i.classList.contains('amt')) i.onblur = () => { const v = num(i.value); if (v !== null) { i.value = money(v); st.bond[i.dataset.bond] = i.value; } };
    });
    $$('[data-bal]').forEach((i) => {
      i.oninput = () => { st.balances[i.dataset.bal] = i.value; touch(); };
      i.onblur = () => { const v = num(i.value); if (v !== null) { i.value = money(v); st.balances[i.dataset.bal] = i.value; } };
    });
    const last = $('#cer-last');
    if (last && !last.disabled) { last.oninput = () => { st.lastExamDate = last.value; touch(); $('#cer-scope').innerHTML = scopeText(st.lastExamDate, st.countDate); };
      last.onchange = () => { const set = OPEN[location.hash]; if (set) set.add('period'); drawOfficer(); }; }
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
    revSel.innerHTML = reviewerOptions(refs, lgu, st.reviewedBy);
    touch(); drawOfficer();
  };
  if (dateIn) dateIn.oninput = () => { st.countDate = dateIn.value; touch(); drawOfficer(); };
  if (revSel) revSel.onchange = () => { st.reviewedBy = revSel.value; touch(); };
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

async function saveSetup(refs, cer, st) {
  const lgu = refs.lgu[st.lguId];
  const bad = (m) => { toast(m, 'bad'); return null; };
  if (!lgu) return bad('Choose the auditee.');
  if (!st.countDate) return bad('Enter the cash count date.');
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
  const bond = { maxCash: num(b.maxCash), amount: num(b.amount), riskNo: String(b.riskNo || '').trim(), from: b.from || '', to: b.to || '' };
  const balances = {};
  balanceRows(st).forEach((r) => {
    const carried = prev && prev.endBalances && prev.endBalances[r.key] !== undefined && prev.endBalances[r.key] !== null;
    balances[r.key] = carried ? { amount: prev.endBalances[r.key], source: 'carried' } : { amount: num(st.balances[r.key]) ?? 0, source: 'typed' };
  });
  const oldAudit = cer.audits.find((a) => a.id === auditId);
  await store.save('cer_audits', auditId, { lguId: st.lguId, countDate: st.countDate, preparedBy: oldAudit ? oldAudit.preparedBy : (refs.me ? refs.me.id : ''), reviewedBy: st.reviewedBy || '' }, by(refs));
  const examId = st.examId || newId('cere');
  const oldExam = cer.exams.find((e) => e.id === examId);
  await store.save('cer_exams', examId, { auditId, officerId: st.officerId, functions: st.functions, forms: st.functions.includes('collecting') ? st.forms : [],
    bond, lastExamDate, lastExamSource: prev ? 'system' : 'typed', balances, endBalances: oldExam ? (oldExam.endBalances || {}) : {} }, by(refs));
  DRAFT = null;
  toast('Audit Setup saved.', 'ok');
  location.hash = `#/cer/setup?a=${auditId}&o=${examId}`;
  return true;
}
