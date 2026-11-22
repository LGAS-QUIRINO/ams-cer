// CER · Collections & Deposits (design approved 18 Oct 2026).
// One screen per accountable officer of a cash examination, in three parts:
//   1. SCD / RCD   the report as submitted (barangays: SCD, Summary of Collections and Deposits; LGU and PLGU: RCD).
//                  For a Liquidating Officer, the remittances received from the collectors are listed here too.
//   2. Collections every OR as printed (issued or cancelled), with its particulars. Fund follows the report.
//   3. Deposits    deposits / remittances of the report, the computed summary, and for an LO the days each remittance stayed with the LO.
// ORs and deposits not yet in a submitted report are kept under "Not yet reported" (one per fund) until the report comes in.
//
// Records:
//   cer_ors      one OR   { lguId, officerId, form, bookletId, serial, date, status: 'issued' | 'cancelled', items[{ p, amt }], amount, fund, reportId ('' = not yet reported) }
//   cer_reports  one SCD / RCD  { lguId, officerId, kind: 'SCD' | 'RCD', no, date, fund, hardTotal, begTyped, deposits[{ date, ref, no (deposit slip No., optional), amount }],
//                                 remittances[{ date, collectorId, reportId, reportNo, amount }] }
//                id 'nyr|<officerId>|<fund>' (pending: true) holds the deposits and remittances not yet reported.
//   cer_settings 'funds|<lguId>' { list }  the auditee's funds (General Fund, Special Education Fund, Trust Fund, plus any added)
import { store, newId, emitChange } from '../../js/store.js';
import { esc, modal, toast, $, $$ } from '../../js/ui.js';
import { FORMS, fixBrgyForm, hasRole, by, mayView, cycleOk, loadCer, pickAudit, pickExam, remember, getPick, agencyName, fmtDate, money, num, personKey, samePerson } from './cer.js';
import { loadForms, FORM_SHORT, exportXlsx, rangesText, mergeRanges, bookletUnused, countRanges, loadXlsx, excelDate, faceOf as faceOfBk } from './forms.js';

// Each auditee's funds: General Fund to start; the others are added with the Funds button. A fund already used stays listed.
const DEFAULT_FUNDS = ['General Fund'];
export const fundsOf = (f, lguId) => f.settings['funds|' + lguId]?.list || [...new Set([...DEFAULT_FUNDS,
  ...(f.ors || []).filter((o) => o.lguId === lguId && o.fund).map((o) => o.fund), ...(f.reports || []).filter((r) => r.lguId === lguId && r.fund).map((r) => r.fund)])];
const canEncode = (refs) => hasRole(refs, 'staff', 'member', 'atl', 'sa', 'admin');
const isBrgy = (l) => !!l && l.data.kind === 'barangay';
// Barangays: AF 51 (and other ORs) go to the SCD (deposited in the bank); CTC goes to the SCR (remitted to the MTO).
// LGU and PLGU: one RCD for all forms.
export const kindsOf = (l) => (isBrgy(l) ? ['SCD', 'SCR'] : ['RCD']);
export const kindOfForm = (l, form) => (isBrgy(l) ? (String(form).startsWith('ctc') ? 'SCR' : 'SCD') : 'RCD');
// LGU (one RCD for all forms): CTC still has its own accountability column (AF 51 and CTC, as the barangays' SCD and SCR).
export const isCtc = (form) => /^ctc/.test(String(form || ''));
export const ctcSplit = (l, exam, f, o) => !isBrgy(l) && ((exam.forms || []).some(isCtc) || f.ors.some((x) => x.officerId === o.id && isCtc(x.form)));
export const partOk = (part, form) => !part || (part === 'ctc') === isCtc(form);
// Beginning share of CTC: the CTC collection balances in Audit Setup over all the collection balances.
export function ctcBegShare(bal) {
  const es = Object.entries(bal || {}).filter(([k]) => k.startsWith('col-'));
  const c = es.filter(([k]) => isCtc(k.slice(4))).reduce((n, [, v]) => n + (+v?.amount || 0), 0), t = es.reduce((n, [, v]) => n + (+v?.amount || 0), 0) + (+bal?.liq?.amount || 0);
  return t > 0.004 ? c / t : 0;
}
// Each deposit of a chain split between CTC and AF 51 by the ORs it covers: the ORs in its own series (OR From–To);
// without a series, the ORs of its report (its OR Range); a report with no ORs, the beginning balances.
// Returns a Map: deposit → its CTC part. Remittances received from collectors are AF 51.
const ALLOC = new WeakMap();
const rawAmt = (x) => r2((x.items || []).reduce((n, i) => n + (+i.amt || 0), 0));
export function ctcAlloc(ch, bs) {
  const k = ALLOC.get(ch); if (k && k.bs === bs) return k.map;
  const map = new Map();
  [...ch.figs, ch.pend].forEach((g) => {
    const own = (g.ors || []).filter((x) => x.status !== 'cancelled');
    const T = own.reduce((n, x) => n + rawAmt(x), 0) + (g.remTotal || 0), C = own.filter((x) => isCtc(x.form)).reduce((n, x) => n + rawAmt(x), 0);
    (g.rec?.deposits || []).forEach((d) => {
      const s = g.serOf?.get(d), a = +d.amount || 0;
      const share = s && s.tot > 0.004 ? s.ctc / s.tot : T > 0.004 ? C / T : bs;
      map.set(d, r2(Math.min(a, Math.max(0, a * share))));
    });
  });
  ALLOC.set(ch, { bs, map });
  return map;
}
// The part of deposit d that goes to the column (part 'ctc' or 'or').
export const depPart = (part, d, map) => { const c = map.get(d) || 0; return part === 'ctc' ? c : r2((+d.amount || 0) - c); };
// Undeposited CTC of the officer, from the reports (the rest of the RCD balance is AF 51).
export function ctcBalance(fig, bs) {
  return r2(Object.values(fig.chains).filter((ch) => ch.kind === 'RCD').reduce((n, ch) => {
    const all = [...ch.figs, ch.pend], map = ctcAlloc(ch, bs);
    const c = all.reduce((m, g) => m + (g.ors || []).filter((x) => x.status !== 'cancelled' && isCtc(x.form)).reduce((k, x) => k + orAmount(x), 0), 0);
    return n + ((all[0]?.beg || 0) + all.reduce((m, g) => m + (g.begAdd || 0), 0)) * bs + c - [...map.values()].reduce((m, v) => m + v, 0);
  }, 0));
}

const kindOf = (l) => kindsOf(l)[0];
// A report's name: its number, or (barangay SCDs often have none) its date, with (2), (3)… for a second unnumbered one of the same date and fund.
// Unnumbered reports of the same date: told apart by their OR series ("SCR of 01/15/2026 · 20630801–20630850"), not (2).
const firstRange = (r) => (Array.isArray(r.ranges) && r.ranges.length ? `${r.ranges[0][0]}–${r.ranges[0][1]}${r.ranges.length > 1 ? '…' : ''}` : '');
export const repName = (r, kind) => { const K = (r && r.kind) || kind || 'RCD'; if (r && String(r.no || '').trim()) return `${K} No. ${r.no}`;
  const sr = r && (r.sameDay || r.dupe) ? firstRange(r) : '';
  return `${K} of ${fmtDate(r && r.date)}${sr ? ` · ${sr}` : r && r.dupe ? ` (${r.dupe})` : ''}`; };
// Marks the unnumbered reports that share officer, type, fund and date with another (for repName).
export function tagSameDay(list) {
  const key = (r) => [r.officerId, r.kind, r.fund, r.date].join('|');
  const n = {}; list.forEach((r) => { if (!r.pending && !String(r.no || '').trim()) n[key(r)] = (n[key(r)] || 0) + 1; });
  list.forEach((r) => { if (!r.pending && !String(r.no || '').trim() && n[key(r)] > 1) r.sameDay = true; });
  return list;
}
const KIND_NAME = { SCD: 'Summary of Collections and Deposits', SCR: 'Summary of Collections and Remittances', RCD: 'Report of Collections and Deposits' };
const pendId = (officerId, kind, fund) => `nyr|${officerId}|${kind}|${fund}`;
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const int = (s) => { const v = parseInt(String(s ?? '').replace(/[^\d]/g, ''), 10); return isNaN(v) ? null : v; };
const r2 = (n) => Math.round(n * 100) / 100;
const sum = (list, k) => r2(list.reduce((n, x) => n + (+x[k] || 0), 0));
const flat = (r) => ({ id: r.id, ...r.data });
const strip = (x) => { const { id, sameDay, formTyped, ...rest } = x; return rest; };   // sameDay is worked out on loading, never saved
const bad = (m) => { toast(m, 'bad'); return false; };
const DEPSHOW = { v: 'all' };
const REM = { key: '', i: -1, date: '', mode: 'type', find: '' };   // the typed remittance being edited (by report) and the last date typed
const KSEL = {};   // the report type shown per officer (SCD / RCD or SCR), remembered while the app is open
const KIND_PICK = { SCD: 'SCD – Collections and Deposits', RCD: 'RCD – Collections and Deposits', SCR: 'SCR – Collections and Remittances' };   // deposits register: all of the officer, or the selected report
const go = (params) => { const q = new URLSearchParams(location.hash.split('?')[1] || ''); Object.entries(params).forEach(([k, v]) => (v ? q.set(k, v) : q.delete(k))); location.hash = location.hash.split('?')[0] + '?' + q.toString(); };

// Kept between screen refreshes (each save redraws the screen).
// One section open at a time (opening one folds the others); Collections is open to start.
const OPEN = { rep: true, col: false, dep: false };   // which tab is shown (one at a time); 1 SCD when the screen is opened
export const resetTabs = () => { Object.keys(OPEN).forEach((k) => { OPEN[k] = k === 'rep'; }); };
const NO_PART = 'No particular';   // an imported OR whose particular was left blank
// Forms with one particular: filled in when encoding (still editable) and shown for an OR left without one. AF 51 is typed.
export const FIXED_PART = { cashbn: 'Market Fees', ctci: 'Community Tax', ctcc: 'Community Tax', af56: 'Real Property Tax', af54: 'Marriage License Fee',
  af52: 'Certificate of Transfer of Large Cattle', af53: 'Certificate of Ownership of Large Cattle', cash: 'Market Fees' };
export const partOf = (form, p) => ((!p || p === NO_PART) && FIXED_PART[form] ? FIXED_PART[form] : p);
const LASTC = { key: '', form: '', bookletId: '', serial: '', date: '', auto: true, status: 'issued', focus: '' };

/* ---------- figures ---------- */
// An OR, or a summary line by OR range (range: serial–serialTo, one total; from a cashbook when the RCD is not available).
// beg: dated before the last cash exam: its numbers are used, its amount is in the beginning balance (not this period's).
// An OR (or range line) not inside a booklet received or issued to the officer, of its form.
const NIB = 'Not in a booklet received or issued to this officer in the Forms Register';
// The beginning ORs listed in Audit Setup (per form): their ORs are the beginning balance, not a booklet of this period.
export function begRangesOf(exam) {
  const out = {};
  Object.entries(exam?.balances || {}).forEach(([k, v]) => { if (!k.startsWith('col-') || !v) return;
    const rs = (v.begOrs || []).map((x) => [+x.from, +(x.to || x.from)]).filter(([a, z]) => a && z >= a);
    String(v.series || '').split(/[;,]/).forEach((p) => { const m = p.replace(/\s/g, '').match(/^(\d+)(?:[-–](\d+))?$/); if (m) rs.push([+m[1], +(m[2] || m[1])]); });
    if (rs.length) out[k.slice(4)] = rs; });
  return out;
}
const inBegRanges = (br, x) => (br[x.form] || []).some(([a, z]) => a <= +x.serial && (x.range ? +x.serialTo : +x.serial) <= z);
const outOfBooklets = (f, o, x) => (x.bnLine ? !f.booklets.some((b) => b.id === x.bookletId) : !f.booklets.some((b) => b.officerId === o.id && b.form === x.form && !b.noSerial && b.from <= +x.serial && (x.range ? +x.serialTo : +x.serial) <= b.to));
// Forms with money value encoded by OR range on the Collections line (Date, OR From, OR To; amount = pieces × denomination).
const MV_SER = ['af52', 'af53', 'af54', 'cash'];
// Cash Ticket (Booklet No.) line: "BN. 125 · 40 pcs".
const bnOf = (f, x) => f.booklets.find((b) => b.id === x.bookletId)?.bn;
export const bnLineText = (f, x) => `BN. ${bnOf(f, x) || '—'} · ${(+x.pcs || 0).toLocaleString('en-US')} pcs`;
// An OR of the beginning (Before the period): dated before the last cash exam; or dated on the exam day itself and in the OR
// series of the beginning balance typed in Audit Setup (when typed for its form, that series decides); with no series typed,
// its number among those already used per the officer's beginning booklet (Partly used at the last cash exam).
export function begOr(f, x, lx, br) {
  if (!lx || !x.date) return false;
  if (x.date < lx) return true;
  if (x.bnLine) return false;
  if (x.date !== lx) return false;
  if (br && (br[x.form] || []).length) return inBegRanges(br, x);
  const n = +x.serial, bk = f.booklets.find((b) => b.id === x.bookletId) || f.booklets.find((b) => b.officerId === x.officerId && b.form === x.form && !b.noSerial && b.from <= n && n <= b.to);
  if (!bk || !n || n < bk.from || n > bk.to || !(bk.beginAs || bk.issuedAsOf || bk.foundAtCount) || (bk.issuedDate && bk.issuedDate > lx)) return false;
  if (!Array.isArray(bk.unusedAtStart)) return false;   // whole booklet unused at the exam
  return !bk.unusedAtStart.some(([a, z]) => n >= a && n <= z);
}
// An OR within the scope of the audit (reports, Verification, Cashbook): after the last cash exam up to the cash count; on the
// exam day itself unless it is of the beginning (begOr: the beginning series typed in Audit Setup, else the beginning booklet),
// so the reports count exactly the ORs the SCDs / RCDs count.
export const orInScope = (f, x, from, to, exam) => !!x.date && x.date <= to && (!from || x.date > from || (x.date === from && !begOr(f, x, from, begRangesOf(exam))));
const orAmount = (o) => (o.status === 'cancelled' || o.beg ? 0 : r2((o.items || []).reduce((n, i) => n + (+i.amt || 0), 0)));
const maxSer = (x) => (x.range ? +x.serialTo : +x.serial);
export const serialsOf = (x) => { const out = []; for (let n = +x.serial, z = maxSer(x); n <= z && out.length < 5001; n++) out.push(n); return out; };
// Cash Ticket (Booklet No.) in a report: "Cash Ticket (Booklet No.) · BN. 98 · 520 pcs; BN. 121 · 380 pcs" (pieces per booklet).
const bnPcsText = (k, pairs) => `${FORM_SHORT[k] || k} · ${pairs.sort((a, b) => a[0] - b[0]).map(([n, q]) => `BN. ${n || '—'} · ${q.toLocaleString('en-US')} pcs`).join('; ')}`;
// Before the collector's own lines are encoded: the booklets of the LO's typed remittances made into this report.
function bnFromLO(f, g) {
  const m = new Map(); f.reports.forEach((r) => (r.remittances || []).forEach((x) => { if (!x.fromCol && x.reportId === g.id && formOfSer(x) === 'cashbn') m.set(+x.bn || 0, (m.get(+x.bn || 0) || 0) + (+x.pcs || 0)); }));
  return m.size ? bnPcsText('cashbn', [...m.entries()]) : '';
}
// The ORs column: receipts counted per OR No.; Cash Ticket (Booklet No.) by pieces ("26 · 3,500 pcs").
const orsText = (g) => { const own = (g.ors || []), rec = own.filter((x) => !x.bnLine), cx = rec.filter((x) => x.status === 'cancelled').length, pcs = own.filter((x) => x.bnLine && x.status !== 'cancelled').reduce((n, x) => n + (+x.pcs || 0), 0);
  return [rec.length || !pcs ? `${rec.length}${cx ? ` <span class="dim">(${cx} cancelled)</span>` : ''}` : '', pcs ? `${pcs.toLocaleString('en-US')} pcs` : ''].filter(Boolean).join(' · '); };
function rangeByForm(list) {
  const by = {}, bn = {}; list.forEach((o) => { if (o.bnLine) { const n = BKS.find((b) => b.id === o.bookletId)?.bn || 0; const m = (bn[o.form] = bn[o.form] || new Map()); m.set(n, (m.get(n) || 0) + (+o.pcs || 0)); return; } (by[o.form] = by[o.form] || []).push(o.serial, maxSer(o)); });
  return [...Object.entries(by).map(([k, ns]) => `${FORM_SHORT[k] || k} ${Math.min(...ns)} – ${Math.max(...ns)}`),
    ...Object.entries(bn).map(([k, m]) => bnPcsText(k, [...m.entries()]))].join('; ');
}
// Every report of the officer (and the "Not yet reported" of each fund), in order, with its figures and checks.
// exam (optional): its Audit Setup beginning balances open the first report of each report type (General Fund), unless the
// first report has its own "undeposited per last report" typed; the beginning ORs in it stay at nil (Before the period).
// A collector's report made from an LO's line (madeFrom) that no LO line uses any more and that has no OR or deposit of its
// own (e.g. the line's collector or No. corrected): a leftover, not shown anywhere. Worked out on screen; removed for good
// the next time that LO saves her remittances.
export function orphanShell(f, r) {
  if (!r || !r.madeFrom) return false;
  if (!f._shellUse || f._shellUseOf !== f.reports) { f._shellUseOf = f.reports; f._shellUse = new Set(f.reports.flatMap((x) => (x.remittances || []).filter((m) => !m.fromCol && m.reportId).map((m) => m.reportId))); }
  if (f._shellUse.has(r.id)) return false;
  return !(f.ors || []).some((x) => x.reportId === r.id) && !(r.deposits || []).some((d) => !d.fromLO);
}
export function figuresOf(f, o, funds, countDate, lgu, exam = null) {
  if (f.booklets) BKS = f.booklets;
  const kinds = kindsOf(lgu);
  const ors = f.ors.filter((x) => x.officerId === o.id);
  // A beginning carried from the officer's previous cash exam: the reports up to that count belong to it.
  const carriedFrom = exam && exam.lastExamDate && Object.entries(exam.balances || {}).some(([k, v]) => (k.startsWith('col-') || k === 'liq') && v?.source === 'carried') ? exam.lastExamDate : '';
  // A report belongs to the cash exam its date falls in: those dated on or before the last cash exam are the previous exam's
  // (its ending is this exam's beginning) and do not count here. A report dated after it that still holds ORs of before the
  // cut-off shows them as Before the period, their amount in the beginning balance.
  const cutPrev = exam?.lastExamDate || carriedFrom;
  const reals = f.reports.filter((r) => r.officerId === o.id && !r.pending && !orphanShell(f, r) && !(cutPrev && r.date && r.date <= cutPrev));
  const oldReps = cutPrev ? f.reports.filter((r) => r.officerId === o.id && !r.pending && !orphanShell(f, r) && r.date && r.date <= cutPrev) : [];
  const oldIds = new Set(oldReps.map((r) => r.id));
  const allFunds = [...new Set([...funds, ...reals.map((r) => r.fund), ...ors.map((x) => x.fund).filter(Boolean)])];
  const begR = begRangesOf(exam);
  // An OR dated before the last cash exam is of the beginning (Before the period), tagged or not yet.
  const lx = exam?.lastExamDate || '';
  const isBeg = (x) => (lx ? begOr(f, x, lx, begR) : !!x.beg);   // always from the current Last Cash Exam date (and the beginning booklet on the exam day)
  // "Before the period" is worked out here each time (never saved by opening a screen): the lists and other screens read it.
  if (lx) ors.forEach((x) => { x.beg = begOr(f, x, lx, begR); });
  const amtOf = (x) => (x.status === 'cancelled' || isBeg(x) ? 0 : r2((x.items || []).reduce((n, i) => n + (+i.amt || 0), 0)));
  const bal0 = exam?.balances || {}, gf = allFunds.find((x) => /general/i.test(x)) || allFunds[0];
  const begSetup = (kind, fund) => (fund !== gf || !exam ? null : r2(Object.entries(bal0).filter(([k]) => k.startsWith('col-') && kindOfForm(lgu, k.slice(4)) === kind).reduce((n, [, v]) => n + (+v?.amount || 0), 0)
    + (kind === kinds[0] && (kind === 'RCD' || (exam.functions || []).includes('liquidating')) ? (+bal0.liq?.amount || 0) : 0)));
  const begSer = (kind) => Object.entries(bal0).filter(([k, v]) => k.startsWith('col-') && kindOfForm(lgu, k.slice(4)) === kind && v && v.series).map(([k, v]) => `${FORM_SHORT[k.slice(4)] || k.slice(4)} ${v.series}`).join('; ');
  // A blank box was saved as 0 before: 0 counts as not typed (the Audit Setup beginning is used).
  const typed = (v) => v !== null && v !== undefined && String(v).trim() !== '' && !!num(v);
  // The opening of a chain: typed on its first report, else the Audit Setup beginning; a typed one that differs is noted.
  const opening = (r, kind, fund) => { const s = begSetup(kind, fund); if (r && typed(r.begTyped)) return { v: num(r.begTyped), s, typed: true }; return { v: s || 0, s, setup: !!s }; };
  const encoded = {}; f.ors.forEach((x) => { const st = (encoded[x.form] = encoded[x.form] || new Set()); serialsOf(x).forEach((n) => st.add(n)); });
  // Records saved earlier with lines shown from the other side (fromLO / fromCol): those lines are made again on loading.
  const clean = (r) => (r ? { ...r, deposits: (r.deposits || []).filter((d) => !d.fromLO), remittances: (r.remittances || []).filter((m) => !m.fromCol) } : r);
  const noKey = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(SCR|RCD|SCD)(NO)?/, '');
  const sameAmt = (a, b) => Math.abs((+a || 0) - (+b || 0)) < 0.005;
  // The same remittance on both sides: same collector, and the same OR range, report No., or date and amount.
  const sameRem = (t, m) => t.collectorId === m.collectorId && ((t.from && m.from && String(t.from) === String(m.from)) || (t.reportId && t.reportId === m.colReportId)
    || (t.reportNo && m.colNo && noKey(t.reportNo) === noKey(m.colNo)) || (t.date === m.date && sameAmt(t.amount, m.amount)));
  const typedRems = f.reports.filter((r) => r.officerId === o.id).flatMap((r) => (r.remittances || []).filter((m) => !m.fromCol && m.collectorId));
  const myDeps = f.reports.filter((r) => r.officerId === o.id).flatMap((r) => (r.deposits || []).filter((d) => !d.fromLO));
  // Remittances to this officer (as the Liquidating Officer) typed on the collectors' side, with their OR series (cashbook only):
  // they show in this LO's remittances received, so the LO's book is not typed again.
  const nm = (v) => String(v || '').toLowerCase().replace(/[^a-z]/g, '');
  // Also the SCR remittances (barangay CTC) whose receiver is this officer by name: the series of the line, else of the SCR.
  const rgTxt = (rs) => (rs || []).map(([a, z]) => (a === z ? `${a}` : `${a}–${z}`)).join('; ');
  const rk = (r) => r.kind || (r.pending && String(r.id || '').startsWith('nyr|') ? String(r.id).split('|')[2] : '');
  const colLines = f.reports.filter((r) => r.officerId !== o.id).flatMap((r) => (r.deposits || []).filter((d) => !d.fromLO && d.date && nm(d.ref) && nm(d.ref) === nm(o.name) && (d.toLO || rk(r) === 'SCR'))
    .map((d) => { const rs = Array.isArray(r.ranges) ? r.ranges : [], from = d.from || (rs[0] ? String(rs[0][0]) : ''), to = d.from ? d.to || d.from : rs.length ? String(rs[rs.length - 1][1]) : '';
      return { key: `${r.id}|${d.date}|${r2(+d.amount || 0)}`, date: d.date, collectorId: r.officerId, colReportId: r.id, colNo: r.no || '', reportNo: rk(r) === 'SCR' ? `SCR${r.no ? ' No. ' + r.no : ''}` : `RCD${r.no ? ' No. ' + r.no : ''}`, amount: +d.amount || 0, from, to, series: d.from ? `${d.from}–${d.to || d.from}` : rgTxt(rs), ...(d.from ? {} : { serList: rs.map((x, i) => [x[0], x[1], (r.rangeForms || [])[i] || '']) }), ...(d.form ? { form: d.form } : {}), fromCol: true, fund: r.fund || '',
        ...(lx && d.date < lx ? { beg: true } : {}) }; }))
    // Typed by this LO too (same collector and the same OR range, report No. or date and amount): counted once, as typed.
    .filter((m) => !typedRems.some((t) => sameRem(t, m)));
  // A collector's remittances recorded by a Liquidating Officer (from the LO's cashbook): the collector's remittances to the LO.
  const loLines = f.reports.filter((r) => r.officerId !== o.id).flatMap((r) => (r.remittances || []).filter((m) => m.collectorId === o.id && !m.fromCol && !m.beg && m.date)
    .map((m) => ({ date: m.date, ref: f.officers.find((x) => x.id === r.officerId)?.name || 'Liquidating Officer', amount: +m.amount || 0, toLO: true, fromLO: true, form: m.form || '', from: m.from || '', to: m.to || '', fund: r.fund || '',
      reportId: m.reportId || '', reportNo: m.reportNo || '', loReportNo: r.pending ? '' : r.no || '', loReportId: r.pending ? '' : r.id })))
    // Typed by the collector too (same OR range, or date and amount): counted once, as the collector typed it.
    .filter((m) => !myDeps.some((d) => (d.from && m.from && String(d.from) === String(m.from)) || (d.date === m.date && sameAmt(d.amount, m.amount))));
  // The report type of a line typed by the LO: its report's; else the form of the booklet holding its OR From; else SCR for a
  // barangay (CTC remitted), the first type for an LGU.
  const loKind = (m) => { const rr = m.reportId && reals.find((r) => r.id === m.reportId); if (rr) return rr.kind || kinds[0];
    const n = +m.from, b = n ? f.booklets.find((x) => x.officerId === o.id && !x.noSerial && x.from <= n && n <= x.to) : null;
    if (b) return kindOfForm(lgu, b.form); if (m.form) return kindOfForm(lgu, m.form); return kinds.includes('SCR') ? 'SCR' : kinds[0]; };
  const out = {};
  const markOpening = (fg, op) => {
    if (op.typed && op.s !== null && Math.abs(op.v - op.s) > 0.004) fg.issues.push(`Undeposited per last report typed ₱${money(op.v)} on this report; beginning per Audit Setup ₱${money(op.s)}. Check which one is right.`);
  };
  // begAdd: the part of the Audit Setup beginning reported in this report (its ORs of before the period).
  const build = (id, rec, list, beg, begAdd = 0) => {
    const own = list.filter((x) => x.status !== 'cancelled');
    const rem = (rec?.remittances || []).filter((m) => !m.beg);
    const fig = { id, rec, ors: list, beg, orsTotal: sum(own.map((x) => ({ a: amtOf(x) })), 'a'), remTotal: sum(rem, 'amount'), dep: sum(rec?.deposits || [], 'amount'),
      begRaw: r2(own.filter(isBeg).reduce((n, x) => n + r2((x.items || []).reduce((t, i) => t + (+i.amt || 0), 0)), 0)),   // ORs of the beginning (Before the period), at face
      nOrs: list.length, nCancelled: list.length - own.length, from: '', to: '', range: rangeByForm(list), issues: [] };
    fig.coll = r2(fig.orsTotal + fig.remTotal);
    fig.begAdd = r2(begAdd);
    fig.end = r2(beg + fig.begAdd + fig.coll - fig.dep);
    const dates = [...list.map((x) => x.date), ...rem.map((x) => x.date)].filter(Boolean).sort();
    fig.from = dates[0] || ''; fig.to = dates[dates.length - 1] || '';
    // Checks
    // The hard copy's total includes the beginning ORs reported in it (at face).
    const hc = r2(fig.coll + fig.begRaw);
    if (rec && !rec.pending && rec.hardTotal !== null && rec.hardTotal !== undefined && rec.hardTotal !== '' && Math.abs(+rec.hardTotal - hc) > 0.004)
      fig.issues.push(`Total per hard copy ₱${money(rec.hardTotal)}; per the encoded records ₱${money(hc)} (₱${money(Math.abs(r2(+rec.hardTotal - hc)))} ${+rec.hardTotal > hc ? 'less' : 'more'} than the hard copy).`);
    // OR Range typed from the hard copy: how many of its numbers are encoded; the hard-copy total is checked against them.
    const rs = rec && !rec.pending && Array.isArray(rec.ranges) ? rec.ranges : [];
    if (rs.length) {
      const encF = (fk) => new Set(ors.filter((x) => sameF(fk, x.form)).flatMap(serialsOf));
      fig.rangeN = rs.reduce((n, [a, z]) => n + z - a + 1, 0);
      const miss = []; rs.forEach(([a, z], i) => { const mine = encF(rangeFormAt({ ...rec, officerId: o.id }, i)); if (z - a < 5000) for (let n = a; n <= z; n++) if (!mine.has(n)) miss.push([n, n]); });
      fig.rangeIn = fig.rangeN - miss.length;
      if (miss.length) fig.issues.push(`${miss.length} OR${miss.length > 1 ? 's' : ''} of the range not yet encoded: ${rangesText(mergeRanges(miss))}.`);
    }
    if (rec && !rec.pending && rec.hardTotal !== null && rec.hardTotal !== undefined && rec.hardTotal !== '') fig.balanced = Math.abs(+rec.hardTotal - fig.coll) <= 0.004;
    const byForm = {}; list.filter((x) => !x.bnLine).forEach((x) => { (byForm[x.form] = byForm[x.form] || []).push(x.serial, maxSer(x)); });
    if (!rs.length) Object.entries(byForm).forEach(([k, ns]) => {
      const lo = Math.min(...ns), hi = Math.max(...ns); const miss = [];
      if (hi - lo < 5000) for (let n = lo; n <= hi; n++) if (!encoded[k].has(n)) miss.push([n, n]);
      if (miss.length) fig.issues.push(`Missing ${FORM_SHORT[k] || k} in the range: ${rangesText(mergeRanges(miss))}.`);
    });
    // ORs whose numbers are in no booklet of this officer (same form) in the Forms Register: never received, or a typing mistake.
    const outside = list.filter((x) => outOfBooklets(f, o, x) && !inBegRanges(begR, x));
    const byF = {}; outside.forEach((x) => { (byF[x.form] = byF[x.form] || []).push([+x.serial, maxSer(x)]); });
    Object.entries(byF).forEach(([k, rs]) => fig.issues.push(`${NIB}: ${FORM_SHORT[k] || k} ${rangesText(mergeRanges(rs))}. Add the booklet in Accountable Forms (Receive / Starting Inventory) or check the number.`));
    rem.forEach((m) => {
      const cr = m.reportId ? f.reports.find((r) => r.id === m.reportId) : null;
      if (cr && !quickColl(f, cr)) { fig.issues.push(`Remittance of ${esc(f.officers.find((x) => x.id === m.collectorId)?.name || 'a collector')} (${esc(repName(cr))}, ₱${money(m.amount)}): its collections are not yet encoded.`); return; }
      if (cr) { const cf = quickColl(f, cr); if (Math.abs(cf - (+m.amount || 0)) > 0.004) fig.issues.push(`Remittance of ${esc(f.officers.find((x) => x.id === m.collectorId)?.name || 'a collector')} (${esc(repName(cr))}) is ₱${money(m.amount)}; that report's collections are ₱${money(cf)}.`); }
    });
    // Each deposit / remittance with its own OR series: the ORs encoded in it (by form), those dated before the last cash exam,
    // and the numbers of the officer's booklets not encoded; the amount is checked against them.
    fig.serOf = new Map();
    (rec?.deposits || []).filter((d) => d.from).forEach((d) => {
      const a = +d.from, z = +(d.to || d.from); if (!(a > 0) || z < a || z - a > 5000) return;
      const ins = ors.filter((x) => x.status !== 'cancelled' && +x.serial >= a && maxSer(x) <= z);
      const tot = r2(ins.reduce((n, x) => n + rawAmt(x), 0)), ctc = r2(ins.filter((x) => isCtc(x.form)).reduce((n, x) => n + rawAmt(x), 0)), beg = r2(ins.filter((x) => x.beg).reduce((n, x) => n + rawAmt(x), 0));
      const mineBk = f.booklets.filter((b) => b.officerId === o.id && !b.noSerial && b.from <= z && b.to >= a);
      const miss = []; for (let n = a; n <= z; n++) if (mineBk.some((b) => b.from <= n && n <= b.to && !(encoded[b.form] && encoded[b.form].has(n)))) miss.push([n, n]);
      const info = { a, z, tot, ctc, af: r2(tot - ctc), beg, miss: mergeRanges(miss), ok: Math.abs(tot - (+d.amount || 0)) <= 0.004 };
      fig.serOf.set(d, info);
      if (!info.ok && (tot > 0.004 || miss.length) && !(rec.madeFrom && !list.length)) fig.issues.push(`Series ${a}–${z}: ₱${money(d.amount)} ${d.toLO ? 'remitted' : 'deposited'} on ${fmtDate(d.date)}; ORs encoded in it ₱${money(tot)}${beg ? ` (₱${money(beg)} of them dated before the last cash exam)` : ''}${miss.length ? `; not encoded: ${rangesText(info.miss)}` : ''}.`);
    });
    if (fig.end < -0.004 && !(rec?.madeFrom && !list.length)) fig.issues.push(`Deposits are more than the undeposited balance and the collections.${(rec?.deposits || []).some((d) => !d.from && !d.fromLO) ? " A deposit may have been made before its ORs were issued: type the deposit's OR series so it goes with its ORs." : ''}`);
    out[id] = fig;
    return fig;
  };
  const chains = {};
  const keys = kinds.flatMap((kind) => allFunds.map((fund) => ({ key: `${kind}|${fund}`, kind, fund })));
  keys.forEach(({ key, kind, fund }) => {
    const list = reals.filter((r) => r.fund === fund && (kinds.includes(r.kind) ? r.kind : kinds[0]) === kind).sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.no).localeCompare(String(b.no), undefined, { numeric: true }));
    let beg = null;
    const pid = pendId(o.id, kind, fund); const prec = f.reports.find((r) => r.id === pid) || null;
    const pendOrs = ors.filter((x) => !x.reportId && (x.fund || allFunds[0]) === fund && kindOfForm(lgu, x.form) === kind);
    const op = opening(list[0] || prec, kind, fund);
    // The Audit Setup beginning goes to the reports holding its ORs (Before the period), up to their face amount, in order;
    // what is left (no beginning OR encoded yet) to the first report.
    const add = {};
    if (op.setup) {
      const faceBeg = (xs) => r2(xs.filter((x) => isBeg(x) && x.status !== 'cancelled').reduce((n, x) => n + r2((x.items || []).reduce((t, i) => t + (+i.amt || 0), 0)), 0));
      let left = op.v;
      [...list.map((r) => ({ id: r.id, raw: faceBeg(ors.filter((x) => x.reportId === r.id)) })), { id: pid, raw: faceBeg(pendOrs) }].forEach(({ id, raw }) => { const a = r2(Math.min(left, raw)); if (a > 0.004) { add[id] = a; left = r2(left - a); } });
      if (left > 0.004) { const fid = list[0] ? list[0].id : pid; add[fid] = r2((add[fid] || 0) + left); }
    }
    const start = op.setup ? 0 : op.v, serTxt = begSer(kind);
    // Lines from the other side placed in this chain's reports. LO: each collector's remittance in the LO's report that has it
    // ticked (colIn); else not yet in a report. Collector:
    // each line typed by the LO in its own report (reportId), else not yet in a report.
    const myColAll = kind === kinds[0] ? colLines.filter((m) => (m.fund || allFunds[0]) === fund) : [];
    // A line already in a report of the previous exam (ticked there, or typed in it) stays with that exam: not shown here.
    const colTgt = (m) => { const inc = list.find((r) => (r.colIn || []).includes(m.key)); return inc ? inc.id : oldReps.some((r) => (r.colIn || []).includes(m.key)) ? null : pid; };   // only where ticked
    const myLoAll = loLines.filter((m) => loKind(m) === kind && ((reals.find((r) => r.id === m.reportId)?.fund) || m.fund || allFunds[0]) === fund);
    const loTgt = (m) => (list.some((r) => r.id === m.reportId) ? m.reportId : oldIds.has(m.reportId) ? null : pid);
    const withSide = (r) => { const c0 = clean(r); const ds = myLoAll.filter((m) => loTgt(m) === r.id), rs = myColAll.filter((m) => colTgt(m) === r.id);
      return ds.length || rs.length ? { ...c0, deposits: [...c0.deposits, ...ds].sort((a, b) => String(a.date).localeCompare(String(b.date))), remittances: [...c0.remittances, ...rs].sort((a, b) => String(a.date).localeCompare(String(b.date))) } : c0; };
    const figs = list.map((r, i) => { const fg = build(r.id, withSide(r), ors.filter((x) => x.reportId === r.id), i === 0 ? start : beg, add[r.id] || 0); if (fg.begAdd) fg.begSer = serTxt; if (i === 0) markOpening(fg, op); beg = fg.end; return fg; });
    const pr0 = prec ? { ...clean(prec), pending: true } : { pending: true, kind, fund, deposits: [], remittances: [] };
    const myLo = myLoAll.filter((m) => loTgt(m) === pid);
    if (myLo.length) pr0.deposits = [...(pr0.deposits || []), ...myLo].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const myCol = myColAll.filter((m) => colTgt(m) === pid);
    if (myCol.length) pr0.remittances = [...(pr0.remittances || []), ...myCol].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const pend = build(pid, pr0, pendOrs, figs.length ? beg : start, add[pid] || 0); if (pend.begAdd) pend.begSer = serTxt;
    pend.pending = true; pend.fund = fund; pend.kind = kind;
    figs.forEach((g) => { g.kind = kind; g.fund = fund; });
    chains[key] = { key, kind, fund, figs, pend };
  });
  return { chains, byId: out, funds: allFunds, keys: keys.map((k) => k.key), kinds };
}
const quickColl = (f, r) => r2(f.ors.filter((x) => x.reportId === r.id && x.status !== 'cancelled').reduce((n, x) => n + orAmount(x), 0) + sum(r.remittances || [], 'amount'));

// Days with the LO: each remittance (and the LO's own collections of a day) is covered by the deposits in date order.
function loDays(f, o, chains, countDate) {
  const items = [], deps = [];
  Object.values(chains).forEach(({ figs, pend }) => [...figs, pend].forEach((fg) => {
    (fg.rec?.remittances || []).forEach((m) => items.push({ date: m.date, from: f.officers.find((x) => x.id === m.collectorId)?.name || '', no: String(m.colNo || m.reportNo || (m.reportId ? f.reports.find((r) => r.id === m.reportId)?.no : '') || '').replace(/^\s*(SCR|RCD|SCD)\s*(No\.?)?\s*/i, '').trim(), amount: +m.amount || 0, fund: fg.rec?.fund || fg.fund,
      m, repId: fg.id, pending: !!fg.pending, noOnly: true, repName: fg.pending ? '' : (fg.rec?.no ? `RCD ${fg.rec.no}` : 'RCD') }));
    const own = {}; fg.ors.filter((x) => x.status !== 'cancelled').forEach((x) => { own[x.date] = r2((own[x.date] || 0) + orAmount(x)); });
    Object.entries(own).forEach(([d, a]) => items.push({ date: d, from: 'Own collections (ORs)', no: '', amount: a, own: true, fund: fg.rec?.fund || fg.fund, repId: fg.id }));
    (fg.rec?.deposits || []).forEach((d) => deps.push({ ...d, amount: +d.amount || 0, fund: fg.rec?.fund || fg.fund, repId: fg.id }));
  }));
  const out = [];
  // Each RCD's deposits cover that RCD's remittances (in date order); a remittance its RCD has not deposited stays undeposited.
  [...new Set(items.map((x) => x.repId))].forEach((rid) => {
    const its = items.filter((x) => x.repId === rid).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const ds = deps.filter((x) => x.repId === rid).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    let di = 0, left = ds[0] ? ds[0].amount : 0;
    its.forEach((it) => {
      let need = it.amount, dep = null;
      while (need > 0.004 && di < ds.length) { const take = Math.min(need, left); need = r2(need - take); left = r2(left - take); dep = ds[di]; if (left <= 0.004) { di++; left = ds[di] ? ds[di].amount : 0; } }
      // Which slip covered which remittance is not known: only whether it is deposited, and the date (the RCD's deposit date;
      // several dates: the last one, so the days with the LO are never understated).
      const lastD = ds.length ? ds[ds.length - 1].date : '';
      out.push({ ...it, depDate: need > 0.004 ? '' : lastD || dep?.date || '', days: it.date ? Math.max(0, days(it.date, need > 0.004 ? countDate : lastD || dep?.date || it.date)) : null, undeposited: need > 0.004 });
    });
  });
  return out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/* ---------- screen ---------- */
export async function collectionsView(ctx) {
  const { refs, q } = ctx;
  const f = await loadForms();
  f.reports = tagSameDay((await store.list('cer_reports')).map(flat));
  BKS = f.booklets;
  const crumb = 'Collections & Deposits';
  const hello = (extra = '') => `<div class="hello"><div><h1>Collections &amp; Deposits</h1><p>Encode each OR as printed on the receipt in hand, then the deposits. Barangays file an SCD (Summary of Collections and Deposits) for AF 51 and an SCR (Summary of Collections and Remittances) for CTC remitted to the MTO; the LGU and PLGU file an RCD (Report of Collections and Deposits).</p></div>${extra}</div>`;
  const audits = f.audits.filter((a) => mayView(refs, refs.lgu[a.lguId]) && (cycleOk(a) || a.id === q.get('a'))).sort((a, b) => String(b.countDate).localeCompare(String(a.countDate)));
  if (!audits.length) return { crumb, body: hello() + '<div class="panel"><div class="empty"><b>No cash examination yet.</b>The auditors set one up in Audit Setup; its accountable officers are listed here.</div></div>' };
  const audit = pickAudit(audits, q);
  const lgu = refs.lgu[audit.lguId];
  const exams = f.exams.filter((e) => e.auditId === audit.id).map((e) => ({ ...e, o: f.officers.find((x) => x.id === e.officerId) })).filter((e) => e.o);
  const exam = pickExam(exams, q, audit) || exams[0] || null; remember(refs, audit, exam);
  const topBar = (extra = '', open = false) => `<div class="panel ${open ? 'cd-head' : 'cd-bar'}">${open ? '<div class="cd-headrow">' : ''}
      <div class="field"><label for="cd-audit">Cash Examination</label><select class="input" id="cd-audit">${audits.map((a) => `<option value="${esc(a.id)}" ${a.id === audit.id ? 'selected' : ''}>${esc(agencyName(refs, refs.lgu[a.lguId]))} · ${esc(fmtDate(a.countDate))}</option>`).join('')}</select></div>
      <div class="field"><label for="cd-exam">Accountable Officer</label><select class="input" id="cd-exam">${exams.length ? exams.map((e) => `<option value="${esc(e.id)}" ${exam && e.id === exam.id ? 'selected' : ''}>${esc(e.o.name)}${e.o.designation ? ' · ' + esc(e.o.designation) : ''}</option>`).join('') : '<option value="">No officer in this examination</option>'}</select></div>
      ${extra}${open ? '</div>' : '</div>'}`;
  const wireTop = () => {
    $('#cd-audit').onchange = (e) => go({ a: e.target.value, e: '', r: '', show: '' });
    $('#cd-exam').onchange = (e) => go({ e: e.target.value, r: '', show: '' });
    const kp = $('#cd-kind'); if (kp) kp.onchange = (e) => go({ k: e.target.value, r: '' });
  };
  if (!exam) return { crumb, body: hello() + topBar() + '<div class="panel"><div class="empty"><b>No accountable officer in this cash examination.</b>Add the officers in Audit Setup.</div></div>', wire: wireTop };

  const o = exam.o;
  const funds = fundsOf(f, audit.lguId);
  let fig = figuresOf(f, o, funds, audit.countDate, lgu, exam);
  // Records dated on or before a submitted report go into it (e.g. ORs encoded after the SCD was added).
  if (canEncode(refs) && misplaced(fig)) { await sweepChains(f, fig, refs); return collectionsView(ctx); }
  const isLO = (exam.functions || []).includes('liquidating');
  const allForms = [...new Set([...((exam.forms || []).length ? exam.forms : f.ors.filter((x) => x.officerId === o.id).map((x) => x.form)), ...(f.booklets.some((b) => b.officerId === o.id && b.form === 'cashbn') ? ['cashbn'] : [])].map((k) => fixBrgyForm(lgu, k)))];
  // Report types in use for this officer: from the forms ticked in Audit Setup, plus any already encoded.
  const active = (c) => c.figs.length || c.pend.nOrs || c.pend.dep || c.pend.remTotal || c.pend.beg;
  const usedKinds = fig.kinds.filter((k) => allForms.some((x) => kindOfForm(lgu, x) === k) || Object.values(fig.chains).some((c) => c.kind === k && active(c)));
  if (!usedKinds.length) usedKinds.push(fig.kinds[0]);
  // One report type at a time (chosen at the top): SCD / RCD with deposits, or SCR with remittances.
  const allKinds = usedKinds.slice();
  const qRep = q.get('r') && fig.byId[q.get('r')];
  const VK = allKinds.includes(q.get('k')) ? q.get('k') : qRep && allKinds.includes(qRep.kind) ? qRep.kind : allKinds.includes(KSEL[o.id]) ? KSEL[o.id] : allKinds[0];
  KSEL[o.id] = VK;
  usedKinds.splice(0, usedKinds.length, VK);
  const kindPick = allKinds.length > 1 ? `<div class="field"><label for="cd-kind">Report</label><select class="input" id="cd-kind">${allKinds.map((k) => `<option value="${k}" ${k === VK ? 'selected' : ''}>${esc(KIND_PICK[k] || k)}</option>`).join('')}</select></div>` : '';
  // "Not yet reported" of the first fund of each report type, plus any other fund already in use (the rest come with + SCD / + RCD).
  const shownKeys = fig.keys.filter((k) => usedKinds.includes(fig.chains[k].kind) && (fig.chains[k].fund === fig.funds[0] || active(fig.chains[k]) || k === q.get('r')?.split('|').slice(2).join('|')));
  const enc = canEncode(refs);
  // The report being worked on: a submitted one, or "Not yet reported" of a fund.
  const realIds = Object.values(fig.chains).flatMap((c) => c.figs.map((g) => g.id));
  let selId = q.get('r');
  if (!selId || !fig.byId[selId] || fig.byId[selId].kind !== VK) selId = fig.chains[shownKeys[0]].pend.id;
  const cur = fig.byId[selId];
  const curFund = cur.fund;
  const K = cur.kind;
  const curKey = `${K}|${curFund}`;
  const KS0 = usedKinds.join(' / ');
  const isRem = K === 'SCR';
  const forms = allForms.filter((x) => kindOfForm(lgu, x) === K);
  const isFirst = (() => { const c = fig.chains[curKey]; return cur.pending ? !c.figs.length : c.figs[0]?.id === selId; })();
  const label = (g) => (g.pending ? `Not yet reported · ${usedKinds.length > 1 ? g.kind + ' · ' : ''}${g.fund}` : `${repName(g.rec, g.kind)}${g.rec.no ? ' · ' + fmtDate(g.rec.date) : ''} · ${g.rec.fund}`);
  const repOpts = [
    ...shownKeys.map((key) => { const g = fig.chains[key].pend; return `<option value="${esc(g.id)}" ${g.id === selId ? 'selected' : ''}>${esc(label(g))}${g.nOrs ? ` (${g.nOrs} OR${g.nOrs > 1 ? 's' : ''})` : ''}</option>`; }),
    realIds.length ? `<optgroup label="Submitted ${usedKinds.join(' / ')}">${realIds.map((id) => fig.byId[id]).sort((a, b) => String(b.rec.date).localeCompare(String(a.rec.date))).map((g) => `<option value="${esc(g.id)}" ${g.id === selId ? 'selected' : ''}>${esc(label(g))}</option>`).join('')}</optgroup>` : ''].join('');
  // Parts 1–3 as tabs in one row: the chosen part shows below; the summary under them always stays.
  const tabs = (list) => { const on = list.find(([k]) => OPEN[k])?.[0] || 'col';
    return `<div class="cd-tabs" role="tablist">${list.map(([k, t, sub], i) => `<button type="button" role="tab" class="cd-tab ${k === on ? 'on' : ''}" data-tab="${k}" aria-selected="${k === on}" aria-controls="cd-pane-${k}"><span class="cd-num">${i + 1}</span><span class="cd-tabt"><b>${t}</b><span class="cd-sub">${sub}</span></span></button>`).join('')}</div></div>
      ${list.map(([k, , , inner]) => `<section class="panel cd-pane" id="cd-pane-${k}" role="tabpanel" ${k === on ? '' : 'hidden'}><div class="cd-body">${inner}</div></section>`).join('')}`; };
  const acc = (key, title, sub, inner) => `<details class="panel cd-acc" data-acc="${key}" ${OPEN[key] ? 'open' : ''}><summary><span class="cd-num">${{ rep: 1, col: 2, dep: 3 }[key]}</span><b>${title}</b><span class="cd-sub">${sub}</span></summary><div class="cd-body">${inner}</div></details>`;

  /* ----- 1 · SCD / RCD ----- */
  const ro = (lbl, val, cls = '') => `<div class="field"><span class="cd-lbl">${lbl}</span><div class="input cd-ro ${cls}">${val || '<span class="dim">—</span>'}</div></div>`;
  const collectors = collectorsOf(f, o, audit, refs);
  const remRow = (m = {}) => `<tr class="cd-rem"><td><input class="input" type="date" data-k="date" value="${esc(m.date || '')}" aria-label="Date received" ${enc ? '' : 'disabled'}></td>
      <td><select class="input" data-k="collectorId" aria-label="From collector" ${enc ? '' : 'disabled'}><option value="">— Collector —</option>${colOpts(collectors, m.collectorId)}</select></td>
      <td><input class="input mono" data-k="reportNo" list="cd-crlist" value="${esc(m.reportNo || '')}" aria-label="Collector's RCD No." ${enc ? '' : 'disabled'}></td>
      <td><input class="input mono" data-k="from" inputmode="numeric" value="${esc(m.from || '')}" aria-label="OR From" ${enc ? '' : 'disabled'}></td><td><input class="input mono" data-k="to" inputmode="numeric" value="${esc(m.to || '')}" aria-label="OR To" ${enc ? '' : 'disabled'}></td>
      <td><input class="input r" data-k="amount" inputmode="decimal" value="${m.amount !== undefined && m.amount !== '' ? esc(money(m.amount)) : ''}" aria-label="Amount" ${enc ? '' : 'disabled'}>${m.beg ? '<br><span class="pill p-beg">Before the period</span>' : ''}</td>
      <td>${m.collectorId ? remCheck(f, m) : ''}</td>
      <td>${enc ? '<button class="btn sm cd-x" type="button" aria-label="Remove remittance">✕</button>' : ''}</td></tr>`;
  // The collectors' remittances (from their SCR / RCD): those in this report, ticked; those not yet in any of the LO's reports, to tick.
  const colIn = (cur.rec?.remittances || []).filter((m) => m.fromCol);
  const colFree = cur.pending ? [] : (fig.chains[curKey]?.pend.rec?.remittances || []).filter((m) => m.fromCol);
  // Typed remittances (a collector whose SCR / RCD is not in the app): one entry line, then the list (Edit / ✕); saved on Add.
  const typed = (cur.rec?.remittances || []).filter((m) => !m.fromCol);
  const allIn = (cur.rec?.remittances || []).filter((m) => !m.beg);
  const inTot = r2(allIn.reduce((n, m) => n + (+m.amount || 0), 0));
  const hardT = !cur.pending && cur.rec.hardTotal !== null && cur.rec.hardTotal !== undefined && cur.rec.hardTotal !== '' ? +cur.rec.hardTotal : null;
  const progress = hardT === null ? '' : Math.abs(hardT - inTot) < 0.005 ? `<span class="pill p-done">Hard copy ₱${money(hardT)} · entered ₱${money(inTot)} · agrees</span>`
    : `<span class="pill p-flag">Hard copy ₱${money(hardT)} · entered ₱${money(inTot)} · ₱${money(Math.abs(r2(hardT - inTot)))} ${hardT > inTot ? 'to go' : 'more than the hard copy'}</span>`;
  const colLabel = (x) => `${x.name}${x.designation ? ' · ' + x.designation : ''}${x.office ? ' · ' + x.office : ''}`;
  // Edit opens the whole report (all its series) in the entry line.
  const edGrp = REM.key === selId && REM.i >= 0 ? remGroups(typed).find((g) => g.some((x) => x.i === REM.i)) || null : null;
  const ed = edGrp ? edGrp[0].m : null;
  // The LO's Collections tab: choose Type (a collector's report not in the app) or Tick (one already in the app), then
  // one list of this RCD: typed reports with their series and ticked ones (In the app), in report-number order.
  const mode = cur.pending ? 'type' : REM.mode;
  // A collector's remittance from the app, shown like a typed one: its form (from the booklet its first number is in) and series.
  // A remittance of the whole report (no series of its own): each OR range of the report on its own line, with its form.
  const tickSerHtml = (m) => (m.serList && m.serList.length > 1 ? m.serList.map(([a, z, fk]) => esc(tickSer({ ...m, from: String(a), to: String(z), series: a === z ? `${a}` : `${a}–${z}`, form: fk || m.form, serList: null }))).join('<br>') : esc(tickSer(m)));
  const tickSer = (m) => { if (m.serList && m.serList.length === 1) { const [a, z, fk] = m.serList[0]; m = { ...m, from: String(a), to: String(z), series: a === z ? `${a}` : `${a}–${z}`, form: fk || m.form, serList: null }; }
    const n = +String(m.from || '').replace(/\D/g, ''), bk = n ? f.booklets.find((x) => !x.noSerial && x.form !== 'chk' && x.from <= n && n <= x.to) : null;
    const fk = m.form || (bk && bk.form) || '', rg = m.series || (m.from ? `${m.from}–${m.to}` : '—');
    return fk ? `${remFormName(fk)} · ${rg}` : rg; };
  // Waiting list: by date received, then by OR series; a search box narrows it (collector, report No., an OR number in the range, amount, date).
  const serOf = (m) => { const t = String(m.series || (m.from ? `${m.from}-${m.to}` : '')); const out = []; t.replace(/(\d+)\s*[–-]\s*(\d+)|(\d+)/g, (_, a, z, one) => { out.push(one ? [+one, +one] : [+a, +z]); return ''; }); return out; };
  const firstSer = (m) => { const r = serOf(m); return r.length ? Math.min(...r.map((x) => x[0])) : Infinity; };
  // Same date: by the SCR / RCD No. when both have one, else by the OR series.
  const repNo = (m) => String(m.colNo || String(m.reportNo || '').replace(/^\s*(SCR|RCD)\s*(No\.)?\s*/i, '')).trim();
  // The collector's SCR / RCD No., editable here (saved on the collector's report itself).
  // Their Report shows the number only (2026-0442); none yet: the report type (SCR / RCD).
  const shortNo = (m) => { const t = String(m.reportNo || '').trim(); const n = t.replace(/^\s*(SCR|RCD|SCD)\s*(No\.?)?\s*/i, '').trim(); return n || (t.match(/^(SCR|RCD|SCD)/i)?.[0].toUpperCase() || t); };
  const noCell = (m) => (enc && m.colReportId ? `<span class="rm-noedit" data-noedit="${esc(m.colReportId)}" data-cur="${esc(m.colNo || '')}" data-ndate="${esc(m.date || '')}" data-namt="${esc(String(m.amount ?? ''))}" data-nfrom="${esc(m.from || '')}" data-nto="${esc(m.to || '')}" tabindex="0" role="button" title="Click to type or change the ${esc(String(m.reportNo || 'SCR').split(' ')[0])} No.">${esc(shortNo(m))}</span>` : esc(shortNo(m)));
  const freeSorted = colFree.slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))
    || (repNo(a) && repNo(b) ? repNo(a).localeCompare(repNo(b), undefined, { numeric: true }) : 0) || firstSer(a) - firstSer(b));
  const tickTbl = !colFree.length ? '<p class="dim" style="margin:6px 0">No collector\'s SCR / RCD in the app is waiting to be put in an RCD.</p>'
    : `<div class="rm-findrow"><label class="sr-only" for="rm-find">Search the waiting remittances</label><input class="input" id="rm-find" type="search" placeholder="Search: collector, report No., OR No., amount or date" value="${esc(REM.find)}" autocomplete="off"><span class="dim" id="rm-findn"></span></div>
      <div class="af-tbl cd-tblbox"><table class="af-reg"><thead><tr><th style="width:30px"></th><th>Date received</th><th>Collector</th><th>Their report</th><th>OR range</th><th class="r">Amount (₱)</th><th>Check of the collections</th></tr></thead>
      <tbody>${freeSorted.map((m) => `<tr data-rmq="${esc([fmtDate(m.date), colName(f, refs, m.collectorId), m.reportNo || '', m.series || '', money(m.amount), String(m.amount ?? '')].join(' ').toLowerCase())}" data-rmrg="${esc(serOf(m).map(([a, z]) => a + '-' + z).join(';'))}"><td><input type="checkbox" data-colk="${esc(m.key)}" ${enc ? '' : 'disabled'} aria-label="Put in this RCD"></td><td>${esc(fmtDate(m.date))}${m.beg ? ' <span class="pill p-beg">Before the period</span>' : ''}</td><td>${esc(colName(f, refs, m.collectorId))}</td><td>${noCell(m)}</td><td class="mono">${tickSerHtml(m)}</td><td class="r">${money(m.amount)}</td><td>${remCheck(f, m)}</td></tr>`).join('')}</tbody></table></div>
      <p class="dim" style="margin:4px 0 0;font-size:12.5px">Tick those listed on the hard copy of this RCD: they move to the list below.</p>`;
  const typeLine = !enc ? '' : `<div class="rm-line" id="rm-form">
        <div class="field"><label for="rm-date">Date received</label><input class="input" type="date" id="rm-date" value="${esc(ed ? ed.date : REM.date || '')}"></div>
        <div class="field rm-col"><label for="rm-col">Collector</label><input class="input" id="rm-col" list="rm-cols" autocomplete="off" placeholder="Type part of the name" value="${esc(ed ? colLabel(collectors.find((x) => x.id === ed.collectorId) || { name: '' }) : '')}">
          <datalist id="rm-cols">${collectors.map((x) => `<option value="${esc(colLabel(x))}">`).join('')}</datalist></div>
        <div class="field"><label for="rm-no">Their SCR / RCD No.</label><input class="input mono" id="rm-no" autocomplete="off" value="${esc(ed ? ed.reportNo || '' : '')}"></div>
        <div class="rm-sers"><div class="rm-shead"><label>Form</label><label>OR From</label><label>OR To</label><label class="r" title="Cash tickets: number of pieces">Pcs</label><label class="r">Amount</label><span></span></div>
          <div id="rm-srows">${(edGrp ? edGrp.map((x) => x.m) : [null]).map(serRow).join('')}</div>
          <div class="rm-sfoot"><a href="#" class="cd-link" id="rm-addser">+ Series</a><span class="dim">same report</span><span id="rm-tot"></span></div></div>
        <div class="field rm-addbox"><button class="btn primary" type="button" id="rm-add">${ed ? 'Save' : 'Add'}</button>${ed ? ' <button class="btn sm" type="button" id="rm-cancel">Cancel</button>' : ''}</div>
      </div><div id="rm-nomsg" class="rm-nomsg"></div>
      <div class="cd-actions" style="justify-content:flex-start;margin-top:6px"><button class="btn sm" type="button" id="rm-imp">Import from Excel</button><a href="#" class="cd-link" id="rm-tpl">Template</a></div>`;
  // One list: typed groups and ticked reports, by report number.
  const nat = (m) => String(m.reportNo || '').replace(/^[^0-9]*/, '').replace(/\d+/g, (d) => d.padStart(12, '0')).toUpperCase();   // "SCR No. 2026-0189" as 2026-0189
  // Ticked remittances of the same collector's report together (one row per series, like the typed ones).
  const tickGrps = []; colIn.forEach((m) => { const k = `${m.collectorId}|${m.colReportId || m.reportNo}`; const g = tickGrps.find((x) => x.k === k); if (g) g.list.push(m); else tickGrps.push({ k, list: [m] }); });
  tickGrps.forEach((g) => g.list.sort((a, b) => String(a.date).localeCompare(String(b.date)) || (+a.from || 0) - (+b.from || 0)));
  const items = [...remGroups(typed).map((grp) => ({ grp })), ...tickGrps.map((g) => ({ tick: g.list }))]
    .sort((a, b) => { const x = a.grp ? a.grp[0].m : a.tick[0], y = b.grp ? b.grp[0].m : b.tick[0]; return (x.reportNo ? 0 : 1) - (y.reportNo ? 0 : 1) || nat(x).localeCompare(nat(y)) || String(x.date).localeCompare(String(y.date)); });
  const listRows = items.map((it, gi) => {
    if (it.tick) { const tl = it.tick, m0 = tl[0];
      // One line per series. A remittance of the whole report (one amount): one line per OR range of the report, each with the
      // collections encoded in it; the remittance's amount is the sub-total.
      const lines = tl.flatMap((m) => (m.serList && m.serList.length > 1 ? m.serList.map(([a, z, fk], j) => ({ m, j, n: m.serList.length,
        ser: tickSer({ ...m, from: String(a), to: String(z), series: a === z ? `${a}` : `${a}–${z}`, form: fk || m.form, serList: null }),
        amt: r2(f.ors.filter((x) => x.officerId === m.collectorId && x.status !== 'cancelled' && +x.serial >= a && maxSer(x) <= z).reduce((t, x) => t + rawAmt(x), 0)) }))
        : [{ m, j: 0, n: 1, ser: tickSer(m), amt: +m.amount || 0, own: true }]));
      return lines.map((l, k) => `<tr class="${k ? 'rm-ser' : 'rm-first'}"><td>${k ? '' : gi + 1}</td><td>${!k || l.m.date !== m0.date && !l.j ? esc(fmtDate(l.m.date)) : ''}${l.m.beg && !l.j ? ' <span class="pill p-beg">Before the period</span>' : ''}</td><td>${k ? '' : esc(colName(f, refs, l.m.collectorId))}</td><td>${k ? '' : `${noCell(l.m)} <span class="pill p-part">In the app</span>`}</td><td class="mono">${esc(l.ser)}</td><td class="r">${l.own || l.amt ? money(l.amt) : '<span class="dim">—</span>'}</td><td>${l.j ? '' : remCheck(f, l.m)}</td>${enc ? `<td class="rm-act">${l.j ? '' : `<button class="btn sm" type="button" data-colrm="${esc(l.m.key)}" title="Take it out of this RCD (the collector's report stays)">Remove</button>`}</td>` : ''}</tr>`).join('')
        + (lines.length > 1 ? `<tr class="rm-sub"><td></td><td></td><td></td><td></td><td><b>${lines.length} series</b></td><td class="r"><b>${money(r2(tl.reduce((n, x) => n + (+x.amount || 0), 0)))}</b></td><td></td>${enc ? '<td></td>' : ''}</tr>` : ''); }
    const grp = it.grp;
    return grp.map(({ m, i }, k) => `<tr class="${edGrp && edGrp.some((x) => x.i === i) ? 'cd-on' : ''} ${k ? 'rm-ser' : 'rm-first'}"><td>${k ? '' : gi + 1}</td><td>${!k || m.date !== grp[0].m.date ? esc(fmtDate(m.date)) : ''}${m.beg ? ' <span class="pill p-beg">Before the period</span>' : ''}</td><td>${k ? '' : esc(colName(f, refs, m.collectorId))}</td><td>${k ? '' : esc(m.reportNo || '')}</td><td class="mono">${esc(serText(m))}</td><td class="r">${money(m.amount)}</td><td>${remCheck(f, m)}</td>${enc ? `<td class="rm-act">${k ? '' : `<button class="btn sm" type="button" data-rmedit="${i}">Edit</button> `}<button class="btn sm" type="button" data-rmdel="${i}" aria-label="Remove${grp.length > 1 ? ' this series' : ''}" title="${grp.length > 1 ? 'Remove this series' : 'Remove'}">✕</button></td>` : ''}</tr>`).join('')
      + (grp.length > 1 ? `<tr class="rm-sub"><td></td><td></td><td></td><td></td><td><b>${grp.length} series</b></td><td class="r"><b>${money(r2(grp.reduce((n, x) => n + (+x.m.amount || 0), 0)))}</b></td><td></td>${enc ? '<td></td>' : ''}</tr>` : '');
  }).join('');
  const remBlock = isLO ? `<div class="cd-block"><div class="cd-orhead"><h3 class="cer-h3">Remittances from the collectors <small class="dim">(the collections of ${cur.pending ? 'this Liquidating Officer' : `this ${K}`})</small></h3>${progress}</div>
      ${enc || colFree.length ? `<div class="seg rm-mode" role="group" aria-label="How to enter"><a href="#" data-rmmode="type" class="${mode === 'type' ? 'on' : ''}">Type a remittance <small>(not in the app)</small></a><a href="#" data-rmmode="tick" class="${mode === 'tick' ? 'on' : ''}">Tick from the app <small>· ${colFree.length} waiting</small></a></div>` : ''}
      <div class="rm-pane">${mode === 'tick' ? (cur.pending ? '<p class="dim">Add or choose the RCD first (tab 1), then tick its remittances here.</p>' : tickTbl) : typeLine}</div>
      ${items.length ? `<h3 class="cer-h3" style="margin-top:14px">${cur.pending ? 'Remittances not yet in an RCD' : `In this ${K}`} <small class="dim">(${items.length} report${items.length === 1 ? '' : 's'})</small></h3>
        <div class="af-tbl cd-tblbox"><table class="af-reg rm-tbl"><thead><tr><th>#</th><th>Date received</th><th>Collector</th><th>Their report</th><th>OR range</th><th class="r">Amount (₱)</th><th>Check</th>${enc ? '<th></th>' : ''}</tr></thead>
        <tbody>${listRows}</tbody>
        <tfoot><tr class="cd-foot"><td colspan="5">Total remittances received${cur.pending ? '' : ' in this RCD'}</td><td class="r">${money(inTot)}</td><td colspan="${enc ? 2 : 1}"></td></tr></tfoot></table></div>` : ''}
      <p class="af-note">Each remittance is encoded once: typed when the collector's SCR / RCD is not in the app, ticked when it is. The check compares the collector's ORs in the range with the amount. A remittance dated before the last cash exam is in the beginning balance.</p></div>` : '';
  // SCD tab: the entry line on top (a new report, or the selected one to edit), a notice of records not yet in a report,
  // then the table of the officer's submitted reports (click a row to select it).
  const realFigs = fig.keys.filter((k) => usedKinds.includes(fig.chains[k].kind)).flatMap((k) => fig.chains[k].figs).sort(byRepNo);
  const pends = fig.keys.map((k) => fig.chains[k]).filter((ch) => usedKinds.includes(ch.kind) && (ch.pend.nOrs || ch.pend.dep || ch.pend.remTotal));
  const notice = pends.map((ch) => { const p = ch.pend, last = ch.figs[ch.figs.length - 1];
    const what = [p.nOrs ? `${p.nOrs} OR${p.nOrs > 1 ? 's' : ''} (₱ ${money(p.orsTotal)})` : '', p.dep ? `₱ ${money(p.dep)} ${ch.kind === 'SCR' ? 'remitted' : 'deposits'}` : '', p.remTotal ? `₱ ${money(p.remTotal)} remittances received` : ''].filter(Boolean).join(' and ');
    return `<div>${what} of ${esc(ch.fund)}${!last ? '' : ch.figs.some(hasRange) ? ` outside the OR ranges of the ${ch.kind}s encoded` : ` dated after ${esc(fmtDate(last.rec.date))}`} ${p.nOrs + (p.rec?.deposits || []).length > 1 ? 'are not yet in an ' + ch.kind + '. They go' : 'is not yet in an ' + ch.kind + '. It goes'} into the next ${ch.kind} when you add it.</div>`; }).join('');
  const isNew = cur.pending;
  // A report with a series not matching its ORs, or ORs outside the received booklets: flagged in the list (details under its summary).
  const chkPill = (g) => { const t = g.issues.filter((x) => x.startsWith('Series ') || x.startsWith(NIB)); return t.length ? ` <span class="pill p-flag" title="${esc(t.join('\n'))}">⚠ Check</span>` : ''; };
  // An LO without ORs of her own: the collectors' SCR / RCD covered by each of her RCDs, by their numbers (417–442), and how many.
  const pureLO = isLO && !forms.length;
  const covOf = (g) => coveredOf(f, refs, g.rec);
  const sumTable = (pick) => realFigs.length ? `<div class="af-tbl"><table class="af-reg cd-sumtbl"><thead><tr><th scope="col">${KS0}</th><th scope="col">Fund</th><th scope="col">Date</th><th scope="col">Period</th><th scope="col">${pureLO ? 'Covered SCR / RCD' : 'OR Range'}</th><th scope="col" class="r">${pureLO ? 'Reports' : 'ORs'}</th><th scope="col" class="r">Collections</th><th scope="col" class="r">${isRem ? 'Remitted' : 'Deposited'}</th><th scope="col" class="r">${isRem ? 'Unremitted' : 'Undeposited'}</th>${pick && enc ? '<th scope="col"></th>' : ''}</tr></thead>
      <tbody>${realFigs.map((g) => `<tr ${pick ? `data-pick="${esc(g.id)}" tabindex="0"` : ''} class="${g.id === selId ? 'cd-on' : ''}"><td><b>${esc(repName({ ...g.rec, sameDay: false, dupe: 0 }, g.kind))}</b>${chkPill(g)}${g.rec.madeFrom ? ` <span class="crumb-i" title="${esc(`From ${g.rec.madeFrom.name || 'the LO'}'s RCD${g.rec.madeFrom.no ? ' ' + g.rec.madeFrom.no : ''} (made from the Liquidating Officer's records)`)}" aria-label="From the Liquidating Officer's RCD">ⓘ</span>` : ''}${g.rec.madeFrom && !g.nOrs ? ` <span class="pill p-flag">Remitted ₱${money(g.dep)} · collections not yet encoded</span>` : ''}</td><td>${esc(g.rec.fund)}</td><td>${esc(fmtDate(g.rec.date))}</td>
        <td>${g.from ? esc(`${fmtDate(g.from)}–${fmtDate(g.to)}`) : '<span class="dim">—</span>'}</td>${pureLO ? (() => { const cv = covOf(g); return `<td class="cd-rng"><span class="cd-rngt" title="${esc(cv.title)}">${cv.text ? esc(cv.text) : '<span class="dim">—</span>'}</span></td><td class="r">${cv.n}</td>`; })() : `<td class="cd-rng">${hasRange(g) ? `<span class="cd-rngt" title="${esc(rangesShow({ ...g.rec, officerId: o.id }))}">${esc(rangesShow({ ...g.rec, officerId: o.id }))}</span> <small class="dim">· ${g.rangeIn} of ${g.rangeN}</small>${(() => { const t = (g.ors || []).some((x) => x.bnLine) ? rangeByForm(g.ors.filter((x) => x.bnLine)) : bnFromLO(f, g); return t ? `<br><span class="cd-rngt" title="${esc(t)}">${esc(t)}</span>` : ''; })()}` : (() => { const t = g.range.replace(/Accountable Form 51 – (Barangay|LGU) /g, 'AF 51 ') || (g.ors.some((x) => x.bnLine) ? '' : bnFromLO(f, g)), onlyBn = !!t && !(g.ors || []).some((x) => !x.bnLine) && /Booklet No\./.test(t); return `<span class="cd-rngt" title="${esc(t)}">${esc(t) || '—'}</span>${onlyBn ? '' : ' <small class="dim">· no range</small>'}`; })()}</td><td class="r">${orsText(g)}</td>`}
        <td class="r">${money(g.coll)}</td><td class="r">${money(g.dep)}</td><td class="r">${money(g.end)}</td>
${pick && enc ? `<td><button class="btn sm" type="button" data-editrep="${esc(g.id)}">Edit</button></td>` : ''}</tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="5">Total, all ${KS0}</td><td class="r">${pureLO ? realFigs.reduce((n, g) => n + covOf(g).n, 0) : orsText({ ors: realFigs.flatMap((g) => g.ors || []) })}</td><td class="r">${money(r2(realFigs.reduce((n, g) => n + g.coll, 0)))}</td><td class="r">${money(r2(realFigs.reduce((n, g) => n + g.dep, 0)))}</td><td></td>${pick && enc ? '<td></td>' : ''}</tr></tfoot></table></div>`
    : `<div class="empty"><b>No ${KS0} encoded for this officer yet.</b>${enc ? `Press + ${K} to enter one.` : ''}</div>`;
  const tip = `Each ${K} is entered once, from the hard copy. ORs, deposits${isLO ? ' and remittances' : ''} dated on or before an ${K}'s date go into it; those dated after the last ${K} wait for the next one. The ${isRem ? 'unremitted' : 'undeposited'} balance carries from one ${K} to the next of the same fund.${usedKinds.includes('SCR') ? ' The SCD is for AF 51 deposited in the bank; the SCR is for CTC remitted to the MTO.' : ''}`;
  const repBody = `<div class="cd-scdhead"><h3 class="cer-h3">${KS0} of this officer</h3><span class="crumb-i" title="${esc(tip)}">ⓘ</span>
      <span class="cd-scdbtns">${enc ? usedKinds.map((k) => `<button class="btn primary sm" type="button" data-newrep="${k}">+ ${k}</button>`).join('') : ''}<button class="btn sm" type="button" id="cd-funds">Funds (${funds.length})</button><button class="btn sm" type="button" id="cd-sumxls2">Export to Excel</button></span></div>
    ${sumTable(true)}`;

  /* ----- 2 · Collections ----- */
  const myBooklets = (form) => f.booklets.filter((b) => b.form === form && b.officerId === o.id && b.status !== 'lost' && !b.noSerial).sort((a, b) => a.from - b.from);
  const ckey = o.id + '|' + selId;
  const cbook = exam.records === 'cashbook', cbMode = cbook || f.ors.some((x) => x.officerId === o.id && x.range);
  if (LASTC.key !== ckey) Object.assign(LASTC, { key: ckey, form: '', bookletId: '', serial: '', focus: '', mode: cbook ? 'range' : 'one' });
  if (!cbMode) LASTC.mode = 'one';
  // An RCD with its OR Range: the entry line follows it. Per range: its form and the numbers not yet encoded; the OR No.
  // starts at the first of them (form and booklet set), and a number outside the range is stopped.
  const rMode = !cur.pending && hasRange(cur) && !cbMode && forms.length > 0;
  const rRec = rMode ? { ...cur.rec, officerId: o.id } : null;
  const rMiss = rMode ? cur.rec.ranges.map(([a, z], i) => { const fk = rangeFormAt(rRec, i) || forms[0];
    const used = new Set(f.ors.filter((x) => x.officerId === o.id && sameF(fk, x.form)).flatMap(serialsOf));
    const miss = []; if (z - a < 5000) for (let n = a; n <= z; n++) if (!used.has(n)) miss.push(n);
    return { a, z, fk: forms.find((k) => sameF(k, fk)) || fk, miss, n: z - a + 1 }; }) : [];
  rMiss.forEach((r) => { if (!forms.includes(r.fk)) forms.push(r.fk); });
  const firstMiss = rMiss.find((r) => r.miss.length);
  const holdBk = (fk, n) => f.booklets.find((b) => b.officerId === o.id && b.form === fk && !b.noSerial && b.from <= n && n <= b.to);
  if (rMode && firstMiss && (LASTC.serial === '' || LASTC.serial === undefined || LASTC.goMiss)) {
    const n = firstMiss.miss[0], b0 = holdBk(firstMiss.fk, n);
    Object.assign(LASTC, { form: firstMiss.fk, bookletId: b0 ? b0.id : '__none', serial: n, goMiss: false });
  }
  const rToGo = rMiss.reduce((t, r) => t + r.miss.length, 0), rDone = rMode && !rToGo;
  const rProg = rMode ? `<div class="cd-rprog"><span>${rMiss.map((r) => `${esc(remFormName(r.fk))} · ${r.a}–${r.z}: <b>${r.n - r.miss.length} of ${r.n}</b>`).join(' &nbsp;·&nbsp; ')}</span>
      ${rToGo ? `<a href="#" class="cd-link" id="cd-gomiss" title="${esc(rMiss.filter((r) => r.miss.length).map((r) => `${remFormName(r.fk)}: ${rangesText(mergeRanges(r.miss.map((n) => [n, n])))}`).join('\n'))}"><b>${rToGo} to go</b> · next ${firstMiss.miss[0]}</a>` : '<b class="ok-t">All ORs of the range encoded</b>'}</div>` : '';
  const form = forms.includes(LASTC.form) ? LASTC.form : forms[0] || '';
  // Only the booklets still in use (with unused numbers) are offered; a used-up booklet stays out of the list (its ORs remain
  // in the records). The booklet chosen last stays listed so the entry line keeps it.
  const bks = myBooklets(form).filter((b) => countRanges(bookletUnused(b)) > 0 || b.id === LASTC.bookletId);
  // Unused per the Forms Register: numbers used before the beginning (partly used) and ORs already encoded are both taken out.
  const unusedOfBk = (b) => countRanges(bookletUnused(b));
  const bk = LASTC.bookletId === '__none' ? null : bks.find((b) => b.id === LASTC.bookletId) || bks.find((b) => unusedOfBk(b) > 0 && b.status === 'issued') || bks[0] || null;
  // Next OR: the first number after the last one used (skipped numbers below it are not offered).
  const nextSerial = (b) => { if (!b) return ''; const rs = bookletUnused(b); const last = rs[rs.length - 1]; return last && last[1] === b.to ? last[0] : ''; };
  const serial = LASTC.serial !== '' && LASTC.serial !== undefined ? LASTC.serial : nextSerial(bk);
  const parts = [...new Set(f.ors.filter((x) => x.lguId === audit.lguId).flatMap((x) => (x.items || []).map((i) => i.p)).filter((p) => p && p !== NO_PART))].sort();
  const show = q.get('show') === 'nyr' && !cur.pending ? 'nyr' : q.get('show') === 'sel' ? 'sel' : q.get('show') === 'all' || cur.pending ? 'all' : 'sel';
  // Not yet in a report: the ORs of the officer not in any submitted report of the type shown.
  const nyrOrs = () => Object.values(fig.chains).filter((ch) => usedKinds.includes(ch.kind)).flatMap((ch) => ch.pend.ors);
  // All of this officer: this cash exam's ORs; those in a report of the previous exam (dated on or before the last cash exam)
  // stay with that exam and are not listed here.
  const prevRep = new Set(exam.lastExamDate ? f.reports.filter((r) => r.officerId === o.id && !r.pending && r.date && r.date <= exam.lastExamDate).map((r) => r.id) : []);
  const listOrs = (show === 'all' ? f.ors.filter((x) => x.officerId === o.id && !prevRep.has(x.reportId)) : show === 'nyr' ? nyrOrs() : cur.ors).slice().sort((a, b) => String(a.form).localeCompare(String(b.form)) || a.serial - b.serial);
  const repPill = (x) => { if (!x.reportId) return `<span class="pill p-part">Not yet in an ${K}</span>`; const r = f.reports.find((y) => y.id === x.reportId); return `<span class="pill p-stock">${esc(r ? (r.no ? `${K} ${r.no}` : repName(r, K)) : '—')}</span>`; };
  // The first line also carries the Date of Collection (one date per OR); the other lines leave that column empty.
  const dateCell = `<div class="cd-dcell"><label class="sr-only" for="cd-ordate">Date of Collection</label><input class="input" type="date" id="cd-ordate" value="${esc(LASTC.date)}"></div>`;
  // The OR on one line: OR No., next, status, date, particular, amount, ✕, Enter. More particulars line up below.
  const orCells = `<div class="cd-ocell"><label class="sr-only" for="cd-or">OR No.</label><input class="input mono cd-orno" id="cd-or" inputmode="numeric" value="${esc(serial)}" autocomplete="off"></div>
      <label class="cd-auto" title="Auto-next: the next OR No. is filled in after saving"><input type="checkbox" id="cd-autonext" ${LASTC.auto ? 'checked' : ''}> next</label>
      <div class="seg cd-st" role="group" aria-label="Status"><a href="#" data-st="issued" class="${LASTC.status !== 'cancelled' ? 'on' : ''}" aria-pressed="${LASTC.status !== 'cancelled'}">Issued</a><a href="#" data-st="cancelled" class="${LASTC.status === 'cancelled' ? 'on' : ''}" aria-pressed="${LASTC.status === 'cancelled'}">Cancelled</a></div>`;
  const partRow = (p = {}, i = 0) => `<div class="cd-prow">${i ? '<span></span><span></span><span></span><span></span>' : orCells + dateCell}<label class="sr-only" for="cd-p${i}">Particular ${i + 1}</label><input class="input cd-p" id="cd-p${i}" list="cd-parts" value="${esc(p.p || (!i ? FIXED_PART[form] || '' : ''))}" placeholder="Type to search or add a new particular…" autocomplete="off">
      <label class="sr-only" for="cd-a${i}">Amount ${i + 1}</label><input class="input r cd-a" id="cd-a${i}" inputmode="decimal" value="${p.amt ? esc(money(p.amt)) : ''}" placeholder="0.00" autocomplete="off">
      <button class="btn sm cd-x" type="button" aria-label="Remove particular">✕</button>${i ? '<span></span>' : '<button class="btn primary" type="button" id="cd-enter">Enter</button>'}</div>`;
  // Cash Ticket (Booklet No.): one line per day and booklet: Date | Booklet No. | Pcs | Value | Amount (Pcs × Value).
  const bnBks = f.booklets.filter((b) => b.form === 'cashbn' && b.officerId === o.id && b.status !== 'lost').sort((a, b) => (a.bn || 0) - (b.bn || 0));
  const bnLeft = (b) => countRanges(bookletUnused(b));
  const bnList = bnBks.filter((b) => bnLeft(b) > 0 || b.id === LASTC.bnBk);
  const bnSel = bnList.find((b) => b.id === LASTC.bnBk) || bnList.find((b) => bnLeft(b) > 0) || null;
  const bnEntry = `<div class="sd-line cd-bnentry" id="cd-bnform">
        <div class="sd-f sd-w-date"><label for="bn-date">Date</label><input class="input" type="date" id="bn-date" value="${esc(LASTC.date)}"></div>
        <div class="sd-f sd-w-bn"><label for="bn-bk">Booklet No.</label><select class="input" id="bn-bk">${bnList.map((b) => `<option value="${esc(b.id)}" data-face="${faceOfBk(b)}" data-left="${bnLeft(b)}" ${bnSel && b.id === bnSel.id ? 'selected' : ''}>BN. ${esc(b.bn || '—')} · ${bnLeft(b).toLocaleString('en-US')} pcs left</option>`).join('')}${bnList.length ? '' : '<option value="">No booklet with pieces left</option>'}</select></div>
        <div class="sd-f sd-w-no"><label for="bn-pcs">Pcs</label><input class="input r mono" id="bn-pcs" inputmode="numeric" autocomplete="off"></div>
        <div class="sd-f sd-w-no"><label for="bn-val">Value (₱)</label><input class="input r" id="bn-val" value="${bnSel ? money(faceOfBk(bnSel)) : ''}" readonly tabindex="-1"></div>
        <div class="sd-f sd-w-amt"><label for="bn-amt">Amount (₱)</label><input class="input r" id="bn-amt" inputmode="decimal" autocomplete="off"></div>
        <div class="sd-f sd-w-txt"><label for="bn-part">Particular</label><input class="input" id="bn-part" list="bn-parts" value="${esc(LASTC.bnPart || FIXED_PART.cashbn)}" autocomplete="off"></div>
        <div class="sd-f sd-w-btn"><label>&nbsp;</label><button class="btn primary" type="button" id="bn-enter">Enter</button></div></div>
      <datalist id="bn-parts">${[...new Set([FIXED_PART.cashbn, ...parts])].map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
      <p class="af-note">Cash tickets with a booklet number only: one line per day and booklet. Amount = Pcs × Value; typing the Amount fills in the Pcs. The pieces are taken out of the booklet.</p>`;
  // AF 52, AF 53, AF 54, Cash Ticket (Serial): Date | OR From | OR To | Pcs | Value | Amount. Each OR of the range is saved at the
  // denomination (the particular fixed by the form); the cancelled ones typed are saved as Cancelled.
  const mvOn = MV_SER.includes(form) && LASTC.mode !== 'range';
  const mvFace = bk ? faceOfBk(bk) : faceOfBk({ form });
  const mvEntry = `<div class="sd-line cd-mventry" id="cd-mvform">
        <div class="sd-f sd-w-date"><label for="mv-date">Date</label><input class="input" type="date" id="mv-date" value="${esc(LASTC.date)}"></div>
        <div class="sd-f sd-w-no"><label for="mv-from">OR From</label><input class="input mono" id="mv-from" inputmode="numeric" value="${esc(serial)}" autocomplete="off"></div>
        <div class="sd-f sd-w-no"><label for="mv-to">OR To</label><input class="input mono" id="mv-to" inputmode="numeric" autocomplete="off"></div>
        <div class="sd-f"><label>Status</label><div class="seg cd-st" role="group" aria-label="Status"><a href="#" data-mvst="issued" class="${LASTC.mvSt !== 'cancelled' ? 'on' : ''}" aria-pressed="${LASTC.mvSt !== 'cancelled'}">Issued</a><a href="#" data-mvst="cancelled" class="${LASTC.mvSt === 'cancelled' ? 'on' : ''}" aria-pressed="${LASTC.mvSt === 'cancelled'}">Cancelled</a></div></div>
        <div class="sd-f sd-w-pcs"><label for="mv-pcs">Pcs</label><input class="input r" id="mv-pcs" readonly tabindex="-1"></div>
        <div class="sd-f sd-w-no"><label for="mv-val">Value (₱)</label><input class="input r" id="mv-val" value="${mvFace ? money(mvFace) : ''}" readonly tabindex="-1"></div>
        <div class="sd-f sd-w-amt"><label for="mv-amt">Amount (₱)</label><input class="input r" id="mv-amt" readonly tabindex="-1"></div>
        <div class="sd-f sd-w-txt" ${LASTC.mvSt === 'cancelled' ? 'style="display:none"' : ''}><label for="mv-cx">Cancelled (optional)</label><input class="input mono" id="mv-cx" placeholder="e.g. 7262455, 7262460" autocomplete="off"></div>
        <div class="sd-f sd-w-btn"><label>&nbsp;</label><button class="btn primary" type="button" id="mv-enter">Enter</button></div></div>
      <p class="af-note">${esc(FIXED_PART[form] || '')}: each OR of the range is saved at its denomination; Pcs and Amount count the issued ones (the cancelled ones typed are saved as Cancelled). Status Cancelled: every OR from OR From to OR To is saved as Cancelled.</p>`;
  const colBody = !forms.length ? `<div class="cd-info">This officer has no accountable forms ticked in Audit Setup${isLO ? '. A Liquidating Officer who issues ORs himself needs Collecting and the forms ticked there' : ''}. ${isLO ? 'Remittances and deposits are entered in parts 1 and 3.' : ''}</div>`
    : `${rProg}${rDone ? `<div class="cd-info cd-rdone">All ORs of ${esc(repName(cur.rec, K))} are encoded (${esc(rangesShow(rRec))}). To encode ORs of another report, choose it in tab 1, or "Not yet in an ${K}" in Show below.</div>` : ''}${enc ? `<div class="cd-set" ${rDone ? 'hidden' : ''}>
        <div class="field"><label for="cd-form">Form Type</label><select class="input" id="cd-form">${forms.map((k) => `<option value="${esc(k)}" ${k === form ? 'selected' : ''}>${esc(FORMS.find(([x]) => x === k)?.[1] || k)}</option>`).join('')}</select></div>
        ${form === 'cashbn' ? '' : `<div class="field"><label for="cd-bk">Booklet</label><select class="input" id="cd-bk">${bks.map((b) => `<option value="${esc(b.id)}" ${bk && b.id === bk.id ? 'selected' : ''}>${b.from} – ${b.to} · ${unusedOfBk(b)} unused</option>`).join('')}<option value="" ${bk ? '' : 'selected'}>Not in the Forms Register</option></select></div>`}
        <span class="cd-goes">Goes to: <b>${esc(cur.pending ? (form === 'cashbn' ? `the ${K} that covers its date` : `the ${K} whose OR Range has its number`) : repName(cur.rec, K))} · ${esc(curFund)}</b> <span class="crumb-i" title="Enter moves along: Date → Particulars → Amount → saves the OR, then back to Date for the next OR (Alt + Enter in Amount adds another particular). The fund follows the ${K}. Cancelled ORs have no particulars and a zero amount.">ⓘ</span></span>
      </div>
      ${form === 'cashbn' ? bnEntry : mvOn ? mvEntry : ''}
      ${cbMode && form !== 'cashbn' ? '' : '<!--'}<div class="seg cd-mode" role="group" aria-label="How to encode"><a href="#" data-cmode="one" class="${LASTC.mode !== 'range' ? 'on' : ''}">One OR at a time</a><a href="#" data-cmode="range" class="${LASTC.mode === 'range' ? 'on' : ''}">By OR range</a></div>${cbMode && form !== 'cashbn' ? '' : '-->'}
      ${LASTC.mode === 'range' && form !== 'cashbn' ? `<div class="sd-line cd-rgentry" id="cd-rgform">
        <div class="sd-f sd-w-date"><label for="rg-date">Date</label><input class="input" type="date" id="rg-date" value="${esc(LASTC.date)}"></div>
        <div class="sd-f sd-w-no"><label for="rg-from">OR From</label><input class="input mono" id="rg-from" inputmode="numeric" value="${esc(LASTC.rgNext || '')}"></div>
        <div class="sd-f sd-w-no"><label for="rg-to">OR To</label><input class="input mono" id="rg-to" inputmode="numeric"></div>
        <div class="sd-f sd-w-amt"><label for="rg-amt">Total (₱)</label><input class="input r" id="rg-amt" inputmode="decimal"></div>
        <div class="sd-f sd-w-txt"><label for="rg-cx">Cancelled (optional)</label><input class="input mono" id="rg-cx" placeholder="e.g. 6827281, 6827290"></div>
        <div class="sd-f sd-w-btn"><label>&nbsp;</label><button class="btn primary" type="button" id="rg-enter">Enter</button></div></div>
        <p class="af-note">From a cashbook when the ${K} is not available: one line per day, its OR range and total. The whole range counts as used.${exam.lastExamDate ? ` A line dated before ${esc(fmtDate(exam.lastExamDate))} (the last cash exam) is tagged "Before the period": its ORs are used, its amount is in the beginning balance.` : ''}</p>
        <label class="cer-tick cd-rga"><input type="checkbox" id="rg-a" ${f.settings?.['orrange|' + o.id]?.noA ? '' : 'checked'}> ORs of a booklet before the first range of the period were used before the last cash exam (not flagged as missing)</label>` : ''}
      ${form === 'cashbn' || mvOn ? '' : `<div class="cd-entry cd-one" ${LASTC.mode === 'range' || rDone ? 'hidden' : ''}>
        <div class="cd-parts cd-entryt ${LASTC.status === 'cancelled' ? 'cd-cxl' : ''}" id="cd-partsbox">
          <div class="cd-phead"><span>OR No.</span><span></span><span>Status</span><span>Date of Collection</span><span>Particulars</span><span class="r">Amount (₱)</span><span></span><span></span></div>
          <div id="cd-prows">${partRow({}, 0)}</div>
          <div class="cd-pfoot"><span></span><span></span><span></span><span></span><span><button class="cd-link" type="button" id="cd-addp" ${LASTC.status === 'cancelled' ? 'hidden' : ''}>+ Add Particular</button></span>
            <span class="cd-ortotal" id="cd-ortotbox" hidden>OR Total <b id="cd-ortot">₱ 0.00</b></span><span></span><span></span></div>
        </div>
        <div id="cd-skip"></div>
        <datalist id="cd-parts">${parts.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
      </div>`}` : ''}
      <div class="cd-listhead"><h3 class="cer-h3">Encoded ORs</h3>
        <label class="sr-only" for="cd-search">Search ORs</label><input class="input af-sm" id="cd-search" placeholder="Search OR No. or particular…">
        <label class="sr-only" for="cd-show">Show</label><select class="input af-sm" id="cd-show"><option value="sel" ${show === 'sel' ? 'selected' : ''}>${esc(cur.pending ? `Not yet in an ${K} · ` + cur.fund : repName(cur.rec, K))}</option>${cur.pending ? '' : `<option value="nyr" ${show === 'nyr' ? 'selected' : ''}>Not yet in an ${K}</option>`}<option value="all" ${show === 'all' ? 'selected' : ''}>All of this officer</option></select>
        <span class="cd-total">Total <b>₱ ${money(listOrs.reduce((n, x) => n + orAmount(x), 0))}</b></span>
        ${enc && forms.length ? '<a href="#" class="cd-link cd-tpl" id="cd-ortpl">Template</a><button class="btn" type="button" id="cd-orimp">Import from Excel</button>' : ''}<button class="btn" type="button" id="cd-xls">Export to Excel</button>${enc ? '<button class="btn danger" type="button" id="cd-delsel" hidden>Delete selected</button>' : ''}</div>
      ${listOrs.length ? `<div class="af-tbl cd-orscroll"><table class="af-reg cd-ors"><thead><tr>${enc ? '<th scope="col" style="width:30px"><input type="checkbox" id="cd-selall" aria-label="Select all ORs shown"></th>' : ''}<th scope="col">No.</th><th scope="col">OR No.</th><th scope="col">Date</th><th scope="col">Particulars</th><th scope="col" class="r">Amount (₱)</th><th scope="col">Status</th><th scope="col">${K}</th><th scope="col" class="r"></th></tr></thead>
        <tbody>${listOrs.map((x, i) => `<tr data-or="${esc(x.id)}" data-s="${esc(((x.bnLine ? bnLineText(f, x) : x.serial) + ' ' + (x.items || []).map((p) => partOf(x.form, p.p)).join(' ')).toLowerCase())}">${enc ? `<td><input type="checkbox" class="cd-sel" data-sel="${esc(x.id)}" aria-label="Select OR ${x.serial}"></td>` : ''}<td>${i + 1}</td><td class="mono" title="${esc(FORM_SHORT[x.form] || x.form)}">${x.bnLine ? `${esc(bnLineText(f, x))}${x.bnShort ? ` <span class="pill p-flag" title="More pieces than the booklet has left">${x.bnShort} pcs over</span>` : ''}` : x.range ? `${x.serial}–${x.serialTo} <small class="dim">${maxSer(x) - x.serial + 1} ORs</small>` : x.serial}${x.beg ? ' <span class="pill p-beg" title="Dated before the last cash exam: in the beginning balance">Before the period</span>' : ''}${outOfBooklets(f, o, x) && !inBegRanges(begRangesOf(exam), x) ? ' <span class="pill p-flag" title="Its number is in no booklet received or issued to this officer in the Forms Register">Not in a received booklet</span>' : ''}</td><td ${enc ? `class="cd-ed" data-id8="${esc(x.id)}" tabindex="0" title="Click to change the date"` : ''}>${esc(fmtDate(x.date))}</td>
          ${(() => { const one = enc && !x.bnLine && x.status !== 'cancelled' && (x.items || []).length <= 1, p = (x.items || [])[0]?.p || '';
            return `<td ${one ? `class="cd-ed" data-ip="${esc(x.id)}" tabindex="0" title="Click to change the particular"` : ''}>${x.status === 'cancelled' ? '<span class="dim">—</span>' : (x.items || []).length > 1 ? esc(x.items.map((q) => partOf(x.form, q.p)).join('; ')) : (p === NO_PART || !p) && !FIXED_PART[x.form] ? `<span class="cd-nopart">${NO_PART}</span>` : esc(partOf(x.form, p))}</td>
            <td class="r ${one ? 'cd-ed' : ''}" ${one ? `data-ia="${esc(x.id)}" tabindex="0" title="Click to change the amount"` : ''}>${x.beg ? `<span class="dim" title="In the beginning balance, not this period's">${money(+x.amount || 0)}</span>` : money(orAmount(x))}</td>`; })()}
          <td><span class="pill ${x.status === 'cancelled' ? 'p-stock' : 'p-done'}">${x.status === 'cancelled' ? 'Cancelled' : 'Issued'}</span></td><td>${repPill(x)}</td>
          <td class="r">${enc ? (x.range ? `<button class="btn sm" type="button" data-rgdel="${esc(x.id)}" aria-label="Delete range ${x.serial}">Delete</button>` : `<button class="btn sm" type="button" data-edit="${esc(x.id)}" aria-label="Edit OR ${x.serial}">Edit</button>`) : ''}</td></tr>`).join('')}</tbody></table></div>
        <p class="af-note">In OR No. order. Click a date, a particular or an amount to change it (an OR with several particulars: Edit). Delete is only for an encoding mistake; a cancelled OR is encoded as Cancelled, not deleted.</p>`
      : `<div class="empty"><b>No ORs encoded here yet.</b>${enc ? 'Encode them above, one OR at a time.' : ''}</div>`}`;

  /* ----- 3 · Deposits (SCR: remittances to the MTO) ----- */

  // A collector who remits to the Liquidating Officer (Audit Setup): same report (RCD / SCD), each entry a remittance to the LO.
  const toLO = !isRem && !!exam.remitToLO;
  const remish = isRem || toLO;
  const DEP = isRem ? 'Remittance' : toLO ? 'Remittance to LO' : 'Deposit', DEPS = isRem ? 'Remittances' : toLO ? 'Remittances to LO' : 'Deposits';
  // Cashbook only: each deposit / remittance with the OR series it covers. The next series starts after the last one.
  const lastTo = Math.max(0, ...f.reports.filter((r) => r.officerId === o.id).flatMap((r) => (r.deposits || []).filter((d) => !d.fromLO).map((d) => +d.to || 0)));
  const firstOr = Math.min(Infinity, ...f.ors.filter((x) => x.officerId === o.id && !x.bnLine && !x.beg && (!exam.lastExamDate || x.date >= exam.lastExamDate)).map((x) => +x.serial));
  const sCell = (d) => (cbook ? `<td><input class="input mono" data-k="from" inputmode="numeric" value="${esc(d.from || '')}" aria-label="OR From" ${enc ? '' : 'disabled'}></td><td><input class="input mono" data-k="to" inputmode="numeric" value="${esc(d.to || '')}" aria-label="OR To" ${enc ? '' : 'disabled'}></td>` : '');
  const early = new Map(depsBeforeOrs(f, o, fig).map((x) => [x.d, x]));
  const earlyPill = (d) => { const x = early.get(d); return x ? ` <span class="pill p-flag" title="${esc(`${toLO ? 'Remitted' : 'Deposited'} ${fmtDate(d.date)}; its ORs are dated ${fmtDate(x.first)}${x.last !== x.first ? `–${fmtDate(x.last)}` : ''}. ORs should be issued upon receipt of the collection.`)}">Before its ORs</span>` : ''; };
  // Remitted to the LO, an RCD with its OR Range: one remittance per range row (its form and series listed, not typed); the
  // amount starts at that series' collections, corrected when the hard copy differs; each line checked against its ORs.
  // The series as encoded: the LO's lines when she recorded them with their series, else the RCD's OR Range.
  const loSer = (cur.rec?.deposits || []).filter((d) => d.fromLO && d.from).map((d) => [+d.from, +(d.to || d.from), d.form || bkFormAt(+d.from, o.id)]);
  const lgSer = toLO && !cur.pending && (hasRange(cur) || loSer.length > 0) && !cbook;
  const serRec = lgSer ? { ...cur.rec, officerId: o.id } : null;

  const serSrc = loSer.length ? [...new Map(loSer.map((x) => [`${x[0]}|${x[1]}`, x])).values()].sort((x, y) => x[0] - y[0]) : (lgSer && hasRange(cur) ? cur.rec.ranges.map(([a, z], i) => [a, z, rangeFormAt(serRec, i)]) : []);
  const sers = lgSer ? serSrc.map(([a, z, fk0], i) => { const fk = fk0;
    const tot = r2(f.ors.filter((x) => x.officerId === o.id && x.status !== 'cancelled' && sameF(fk, x.form) && +x.serial >= a && maxSer(x) <= z).reduce((n, x) => n + rawAmt(x), 0));
    return { i, a, z, fk, tot, label: `${fk ? remFormName(fk) + ' · ' : ''}${a === z ? a : `${a}–${z}`}` }; }) : [];
  const serOfDep = (d) => sers.find((x) => d.from && +d.from === x.a && sameF(d.form || x.fk, x.fk)) || sers.find((x) => d.from && +d.from >= x.a && +d.from <= x.z) || null;
  const serCell = (d) => { if (!lgSer || !d.from) return ''; const sx = serOfDep(d);
    return `<td><select class="input mono" data-k="ser" aria-label="OR Series" ${enc ? '' : 'disabled'}><option value="">— Series —</option>${sers.map((x) => `<option value="${x.i}" data-tot="${x.tot}" ${sx === x ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select></td>`; };
  const serChk = (d) => (lgSer && d.from ? `<td class="cd-serchk2">${(() => { const sx = serOfDep(d); if (!sx || d.amount === undefined || d.amount === '') return '';
    const df = r2((+d.amount || 0) - sx.tot); return Math.abs(df) < 0.005 ? '<span class="pill p-done">Agrees</span>' : `<span class="pill p-flag" title="Collections in the series ₱${money(sx.tot)}">₱${money(Math.abs(df))} ${df > 0 ? 'more than the ORs' : 'less than the ORs'}</span>`; })()}</td>` : '');
  const lastLO = lgSer ? ([...f.reports.filter((r) => r.officerId === o.id).flatMap((r) => (r.deposits || []).filter((d) => d.toLO && !d.fromLO && d.ref))].sort((a, b) => String(b.date).localeCompare(String(a.date)))[0]?.ref || '') : '';
  const depRow = (d = {}) => `<tr class="cd-dep"><td><input class="input" type="date" data-k="date" value="${esc(d.date || '')}" aria-label="${toLO ? 'Date remitted' : 'Deposit date'}" ${enc ? '' : 'disabled'}>${earlyPill(d) ? `<br>${earlyPill(d)}` : ''}</td>
      <td><input class="input" data-k="ref" value="${esc(d.ref || '')}" list="cd-reflist" placeholder="${remish ? 'Choose or type the name' : 'Choose or type'}" aria-label="${remish ? 'Liquidating Officer' : 'Reference'}" ${enc ? '' : 'disabled'}></td>
      ${remish ? '' : `<td><input class="input mono" data-k="no" value="${esc(d.no || '')}" placeholder="Optional" aria-label="Deposit slip No." ${enc ? '' : 'disabled'}></td>`}
      ${sCell(d)}${serCell(d)}<td><input class="input r" data-k="amount" inputmode="decimal" value="${d.amount !== undefined && d.amount !== '' ? esc(money(d.amount)) : ''}" aria-label="Amount" ${enc ? '' : 'disabled'}></td>${serChk(d)}
      <td>${enc ? '<button class="btn sm cd-x" type="button" aria-label="Remove deposit">✕</button>' : ''}</td></tr>`;
  // Remittances recorded by the LO in her RCD: in the same table, one row per date (its total), locked; the details are in
  // Series of the RCD. Changed only in the LO's RCD (the tag opens it).
  const loGrp = []; (cur.rec?.deposits || []).filter((d) => d.fromLO).forEach((d) => { const k = `${d.date}|${d.ref}|${d.loReportId || ''}`; const g = loGrp.find((x) => x.k === k);
    if (g) g.amount = r2(g.amount + (+d.amount || 0)); else loGrp.push({ k, date: d.date, ref: d.ref, amount: +d.amount || 0, loReportNo: d.loReportNo || '', loReportId: d.loReportId || '' }); });
  const loHref = (g) => { const rr = g.loReportId && f.reports.find((r) => r.id === g.loReportId); const ex = rr && (f.exams || []).filter((e) => e.officerId === rr.officerId).sort((a, b) => (a.auditId === audit.id ? -1 : b.auditId === audit.id ? 1 : 0))[0];
    return ex ? `#/cer/collections?a=${ex.auditId}&e=${ex.id}&r=${rr.id}` : ''; };
  const loRow = (g) => `<tr class="cd-dep cd-lolock"><td><input class="input" type="date" value="${esc(g.date || '')}" disabled aria-label="Date remitted"></td>
      <td><input class="input" value="${esc(g.ref || '')}" disabled aria-label="Liquidating Officer"></td>
      ${remish ? '' : '<td></td>'}${cbook ? '<td></td><td></td>' : ''}${lgSer && perSer.length ? '<td></td>' : ''}<td><input class="input r" value="${esc(money(g.amount))}" disabled aria-label="Amount"></td>${lgSer && perSer.length ? '<td></td>' : ''}<td></td></tr>`;
  // Nothing remitted yet for this RCD: one line per series, filled in (date of the RCD, the last LO, the series' collections).
  const depRows0 = (() => { const saved = (cur.rec?.deposits || []).filter((d) => !d.fromLO);
    if (saved.length || !lgSer || !enc || (cur.rec?.deposits || []).some((d) => d.fromLO)) return saved;   // the LO already recorded it: nothing to type here
    return [{ date: cur.rec.date || '', ref: lastLO, amount: r2(sers.reduce((t, x) => t + x.tot, 0)) || '' }]; })();
  // Remittances saved per series (before): combined into one remittance of the RCD.
  const perSer = lgSer ? (cur.rec?.deposits || []).filter((d) => !d.fromLO && d.toLO && d.from) : [];
  const serTot = r2(sers.reduce((t, x) => t + x.tot, 0));
  const serBreak = lgSer ? `<div class="cd-serbd" id="cd-serbd" data-tot="${serTot}" data-lo="${r2((cur.rec?.deposits || []).filter((d) => d.fromLO).reduce((t, d) => t + (+d.amount || 0), 0))}"><div class="cd-serbdh"><b>Series of the RCD</b> <span class="dim">(collections encoded; the remittance is one amount for the RCD)</span></div>
      <table class="af-reg"><tbody>${sers.map((x) => `<tr><td class="mono">${esc(x.label)}</td><td class="r">${money(x.tot)}</td></tr>`).join('')}</tbody>
      <tfoot><tr class="cd-foot"><td>${sers.length} series · total collections</td><td class="r">${money(serTot)}</td></tr></tfoot></table>
      <div class="cd-serbdc" id="cd-serbdc"></div>${perSer.length > 1 && enc ? `<div class="cd-actions" style="justify-content:flex-start"><button class="btn sm" type="button" id="cd-combine">Combine the ${perSer.length} series remittances into one</button></div>` : ''}</div>` : '';
  const agree = !cur.pending && cur.rec.hardTotal !== null && cur.rec.hardTotal !== undefined && cur.rec.hardTotal !== '' ? (Math.abs(+cur.rec.hardTotal - r2(cur.coll + cur.begRaw)) < 0.005 ? '<span class="pill p-done">Agrees with hard copy</span>' : `<span class="pill p-stock">Hard copy ₱${money(cur.rec.hardTotal)}</span>`) : '';
  const lo = isLO ? loDays(f, o, fig.chains, audit.countDate) : [];
  // Deposits register (SCD / RCD) and Remittances register (SCR), kept apart: those of the kind shown, oldest first; a row opens its report.
  const allDeps = [];
  fig.keys.filter((k) => usedKinds.includes(fig.chains[k].kind) && (fig.chains[k].kind === 'SCR') === isRem).forEach((k) => { const ch = fig.chains[k]; [...ch.figs, ch.pend].forEach((g) => (g.rec?.deposits || []).forEach((d) => allDeps.push({ ...d, g, ch, src: d, kind: ch.kind, fund: ch.fund }))); });
  // LGU with CTC: each deposit's AF 51 and CTC parts (from the ORs it covers); any line with a series: its check against the ORs in it.
  const dSplit = !isRem && ctcSplit(lgu, exam, f, o), dBs = ctcBegShare(exam.balances);
  const dHasSer = allDeps.some((d) => d.g.serOf?.get(d.src));
  const dCtc = (d) => ctcAlloc(d.ch, dBs).get(d.src) || 0;
  const dChk = (d) => { const s = d.g.serOf?.get(d.src); if (!s) return '<span class="dim">—</span>';
    return s.ok ? '<span class="pill p-done" title="The ORs encoded in the series add up to the amount">✓</span>'
      : `<span class="pill p-flag" title="${esc(`ORs encoded in ${s.a}–${s.z}: ₱${money(s.tot)}${s.beg ? `, ₱${money(s.beg)} of them dated before the last cash exam` : ''}${s.miss.length ? `; not encoded: ${rangesText(s.miss)}` : ''}`)}">₱${money(Math.abs(r2((+d.amount || 0) - s.tot)))} ${(+d.amount || 0) > s.tot ? 'not found' : 'more in the ORs'}</span>`; };
  allDeps.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.ref).localeCompare(String(b.ref)));
  const shownDeps = DEPSHOW.v === 'sel' ? allDeps.filter((d) => d.g.id === selId) : DEPSHOW.v === 'nyr' ? allDeps.filter((d) => d.g.pending) : allDeps;
  const depReg = `<div class="cd-block cd-depreg"><div class="cd-orhead"><h3 class="cer-h3">${remish ? 'Remittances' : 'Deposits'} register</h3><span class="pill">${shownDeps.length}</span>
      <label class="sr-only" for="cd-depshow">Show</label><select class="input af-sm" id="cd-depshow"><option value="all" ${DEPSHOW.v !== 'sel' && DEPSHOW.v !== 'nyr' ? 'selected' : ''}>All of this officer</option><option value="sel" ${DEPSHOW.v === 'sel' ? 'selected' : ''}>${esc(cur.pending ? `Not yet in an ${K} · ` + cur.fund : repName(cur.rec, K))}</option>${cur.pending ? '' : `<option value="nyr" ${DEPSHOW.v === 'nyr' ? 'selected' : ''}>Not yet in an ${K}</option>`}</select>
      <button class="btn sm" type="button" id="cd-depxls">Export to Excel</button></div>
    ${shownDeps.length ? `<div class="af-tbl cd-depscroll"><table class="af-reg cd-deptbl"><thead><tr><th scope="col">Date</th><th scope="col">${remish ? 'Liquidating Officer' : 'Reference'}</th><th scope="col" class="r">Amount (₱)</th>${dSplit ? '<th scope="col" class="r">AF 51</th><th scope="col" class="r">CTC</th>' : ''}${dHasSer ? '<th scope="col">Check</th>' : ''}<th scope="col">${isRem ? 'SCR' : usedKinds.filter((k) => k !== 'SCR').join(' / ')}</th><th scope="col">Fund</th></tr></thead>
      <tbody>${shownDeps.map((d) => `<tr data-pickdep="${esc(d.g.id)}" tabindex="0" class="${d.g.id === selId ? 'cd-on' : ''}"><td>${esc(fmtDate(d.date))}${earlyPill(d.src)}</td><td class="mono">${esc(depRefText(d, d.kind === 'SCR'))}</td><td class="r">${money(+d.amount || 0)}</td>${dSplit ? `<td class="r">${money(r2((+d.amount || 0) - dCtc(d)))}</td><td class="r">${money(dCtc(d))}</td>` : ''}${dHasSer ? `<td>${dChk(d)}</td>` : ''}<td>${esc(d.g.pending ? `Not yet in an ${d.kind}` : repName(d.g.rec, d.kind))}</td><td>${esc(d.fund)}</td></tr>`).join('')}</tbody>
      <tfoot><tr class="cd-foot"><td colspan="2">Total</td><td class="r">${money(r2(shownDeps.reduce((n, d) => n + (+d.amount || 0), 0)))}</td>${dSplit ? `<td class="r">${money(r2(shownDeps.reduce((n, d) => n + (+d.amount || 0) - dCtc(d), 0)))}</td><td class="r">${money(r2(shownDeps.reduce((n, d) => n + dCtc(d), 0)))}</td>` : ''}${dHasSer ? '<td></td>' : ''}<td colspan="2"></td></tr></tfoot></table></div>`
      : `<div class="empty"><b>No ${remish ? 'remittance' : 'deposit'} encoded yet.</b></div>`}</div>`;
  const depBody = `<div class="af-tbl cd-tblbox"><table class="af-reg cd-edit"><thead><tr><th scope="col">${isRem ? 'Date Received by MTO' : toLO ? 'Date Remitted to LO' : 'Deposit Date'}</th><th scope="col">${remish ? 'Liquidating Officer' : 'Reference'}</th>${remish ? '' : '<th scope="col">No.</th>'}${cbook ? '<th scope="col">OR From</th><th scope="col">OR To</th>' : ''}${lgSer && perSer.length ? '<th scope="col">OR Series</th>' : ''}<th scope="col" class="r">Amount (₱)</th>${lgSer && perSer.length ? '<th scope="col">Check</th>' : ''}<th scope="col"></th></tr></thead>
      <tbody id="cd-deps" data-next="${lastTo ? lastTo + 1 : isFinite(firstOr) ? firstOr : ''}" ${lgSer ? `data-sers="${esc(JSON.stringify(sers.map((x) => [x.a, x.z, x.fk, x.tot, x.label])))}" data-lastlo="${esc(lastLO)}" data-rdate="${esc(cur.rec.date || '')}"` : ''}>${loGrp.map(loRow).join('')}${depRows0.map(depRow).join('')}</tbody></table></div>
      ${loGrp.filter((g) => g.loReportNo).length ? `<p class="af-note cd-lotag">${[...new Map(loGrp.filter((g) => g.loReportNo).map((g) => [g.loReportNo, g])).values()].map((g) => `${loHref(g) ? `<a href="${esc(loHref(g))}">From RCD No. ${esc(g.loReportNo)}</a>` : `From RCD No. ${esc(g.loReportNo)}`} of ${esc(g.ref)}`).join('; ')} · changed in the LO's RCD.</p>` : ''}
      ${serBreak}
    
    <datalist id="cd-reflist">${(remish ? loNames(refs, f, lgu) : depRefs(f, audit.lguId)).map((v) => `<option value="${esc(v)}">`).join('')}</datalist>
    ${enc ? `<div class="cd-actions"><button class="btn sm" type="button" id="cd-adddep">+ Add ${DEP}</button><button class="btn primary" type="button" id="cd-savedep">Save ${DEPS}</button></div>` : ''}
    <div class="cd-sum">
      <b class="cd-sumh">Summary (computed) · ${esc(cur.pending ? `Not yet in an ${K} · ` + cur.fund : repName(cur.rec, K))}</b>
      <div><span>${remish ? 'Unremitted' : 'Undeposited'}, last ${K}</span><span>${money(cur.beg)}</span></div>
      ${cur.begAdd ? `<div><span>Add: Beginning balance, last cash exam (ORs in this ${cur.pending ? 'list' : K}${cur.begSer ? `: ${esc(cur.begSer)}` : ''})</span><span>${money(cur.begAdd)}</span></div>` : ''}
      <div><span>Add: Collections</span><span>${money(cur.coll)}</span></div>
      <div><span>Less: ${DEPS}</span><span>${money(cur.dep)}</span></div>
      <div class="cd-sumt"><span>${remish ? 'Unremitted' : 'Undeposited'}, end</span><span>${money(cur.end)}</span></div>
      ${agree}${cur.issues.filter((t) => t.startsWith('Series ') || t.startsWith(NIB)).map((t) => `<p class="cd-serchk">⚠ ${esc(t)}</p>`).join('')}</div>
    ${isLO ? `<div class="cd-block"><h3 class="cer-h3">Days with the LO · received → deposited</h3>
      ${lo.length ? `<div class="af-tbl cd-tblbox"><table class="af-reg"><thead><tr><th scope="col">Date Received</th><th scope="col">From</th><th scope="col">Collector's RCD No.</th><th scope="col">Fund</th><th scope="col" class="r">Amount (₱)</th><th scope="col">Date Deposited</th><th scope="col">Status</th><th scope="col" class="r">Days with LO</th><th scope="col">In</th>${enc ? '<th scope="col"></th>' : ''}</tr></thead>
        <tbody>${lo.map((x) => `<tr><td>${esc(fmtDate(x.date))}</td><td>${esc(x.from)}</td><td class="mono">${esc(x.no || '')}</td><td>${esc(x.fund)}</td><td class="r">${money(x.amount)}</td>
          <td>${x.undeposited ? '<span class="dim">—</span>' : esc(fmtDate(x.depDate))}</td><td>${x.undeposited ? '<span class="pill p-stock">Undeposited</span>' : '<span class="pill p-done">Deposited</span>'}</td><td class="r">${x.days ?? '—'}${x.undeposited ? ' <span class="dim">to the count</span>' : ''}</td>
          <td>${x.own ? '' : `<a href="#" class="cd-link" data-lorep="${esc(x.repId)}">${esc(x.pending ? 'Not yet in an RCD' : x.repName)}</a>`}</td>
          ${enc ? `<td>${x.own ? '' : `<button class="btn sm" type="button" data-lodel="${esc(x.repId)}" data-lokey="${esc(x.m.fromCol ? 'c|' + x.m.key : `t|${x.m.collectorId}|${x.m.date}|${r2(+x.m.amount || 0)}|${x.m.from || ''}`)}" title="${x.m.fromCol ? 'Take it out of the RCD (the collector\'s record stays)' : 'Delete this remittance typed by the LO'}" aria-label="Remove">✕</button>`}</td>` : ''}</tr>`).join('')}</tbody></table></div>
        <p class="af-note">Days with LO = date received to date deposited. Each RCD's deposits cover that RCD's remittances; the date is the RCD's deposit date (several dates: the last). The deposit slips are in the Deposits register. An undeposited remittance counts up to the cash count on ${esc(fmtDate(audit.countDate))}.</p>`
      : '<div class="empty"><b>No remittances received yet.</b>Enter them in part 1.</div>'}</div>` : ''}
    ${depReg}`;

  /* ----- Summary by report ----- */
  const allFigs = realFigs;
  const KS = usedKinds.join(' / ');
  const tot = (k) => r2(allFigs.reduce((n, g) => n + g[k], 0));
  const sumBody = sumTable(true);

  const nPend = pends.reduce((n, ch) => n + ch.pend.nOrs, 0);
  const subRep = cur.pending ? (nPend ? `${nPend} OR${nPend > 1 ? 's' : ''} not yet in an ${K}` : `${realFigs.length} ${K}${realFigs.length === 1 ? '' : 's'} · none selected`) : (cur.rec.no ? `${esc(repName(cur.rec, K))} · ${esc(fmtDate(cur.rec.date))}` : esc(repName(cur.rec, K)));
  // An LO's collections are the remittances from the collectors (and her own ORs, if she collects too).
  const nRem = (cur.rec?.remittances || []).filter((m) => !m.beg).length;
  const colSub = [forms.length ? `${cur.nOrs} OR${cur.nOrs === 1 ? '' : 's'}` : '', `${nRem} remittance${nRem === 1 ? '' : 's'}`].filter(Boolean).join(' · ') + ` · ₱ ${money(r2((cur.orsTotal || 0) + (cur.remTotal || 0)))}`;
  // One compact panel on top: the two choices on one line, the three tabs under them.
  const body = hello() + topBar(kindPick, true) + `
    ${tabs([['rep', K, subRep, repBody], ['col', 'Collections', isLO ? colSub : `${cur.nOrs} OR${cur.nOrs === 1 ? '' : 's'} · ₱ ${money(cur.orsTotal)}`, isLO ? (forms.length ? colBody + remBlock : remBlock) : colBody],
      ['dep', isRem ? 'Remittances to MTO' : 'Deposits', `₱ ${money(cur.dep)} ${isRem ? 'remitted' : 'deposited'} · ₱ ${money(cur.end)} ${isRem ? 'unremitted' : 'undeposited'}`, depBody]])}
`;

  const ctxw = { refs, f, audit, lgu, K, KS, o, exam, fig, cur, curFund, curKey, selId, isLO, pureLO, enc, funds, form, bk, bks, listOrs, allFigs, isFirst, toLO, cbook, rMode, rRec };
  return { crumb, body, wire: () => { wireTop(); wireAll(ctxw); } };
}

/* ---------- wiring ---------- */
function wireAll(c) {
  const { refs, f, audit, K, o, cur, curFund, selId, isLO, enc } = c;
  $$('.cd-tab').forEach((t) => { t.onclick = () => {
    Object.keys(OPEN).forEach((k) => { OPEN[k] = k === t.dataset.tab; });
    $$('.cd-tab').forEach((x) => { const on = x === t; x.classList.toggle('on', on); x.setAttribute('aria-selected', String(on)); $('#cd-pane-' + x.dataset.tab).hidden = !on; });
    const sp = $('#cd-sumpanel'); if (sp) sp.hidden = t.dataset.tab === 'rep';
  }; });
  $$('details.cd-acc').forEach((d) => { d.ontoggle = () => {
    OPEN[d.dataset.acc] = d.open;
    if (d.open) $$('details.cd-acc').forEach((x) => { if (x !== d && x.open) { x.open = false; OPEN[x.dataset.acc] = false; } });
  }; });
  $('#cd-funds').onclick = () => fundsModal(refs, f, audit.lguId);
  const ds = $('#cd-depshow'); if (ds) ds.onchange = () => { DEPSHOW.v = ds.value; window.dispatchEvent(new HashChangeEvent('hashchange')); };
  $$('tr[data-pickdep]').forEach((tr) => { const pick = () => go({ r: tr.dataset.pickdep }); tr.onclick = pick; tr.onkeydown = (e) => { if (e.key === 'Enter') pick(); }; });
  const dx = $('#cd-depxls'); if (dx) dx.onclick = () => { const rem = c.K === 'SCR'; exportXlsx(`${rem ? 'Remittances' : 'Deposits'} ${c.o.name}.xlsx`, rem ? 'Remittances' : 'Deposits', $$('.cd-deptbl tbody tr').map((tr) => { const t = [...tr.children].map((td) => td.textContent.trim()); return { Date: t[0], [rem ? 'Liquidating Officer' : 'Reference']: t[1], Amount: num(t[2]), Report: t[3], Fund: t[4] }; })); };
  $$('tr[data-pick]').forEach((tr) => { const pick = () => go({ r: tr.dataset.pick }); tr.onclick = pick; tr.onkeydown = (e) => { if (e.key === 'Enter') pick(); }; });
  const sumX = () => exportXlsx(`${K} Summary ${o.name} ${audit.countDate}.xlsx`, `${K} Summary`, c.allFigs.map((g) => ({
    [`${K}`]: g.pending ? 'Not yet in a report' : repName(g.rec, g.kind), [`${K} No.`]: g.pending ? '' : g.rec.no, Fund: g.pending ? g.fund : g.rec.fund, [`${K} Date`]: g.pending ? '' : fmtDate(g.rec.date), 'Period From': fmtDate(g.from), 'Period To': fmtDate(g.to),
    ...(c.pureLO ? (() => { const cv = coveredOf(c.f, c.refs, g.rec); return { 'Covered SCR / RCD': cv.text.replace(' …', '') + (cv.text.endsWith('…') ? ' (more)' : ''), Reports: cv.n }; })() : { 'OR Range': g.range, 'No. of ORs': g.nOrs, Cancelled: g.nCancelled }), 'Undeposited, Last': g.beg, 'Beginning, Last Cash Exam': g.begAdd || 0, 'Collections (ORs)': g.orsTotal, Remittances: g.remTotal, Deposited: g.dep, 'Undeposited, End': g.end,
    'Total per Hard Copy': g.pending ? '' : (g.rec.hardTotal ?? ''), 'Date Received': g.pending ? '' : fmtDate(g.rec.received), Checks: g.issues.join(' ') || 'Complete' })));
  ['#cd-sumxls', '#cd-sumxls2'].forEach((id) => { const b = $(id); if (b) b.onclick = sumX; });
  const xls = $('#cd-xls');
  if (xls) xls.onclick = () => exportXlsx(`ORs ${o.name} ${audit.countDate}.xlsx`, 'ORs', c.listOrs.map((x) => ({
    Form: FORM_SHORT[x.form] || x.form, 'OR No.': x.bnLine ? bnLineText(f, x) : x.serial, Date: fmtDate(x.date), Particulars: (x.items || []).map((p) => partOf(x.form, p.p)).join('; '), 'Amounts': (x.items || []).map((p) => money(p.amt)).join('; '),
    Fund: x.fund || '', Amount: orAmount(x), Status: x.status === 'cancelled' ? 'Cancelled' : 'Issued', [K]: x.reportId ? repName(f.reports.find((r) => r.id === x.reportId), K) : `Not yet in an ${K}` })));
  const sr = $('#cd-search');
  // Select ORs (the header box: all those shown by the search) and delete them at once: encoding mistakes only.
  const selBtn = $('#cd-delsel'), selAll = $('#cd-selall');
  const selPaint = () => { if (!selBtn) return; const n = $$('.cd-sel').filter((b) => b.checked).length; selBtn.hidden = !n; selBtn.textContent = `Delete ${n} selected`;
    const shown = $$('tr[data-or]').filter((tr) => !tr.hidden).map((tr) => $('.cd-sel', tr)).filter(Boolean); if (selAll) { selAll.checked = !!shown.length && shown.every((b) => b.checked); selAll.indeterminate = !selAll.checked && shown.some((b) => b.checked); } };
  $$('.cd-sel').forEach((b) => { b.onchange = selPaint; });
  if (selAll) selAll.onchange = () => { $$('tr[data-or]').forEach((tr) => { const b = $('.cd-sel', tr); if (b) b.checked = !tr.hidden && selAll.checked; }); selPaint(); };
  if (selBtn) selBtn.onclick = async () => {
    const picked = $$('.cd-sel').filter((b) => b.checked).map((b) => f.ors.find((x) => x.id === b.dataset.sel)).filter(Boolean);
    const inRep = picked.filter((x) => x.reportId && f.reports.some((r) => r.id === x.reportId && !r.pending)), del = picked.filter((x) => !inRep.includes(x));
    if (!del.length) return bad(`The ${inRep.length} OR${inRep.length > 1 ? 's' : ''} selected ${inRep.length > 1 ? 'are' : 'is'} in a submitted ${K}. Take ${inRep.length > 1 ? 'them' : 'it'} out of the ${K} first (Edit), then delete.`);
    const nos = mergeRanges(del.flatMap((x) => (x.range ? [[+x.serial, maxSer(x)]] : [[+x.serial, +x.serial]])));
    const ok = await modal({ title: `Delete ${del.length} OR${del.length > 1 ? 's' : ''}?`, body: `<p style="margin:0 0 8px">${esc(rangesText(nos))} · ₱ ${money(r2(del.reduce((n, x) => n + (x.status === 'cancelled' ? 0 : +x.amount || 0), 0)))}</p>
        <p class="af-note" style="margin:0">Only for an encoding mistake: a cancelled OR is encoded as Cancelled, not deleted.${inRep.length ? ` <b>${inRep.length} OR${inRep.length > 1 ? 's' : ''} in a submitted ${K} ${inRep.length > 1 ? 'are' : 'is'} skipped</b> (take ${inRep.length > 1 ? 'them' : 'it'} out of the ${K} first).` : ''}</p>`,
      buttons: [{ label: 'Cancel', value: false }, { label: `Delete ${del.length}`, cls: 'danger', value: true }] });
    if (!ok) return;
    selBtn.disabled = true;
    try { for (const x of del) await store.save('cer_ors', x.id, strip(x), by(refs), { deleted: true, quiet: true }); }
    finally { selBtn.disabled = false; }
    emitChange('local'); toast(`${del.length} OR${del.length > 1 ? 's' : ''} deleted.${inRep.length ? ` ${inRep.length} in a ${K} skipped.` : ''}`, 'ok');
  };
  if (sr) sr.oninput = () => { const t = sr.value.trim().toLowerCase(); $$('tr[data-or]').forEach((tr) => { tr.hidden = !!t && !tr.dataset.s.includes(t); }); selPaint(); };
  const sh = $('#cd-show'); if (sh) sh.onchange = () => go({ show: sh.value });
  if (!enc) return;

  /* SCD / RCD */
  // + SCD / + SCR opens a window for a new report; Edit on a row opens it for that report.
  $$('[data-newrep]').forEach((b) => { b.onclick = () => reportModal(c, b.dataset.newrep, null); });
  $$('[data-editrep]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); const g = c.fig.byId[b.dataset.editrep]; if (g) reportModal(c, g.kind, g); }; });
  const pendRec = async (patch) => {
    const id = cur.pending ? cur.id : selId;
    const base = cur.rec && cur.rec.lguId ? strip(cur.rec) : { lguId: audit.lguId, officerId: o.id, kind: K, fund: curFund, pending: true, deposits: [], remittances: [] };
    delete base.pending; if (cur.pending) base.pending = true;
    // Never store the lines shown from the other side (they are made again on loading).
    base.deposits = (base.deposits || []).filter((d) => !d.fromLO); base.remittances = (base.remittances || []).filter((m) => !m.fromCol);
    await store.save('cer_reports', id, { ...base, ...patch }, by(refs));
  };
  /* table editors (remittances, deposits) */
  const tbodyOf = (tr) => ({ querySelectorAll: () => [tr] });
  const wireRows = (box) => $$('.cd-x', box).forEach((b) => { b.onclick = () => b.closest('tr').remove(); });
  // Ticking a collector's remittance in (or out of) this RCD of the LO: kept on the LO's reports (colIn / colOut).
  const putCol = async (k, on) => {
    const ch = c.fig.chains[c.curKey]; if (!ch) return;
    for (const g of ch.figs) {
      const r = f.reports.find((y) => y.id === g.id); if (!r) continue;
      let inn = (r.colIn || []).filter((x) => x !== k);
      if (g.id === selId && on) inn = [...inn, k];
      if (inn.length === (r.colIn || []).length && g.id !== selId) continue;
      await store.save('cer_reports', r.id, { ...strip(r), colIn: inn }, by(refs), { quiet: true });
    }
    emitChange('local'); toast(on ? 'Put in this RCD.' : 'Taken out of this RCD (the collector\'s report stays).', 'ok');
  };
  $$('[data-colk]').forEach((cb) => { cb.onchange = () => putCol(cb.dataset.colk, cb.checked); });
  // Remittances received register: open the RCD a line is in, or take the line out (ticked) / delete it (typed).
  $$('[data-lorep]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); go({ r: a.dataset.lorep }); }; });
  $$('[data-lodel]').forEach((b) => { b.onclick = async () => {
    const k = b.dataset.lokey, rec = f.reports.find((r) => r.id === b.dataset.lodel);
    if (k.startsWith('c|')) { const key = k.slice(2);
      for (const r of f.reports.filter((y) => y.officerId === o.id && ((y.colIn || []).includes(key)))) await store.save('cer_reports', r.id, { ...strip(r), remittances: (r.remittances || []).filter((m) => !m.fromCol), deposits: (r.deposits || []).filter((d) => !d.fromLO), colIn: (r.colIn || []).filter((x) => x !== key) }, by(refs), { quiet: true });
      emitChange('local'); toast('Taken out of the RCD (the collector\'s record stays).', 'ok'); return; }
    if (!rec) return;
    const [, col, date, amt, from] = k.split('|');
    const ok = await modal({ title: 'Delete this remittance?', body: `<p style="margin:0">${esc(f.officers.find((x) => x.id === col)?.name || 'Collector')} · ${esc(fmtDate(date))} · ₱${money(+amt)}${from ? ` · from ${esc(from)}` : ''}, typed in ${esc(rec.pending ? 'Not yet in an RCD' : repName(rec, K))}.</p>`, buttons: [{ label: 'Cancel', value: false }, { label: 'Delete', cls: 'danger', value: true }] });
    if (!ok) return;
    let done = false;
    const rems = (rec.remittances || []).filter((m) => !m.fromCol).filter((m) => { if (!done && m.collectorId === col && m.date === date && Math.abs(r2(+m.amount || 0) - +amt) < 0.005 && String(m.from || '') === from) { done = true; return false; } return true; });
    await store.save('cer_reports', rec.id, { ...strip(rec), remittances: rems, deposits: (rec.deposits || []).filter((d) => !d.fromLO) }, by(refs));
    emitChange('local'); toast('Remittance deleted.', 'ok'); }; });
  $$('[data-noedit]').forEach((sp) => { const open = () => {
    if (sp.querySelector('input')) return;
    const id = sp.dataset.noedit, was = sp.dataset.cur || '', html = sp.innerHTML;
    sp.innerHTML = `<input class="input mono rm-noin" value="${esc(was)}" placeholder="No." aria-label="Their report No.">`;
    const inp = sp.querySelector('input'); inp.focus(); inp.select();
    let done = false;
    const close = () => { if (!done) { done = true; sp.innerHTML = html; } };
    const save = async () => { if (done) return; const v = inp.value.trim(); if (v === was) return close(); done = true;
      const rec = await store.get('cer_reports', id); if (!rec || rec.deleted) { toast('That report is no longer in the app.', 'bad'); sp.innerHTML = html; return; }
      const r = rec.data, key = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const pend = id.startsWith('nyr|'), kind = r.kind || (pend ? id.split('|')[2] : ''), colId = r.officerId || (pend ? id.split('|')[1] : '');
      if (v && f.reports.some((x) => x.id !== id && !x.pending && x.officerId === colId && (x.kind || '') === kind && key(x.no) === key(v))) {
        toast(`${colName(f, refs, colId)} already has ${kind || 'a report'} No. ${v}.`, 'bad'); done = false; inp.focus(); return; }
      if (!pend) { await store.save('cer_reports', id, { ...r, no: v }, by(refs)); }
      else {
        // Not yet in a report on the collector's side: the number makes it a report of its own (this remittance and its ORs).
        if (!v) return close();
        const date = sp.dataset.ndate, amt = r2(+sp.dataset.namt || 0), a = +sp.dataset.nfrom || 0, z = +(sp.dataset.nto || sp.dataset.nfrom) || 0, fund = id.split('|').slice(3).join('|');
        const deps = r.deposits || [], k = deps.findIndex((d) => !d.fromLO && d.date === date && Math.abs(r2(+d.amount || 0) - amt) < 0.005);
        if (k < 0) { toast('That remittance is no longer waiting on the collector\'s side.', 'bad'); sp.innerHTML = html; return; }
        const d = deps[k], nid = newId('cerr');
        await store.save('cer_reports', nid, { lguId: r.lguId, officerId: colId, kind, no: v, date, fund, ranges: a ? [[a, z]] : [], deposits: [d], remittances: [], begTyped: 0 }, by(refs), { quiet: true });
        await store.save('cer_reports', id, { ...r, deposits: deps.filter((_, i) => i !== k) }, by(refs), { quiet: true });
        // Already ticked into an RCD of the LO: the tick follows (the line's key names its report).
        const ok0 = `${id}|${date}|${r2(+d.amount || 0)}`, nk = `${nid}|${date}|${r2(+d.amount || 0)}`;
        for (const lr of f.reports.filter((y) => (y.colIn || []).includes(ok0) || (y.colOut || []).includes(ok0))) {
          const sw = (l) => (l || []).map((x) => (x === ok0 ? nk : x));
          await store.save('cer_reports', lr.id, { ...strip(lr), remittances: (lr.remittances || []).filter((m) => !m.fromCol), deposits: (lr.deposits || []).filter((dd) => !dd.fromLO), colIn: sw(lr.colIn), ...(lr.colOut ? { colOut: sw(lr.colOut) } : {}) }, by(refs), { quiet: true }); }
        if (a) for (const x of f.ors.filter((y) => y.officerId === colId && !y.reportId && (y.fund || fund) === fund && +y.serial <= z && +(y.serialTo || y.serial) >= a)) {
          await store.save('cer_ors', x.id, { ...strip(x), reportId: nid, fund }, by(refs), { quiet: true }); }
      }
      toast(`${kind || 'Report'} No. saved on ${colName(f, refs, colId)}'s ${kind || 'report'}.`, 'ok'); emitChange('local'); };
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } else if (e.key === 'Escape') { e.preventDefault(); close(); } };
    inp.onblur = () => { save(); };
  };
    sp.onclick = (e) => { e.preventDefault(); open(); }; sp.onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && !sp.querySelector('input')) { e.preventDefault(); open(); } }; });
  { const fi = $('#rm-find'); if (fi) { const run = () => { REM.find = fi.value; const q = fi.value.trim().toLowerCase(), n = +q.replace(/[^\d]/g, ''), num = /^[\d\s,.-]+$/.test(q) && n;
      let shown = 0, all = 0;
      $$('tr[data-rmq]').forEach((tr) => { all++; const ok = !q || q.split(/\s+/).every((w) => tr.dataset.rmq.includes(w))
        || (num && String(n).length >= 4 && (tr.dataset.rmrg || '').split(';').some((r) => { const [a, z] = r.split('-').map(Number); return a <= n && n <= z; }));
        tr.hidden = !ok; if (ok) shown++; });
      $('#rm-findn').textContent = q ? `${shown} of ${all}` : ''; };
    fi.oninput = run; run(); } }
  $$('[data-colrm]').forEach((b) => { b.onclick = () => putCol(b.dataset.colrm, false); });
  $$('[data-rmmode]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); REM.mode = a.dataset.rmmode; emitChange('local'); }; });
  // Typed remittances of this report (a collector whose SCR / RCD is not in the app): the entry line and the list.
  const typedNow = () => (cur.rec?.remittances || []).filter((m) => !m.fromCol);
  const colsAll = collectorsOf(f, o, audit, refs);
  const cLabel = (x) => `${x.name}${x.designation ? ' · ' + x.designation : ''}${x.office ? ' · ' + x.office : ''}`;
  const letters = (v) => String(v || '').toLowerCase().replace(/[^a-z]/g, '');
  const resolveCol = (v) => { const t = String(v || '').trim(); if (!t) return null;
    const hit = colsAll.find((x) => cLabel(x) === t) || colsAll.find((x) => letters(x.name) === letters(t.split('·')[0]));
    if (hit) return hit; const part = colsAll.filter((x) => letters(x.name).includes(letters(t.split('·')[0]))); if (part.length === 1) return part[0];
    // The same person under another spelling (LOURDES DIMMOCLO = LOURDES B. DIMMOCLO): that officer, so the names stay uniform.
    const same = samePerson(colsAll, t.split('·')[0]); return same.length === 1 ? same[0] : null; };
  // A collector not yet in the app: added here (name, office, designation) and kept as an officer of that office, so Audit
  // Setup lists him or her later with the SCR / RCD made from the remittances already there.
  const offices = [audit.lguId, ...Object.keys(refs.lgu).filter((k) => refs.lgu[k]?.data.parentId === audit.lguId)].filter((k) => refs.lgu[k])
    .map((k) => ({ id: k, name: refs.lgu[k].data.name || k, brgy: isBrgy(refs.lgu[k]) }))
    .sort((a, b) => (a.brgy ? 1 : 0) - (b.brgy ? 1 : 0) || a.name.localeCompare(b.name));
  const offOpts = (sel) => `<option value="">Choose the office…</option>${offices.map((x) => `<option value="${esc(x.id)}" ${x.id === sel ? 'selected' : ''}>${x.brgy ? esc(x.name) : `This office · ${esc(x.name)}`}</option>`).join('')}`;
  const officeOf = (v) => { const t = letters(v); if (!t) return ''; const hit = offices.find((x) => letters(x.name) === t) || offices.filter((x) => letters(x.name).includes(t) || t.includes(letters(x.name).replace(/^(barangay|brgy)/, '')));
    return Array.isArray(hit) ? (hit.length === 1 ? hit[0].id : '') : hit.id; };
  const cleanName = (v) => String(v || '').split('·')[0].trim().replace(/\s+/g, ' ').toUpperCase();
  // Same surname and the same first letter: probably the same person.
  const similarTo = (nm) => { const w = cleanName(nm).split(' ').filter(Boolean), last = letters(w[w.length - 1]), first = letters(w[0]).charAt(0);
    const same = samePerson(colsAll, nm);
    return [...same, ...(last ? colsAll.filter((x) => { if (same.includes(x)) return false; const v = cleanName(x.name).split(' '); return letters(v[v.length - 1]) === last && (!first || letters(v[0]).charAt(0) === first); }) : [])]; };
  const desigFor = (lid) => (isBrgy(refs.lgu[lid]) ? 'Barangay Treasurer' : '');
  const saveNewCols = async (list) => { for (const x of list) { await store.save('cer_officers', x.id, { lguId: x.lguId, name: x.name, designation: x.designation || '' }, by(refs), { quiet: true }); f.officers.push(x); colsAll.push({ ...x, office: x.lguId === audit.lguId ? '' : refs.lgu[x.lguId]?.data.name || '' }); } };
  const newColModal = async (typedName) => {
    let out = null; const sim = similarTo(typedName);
    await modal({ title: 'New Collector', wide: false,
      body: `<p class="af-note" style="margin-top:0"><b>${esc(cleanName(typedName))}</b> is not in the app yet. Add as a collector? The officer is kept for this office; in Audit Setup, choose the name later and the SCR / RCD made here are already there.</p>
        ${sim.length ? `<div class="msg warn">Did you mean ${sim.map((x) => `<button class="btn sm" type="button" data-simcol="${esc(x.id)}">${esc(cLabel(x))}</button>`).join(' ')}? Pick it to avoid two records of the same person.</div>` : ''}
        <div class="field"><label for="nc-name">Full name</label><input class="input upper" id="nc-name" value="${esc(cleanName(typedName))}" autocomplete="off"></div>
        <div class="field"><label for="nc-off">Office</label><select class="input" id="nc-off">${offOpts('')}</select><span class="hint">A barangay treasurer's report is taken as an SCR, an LGU collector's as an RCD.</span></div>
        <div class="field"><label for="nc-des">Designation <small class="dim">(optional)</small></label><input class="input" id="nc-des" autocomplete="off"></div>`,
      onOpen: (bg) => {
        $('#nc-off', bg).onchange = () => { const d = $('#nc-des', bg); if (!d.value.trim() || d.dataset.auto) { d.value = desigFor($('#nc-off', bg).value); d.dataset.auto = '1'; } };
        $('#nc-des', bg).oninput = (e) => { delete e.target.dataset.auto; };
        $$('[data-simcol]', bg).forEach((b) => { b.onclick = () => { out = { pick: colsAll.find((x) => x.id === b.dataset.simcol) }; bg.querySelector('.mf .btn:not(.primary)')?.click(); }; });
      },
      buttons: [{ label: 'Cancel', value: null }, { label: 'Add Collector', cls: 'primary', value: 'ok', check: (bg) => {
        const name = cleanName($('#nc-name', bg).value), lid = $('#nc-off', bg).value;
        if (!name) { toast('Enter the collector\'s name.', 'bad'); return false; }
        if (!lid) { toast('Choose the office.', 'bad'); return false; }
        if (colsAll.some((x) => letters(x.name) === letters(name))) { toast(`${name} is already in the list. Choose it there.`, 'bad'); return false; }
        out = { add: { id: newId('cero'), name, lguId: lid, designation: $('#nc-des', bg).value.trim() } }; return true; } }] });
    if (!out) return null;
    if (out.pick) return out.pick;
    await saveNewCols([out.add]); toast(`${out.add.name} added as a collector.`, 'ok');
    return colsAll.find((x) => x.id === out.add.id);
  };
  const shownCol = () => Object.values(c.fig.chains).flatMap((ch) => [...ch.figs, ch.pend]).flatMap((g) => (g.rec?.remittances || []).filter((m) => m.fromCol));
  const nk = (v) => String(v || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  const dupOf = (m) => shownCol().find((x) => x.collectorId === m.collectorId && ((x.from && m.from && String(x.from) === String(m.from)) || (m.reportNo && x.colNo && nk(m.reportNo) === nk(x.colNo)) || (x.date === m.date && Math.abs(x.amount - m.amount) < 0.005)));
  const lineOf = (date, col, no, fr0, to0, amt, form = '', pcs = 0, bn = 0) => {
    const fr = String(fr0 || '').replace(/\D/g, ''), to = String(to0 || '').replace(/\D/g, '') || fr;
    const cr = no ? f.reports.find((r) => !r.pending && r.officerId === col.id && String(r.no).trim().toUpperCase() === String(no).trim().toUpperCase()) : null;
    return { date, collectorId: col.id, reportNo: String(no || '').trim(), reportId: cr ? cr.id : '', amount: r2(amt), ...(fr ? { from: fr, to } : {}), ...(form && form !== 'af51' ? { form } : {}), ...(pcs ? { pcs } : {}), ...(bn ? { bn } : {}), ...(c.exam.lastExamDate && date < c.exam.lastExamDate ? { beg: true } : {}) };
  };
  // Saves the typed list of this report: a remittance already in the collector's records is not saved again; one whose
  // collector's SCR / RCD is not in the app makes it (No., date, OR range); only its collections are left to encode there.
  // A collector's SCR / RCD made from the LO's lines carries the OR series of all those lines (one report, several series);
  // a series taken out is taken out of it too, while the report has no OR of its own yet.
  const syncShells = async (list) => {
    const ids = new Set(list.map((m) => m.reportId).filter(Boolean));
    for (const id of ids) {
      const sh = f.reports.find((r) => r.id === id && r.madeFrom && r.madeFrom.officerId === o.id); if (!sh) continue;
      // One range per series with its form (AF 56 · …, AF 51 · …), as on the LO's lines.
      const mine = list.filter((m) => m.reportId === id && m.from).map((m) => [+m.from, +(m.to || m.from), remForm(formOfSer(m))]);
      const old = (sh.ranges || []).map(([a, z], i) => [a, z, rangeFormAt(sh, i)]);
      // As encoded: one range per series (not merged), duplicates dropped.
      const asIs = (l) => { const seen = new Set(), out = l.filter(([a, z, fk]) => { const k = `${a}|${z}|${remForm(fk || '')}`; if (seen.has(k)) return false; seen.add(k); return true; }).sort((x, y) => x[0] - y[0]);
        return { ranges: out.map(([a, z]) => [a, z]), rangeForms: out.map((x) => x[2] || '') }; };
      const want = asIs(f.ors.some((x) => x.reportId === id) ? [...old, ...mine] : mine);
      const have = asIs(old);
      if (JSON.stringify(want) !== JSON.stringify(have) || JSON.stringify(sh.rangeForms || []) !== JSON.stringify(want.rangeForms)) { Object.assign(sh, want); await store.save('cer_reports', sh.id, { ...strip(sh), ...want }, by(refs), { quiet: true }); }
    }
  };
  const saveRems = async (list, quiet) => {
    const was = typedNow();
    for (const m of list) {
      if (was.some((w) => w.collectorId === m.collectorId && w.date === m.date && Math.abs(w.amount - m.amount) < 0.005 && String(w.from || '') === String(m.from || ''))) continue;
      const dup = dupOf(m);
      if (dup) { bad(`Already in ${f.officers.find((y) => y.id === m.collectorId)?.name || 'the collector'}'s ${dup.reportNo} (${fmtDate(dup.date)}, ₱${money(dup.amount)}). No need to type it: tick it in the list above.`); return false; }
    }
    for (const m of list) {
      if (m.reportId || !m.reportNo) continue;
      const col = f.officers.find((y) => y.id === m.collectorId), cl = col && refs.lgu[col.lguId]; if (!col) continue;
      const n = +m.from, bk = n ? f.booklets.find((x) => x.officerId === col.id && !x.noSerial && x.from <= n && n <= x.to) : null;
      const ckind = bk ? kindOfForm(cl, bk.form) : kindsOf(cl).includes('SCR') ? 'SCR' : kindsOf(cl)[0];
      const hit = f.reports.find((r) => !r.pending && r.officerId === col.id && (r.kind || ckind) === ckind && String(r.no).trim().toUpperCase() === m.reportNo.toUpperCase());
      if (hit) { m.reportId = hit.id; continue; }
      const nid = newId('cerr');
      const rec = { lguId: col.lguId, officerId: col.id, kind: ckind, no: m.reportNo, date: m.date, fund: cl && isBrgy(cl) ? 'General Fund' : curFund, hardTotal: null,
        ranges: m.from ? [[+m.from, +(m.to || m.from)]] : [], rangeForms: m.from ? [remForm(formOfSer(m))] : [], deposits: [], remittances: [], begTyped: 0, madeFrom: { officerId: o.id, name: o.name, no: cur.pending ? '' : cur.rec.no || '', reportId: cur.pending ? '' : cur.id } };
      await store.save('cer_reports', nid, rec, by(refs), { quiet: true });
      m.reportId = nid;
      // The other series of the same report (same save) find it, not a second copy.
      f.reports.push({ id: nid, ...rec });
    }
    await syncShells(list);
    // A report made from these lines that no line uses any more (e.g. its No. corrected with Edit), still without ORs: removed.
    for (const id of new Set(was.map((m) => m.reportId).filter((x) => x && !list.some((m) => m.reportId === x)))) {
      const sh = f.reports.find((r) => r.id === id && r.madeFrom && r.madeFrom.officerId === o.id);
      if (sh && !f.ors.some((x) => x.reportId === id) && !(sh.deposits || []).some((d) => !d.fromLO)) await store.save('cer_reports', sh.id, strip(sh), by(refs), { deleted: true, quiet: true });
    }
    // Leftovers made from this LO's lines that no LO line uses any more (any of her RCDs, or another LO's): removed for good.
    { const used = new Set([...f.reports.filter((r) => r.id !== selId).flatMap((r) => (r.remittances || []).filter((m) => !m.fromCol && m.reportId).map((m) => m.reportId)), ...list.map((m) => m.reportId).filter(Boolean)]);
      for (const sh of f.reports.filter((r) => r.madeFrom && r.madeFrom.officerId === o.id && !used.has(r.id) && !f.ors.some((x) => x.reportId === r.id) && !(r.deposits || []).some((d) => !d.fromLO)))
        await store.save('cer_reports', sh.id, strip(sh), by(refs), { deleted: true, quiet: true }); }
    await pendRec({ remittances: [...list].sort((a, b) => String(a.date).localeCompare(String(b.date))) });
    if (!quiet) { const n = list.filter((x) => x.reportId && x.reportId === list[list.length - 1]?.reportId).length; toast(n > 1 ? `Saved as series ${n} of ${list[list.length - 1].reportNo}.` : 'Remittance saved.', 'ok'); }
    return true;
  };
  if ($('#rm-form')) {
    const edGrp = REM.key === selId && REM.i >= 0 ? remGroups(typedNow()).find((g) => g.some((x) => x.i === REM.i)) || null : null;
    const box = $('#rm-srows');
    const rows = () => $$('.rm-srow', box);
    const blank = (r) => !['.rm-sf', '.rm-st', '.rm-sp', '.rm-sa'].some((k) => $(k, r).value.trim());
    const order = () => [$('#rm-date'), $('#rm-col'), $('#rm-no'), ...rows().flatMap((r) => ['.rm-sf', '.rm-st', ...(r.classList.contains('rm-cash') ? ['.rm-sp'] : []), '.rm-sa'].map((k) => $(k, r)).filter((el) => !el.readOnly))];
    const total = () => { const rs = rows().filter((r) => !blank(r)), t = r2(rs.reduce((n, r) => n + (num($('.rm-sa', r).value) || 0), 0));
      $('#rm-tot').innerHTML = rs.length > 1 ? `Total <b>₱ ${money(t)}</b> · ${rs.length} series` : '';
      rows().forEach((r) => { $('.rm-sx', r).style.visibility = rows().length > 1 ? 'visible' : 'hidden'; }); };
    const newRow = (focus = true) => { box.insertAdjacentHTML('beforeend', serRow(null)); wireRow(rows()[rows().length - 1]); total(); if (focus) $('.rm-sf', rows()[rows().length - 1]).focus(); };
    const wireRow = (r) => {
      $('.rm-sx', r).onclick = () => { if (rows().length > 1) { r.remove(); total(); } };
      // Cash tickets: OR From / To optional (pre-numbered or not), the pieces counted from them or typed.
      // Other forms: the pieces are counted from OR From and To (shown, not typed); cash tickets: counted or typed.
      const kind = () => { const cash = $('.rm-sk', r).value === 'cashbn'; r.classList.toggle('rm-cash', cash); r.classList.toggle('rm-bn', cash);
        $('.rm-sf', r).placeholder = cash ? 'Booklet No.' : ''; $('.rm-sf', r).setAttribute('aria-label', cash ? 'Booklet No.' : 'OR From'); if (cash) $('.rm-st', r).value = '';
        const sp = $('.rm-sp', r); sp.readOnly = !cash; sp.tabIndex = cash ? 0 : -1; sp.title = cash ? '' : 'Counted from OR From and OR To'; if (!cash) pcsFill(); };
      // Booklet No.: Amount = Pcs × the booklet's denomination (the collector's booklet of that No., else ₱5); typing either fills the other.
      const bnFace = () => { const n = +$('.rm-sf', r).value.replace(/\D/g, ''), cid = resolveCol($('#rm-col').value)?.id; const bs = f.booklets.filter((b) => b.form === 'cashbn' && b.bn === n);
        return faceOfBk(bs.find((b) => b.officerId === cid) || bs[0] || { form: 'cashbn' }); };
      $('.rm-sp', r).addEventListener('input', () => { if (!r.classList.contains('rm-bn')) return; const q = int($('.rm-sp', r).value); if (q) { $('.rm-sa', r).value = money(r2(q * bnFace())); total(); } });
      $('.rm-sa', r).addEventListener('input', () => { if (!r.classList.contains('rm-bn')) return; const a = num($('.rm-sa', r).value), fv = bnFace(); if (a && fv) { const q = a / fv; if (Math.abs(q - Math.round(q)) < 1e-6) $('.rm-sp', r).value = Math.round(q); } });
      $('.rm-sk', r).onchange = () => { r.dataset.picked = '1'; kind(); mvAmt(); };
      // AF 52 / 53 / 54, Cash Ticket (Serial): Amount = Pcs × the denomination of the booklet holding the numbers (computed, not typed).
      const mvF = () => MV_SER.includes($('.rm-sk', r).value);
      const serFace = (n) => { const fk = $('.rm-sk', r).value, cid = resolveCol($('#rm-col').value)?.id; const bs = f.booklets.filter((b) => b.form === fk && !b.noSerial && b.from <= n && n <= b.to);
        return faceOfBk(bs.find((b) => b.officerId === cid) || bs[0] || { form: fk }); };
      const mvAmt = () => { const sa = $('.rm-sa', r); sa.readOnly = mvF(); sa.tabIndex = mvF() ? -1 : 0; sa.title = mvF() ? 'Pcs × denomination' : '';
        if (!mvF()) return; const a = +$('.rm-sf', r).value.replace(/\D/g, ''), z = +$('.rm-st', r).value.replace(/\D/g, '') || a;
        if (!a || z < a || z - a > 5000) { sa.value = ''; total(); return; } let t = 0; for (let n = a; n <= z; n++) t += serFace(n); sa.value = money(r2(t)); total(); };
      function pcsFill() { const a = +$('.rm-sf', r).value.replace(/\D/g, ''), z = +$('.rm-st', r).value.replace(/\D/g, '') || a;
        if (!r.classList.contains('rm-cash')) { $('.rm-sp', r).value = a && z >= a ? z - a + 1 : ''; mvAmt(); return; }
        if (a && z >= a && (!$('.rm-sp', r).value || r.dataset.autopcs)) { $('.rm-sp', r).value = z - a + 1; r.dataset.autopcs = '1'; } }
      $('.rm-sp', r).addEventListener('input', () => { delete r.dataset.autopcs; });
      // The form from the booklet the number is in (Accountable Forms), unless chosen by hand.
      $('.rm-sf', r).addEventListener('change', () => { if (r.classList.contains('rm-bn')) return; const n = +$('.rm-sf', r).value.replace(/\D/g, ''); if (!n || r.dataset.picked) return pcsFill();
        const bk = f.booklets.find((x) => !x.noSerial && x.from <= n && n <= x.to && x.form !== 'chk');
        if (bk && REM_FORMS.some(([k]) => k === remForm(bk.form))) { $('.rm-sk', r).value = remForm(bk.form); kind(); } pcsFill(); });
      $('.rm-st', r).addEventListener('change', pcsFill);
      ['.rm-sf', '.rm-st'].forEach((k) => $(k, r).addEventListener('input', () => { if (!r.classList.contains('rm-cash')) pcsFill(); }));
      $('.rm-sa', r).onblur = () => { const v = num($('.rm-sa', r).value); if (v !== null) $('.rm-sa', r).value = money(v); total(); };
      ['.rm-sf', '.rm-st', '.rm-sa'].forEach((k) => { $(k, r).oninput = total; });
      { const sa = $('.rm-sa', r); sa.readOnly = mvF(); sa.tabIndex = mvF() ? -1 : 0; }
    };
    rows().forEach(wireRow); total();
    // The collector's report No.: already in another RCD of this LO, or already in the app on the collector's side → stopped;
    // already in this RCD → another series of it.
    const noCheck = (col) => { const no = nk($('#rm-no').value); if (!col || !no) return null;
      const mine = new Set(edGrp ? edGrp.map((x) => x.i) : []);
      const other = f.reports.find((r) => r.officerId === o.id && !r.pending && r.id !== selId && (r.remittances || []).some((m) => !m.fromCol && m.collectorId === col.id && nk(m.reportNo) === no));
      if (other) return { block: true, text: `${$('#rm-no').value.trim()} of ${col.name} is already in ${repName(other, K)} (${fmtDate(other.date)}). Check the number.` };
      const own = f.reports.find((r) => r.officerId === col.id && !r.pending && nk(r.no) === no && !(r.madeFrom && r.madeFrom.officerId === o.id));
      if (own) return { block: true, text: `${col.name}'s ${repName(own, own.kind)} is already in the app: tick it instead (Tick from the app).` };
      const here = typedNow().filter((m, i) => !mine.has(i) && m.collectorId === col.id && nk(m.reportNo) === no);
      if (here.length) return { block: false, text: `${$('#rm-no').value.trim()} is already in this ${K} (${here.length} series). It will be added as another series.` };
      return null; };
    const showNo = () => { const r = noCheck(resolveCol($('#rm-col').value)), el = $('#rm-nomsg'); el.className = `rm-nomsg ${r ? (r.block ? 'bad' : 'info') : ''}`; el.textContent = r ? r.text : ''; return r; };
    ['#rm-no', '#rm-col'].forEach((k) => { $(k).addEventListener('change', showNo); $(k).addEventListener('blur', showNo); });
    $('#rm-addser').onclick = (e) => { e.preventDefault(); newRow(); };
    const add = async () => {
      const date = $('#rm-date').value; let col = resolveCol($('#rm-col').value);
      const sers = rows().filter((r) => !blank(r));
      if (!date) { $('#rm-date').focus(); return bad('Enter the date received.'); }
      if (!sers.length) { $('.rm-sa', rows()[0]).focus(); return bad('Enter the amount.'); }
      if (!col && !$('#rm-col').value.trim()) { $('#rm-col').focus(); return bad('Type the collector\'s name.'); }
      const lines = [];
      for (const r of sers) {
        const amt = num($('.rm-sa', r).value), fr = $('.rm-sf', r).value.replace(/\D/g, ''), to = $('.rm-st', r).value.replace(/\D/g, '') || fr;
        const form = $('.rm-sk', r).value, cash = form === 'cashbn', pcs = cash ? (parseInt($('.rm-sp', r).value.replace(/\D/g, ''), 10) || 0) : 0;
        if (cash) { const bn = int($('.rm-sf', r).value); if (!(amt > 0)) { $('.rm-sa', r).focus(); return bad('Enter the amount of each series.'); } if (!pcs) { $('.rm-sp', r).focus(); return bad('Enter the pieces (Pcs) of the cash tickets.'); }
          lines.push({ fr: '', to: '', amt, form, pcs, bn: bn || 0 }); continue; }
        if (!(amt > 0)) { $('.rm-sa', r).focus(); return bad('Enter the amount of each series.'); }
        if (fr && +to < +fr) { $('.rm-st', r).focus(); return bad('OR To must not be before OR From.'); }
        if (fr && rangeOff(fr, to)) { $('.rm-st', r).focus(); return bad(`Check the OR range: ${rangeOff(fr, to)}. One remittance does not cover that many; correct OR From or OR To.`); }
        if (sers.length > 1 && !fr) { $('.rm-sf', r).focus(); return bad('Each series needs its OR From and OR To (only Cash Ticket (Booklet No.) has none).'); }
        lines.push({ fr, to, amt, form, pcs });
      }
      { const rs = lines.filter((x) => x.fr).map((x) => [+x.fr, +x.to]).sort((p, q) => p[0] - q[0]);
        for (let k = 1; k < rs.length; k++) if (rs[k][0] <= rs[k - 1][1]) return bad(`The series ${rs[k - 1][0]}–${rs[k - 1][1]} and ${rs[k][0]}–${rs[k][1]} overlap.`); }
      if (!col) {
        // Several names fit what was typed: choose one from the list; none fits: a new collector.
        const part = letters(cleanName($('#rm-col').value)), many = colsAll.filter((x) => letters(x.name).includes(part));
        if (many.length > 1) { $('#rm-col').focus(); return bad(`${many.length} collectors fit "${$('#rm-col').value.trim()}". Choose one from the list.`); }
        col = await newColModal($('#rm-col').value); if (!col) return;
      }
      { const r = noCheck(col); if (r && r.block) { showNo(); $('#rm-no').focus(); return bad(r.text); } }
      const ms = lines.map((x) => lineOf(date, col, $('#rm-no').value, x.fr, x.to, x.amt, x.form, x.pcs, x.bn));
      const gone = new Set(edGrp ? edGrp.map((x) => x.i) : []);
      const list = [...typedNow().filter((_, i) => !gone.has(i)), ...ms];
      if (await saveRems(list, true)) { toast(ms.length > 1 ? `Saved: ${ms[0].reportNo || 'the report'} with ${ms.length} series, ₱ ${money(r2(ms.reduce((n, m) => n + m.amount, 0)))}.` : 'Remittance saved.', 'ok');
        REM.key = selId; REM.i = -1; REM.date = date; setTimeout(() => { const el = $('#rm-col'); if (el) el.focus(); }, 350); }
    };
    // Enter: next box; on the last Amount, another series; on an empty series row (not the only one), save.
    $('#rm-form').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) return add();
      const r = e.target.closest('.rm-srow');
      if (r && blank(r) && rows().length > 1) { r.remove(); total(); return add(); }
      const els = order(), i = els.indexOf(e.target);
      if (i === els.length - 1) { if (blank(r)) return add(); return newRow(); }
      if (i >= 0) els[i + 1].focus();
    });
    $('#rm-add').onclick = add;
    if ($('#rm-cancel')) $('#rm-cancel').onclick = () => { REM.i = -1; emitChange('local'); };
  }
  $$('[data-rmedit]').forEach((b) => { b.onclick = () => { REM.key = selId; REM.i = +b.dataset.rmedit; emitChange('local'); setTimeout(() => { const el = $('#rm-srows .rm-sa'); if (el) { el.focus(); $('#rm-form').scrollIntoView({ block: 'center', behavior: 'smooth' }); } }, 350); }; });
  $$('[data-rmdel]').forEach((b) => { b.onclick = async () => { const gone = typedNow()[+b.dataset.rmdel], list = typedNow().filter((_, i) => i !== +b.dataset.rmdel); REM.i = -1;
    if (!(await saveRems(list, true))) return;
    // The collector's SCR / RCD made from this line, still without any OR: removed with it.
    const sh = gone && gone.reportId && !list.some((m) => m.reportId === gone.reportId) && f.reports.find((r) => r.id === gone.reportId && r.madeFrom && r.madeFrom.officerId === o.id);
    if (sh && !f.ors.some((x) => x.reportId === sh.id) && !(sh.deposits || []).some((d) => !d.fromLO)) await store.save('cer_reports', sh.id, strip(sh), by(refs), { deleted: true, quiet: true });
    toast('Remittance removed.', 'ok'); }; });
  if ($('#rm-tpl')) $('#rm-tpl').onclick = async (e) => { e.preventDefault();
    try { const XLSX = await loadXlsx(); const ws = XLSX.utils.aoa_to_sheet([['Date', 'Collector', 'Office (new collector only)', 'SCR/RCD No.', 'Form (blank = AF 51)', 'OR From', 'OR To', 'Pcs (cash tickets)', 'Amount'], ['01/14/2026', colsAll[0]?.name || 'JUAN DELA CRUZ', '', '2026-0189', '', 100001, 100050, '', 8456], ['01/14/2026', colsAll[0]?.name || 'JUAN DELA CRUZ', '', '2026-0189', 'Cash tickets', '', '', 120, 600]]);
      ws['!cols'] = [12, 30, 24, 14, 18, 12, 12, 16, 12].map((w) => ({ wch: w })); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Remittances'); XLSX.writeFile(wb, 'Remittances Received Template.xlsx'); } catch (err) { toast(err.message || String(err), 'bad'); } };
  if ($('#rm-imp')) $('#rm-imp').onclick = async () => {
    let plan = null;
    const read = async (file) => {
      const XLSX = await loadXlsx(); const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
      const hi = rows.findIndex((r) => r.some((x) => /date/i.test(String(x))) && r.some((x) => /amount/i.test(String(x)))); if (hi < 0) return { error: 'No header row with Date and Amount was found. Use the Template.' };
      const H = rows[hi].map((x) => String(x)), col = (re) => H.findIndex((x) => re.test(x));
      const M = { date: col(/date/i), col: col(/collector|name/i), off: col(/office|barangay/i), form: col(/^\s*form/i), pcs: col(/pcs|pieces|quantity|qty/i), no: col(/scr|rcd|report|\bno\b/i), from: col(/from/i), to: col(/\bto\b/i), amt: col(/amount/i) };
      const add = [], problems = [], fresh = new Map(), sameAs = [];
      rows.slice(hi + 1).forEach((r, i) => { const line = hi + i + 2, g = (k) => (M[k] < 0 ? '' : r[M[k]]);
        if (!String(g('col')).trim() && !g('amt')) return;
        const date = excelDate(XLSX, g('date')), amt = typeof g('amt') === 'number' ? r2(g('amt')) : num(g('amt'));
        let c0 = resolveCol(String(g('col')));
        if (c0 && letters(c0.name) !== letters(cleanName(g('col'))) && samePerson([c0], g('col')).length) { const t = sameAs.find((x) => x.typed === cleanName(g('col'))); if (t) t.rows++; else sameAs.push({ typed: cleanName(g('col')), name: c0.name, rows: 1 }); }
        if (!date) return problems.push({ line, why: 'Date is missing or not a date.' });
        if (!c0) {
          // Not in the app yet: a new collector (one per name), its office from the Office column or chosen below.
          const nm = cleanName(g('col')); if (!nm) return problems.push({ line, why: 'Collector is missing.' });
          const k = letters(nm); if (!fresh.has(k)) { const lid = officeOf(g('off')); fresh.set(k, { id: newId('cero'), name: nm, lguId: lid, designation: desigFor(lid), sim: similarTo(nm), rows: 0 }); }
          c0 = fresh.get(k); c0.rows++;
        }
        if (!(amt > 0)) return problems.push({ line, why: 'Amount is missing.' });
        { const fr = String(g('from') || '').replace(/\D/g, ''), to = String(g('to') || '').replace(/\D/g, '') || fr;
          if (fr && +to < +fr) return problems.push({ line, why: 'OR To is before OR From.' });
          if (fr && rangeOff(fr, to)) return problems.push({ line, why: `Check the OR range: ${rangeOff(fr, to)}.` }); }
        const ft = String(g('form') || '').toLowerCase(), fk = /cash/.test(ft) ? (/booklet|\bbn\b/.test(ft) || !String(g('to') || '').trim() ? 'cashbn' : 'cash') : /ctc|cedula/.test(ft) ? (/corp/.test(ft) ? 'ctcc' : 'ctci') : (ft.match(/5[2346]/) ? 'af' + ft.match(/5[2346]/)[0] : 'af51');
        if (fk !== 'cashbn' && !String(g('from') || '').trim() && String(g('to') || '').trim()) return problems.push({ line, why: 'OR From is missing.' });
        const bnX = fk === 'cashbn', m = lineOf(date, c0, String(g('no') || ''), bnX ? '' : g('from'), bnX ? '' : g('to'), amt, fk, bnX ? (parseInt(String(g('pcs') || '').replace(/\D/g, ''), 10) || 0) : 0, bnX ? (parseInt(String(g('from') || '').replace(/\D/g, ''), 10) || 0) : 0), d = dupOf(m);
        if (d) return problems.push({ line, why: `Already in ${c0.name}'s ${d.reportNo}: tick it instead.` });
        add.push(m); });
      return { add, problems, fresh: [...fresh.values()], sameAs };
    };
    const v = await modal({ title: 'Import Remittances Received', wide: true,
      body: `<p class="af-note">Excel columns: <b>Date, Collector, SCR/RCD No., OR From, OR To, Amount</b>; Form (blank = AF 51) and Pcs for cash tickets (Cash Ticket (Booklet No.): its Booklet No. in OR From, OR To blank); Office for a collector not yet in the app (see the Template). Remittances already in the collectors' records are skipped (tick them instead).</p><div class="field"><label for="rm-file">Excel file</label><input class="input" type="file" id="rm-file" accept=".xlsx,.xls,.csv"></div><div id="rm-res"></div>`,
      onOpen: (bg) => { $('#rm-file', bg).onchange = async (e) => { const fl = e.target.files[0]; if (!fl) return; try { plan = await read(fl); } catch (err) { plan = { error: err.message || String(err) }; }
        const nc = plan.fresh || [];
        $('#rm-res', bg).innerHTML = plan.error ? `<div class="msg bad">${esc(plan.error)}</div>` : `<div class="oi-sum"><b>${plan.add.length} remittance${plan.add.length === 1 ? '' : 's'} to add</b> · ₱ ${money(r2(plan.add.reduce((n, m) => n + m.amount, 0)))}</div>
          ${nc.length ? `<h3 class="cer-h3" style="margin-top:10px">New collectors: ${nc.length} <small class="dim">(not in the app yet; added with the import, choose each one's office)</small></h3>
            <div class="af-tbl"><table class="af-reg rm-newcols"><thead><tr><th>Name</th><th>Lines</th><th>Office</th><th>Designation</th></tr></thead><tbody>${nc.map((x, i) => `<tr><td><b>${esc(x.name)}</b>${x.sim.length ? `<div class="warn-t" style="font-size:12px">Similar: ${x.sim.map((y) => esc(cLabel(y))).join('; ')}. If the same person, fix the name in the Excel file.</div>` : ''}</td><td class="r">${x.rows}</td><td><select class="input" data-ncoff="${i}">${offOpts(x.lguId)}</select></td><td><input class="input" data-ncdes="${i}" value="${esc(x.designation)}"></td></tr>`).join('')}</tbody></table></div>` : ''}
          ${(plan.sameAs || []).length ? `<p class="hint" style="margin:8px 0 0"><b>Matched to a collector already in the app (same person):</b> ${plan.sameAs.map((x) => `${esc(x.typed)} → <b>${esc(x.name)}</b> (${x.rows} line${x.rows === 1 ? '' : 's'})`).join('; ')}. If one is a different person, correct the name in the Excel file.</p>` : ''}
          ${plan.problems.length ? `<div class="af-probs"><b>Not imported (${plan.problems.length})</b>${plan.problems.map((q) => `<div>Row ${q.line} — ${esc(q.why)}</div>`).join('')}</div>` : ''}`;
        $$('[data-ncoff]', bg).forEach((el) => { el.onchange = () => { const x = nc[+el.dataset.ncoff], d = $(`[data-ncdes="${el.dataset.ncoff}"]`, bg); if (d.value === x.designation) d.value = desigFor(el.value); x.lguId = el.value; x.designation = d.value; }; });
        $$('[data-ncdes]', bg).forEach((el) => { el.oninput = () => { nc[+el.dataset.ncdes].designation = el.value.trim(); }; }); }; },
      buttons: [{ label: 'Cancel', value: null }, { label: 'Import', cls: 'primary', value: 'go', check: () => { if (!plan || plan.error || !plan.add.length) { toast('Nothing to import.', 'bad'); return false; }
        const miss = (plan.fresh || []).filter((x) => !x.lguId); if (miss.length) { toast(`Choose the office of ${miss.map((x) => x.name).join(', ')}.`, 'bad'); return false; } return true; } }] });
    if (v !== 'go') return;
    if ((plan.fresh || []).length) await saveNewCols(plan.fresh.map(({ id, name, lguId, designation }) => ({ id, name, lguId, designation })));
    if (await saveRems([...typedNow(), ...plan.add], true)) toast(`${plan.add.length} remittance${plan.add.length === 1 ? '' : 's'} imported.`, 'ok');
  };
  const depBox = $('#cd-deps');
  // Cashbook only: typing the series fills the amount with the collections in it (the officer's ORs and lines by OR range,
  // and for an LO who collects, the remittances received with their series in it). A typed amount is kept.
  const nmx = (v) => String(v || '').toLowerCase().replace(/[^a-z]/g, '');
  const seriesTotal = (a, z) => r2(f.ors.filter((x) => x.officerId === o.id && x.status !== 'cancelled' && +x.serial >= a && (x.range ? +x.serialTo : +x.serial) <= z).reduce((n, x) => n + r2((x.items || []).reduce((m, i) => m + (+i.amt || 0), 0)), 0)
    + [...f.reports.filter((r) => r.officerId === o.id).flatMap((r) => (r.remittances || []).filter((m) => m.from)),
      ...f.reports.filter((r) => r.officerId !== o.id).flatMap((r) => (r.deposits || []).filter((d) => d.toLO && d.from && nmx(d.ref) === nmx(o.name)).map((d) => ({ ...d, collectorId: r.officerId })))]
      .filter((m, i, all) => all.findIndex((y) => y.collectorId === m.collectorId && String(y.from) === String(m.from)) === i)
      .filter((m) => +m.from >= a && +(m.to || m.from) <= z).reduce((n, m) => n + (+m.amount || 0), 0));
  const wireSeries = (box) => $$('tr', box).forEach((tr) => {
    const fi = $('[data-k="from"]', tr), ti = $('[data-k="to"]', tr), am = $('[data-k="amount"]', tr); if (!fi || !ti || !am) return;
    const fill = () => { const a = +fi.value.replace(/\D/g, ''), z = +(ti.value.replace(/\D/g, '') || a); if (!a || z < a) return;
      if (am.value.trim() && am.dataset.auto !== '1') return;
      const t = seriesTotal(a, z); am.value = t ? money(t) : ''; am.dataset.auto = t ? '1' : ''; };
    fi.addEventListener('change', fill); ti.addEventListener('change', fill); ti.addEventListener('input', () => { if (ti.value.replace(/\D/g, '').length >= fi.value.replace(/\D/g, '').length) fill(); });
    am.addEventListener('input', () => { am.dataset.auto = ''; });
  });
  if (depBox) {
    wireRows(depBox); if (c.cbook) wireSeries(depBox);
    const SERS = depBox.dataset.sers ? JSON.parse(depBox.dataset.sers) : null;
    // A line's check: its amount against the collections of its series.
    const serPaint = (tr) => { if (!SERS) return; const sel = $('[data-k="ser"]', tr), cell = $('.cd-serchk2', tr), am = num($('[data-k="amount"]', tr).value);
      if (!sel || !cell) return; const x = SERS[+sel.value]; if (sel.value === '' || !x || am === null) { cell.innerHTML = ''; return; }
      const df = r2(am - x[3]); cell.innerHTML = Math.abs(df) < 0.005 ? '<span class="pill p-done">Agrees</span>' : `<span class="pill p-flag" title="Collections in the series ₱${money(x[3])}">₱${money(Math.abs(df))} ${df > 0 ? 'more than the ORs' : 'less than the ORs'}</span>`; };
    if (SERS) $$('tr', depBox).forEach((tr) => { ['[data-k="ser"]', '[data-k="amount"]'].forEach((k) => { const el = $(k, tr); if (el) { el.addEventListener('input', () => serPaint(tr)); el.addEventListener('change', () => serPaint(tr)); } }); });
    // One remittance for the RCD: its amount(s) against the total collections of the series.
    const bd = $('#cd-serbd');
    const bdPaint = () => { if (!bd) return; const tot = +bd.dataset.tot || 0, am = r2($$('[data-k="amount"]', depBox).reduce((t, i) => t + (num(i.value) || 0), 0) + (+bd.dataset.lo || 0)), df = r2(am - tot);
      $('#cd-serbdc').innerHTML = !am ? '' : Math.abs(df) < 0.005 ? `<span class="pill p-done">Remitted ₱${money(am)} · agrees with the collections</span>` : `<span class="pill p-flag">Remitted ₱${money(am)} · ₱${money(Math.abs(df))} ${df > 0 ? 'more than' : 'less than'} the collections</span>`; };
    if (bd) { depBox.addEventListener('input', bdPaint); bdPaint(); }
    { const cb = $('#cd-combine'); if (cb) cb.onclick = async () => {
      const all = (cur.rec?.deposits || []).filter((d) => !d.fromLO), ps = all.filter((d) => d.toLO && d.from);
      const one = { date: ps.map((d) => d.date).sort()[0], ref: ps[0].ref, amount: r2(ps.reduce((t, d) => t + (+d.amount || 0), 0)), toLO: true };
      const ok = await modal({ title: 'Combine into one remittance?', body: `<p style="margin:0">${ps.length} remittances (one per series) become one of ₱${money(one.amount)} dated ${esc(fmtDate(one.date))} to ${esc(one.ref)}. If the Liquidating Officer already ticked them, tick the combined one again in her RCD.</p>`, buttons: [{ label: 'Cancel', value: false }, { label: 'Combine', cls: 'primary', value: true }] });
      if (!ok) return;
      await pendRec({ deposits: [...all.filter((d) => !ps.includes(d)), one].sort((a, b) => String(a.date).localeCompare(String(b.date))) }); toast('Combined into one remittance.', 'ok'); }; }
    $('#cd-adddep').onclick = (ev) => { const t = document.createElement('tbody'); t.innerHTML = depRowHtml(c.K === 'SCR' || c.toLO, c.toLO, c.cbook, null);
      if (SERS && ev && ev.isTrusted) { const tr0 = t.firstElementChild; $('[data-k="date"]', tr0).value = depBox.dataset.rdate || ''; $('[data-k="ref"]', tr0).value = depBox.dataset.lastlo || ''; }
      if (c.cbook) { const tos = $$('[data-k="to"]', depBox).map((i) => +i.value || 0); const nx = Math.max(+depBox.dataset.next || 0, ...tos.map((v) => (v ? v + 1 : 0))); const fi = $('[data-k="from"]', t.firstElementChild); if (fi && nx) fi.value = nx; } const tr = t.firstElementChild; depBox.appendChild(tr); wireRows(depBox); if (c.cbook) wireSeries(tbodyOf(tr)); $('input', tr).focus(); };
    if (!depBox.children.length) $('#cd-adddep').click();
    $('#cd-savedep').onclick = async () => {
      const list = [];
      for (const tr of $$('tr', depBox).filter((x) => !x.classList.contains('cd-lolock'))) {
        const g = (k) => { const el = $(`[data-k="${k}"]`, tr); return el ? el.value.trim() : ''; };
        if (!g('date') && !g('amount') && !g('ref') && !g('no')) continue;
        if (!g('date')) return bad('Enter the date of each deposit.');
        const amt = num(g('amount')); if (!amt) return bad('Enter the amount of each deposit.');
        let sf = g('from').replace(/\D/g, ''), stt = g('to').replace(/\D/g, '') || sf, fk = '';
        if (SERS && $('[data-k="ser"]', tr)) { const x = SERS[+g('ser')]; if (g('ser') === '' || !x) return bad('Choose the OR series of each remittance.'); sf = String(x[0]); stt = String(x[1]); fk = x[2] || ''; }
        if (sf && +stt < +sf) return bad('OR To must not be before OR From.');
        list.push({ date: g('date'), ref: K === 'SCR' || c.toLO ? loCanon(refs, f, c.lgu, g('ref')) : g('ref'), ...(g('no') ? { no: g('no') } : {}), amount: amt, ...(c.toLO ? { toLO: true } : {}), ...(sf ? { from: sf, to: stt } : {}), ...(fk ? { form: fk } : {}) });
      }
      list.sort((a, b) => a.date.localeCompare(b.date));
      // Not typed twice: a remittance the Liquidating Officer already recorded (shown from the LO's RCD) is not saved again.
      const fromLo = Object.values(c.fig.chains).flatMap((ch) => [...ch.figs, ch.pend]).flatMap((g) => (g.rec?.deposits || []).filter((d) => d.fromLO));
      const was = (cur.rec?.deposits || []).filter((d) => !d.fromLO);
      for (const d of list) {
        if (was.some((w) => w.date === d.date && Math.abs(w.amount - d.amount) < 0.005)) continue;
        const dup = fromLo.find((x) => (x.from && d.from && String(x.from) === String(d.from)) || (x.date === d.date && Math.abs(x.amount - d.amount) < 0.005));
        if (dup) return bad(`Already recorded in ${dup.ref}'s RCD${dup.loReportNo ? ' No. ' + dup.loReportNo : ''} (${fmtDate(dup.date)}, ₱${money(dup.amount)}). No need to type it here.`);
      }
      await pendRec({ deposits: list }); toast(K === 'SCR' || c.toLO ? 'Remittances saved.' : 'Deposits saved.', 'ok');
    };
  }
  $$('[data-edit]').forEach((b) => { b.onclick = () => editOrModal(c, f.ors.find((x) => x.id === b.dataset.edit)); });
  // Encoded ORs: kept where it was after a change in the list, else scrolled to the latest OR No.
  const box = $('.cd-orscroll');
  if (box) { if (LASTC.scroll !== undefined && LASTC.scroll !== null) { box.scrollTop = LASTC.scroll; LASTC.scroll = null; } else box.scrollTop = box.scrollHeight; }
  // Click a particular or an amount to change it in place (ORs with one particular).
  const cellEdit = (td, kind) => {
    if (td.querySelector('input')) return;
    const x = f.ors.find((y) => y.id === (td.dataset.ip || td.dataset.ia)); if (!x) return;
    const it = (x.items || [])[0] || { p: NO_PART, amt: x.amount || 0 };
    const was = td.innerHTML;
    td.innerHTML = kind === 'p' ? `<input class="input af-sm cd-cell" list="cd-parts" value="${esc(it.p === NO_PART ? '' : it.p)}" placeholder="${NO_PART}" aria-label="Particular of OR ${x.serial}">`
      : `<input class="input af-sm r cd-cell" inputmode="decimal" value="${esc(money(it.amt))}" aria-label="Amount of OR ${x.serial}">`;
    const inp = $('input', td); inp.focus(); inp.select();
    let done = false;
    const finish = async (save) => {
      if (done) return; done = true;
      if (!save) { td.innerHTML = was; return; }
      const v = inp.value.trim().replace(/\s+/g, ' ');
      const next = kind === 'p' ? { p: v || NO_PART, amt: it.amt } : { p: it.p, amt: num(v) };
      if (kind === 'a' && (next.amt === null || next.amt <= 0)) { toast('Enter an amount more than zero.', 'bad'); td.innerHTML = was; return; }
      if (next.p === it.p && next.amt === it.amt) { td.innerHTML = was; return; }
      LASTC.scroll = box ? box.scrollTop : null;
      await store.save('cer_ors', x.id, { ...strip(x), items: [next], amount: r2(next.amt) }, by(refs));
      toast(`OR ${x.serial} ${kind === 'p' ? 'particular' : 'amount'} saved.`, 'ok');
    };
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } if (e.key === 'Escape') finish(false); };
    inp.onblur = () => finish(true);
  };
  // Click a date to change it in place (any OR or line); the OR stays in its report, "Before the period" follows the new date.
  $$('td[data-id8]').forEach((td) => { const open = () => { if (td.querySelector('input')) return; const x = f.ors.find((y) => y.id === td.dataset.id8); if (!x) return;
    const was = td.innerHTML; td.innerHTML = `<input class="input af-sm cd-cell" type="date" value="${esc(x.date || '')}" aria-label="Date of OR ${esc(x.serial)}">`;
    const inp = $('input', td); inp.focus(); let done = false;
    const finish = async (save) => { if (done) return; done = true; const v = inp.value;
      if (!save || !v || v === x.date) { td.innerHTML = was; return; }
      if (c.audit.countDate && v > c.audit.countDate) { const ok = await modal({ title: 'Date after the cash count?', body: `<p style="margin:0">The date ${esc(fmtDate(v))} is after the cash count on ${esc(fmtDate(c.audit.countDate))}. Save it anyway?</p>`, buttons: [{ label: 'Go back', value: false }, { label: 'Save', cls: 'primary', value: true }] }); if (!ok) { td.innerHTML = was; return; } }
      const { beg, ...rest } = strip(x), nb = begOr(f, { ...x, date: v }, c.exam.lastExamDate, begRangesOf(c.exam));
      LASTC.scroll = box ? box.scrollTop : null;
      await store.save('cer_ors', x.id, { ...rest, date: v, ...(nb ? { beg: true } : {}) }, by(refs));
      toast(`${x.bnLine ? bnLineText(f, x) : `OR ${x.serial}`}: date ${fmtDate(v)} saved.`, 'ok'); };
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } if (e.key === 'Escape') finish(false); };
    inp.onblur = () => finish(true); };
    td.onclick = open; td.onkeydown = (e) => { if (e.key === 'Enter') open(); }; });
  $$('td[data-ip]').forEach((td) => { td.onclick = () => cellEdit(td, 'p'); td.onkeydown = (e) => { if (e.key === 'Enter') cellEdit(td, 'p'); }; });
  $$('td[data-ia]').forEach((td) => { td.onclick = () => cellEdit(td, 'a'); td.onkeydown = (e) => { if (e.key === 'Enter') cellEdit(td, 'a'); }; });
  const imp = $('#cd-orimp'); if (imp) imp.onclick = () => importOrs(c);
  const tpl = $('#cd-ortpl'); if (tpl) tpl.onclick = async (e) => { e.preventDefault(); try { const XLSX = await loadXlsx(); const ws = XLSX.utils.aoa_to_sheet([['Date', 'OR No.', 'Particular', 'Amount']]); ws['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 40 }, { wch: 12 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'ORs'); XLSX.writeFile(wb, 'OR Import Template.xlsx'); } catch (err) { toast(err.message || String(err), 'bad'); } };

  /* By OR range */
  $$('[data-cmode]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); LASTC.mode = a.dataset.cmode; emitChange('local'); }; });
  $$('[data-rgdel]').forEach((b) => { b.onclick = async () => { const x = f.ors.find((y) => y.id === b.dataset.rgdel);
    const ok = await modal({ title: `Delete ${x.bnLine ? bnLineText(f, x) : `${x.serial}–${x.serialTo}`}?`, body: '<p style="margin:0">Only for an encoding mistake.</p>', buttons: [{ label: 'Keep', value: false }, { label: 'Delete', cls: 'danger', value: true }] });
    if (ok) { const { id, ...rec } = x; await store.save('cer_ors', id, rec, by(refs), { deleted: true }); toast('Range deleted.', 'ok'); } }; });
  if ($('#rg-a')) $('#rg-a').onchange = (e) => store.save('cer_settings', 'orrange|' + o.id, { noA: !e.target.checked }, by(refs));
  if ($('#rg-enter')) {
    const amt = $('#rg-amt'); amt.onblur = () => { const v = num(amt.value); if (v !== null) amt.value = money(v); };
    const saveRg = async () => {
      const form = $('#cd-form').value, date = $('#rg-date').value, a = +String($('#rg-from').value).replace(/\D/g, ''), z = +String($('#rg-to').value).replace(/\D/g, ''), tot = num(amt.value);
      if (!date) return bad('Enter the date.'); if (!a || !z || z < a) return bad('Enter the OR range (From must not be after To).');
      if (z - a > 4999) return bad('That range is too long. Check the numbers.');
      if (tot === null || tot < 0) return bad('Enter the total.');
      const hit = f.ors.find((x) => x.form === form && +x.serial <= z && a <= maxSer(x));
      if (hit) return bad(`${FORM_SHORT[form] || form} ${hit.range ? `${hit.serial}–${hit.serialTo}` : hit.serial} is already encoded (${fmtDate(hit.date)}).`);
      const cx = [...new Set(String($('#rg-cx').value).split(/[^\d]+/).filter(Boolean).map(Number))].filter((n) => n >= a && n <= z);
      const bk = c.bks.find((b) => b.from <= a && a <= b.to) || f.booklets.find((b) => b.form === form && b.officerId === o.id && b.from <= a && a <= b.to) || null;
      const beg = begOr(f, { date, serial: a, bookletId: bk ? bk.id : '', officerId: o.id, form, range: true, serialTo: z }, c.exam.lastExamDate, begRangesOf(c.exam));
      const rec = { lguId: audit.lguId, officerId: o.id, form, bookletId: bk ? bk.id : '', serial: a, serialTo: z, range: true, date, status: 'issued', items: [{ p: 'Collections (by OR range)', amt: r2(tot) }], amount: r2(tot), fund: c.curFund,
        reportId: c.cur.pending || hasRange(c.cur) ? placeIn(c.fig.chains[c.curKey], date, a, form) : c.selId, ...(cx.length ? { cancelledNos: cx } : {}), ...(beg ? { beg: true } : {}) };
      Object.assign(LASTC, { date, rgNext: String(z + 1) });
      await store.save('cer_ors', newId('ceror'), rec, by(refs));
      toast(`${a}–${z} saved${beg ? ' (before the period: in the beginning balance)' : ''}.`, 'ok');
      setTimeout(() => { const el = $('#rg-to'); if (el) el.focus(); }, 80);
    };
    $('#rg-enter').onclick = saveRg;
    $('#cd-rgform').onkeydown = (e) => { if (e.key !== 'Enter') return; e.preventDefault(); const els = ['#rg-date', '#rg-from', '#rg-to', '#rg-amt', '#rg-cx'].map((k) => $(k)); const i = els.indexOf(e.target); if (i < 0 || i >= els.length - 2) saveRg(); else els[i + 1].focus(); };
  }
  if ($('#cd-form') && LASTC.mode === 'range') $('#cd-form').onchange = (e) => { Object.assign(LASTC, { form: e.target.value, bookletId: '', serial: '' }); emitChange('local'); };

  // The OR Range's "to go" link: the entry line jumps to the next number not yet encoded (every kind of entry line).
  { const gm = $('#cd-gomiss'); if (gm) gm.onclick = (e) => { e.preventDefault(); LASTC.goMiss = true; emitChange('local'); }; }
  /* AF 52 / 53 / 54, Cash Ticket (Serial): Date | OR From | OR To | Pcs | Value | Amount, each OR saved at the denomination */
  if ($('#mv-enter')) {
    $('#cd-form').onchange = (e) => { Object.assign(LASTC, { form: e.target.value, bookletId: '', serial: '' }); emitChange('local'); };
    $('#cd-bk').onchange = (e) => { Object.assign(LASTC, { form: $('#cd-form').value, bookletId: e.target.value || '__none', serial: '' }); emitChange('local'); };
    const form = $('#cd-form').value, fromIn = $('#mv-from'), toIn = $('#mv-to'), cxIn = $('#mv-cx');
    const bkAt = (n) => f.booklets.find((b) => b.officerId === o.id && b.form === form && !b.noSerial && b.from <= n && n <= b.to) || null;
    const faceAt = (n) => faceOfBk(bkAt(n) || { form });
    const allCx = () => LASTC.mvSt === 'cancelled';
    $$('[data-mvst]').forEach((x) => { x.onclick = (e) => { e.preventDefault(); LASTC.mvSt = x.dataset.mvst; $$('[data-mvst]').forEach((y) => { y.classList.toggle('on', y === x); y.setAttribute('aria-pressed', y === x); }); cxIn.closest('.sd-f').style.display = allCx() ? 'none' : ''; paint(); }; });
    const read = () => { const a = int(fromIn.value), z = int(toIn.value) || a;
      const cx = allCx() && a && z >= a && z - a < 500 ? Array.from({ length: z - a + 1 }, (_, i) => a + i) : [...new Set(String(cxIn.value).split(/[^\d]+/).filter(Boolean).map(Number))];
      return { a, z, cx, ok: a && z >= a && z - a < 500 }; };
    const paint = () => { const r = read();
      if (!r.ok) { $('#mv-pcs').value = ''; $('#mv-amt').value = ''; return; }
      let q = 0, amt = 0; for (let n = r.a; n <= r.z; n++) if (!r.cx.includes(n)) { q++; amt += faceAt(n); }
      $('#mv-pcs').value = q; $('#mv-val').value = money(faceAt(r.a)); $('#mv-amt').value = money(r2(amt)); };
    [fromIn, toIn, cxIn].forEach((el) => { el.oninput = paint; });
    $('#mv-date').onchange = () => { LASTC.date = $('#mv-date').value; };
    const saveMv = async () => {
      const date = $('#mv-date').value, r = read();
      if (!date) return bad('Enter the date.');
      if (!r.a) return bad('Enter the OR From.');
      if (r.z < r.a) return bad('OR To must not be before OR From.');
      if (r.z - r.a >= 500) return bad('That range is too long (500 at most). Check the numbers.');
      const out = r.cx.filter((n) => n < r.a || n > r.z); if (out.length) return bad(`Cancelled ${out.join(', ')} is outside ${r.a}–${r.z}.`);
      const done = f.ors.filter((x) => x.form === form && !x.bnLine && +x.serial <= r.z && r.a <= maxSer(x));
      if (done.length) return bad(`${FORM_SHORT[form] || form} ${done[0].range ? `${done[0].serial}–${done[0].serialTo}` : done[0].serial} is already encoded (${fmtDate(done[0].date)}).`);
      if (c.rMode) { for (let n = r.a; n <= r.z; n++) if (!inRec(c.rRec, n, form)) return bad(`${FORM_SHORT[form] || form} ${n} is not in the OR Range of ${repName(c.cur.rec, K)} (${rangesShow(c.rRec)}). Check the numbers, or choose "Not yet in an ${K}" to encode ORs of another report.`); }
      if (c.audit.countDate && date > c.audit.countDate) { const ok = await modal({ title: 'Date after the cash count?', body: `<p style="margin:0">The date ${esc(fmtDate(date))} is after the cash count on ${esc(fmtDate(c.audit.countDate))}. Save it anyway?</p>`, buttons: [{ label: 'Go back', value: false }, { label: 'Save', cls: 'primary', value: true }] }); if (!ok) return; }
      const p = FIXED_PART[form] || NO_PART, lx = c.exam.lastExamDate, br = begRangesOf(c.exam);
      $('#mv-enter').disabled = true;
      try {
        let q = 0, tot = 0;
        for (let n = r.a; n <= r.z; n++) {
          const b = bkAt(n), cxd = r.cx.includes(n), fv = faceAt(n);
          const rec = { lguId: audit.lguId, officerId: o.id, form, bookletId: b ? b.id : '', serial: n, date, status: cxd ? 'cancelled' : 'issued', items: cxd ? [] : [{ p, amt: fv }], amount: cxd ? 0 : fv, fund: c.curFund,
            reportId: c.cur.pending || hasRange(c.cur) ? placeIn(c.fig.chains[c.curKey], date, n, form) : c.selId,
            ...(begOr(f, { date, serial: n, bookletId: b ? b.id : '', officerId: o.id, form }, lx, br) ? { beg: true } : {}) };
          await store.save('cer_ors', newId('ceror'), rec, by(refs), { quiet: true });
          if (!cxd) { q++; tot += fv; }
        }
        const last = bkAt(r.z);
        Object.assign(LASTC, { form, date, bookletId: last ? last.id : LASTC.bookletId, serial: last && r.z < last.to ? r.z + 1 : '', goMiss: !!c.rMode });
        emitChange('local');
        toast(`${FORM_SHORT[form] || form} ${r.a === r.z ? r.a : `${r.a}–${r.z}`} saved: ${q} issued · ₱${money(r2(tot))}${r.cx.length ? ` · ${r.cx.length} cancelled` : ''}.`, 'ok');
        setTimeout(() => { const el = $('#mv-date'); if (el) el.focus(); }, 80);   // the date is what changes next
      } finally { const btn = $('#mv-enter'); if (btn) btn.disabled = false; }
    };
    $('#mv-enter').onclick = saveMv;
    $('#cd-mvform').onkeydown = (e) => { if (e.key !== 'Enter') return; e.preventDefault(); const els = ['#mv-date', '#mv-from', '#mv-to', '#mv-cx'].map((k) => $(k)).filter((el) => el.offsetParent !== null); const i = els.indexOf(e.target); if (i < 0 || i >= els.length - 1) saveMv(); else els[i + 1].focus(); };
    paint();
  }

  /* Cash Ticket (Booklet No.) entry: Date | Booklet No. | Pcs | Value | Amount */
  if ($('#bn-enter')) {
    $('#cd-form').onchange = (e) => { Object.assign(LASTC, { form: e.target.value, bookletId: '', serial: '' }); emitChange('local'); };
    const bkSel = $('#bn-bk'), pcsIn = $('#bn-pcs'), amtIn = $('#bn-amt'), valIn = $('#bn-val');
    const face = () => +(bkSel.selectedOptions[0]?.dataset.face || 0), left = () => +(bkSel.selectedOptions[0]?.dataset.left || 0);
    bkSel.onchange = () => { LASTC.bnBk = bkSel.value; valIn.value = face() ? money(face()) : ''; if (int(pcsIn.value)) amtIn.value = money(r2(int(pcsIn.value) * face())); };
    pcsIn.oninput = () => { const q = int(pcsIn.value); amtIn.value = q && face() ? money(r2(q * face())) : ''; };
    amtIn.oninput = () => { const a = num(amtIn.value); if (a && face()) { const q = a / face(); pcsIn.value = Math.abs(q - Math.round(q)) < 1e-6 ? Math.round(q) : ''; } };
    amtIn.onblur = () => { const v = num(amtIn.value); if (v !== null) amtIn.value = money(v); };
    const saveBn = async () => {
      const b = f.booklets.find((x) => x.id === bkSel.value), date = $('#bn-date').value, q = int(pcsIn.value), p = $('#bn-part').value.trim().replace(/\s+/g, ' ') || FIXED_PART.cashbn;
      if (!date) return bad('Enter the date.');
      if (!b) return bad('Choose the Booklet No.');
      const a = num(amtIn.value);
      if (!q) return bad(a ? `₱${money(a)} is not a whole number of ₱${money(face())} tickets. Check the amount.` : 'Enter the pieces (Pcs) or the amount.');
      if (q > left()) return bad(`BN. ${b.bn} has only ${left().toLocaleString('en-US')} pieces left.`);
      const amt = r2(q * face());
      if (c.audit.countDate && date > c.audit.countDate) { const ok = await modal({ title: 'Date after the cash count?', body: `<p style="margin:0">The date ${esc(fmtDate(date))} is after the cash count on ${esc(fmtDate(c.audit.countDate))}. Save it anyway?</p>`, buttons: [{ label: 'Go back', value: false }, { label: 'Save', cls: 'primary', value: true }] }); if (!ok) return; }
      const lx = c.exam.lastExamDate;
      const rec = { lguId: audit.lguId, officerId: o.id, form: 'cashbn', bookletId: b.id, bnLine: true, range: true, pcs: q, date, status: 'issued', items: [{ p, amt }], amount: amt, fund: c.curFund,
        reportId: c.cur.pending || hasRange(c.cur) ? placeIn(c.fig.chains[c.curKey], date, 0, 'cashbn') : c.selId, ...(lx && date < lx ? { beg: true } : {}) };
      $('#bn-enter').disabled = true;
      try {
        Object.assign(LASTC, { date, bnBk: b.id, bnPart: p, form: 'cashbn' });
        await store.save('cer_ors', newId('ceror'), rec, by(refs));
        toast(`BN. ${b.bn} · ${q} pcs · ₱${money(amt)} saved.`, 'ok');
        setTimeout(() => { const el = $('#bn-date'); if (el) el.focus(); }, 80);
      } finally { const btn = $('#bn-enter'); if (btn) btn.disabled = false; }
    };
    $('#bn-enter').onclick = saveBn;
    $('#cd-bnform').onkeydown = (e) => { if (e.key !== 'Enter') return; e.preventDefault(); const els = ['#bn-date', '#bn-bk', '#bn-pcs', '#bn-amt', '#bn-part'].map((k) => $(k)); const i = els.indexOf(e.target); if (i < 0 || i >= els.length - 1) saveBn(); else els[i + 1].focus(); };
  }

  /* Collections entry */
  const enter = $('#cd-enter');
  if (!enter) return;
  const orIn = $('#cd-or'), dateIn = $('#cd-ordate'), rows = $('#cd-prows');
  const bkOf = () => c.bks.find((b) => b.id === $('#cd-bk').value) || null;
  $('#cd-form').onchange = (e) => { Object.assign(LASTC, { form: e.target.value, bookletId: '', serial: '' }); emitChange('local'); };
  $('#cd-bk').onchange = (e) => { Object.assign(LASTC, { form: $('#cd-form').value, bookletId: e.target.value || '__none', serial: '' }); emitChange('local'); };
  $('#cd-autonext').onchange = (e) => { LASTC.auto = e.target.checked; };
  dateIn.onchange = () => { LASTC.date = dateIn.value; };
  const total = () => { const t = $$('.cd-a', rows).reduce((n, i) => n + (num(i.value) || 0), 0); $('#cd-ortot').textContent = '₱ ' + money(LASTC.status === 'cancelled' ? 0 : t); $('#cd-ortotbox').hidden = $$('.cd-prow', rows).length < 2 || LASTC.status === 'cancelled'; };
  const wireParts = () => {
    $$('.cd-prow', rows).forEach((r) => {
      $('.cd-x', r).onclick = () => { if ($$('.cd-prow', rows).length > 1 && !r.contains(dateIn)) r.remove(); else { $('.cd-p', r).value = ''; $('.cd-a', r).value = ''; } total(); };
      $('.cd-a', r).oninput = total;
      $('.cd-a', r).onblur = (e) => { const v = num(e.target.value); if (v !== null) e.target.value = money(v); };
      $('.cd-a', r).onkeydown = (e) => { if (e.key !== 'Enter') return; e.preventDefault(); if (e.altKey) addPart(); else enter.click(); };
      $('.cd-p', r).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('.cd-a', r).focus(); } };
    });
  };
  function addPart() { addPartRow(); }
  const addPartRow = () => { const n = $$('.cd-prow', rows).length; const d = document.createElement('div'); d.innerHTML = partRowHtml(n); const r0 = d.firstElementChild; for (let k = 0; k < 4; k++) r0.prepend(document.createElement('span')); r0.append(document.createElement('span')); rows.appendChild(d.firstElementChild); wireParts(); $$('.cd-p', rows).pop().focus(); };
  $('#cd-addp').onclick = addPart;
  // Date → Enter → first particular (a cancelled OR is saved right away).
  dateIn.onkeydown = (e) => { if (e.key !== 'Enter') return; e.preventDefault(); LASTC.date = dateIn.value; if (LASTC.status === 'cancelled') enter.click(); else if (FIXED_PART[$('#cd-form').value] && $('.cd-p', rows).value.trim()) $('.cd-a', rows).focus(); else $('.cd-p', rows).focus(); };
  wireParts(); total();
  $$('[data-st]').forEach((a) => { a.onclick = (e) => {
    e.preventDefault(); LASTC.status = a.dataset.st;
    $$('[data-st]').forEach((x) => { x.classList.toggle('on', x === a); x.setAttribute('aria-pressed', String(x === a)); });
    $('#cd-partsbox').classList.toggle('cd-cxl', LASTC.status === 'cancelled'); $('#cd-addp').hidden = LASTC.status === 'cancelled'; total();
  }; });
  // Skipped-OR notice: numbers between the last one encoded in the booklet and this OR No.
  const skipBox = $('#cd-skip');
  const checkSkip = () => {
    skipBox.innerHTML = '';
    const b = bkOf(), n = int(orIn.value);
    if (!b || !n || n < b.from || n > b.to) return;
    // Used numbers per the Forms Register: the ORs encoded and the numbers already used at the beginning (partly used).
    const un = bookletUnused(b), isUn = (x) => un.some(([a, z]) => a <= x && x <= z);
    let last = b.from - 1; for (let x = n - 1; x >= b.from; x--) if (!isUn(x)) { last = x; break; }
    const gap = []; for (let x = last + 1; x < n; x++) if (isUn(x)) gap.push(x);
    if (!gap.length) return;
    const txt = gap.length === 1 ? `<b>${gap[0]} was skipped.</b>` : `<b>${gap[0]} – ${gap[gap.length - 1]} were skipped (${gap.length}).</b>`;
    skipBox.innerHTML = `<div class="cer-alert" role="status"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4"/><path d="M12 17h.01"/></svg>
      <span>${txt} ${last >= b.from ? `The last number used in this booklet is ${last}.` : 'No number of this booklet is used yet.'}</span>
      <span class="cd-skipbtns"><button class="btn sm" type="button" id="cd-skipc">Encode ${gap.length === 1 ? gap[0] : 'them'} as Cancelled</button><button class="btn sm" type="button" id="cd-skipl">Leave as skipped</button></span></div>`;
    $('#cd-skipl').onclick = () => { skipBox.innerHTML = ''; };
    $('#cd-skipc').onclick = async () => {
      if (!dateIn.value) return bad('Enter the date of collection first.');
      if (gap.length > 100) return bad('That is more than 100 numbers. Check the OR No.');
      for (const s of gap) await store.save('cer_ors', newId('ceror'), orData(c, b, s, dateIn.value, 'cancelled', []), by(refs), { quiet: true });
      Object.assign(LASTC, { serial: n, date: dateIn.value, form: $('#cd-form').value, bookletId: b.id, focus: 'or' });
      emitChange('local'); toast(`${gap.length} OR${gap.length > 1 ? 's' : ''} encoded as Cancelled.`, 'ok');
    };
  };
  orIn.oninput = checkSkip; checkSkip();
  orIn.onkeydown = (e) => { if (e.key !== 'Enter') return; e.preventDefault(); dateIn.focus(); };
  enter.onclick = async () => {
    const b = bkOf(), n = int(orIn.value), date = dateIn.value, st = LASTC.status === 'cancelled' ? 'cancelled' : 'issued';
    if (!n) return bad('Enter the OR No.');
    if (!date) return bad('Enter the date of collection.');
    if (b && (n < b.from || n > b.to)) return bad(`OR No. ${n} is outside the booklet ${b.from} – ${b.to}. Choose the right booklet.`);
    const form = $('#cd-form').value;
    if (c.rMode && !inRec(c.rRec, n, form)) return bad(`${FORM_SHORT[form] || form} ${n} is not in the OR Range of ${repName(c.cur.rec, K)} (${rangesShow(c.rRec)}). Check the number, or choose "Not yet in an ${K}" to encode ORs of another report.`);
    if (f.ors.some((x) => x.form === form && x.serial === n)) return bad(`${FORM_SHORT[form] || form} ${n} is already encoded.`);
    const items = [];
    if (st === 'issued') {
      for (const r of $$('.cd-prow', rows)) {
        const p = $('.cd-p', r).value.trim().replace(/\s+/g, ' '), a = num($('.cd-a', r).value);
        if (!p && !a) continue;
        if (!p) return bad('Type the particular for each amount.');
        if (!a || a <= 0) return bad(`Enter the amount of "${p}".`);
        items.push({ p, amt: a });
      }
      if (!items.length) return bad('Enter at least one particular and its amount, or mark the OR as Cancelled.');
    }
    if (c.audit.countDate && date > c.audit.countDate) { const ok = await modal({ title: 'Date after the cash count?', body: `<p style="margin:0">The date ${esc(fmtDate(date))} is after the cash count on ${esc(fmtDate(c.audit.countDate))}. Save it anyway?</p>`, buttons: [{ label: 'Go back', value: false }, { label: 'Save', cls: 'primary', value: true }] }); if (!ok) return; }
    enter.disabled = true;
    try {
      let nextBk = b ? b.id : '__none', next = '';
      if (LASTC.auto) {
        if (b && n < b.to) next = n + 1;
        else if (b) { const nb2 = c.bks.find((x) => x.from > b.to && x.status === 'issued'); if (nb2) { nextBk = nb2.id; next = ''; } }
        else next = n + 1;
      }
      Object.assign(LASTC, { form, bookletId: nextBk, serial: next, date, focus: 'date', goMiss: !!c.rMode });   // an RCD with a range: the next number not yet encoded
      await store.save('cer_ors', newId('ceror'), orData(c, b, n, date, st, items), by(refs));
      toast(`OR ${n} saved.`, 'ok');
    } finally { enter.disabled = false; }
  };
  // Focus after a save: the Date of the next OR (the OR No. after encoding skipped numbers).
  if (LASTC.focus) { const el = LASTC.focus === 'or' ? orIn : dateIn; if (el) el.focus(); LASTC.focus = ''; }
}
const orData = (c, b, serial, date, status, items) => ({ lguId: c.audit.lguId, officerId: c.o.id, form: $('#cd-form') ? $('#cd-form').value : (b ? b.form : ''), bookletId: b ? b.id : '', serial, date, status,
  items, amount: status === 'cancelled' ? 0 : r2(items.reduce((n, i) => n + i.amt, 0)), fund: c.curFund, reportId: c.cur.pending || hasRange(c.cur) ? placeIn(c.fig.chains[c.curKey], date, serial, $('#cd-form') ? $('#cd-form').value : (b ? b.form : '')) : c.selId,
  ...(begOr(c.f, { date, serial, bookletId: b ? b.id : '', officerId: c.o.id, form: $('#cd-form') ? $('#cd-form').value : (b ? b.form : '') }, c.exam.lastExamDate, begRangesOf(c.exam)) ? { beg: true } : {}) });   // before the period: its amount is in the beginning balance
function partRowHtml(i) {
  return `<div class="cd-prow"><label class="sr-only" for="cd-p${i}">Particular ${i + 1}</label><input class="input cd-p" id="cd-p${i}" list="cd-parts" placeholder="Type to search or add a new particular…" autocomplete="off">
    <label class="sr-only" for="cd-a${i}">Amount ${i + 1}</label><input class="input r cd-a" id="cd-a${i}" inputmode="decimal" placeholder="0.00" autocomplete="off">
    <button class="btn sm cd-x" type="button" aria-label="Remove particular">✕</button></div>`;
}
function remRowHtml(c) {
  const collectors = collectorsOf(c.f, c.o, c.audit, c.refs);
  return `<tr class="cd-rem"><td><input class="input" type="date" data-k="date" aria-label="Date received"></td>
    <td><select class="input" data-k="collectorId" aria-label="From collector"><option value="">— Collector —</option>${colOpts(collectors, '')}</select></td>
    <td><input class="input mono" data-k="reportNo" list="cd-crlist" aria-label="Collector's RCD No."></td>
    <td><input class="input mono" data-k="from" inputmode="numeric" aria-label="OR From"></td><td><input class="input mono" data-k="to" inputmode="numeric" aria-label="OR To"></td>
    <td><input class="input r" data-k="amount" inputmode="decimal" aria-label="Amount"></td><td></td>
    <td><button class="btn sm cd-x" type="button" aria-label="Remove remittance">✕</button></td></tr>`;
}
// The collectors an LO receives from: the officers of the office and of its barangays (with the barangay named).
function collectorsOf(f, o, audit, refs) {
  return f.officers.filter((x) => x.id !== o.id && (x.lguId === audit.lguId || refs.lgu[x.lguId]?.data.parentId === audit.lguId))
    .map((x) => ({ ...x, office: x.lguId === audit.lguId ? '' : (refs.lgu[x.lguId]?.data.name || '') }))
    .sort((a, b) => (a.office ? 1 : 0) - (b.office ? 1 : 0) || a.office.localeCompare(b.office) || a.name.localeCompare(b.name));
}
const colOpts = (cs, sel) => { const own = cs.filter((x) => !x.office), br = cs.filter((x) => x.office);
  const op = (x) => `<option value="${esc(x.id)}" ${x.id === sel ? 'selected' : ''}>${esc(x.name)}${x.designation ? ' · ' + esc(x.designation) : ''}${x.office ? ' · ' + esc(x.office) : ''}</option>`;
  return `${own.length ? `<optgroup label="This office">${own.map(op).join('')}</optgroup>` : ''}${br.length ? `<optgroup label="Barangays">${br.map(op).join('')}</optgroup>` : ''}`; };
const colName = (f, refs, id) => { const x = f.officers.find((y) => y.id === id); if (!x) return ''; const l = refs.lgu[x.lguId]; return `${x.name}${l && l.data.kind === 'barangay' ? ' · ' + l.data.name : ''}`; };
// One OR series row of the LO's entry line (OR From, OR To, Amount, ✕).
// The forms a remittance series may be of (AF 51 when not chosen); cash tickets may have no numbers: then the pieces.
const REM_FORMS = [['af51', 'AF 51'], ['ctci', 'CTC – Ind.'], ['ctcc', 'CTC – Corp.'], ['af52', 'AF 52'], ['af53', 'AF 53'], ['af54', 'AF 54'], ['af56', 'AF 56'], ['cash', 'Cash Ticket (Serial)'], ['cashbn', 'Cash Ticket (Booklet No.)']];
const remForm = (k) => (k === 'af51b' ? 'af51' : k || 'af51');
const remFormName = (k) => (REM_FORMS.find(([x]) => x === remForm(k)) || [, 'AF 51'])[1];
// The form of a remittance's series: the booklet holding its OR From decides (the collector's first), else the form chosen.
let BKS = [];
export const formOfSer = (m) => { if (!m) return remForm(''); const fk = remForm(m.form); const n = +String(m.from || '').replace(/\D/g, '');
  if (fk === 'cashbn' || (fk === 'cash' && !n)) return 'cashbn';   // cash tickets once typed without numbers: Booklet No. kind
  if (!n || fk === 'cash') return fk;
  const hold = BKS.filter((b) => !b.noSerial && b.form !== 'chk' && b.from <= n && n <= b.to), b = hold.find((x) => x.officerId === m.collectorId) || hold[0];
  return b && REM_FORMS.some(([k]) => k === remForm(b.form)) ? remForm(b.form) : fk; };
// A report's OR Range with the form of each range (rangeForms[i], as typed or from the LO's series; else the form of the
// booklet holding its first number). ORs go into a range by number and form, so AF 56 and AF 51 numbers are never mixed.
const bkFormAt = (n, officerId) => { const hold = BKS.filter((b) => !b.noSerial && b.form !== 'chk' && b.from <= n && n <= b.to); const b = hold.find((x) => x.officerId === officerId) || hold[0]; return b ? b.form : ''; };
const rangeFormAt = (rec, i) => (rec.rangeForms && rec.rangeForms[i]) || bkFormAt(rec.ranges[i][0], rec.officerId);
const sameF = (a, b) => !a || !b || remForm(a) === remForm(b);
const inRec = (rec, n, form) => (rec.ranges || []).some(([a, z], i) => a <= n && n <= z && sameF(rangeFormAt(rec, i), form));
export const rangesShow = (rec) => (rec.ranges || []).map(([a, z], i) => { const fk = rangeFormAt(rec, i); return `${fk ? remFormName(fk) + ' · ' : ''}${a === z ? a : `${a}–${z}`}`; }).join('; ');
// [[from, to, form], …] → { ranges, rangeForms }: merged within each form, sorted by number.
const mergeF = (list) => { const by = {}; list.forEach(([a, z, fk]) => (by[fk || ''] = by[fk || ''] || []).push([a, z]));
  const all = Object.entries(by).flatMap(([fk, rs]) => mergeRanges(rs).map(([a, z]) => [a, z, fk])).sort((x, y) => x[0] - y[0]);
  return { ranges: all.map(([a, z]) => [a, z]), rangeForms: all.map((x) => x[2]) }; };
// Cash Ticket (Booklet No.): one Booklet No. field across OR From and OR To; the pieces typed (Amount = Pcs × denomination).
const serRow = (m) => { const fk = formOfSer(m), cash = fk === 'cashbn';
  return `<div class="rm-srow${cash ? ' rm-cash rm-bn' : ''}"><select class="input rm-sk" aria-label="Form">${REM_FORMS.map(([k, l]) => `<option value="${k}" ${k === fk ? 'selected' : ''}>${l}</option>`).join('')}</select><input class="input mono rm-sf" inputmode="numeric" aria-label="${cash ? 'Booklet No.' : 'OR From'}" placeholder="${cash ? 'Booklet No.' : ''}" value="${esc(m ? (cash ? m.bn || '' : m.from || '') : '')}"><input class="input mono rm-st" inputmode="numeric" aria-label="OR To" value="${esc(m && !cash ? m.to || '' : '')}"><input class="input r rm-sp" inputmode="numeric" aria-label="Pieces" ${cash ? '' : 'readonly tabindex="-1" title="Counted from OR From and OR To"'} value="${esc(cash ? (m && m.pcs ? m.pcs : '') : (m && +m.from && +(m.to || m.from) >= +m.from ? +(m.to || m.from) - +m.from + 1 : ''))}"><input class="input r rm-sa" inputmode="decimal" aria-label="Amount" value="${m ? esc(money(m.amount)) : ''}"><button class="btn sm rm-sx" type="button" aria-label="Remove this series" title="Remove this series">✕</button></div>`; };
// The series as listed: its form and range (every form named, AF 51 too); cash tickets with their pieces.
const serText = (m) => { const fk = formOfSer(m), rg = m.from ? `${m.from}–${m.to || m.from}` : '';
  if (fk === 'cashbn') return `Cash Ticket (Booklet No.) · BN. ${m.bn || '—'}${m.pcs ? ` · ${m.pcs} pcs` : ''}`;
  return `${remFormName(fk)} · ${rg || '—'}`; };
// Typed remittances grouped by the collector's report (same collector and No.): one row per report, its OR series under it,
// the reports in the order of their numbers.
function remGroups(list) {
  const key = (m) => (m.reportNo ? `${m.collectorId}|${String(m.reportNo).replace(/[^0-9A-Za-z]/g, '').toUpperCase()}` : `#${Math.random()}`);
  const out = new Map(); list.forEach((m, i) => { const k = key(m); if (!out.has(k)) out.set(k, []); out.get(k).push({ m, i }); });
  // In the order of the report numbers (417, 418, 419 …), as on the hard copy; lines without a No. last, by date.
  const nat = (m) => String(m.reportNo || '').replace(/^[^0-9]*/, '').replace(/\d+/g, (d) => d.padStart(12, '0')).toUpperCase();   // "SCR No. 2026-0189" as 2026-0189
  return [...out.values()].sort((a, b) => (a[0].m.reportNo ? 0 : 1) - (b[0].m.reportNo ? 0 : 1) || nat(a[0].m).localeCompare(nat(b[0].m)) || String(a[0].m.date).localeCompare(String(b[0].m.date)));
}
// An LO's RCD: the collectors' SCR / RCD it covers (distinct reports), their numbers as runs (417–442).
function coveredOf(f, refs, rec) { const seen = new Map();
  (rec.remittances || []).filter((m) => !m.beg && m.reportNo).forEach((m) => { const k = `${m.collectorId}|${String(m.reportNo).replace(/[^0-9A-Za-z]/g, '').toUpperCase()}`; if (!seen.has(k)) seen.set(k, m); });
  const reps = [...seen.values()], nums = [...new Set(reps.map((m) => +((String(m.reportNo).match(/(\d+)\D*$/) || [])[1])).filter((n) => n > 0))].sort((a, b) => a - b);
  const runs = []; nums.forEach((n) => { const r = runs[runs.length - 1]; if (r && n === r[1] + 1) r[1] = n; else runs.push([n, n]); });
  const txt = runs.map(([a, z]) => (a === z ? `${a}` : `${a}–${z}`));
  return { n: reps.length, text: txt.length > 3 ? `${txt.slice(0, 3).join(', ')} …` : txt.join(', '),
    title: reps.map((m) => `${colName(f, refs, m.collectorId)} · ${m.reportNo}`).join('\n') }; };
// An OR range too long for one remittance (a typing slip, e.g. 3056651–3656653): flagged, and refused on entry.
const REM_MAXPCS = 1000;
const rangeOff = (fr, to) => { const a = +fr, z = +(to || fr); if (!a) return ''; const n = z - a + 1;
  return n > REM_MAXPCS ? `${n.toLocaleString('en-US')} ORs in ${a}–${z}` : String(Math.trunc(a)).length !== String(Math.trunc(z)).length ? `OR From and OR To have a different number of digits` : ''; };
// A remittance against the collector's ORs in its range: agree, not found, more, or not yet encoded.
function remCheck(f, m) {
  // Cash Ticket (Booklet No.): the collector's lines of that booklet in the collector's report (else in any report of hers).
  if (!m.from && formOfSer(m) === 'cashbn') {
    if (!m.bn) return '<span class="pill p-flag">Booklet No. not typed</span>';
    const mine = (x) => x.officerId === m.collectorId && x.bnLine && x.status !== 'cancelled' && +BKS.find((b) => b.id === x.bookletId)?.bn === +m.bn;
    const rid = m.colReportId || m.reportId, inRep = rid ? f.ors.filter((x) => mine(x) && x.reportId === rid) : [];
    const xs = inRep.length ? inRep : f.ors.filter((x) => mine(x) && x.date && x.date <= m.date && (!rid || !x.reportId));
    if (!xs.length) return '<span class="pill p-flag">Collections not yet encoded</span>';
    const t = r2(xs.reduce((n, x) => n + rawAmt(x), 0)), d = r2((+m.amount || 0) - t);
    return Math.abs(d) < 0.005 ? '<span class="pill p-done">Collections agree</span>' : `<span class="pill p-flag" title="BN. ${esc(m.bn)} encoded: ₱${money(t)}">₱${money(Math.abs(d))} ${d > 0 ? 'not found in the collections' : 'more in the collections'}</span>`;
  }
  if (!m.from) return '<span class="dim">no range</span>';
  const off = m.serList && m.serList.length > 1 ? '' : rangeOff(m.from, m.to); if (off) return `<span class="pill p-bad" title="${esc(off)}">Check the OR range · ${esc(off)}</span>`;
  const a = +m.from, z = +(m.to || m.from);
  // From the collector's own report: its ORs; else the ORs of the collector in the range.
  const rr = m.colReportId ? f.reports.find((r) => r.id === m.colReportId) : null, one = !!rr && (rr.deposits || []).filter((d) => !d.fromLO).length === 1;
  const xs = one && f.ors.some((x) => x.reportId === m.colReportId) ? f.ors.filter((x) => x.reportId === m.colReportId && x.status !== 'cancelled')
    : m.serList && m.serList.length > 1 ? f.ors.filter((x) => x.officerId === m.collectorId && x.status !== 'cancelled' && m.serList.some(([p, q]) => +x.serial >= p && maxSer(x) <= q))
    : f.ors.filter((x) => x.officerId === m.collectorId && x.status !== 'cancelled' && +x.serial >= a && maxSer(x) <= z);
  if (!xs.length) return '<span class="pill p-flag">Collections not yet encoded</span>';
  const t = r2(xs.reduce((n, x) => n + rawAmt(x), 0)), d = r2((+m.amount || 0) - t);
  return Math.abs(d) < 0.005 ? '<span class="pill p-done">ORs agree</span>' : `<span class="pill p-flag" title="ORs encoded in ${a}–${z}: ₱${money(t)}">₱${money(Math.abs(d))} ${d > 0 ? 'not found in the ORs' : 'more in the ORs'}</span>`;
}
function depRowHtml(rem, toLO = false, series = false, sers = null) {
  return `<tr class="cd-dep"><td><input class="input" type="date" data-k="date" aria-label="${toLO ? 'Date remitted to LO' : rem ? 'Date received by MTO' : 'Deposit date'}"></td>
    <td><input class="input" data-k="ref" list="cd-reflist" placeholder="${rem ? 'Choose or type the name' : 'Choose or type'}" aria-label="${rem ? 'Liquidating Officer' : 'Reference'}"></td>
    ${rem ? '' : '<td><input class="input mono" data-k="no" placeholder="Optional" aria-label="Deposit slip No."></td>'}
    ${series ? '<td><input class="input mono" data-k="from" inputmode="numeric" aria-label="OR From"></td><td><input class="input mono" data-k="to" inputmode="numeric" aria-label="OR To"></td>' : ''}
    ${sers ? `<td><select class="input mono" data-k="ser" aria-label="OR Series"><option value="">— Series —</option>${sers.map((x, i) => `<option value="${i}">${esc(x[4])}</option>`).join('')}</select></td>` : ''}
    <td><input class="input r" data-k="amount" inputmode="decimal" aria-label="Amount"></td>${sers ? '<td class="cd-serchk2"></td>' : ''}
    <td><button class="btn sm cd-x" type="button" aria-label="Remove deposit">✕</button></td></tr>`;
}
// Reference choices for deposits: the usual slips, plus every reference already typed in this LGU (a new one joins the list once saved).
const DEP_REFS = ['Cash Deposit Slip', 'Check Deposit Slip'];
function depRefs(f, lguId) {
  const typed = f.reports.filter((r) => r.lguId === lguId && r.kind !== 'SCR').flatMap((r) => (r.deposits || []).map((d) => String(d.ref || '').trim())).filter(Boolean);
  return [...new Set([...DEP_REFS, ...typed.sort((a, b) => a.localeCompare(b))])];
}
// SCR remittances: the Liquidating Officer of the municipality who received them (matched later in that officer's cash exam).
// The list: officers of the municipality encoded as Liquidating Officer or with the Liquidating function, plus names typed before.
function loNames(refs, f, lgu) {
  const mun = lgu.data.kind === 'barangay' ? lgu.data.parentId : lgu.id;
  const inMun = (id) => id === mun || refs.lgu[id]?.data.parentId === mun;
  const los = loOfficers(refs, f, lgu).map((o) => o.name);
  const typed = f.reports.filter((r) => r.kind === 'SCR' && inMun(r.lguId)).flatMap((r) => (r.deposits || []).map((d) => String(d.ref || '').trim())).filter((v) => v && !/^(mto\s*)?or\b|^\d+$/i.test(v));
  // One name per person: a typed name of an officer (another spelling or case) is shown once, as the officer's name.
  const out = []; [...los, ...typed.map((v) => loCanon(refs, f, lgu, v))].forEach((v) => { if (!out.some((x) => x.toLowerCase().replace(/[^a-z]/g, '') === v.toLowerCase().replace(/[^a-z]/g, ''))) out.push(v); });
  return out.sort((a, b) => a.localeCompare(b));
}
// The Liquidating Officers of the municipality (by designation or by the Liquidating function in a cash exam).
function loOfficers(refs, f, lgu) {
  const mun = lgu.data.kind === 'barangay' ? lgu.data.parentId : lgu.id;
  return f.officers.filter((o) => o.lguId === mun && (/liquidating/i.test(o.designation || '') || f.exams.some((e) => e.officerId === o.id && (e.functions || []).includes('liquidating'))));
}
// A name typed for the LO, written as the officer's own name when it is that officer (case, dots, middle initial aside).
function loCanon(refs, f, lgu, v) {
  const t = String(v || '').trim(); if (!t) return t;
  const offs = f.officers.filter((o) => { const mun = lgu.data.kind === 'barangay' ? lgu.data.parentId : lgu.id; return o.lguId === mun || refs.lgu[o.lguId]?.data.parentId === mun; });
  const L = (x) => x.toLowerCase().replace(/[^a-z]/g, '');
  const hit = offs.find((o) => L(o.name) === L(t)) || (samePerson(offs, t).length === 1 ? samePerson(offs, t)[0] : null);
  return hit ? hit.name : t;
}
// "Cash Deposit Slip · No. 123456" or, for a remittance, "Sheena Gonzaga · OR 12345" (the No. is optional).
export const depRefText = (d, rem = false) => [d.ref || '', d.no ? `${rem ? 'OR' : 'No.'} ${d.no}` : ''].filter(Boolean).join(' · ');

// The next (n) for an unnumbered report of the same officer, kind, date and fund: 0 when it is the only one.
function dupeOf(f, officerId, K, date, fund, skipId) {
  const same = f.reports.filter((r) => !r.pending && r.id !== skipId && r.officerId === officerId && (r.kind || K) === K && !String(r.no || '').trim() && r.date === date && r.fund === fund);
  return same.length ? Math.max(1, ...same.map((r) => r.dupe || 1)) + 1 : 0;
}
// Where a dated OR, deposit or remittance belongs: the first submitted report of its chain dated on or after it
// ('' when none: not yet in a report).
// OR Range typed on a report: "3764059-3764100; 3765951-3765971" (single numbers allowed). Returns { ranges } or { error }.
function readRanges(t) {
  const out = [];
  for (const part of String(t || '').split(/[;,\n]+/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d+)\s*(?:[-–—]|to)\s*(\d+)$/i.exec(part) || /^(\d+)$/.exec(part);
    if (!m) return { error: `"${part}" is not a number or a range.` };
    const a = +m[1], z = m[2] ? +m[2] : a;
    if (z < a) return { error: `${part}: the first number is after the last.` };
    if (z - a > 20000) return { error: `${part} has ${z - a + 1} numbers. Check the range.` };
    out.push([a, z]);
  }
  out.sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < out.length; i++) if (out[i][0] <= out[i - 1][1]) return { error: 'The ranges overlap.' };
  return { ranges: out };
}
const rangesTyped = (rs) => (rs || []).map(([a, z]) => (a === z ? `${a}` : `${a}-${z}`)).join('; ');
// An OR (serial given) goes to the report whose OR Range includes its number; a report without a range takes, by date,
// the ORs not in any range. Deposits and remittances (no serial) go by date.
const hasRange = (g) => Array.isArray(g.rec.ranges) && g.rec.ranges.length > 0;
const inRanges = (rs, n) => (rs || []).some(([a, z]) => a <= n && n <= z);
function placeIn(chain, date, serial, form = '') {
  if (!chain) return '';
  if (serial) {
    const hit = chain.figs.find((g) => hasRange(g) && inRec(g.rec, serial, form)); if (hit) return hit.id;
    return date ? chain.figs.find((g) => !hasRange(g) && String(g.rec.date || '') >= date)?.id || '' : '';
  }
  return date ? chain.figs.find((g) => String(g.rec.date || '') >= date)?.id || '' : '';
}
// A deposit / remittance with its own OR series goes with its ORs, even when it was made before them; without one, by date.
const serIn = (d) => { const a = +d.from, z = +(d.to || d.from); return (x) => +x.serial <= z && maxSer(x) >= a; };
function depHome(ch, d) {
  if (d.from && !d.fromLO) {
    const inR = serIn(d); const g = ch.figs.find((y) => y.ors.some(inR)); if (g) return g.id;
    const x = ch.pend.ors.find(inR); if (x) return placeIn(ch, x.date, x.serial, x.form);
  }
  return placeIn(ch, d.date);
}
// Whether a deposit not yet in a report goes into a new report: with its ORs when it has a series, else by date.
function depWith(ch, d, moving, date) {
  if (d.from && !d.fromLO) {
    const inR = serIn(d); if (ch.figs.some((y) => y.ors.some(inR))) return false;   // its ORs are in another report: it follows them
    const mine = ch.pend.ors.filter(inR); if (mine.length) return mine.some(moving);
  }
  return d.date <= date;
}
// Deposits made before the ORs they cover (by the deposit's own OR series): ORs should be issued upon receipt of the collection.
export function depsBeforeOrs(f, o, fig) {
  const ors = f.ors.filter((x) => x.officerId === o.id && x.status !== 'cancelled' && x.date);
  const out = [];
  Object.values(fig.chains).forEach((ch) => [...ch.figs, ch.pend].forEach((g) => (g.rec?.deposits || []).filter((d) => d.from && !d.fromLO && d.date).forEach((d) => {
    const ds = ors.filter(serIn(d)).map((x) => x.date).sort(); if (!ds.length) return;
    const late = ds.filter((x) => x > d.date); if (!late.length) return;
    out.push({ d, g, kind: ch.kind, fund: ch.fund, first: ds[0], last: ds[ds.length - 1], nLate: late.length });
  })));
  return out;
}
// ORs in a report with a range whose number is outside it (e.g. the range was corrected).
const strays = (ch) => ch.figs.filter(hasRange).flatMap((g) => g.ors.filter((x) => !x.bnLine && !inRec(g.rec, x.serial, x.form)));
const byDate = (a, b) => String(a.date).localeCompare(String(b.date));
// The reports as listed: by report No. (numbered ones first), those without a No. after them by date. Shown only: the
// figures (undeposited carried from report to report) still follow the date order.
const byRepNo = (x, y) => { const a = String(x.rec.no || '').trim(), b = String(y.rec.no || '').trim();
  return (a ? 0 : 1) - (b ? 0 : 1) || (a && b ? a.localeCompare(b, undefined, { numeric: true }) : 0) || byDate(x.rec, y.rec) || (x.rec.dupe || 0) - (y.rec.dupe || 0); };
// An OR not yet in a report whose number is in the OR Range of a report of this officer (any fund or report type): it goes there.
const rangeHome = (fig, x) => { for (const ch of Object.values(fig.chains)) { const g = ch.figs.find((y) => hasRange(y) && inRec(y.rec, +x.serial, x.form)); if (g) return { ch, id: g.id }; } return null; };
const pendOrs = (fig) => Object.values(fig.chains).flatMap((ch) => ch.pend.ors);
const misplaced = (fig) => pendOrs(fig).some((x) => rangeHome(fig, x)) || Object.values(fig.chains).some((ch) => ch.figs.length && (ch.pend.ors.some((x) => placeIn(ch, x.date, x.serial, x.form)) || strays(ch).length
  || (ch.pend.rec?.deposits || []).some((d) => !d.fromLO && depHome(ch, d)) || (ch.pend.rec?.remittances || []).some((m) => !m.fromCol && placeIn(ch, m.date))));
// Moves the ORs, deposits and remittances not yet in a report into the report that covers their date.
async function sweepChains(f, fig, refs) {
  // First by OR Range, across funds and report types (e.g. ORs imported while another fund was selected).
  const moved = new Set();
  for (const x of pendOrs(fig)) { const h = rangeHome(fig, x); if (h) { moved.add(x.id); await store.save('cer_ors', x.id, { ...strip(x), reportId: h.id, fund: h.ch.fund }, by(refs), { quiet: true }); } }
  for (const ch of Object.values(fig.chains)) {
    if (!ch.figs.length) continue;
    const p = ch.pend;
    for (const x of strays(ch)) await store.save('cer_ors', x.id, { ...strip(x), reportId: placeIn(ch, x.date, x.serial, x.form) }, by(refs), { quiet: true });
    for (const x of p.ors.filter((y) => !moved.has(y.id))) { const to = placeIn(ch, x.date, x.serial, x.form); if (to) await store.save('cer_ors', x.id, { ...strip(x), reportId: to, fund: ch.fund }, by(refs), { quiet: true }); }
    // The stored record only (not the lines shown from the other side).
    const prec0 = f.reports.find((r) => r.id === p.id) || null;
    const prec = prec0 && prec0.lguId ? { ...prec0, deposits: (prec0.deposits || []).filter((d) => !d.fromLO), remittances: (prec0.remittances || []).filter((m) => !m.fromCol) } : null;
    if (!prec) continue;
    const moves = {};
    (prec.deposits || []).forEach((d) => { const t = depHome(ch, d); if (t) (moves[t] = moves[t] || { d: [], r: [] }).d.push(d); });
    (prec.remittances || []).forEach((m) => { const t = placeIn(ch, m.date); if (t) (moves[t] = moves[t] || { d: [], r: [] }).r.push(m); });
    if (!Object.keys(moves).length) continue;
    for (const [t, v] of Object.entries(moves)) {
      const r = f.reports.find((y) => y.id === t);
      await store.save('cer_reports', t, { ...strip(r), deposits: [...(r.deposits || []).filter((d) => !d.fromLO), ...v.d].sort(byDate), remittances: [...(r.remittances || []).filter((m) => !m.fromCol), ...v.r].sort(byDate) }, by(refs), { quiet: true });
    }
    await store.save('cer_reports', p.id, { ...strip(prec), pending: true, deposits: (prec.deposits || []).filter((d) => !depHome(ch, d)), remittances: (prec.remittances || []).filter((m) => !placeIn(ch, m.date)) }, by(refs), { quiet: true });
  }
}
// Saves a new report (SCD / SCR / RCD); the records not yet in a report dated on or before it move into it.
async function createReport(c, K, out) {
  const { refs, f, audit, o, fig } = c;
  const ch = fig.chains[`${K}|${out.fund}`];
  const p = ch.pend, prec = p.rec && p.rec.lguId ? p.rec : null;
  const deps = (prec?.deposits || []).filter((d) => !d.fromLO), rems = (prec?.remittances || []).filter((m) => !m.fromCol);   // stored lines only
  const id = newId('cerr');
  const first = !ch.figs.length;
  const outR = { ...out, officerId: o.id }, goes = (d) => depWith(ch, d, (x) => inRec(outR, x.serial, x.form), out.date);
  await store.save('cer_reports', id, { lguId: audit.lguId, officerId: o.id, kind: K, ...out, begTyped: first ? (out.begTyped ?? (num(prec?.begTyped) || 0)) : 0,
    deposits: deps.filter(goes), remittances: rems.filter((m) => m.date <= out.date) }, by(refs), { quiet: true });
  if (prec) await store.save('cer_reports', p.id, { ...strip(prec), pending: true, begTyped: first ? 0 : prec.begTyped, deposits: deps.filter((d) => !goes(d)), remittances: rems.filter((m) => m.date > out.date) }, by(refs), { quiet: true });
  for (const x of p.ors.filter((x) => inRec(outR, x.serial, x.form))) await store.save('cer_ors', x.id, { ...strip(x), reportId: id, fund: out.fund }, by(refs), { quiet: true });
  return id;
}

/* ---------- Import ORs from Excel: Date, OR No., Particular, Amount ---------- */
// Particular "Cancelled" → a cancelled OR; blank → "No particular"; anything else (e.g. Various) as written.
// Several rows with the same OR No. become one OR with several particulars.
async function importOrs(c) {
  const { refs, f, o, lgu, curFund } = c;
  const form = $('#cd-form') ? $('#cd-form').value : '';
  if (!form) return bad('Choose the Form Type first.');
  let plan = null, XLSX = null;
  const read = async (file) => {
    XLSX = await loadXlsx();
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const cols = [['date', /date/i], ['or', /or\s*no|^\s*o\.?\s*r\.?\s*(#|number)?\s*$|receipt/i], ['part', /particular|nature|description/i], ['amt', /amount|amt/i]];
    let sheet = null;
    for (const n of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' });
      for (let r = 0; r < Math.min(rows.length, 15) && !sheet; r++) {
        const map = {}; rows[r].forEach((cell, i) => { const t = String(cell || ''); cols.forEach(([k, re]) => { if (map[k] === undefined && re.test(t)) map[k] = i; }); });
        if (map.or !== undefined && map.date !== undefined) sheet = { rows, header: r, map };
      }
      if (sheet) break;
    }
    if (!sheet) return { error: 'No sheet with the columns Date and OR No. was found. Use the template.' };
    const M = sheet.map, get = (row, k) => (M[k] === undefined ? '' : row[M[k]]);
    const kind = kindOfForm(lgu, form), ch = c.fig.chains[`${kind}|${curFund}`];
    const byNo = new Map(), problems = [];
    sheet.rows.slice(sheet.header + 1).forEach((row, i) => {
      const line = sheet.header + i + 2;
      const noTxt = String(get(row, 'or')).trim(), dTxt = get(row, 'date'), pTxt = String(get(row, 'part') ?? '').trim().replace(/\s+/g, ' '), aTxt = get(row, 'amt');
      if (!noTxt && !String(dTxt).trim() && !pTxt && String(aTxt).trim() === '') return;
      const n = parseInt(noTxt.replace(/[^\d]/g, ''), 10);
      if (!n) { problems.push({ line, why: `OR No. "${noTxt}" is not a number.` }); return; }
      const date = excelDate(XLSX, dTxt);
      if (!date) { problems.push({ line, no: n, why: date === null ? `Date "${dTxt}" is not a date.` : 'Date is missing.' }); return; }
      const cancelled = /^cancel+ed$/i.test(pTxt);
      const amt = typeof aTxt === 'number' ? aTxt : num(aTxt);
      if (!cancelled && (amt === null || amt <= 0)) { problems.push({ line, no: n, why: String(aTxt).trim() ? `Amount "${aTxt}" is not a number.` : 'Amount is missing.' }); return; }
      const g = byNo.get(n) || { n, date, items: [], cancelled: false, lines: [] };
      g.lines.push(line); if (cancelled) g.cancelled = true; else g.items.push({ p: pTxt || FIXED_PART[form] || NO_PART, amt: r2(amt) });
      byNo.set(n, g);
    });
    const add = [];
    [...byNo.values()].sort((a, b) => a.n - b.n).forEach((g) => {
      // The booklet holding the number decides the form (e.g. AF 56 numbers imported while AF 51 was chosen).
      const hold = f.booklets.filter((y) => y.officerId === o.id && !y.noSerial && y.form !== 'chk' && y.from <= g.n && g.n <= y.to);
      const b = hold.find((y) => y.form === form) || (hold.length === 1 ? hold[0] : null), fm = b ? b.form : form;
      if (c.rMode && !inRec(c.rRec, g.n, fm)) { problems.push({ line: g.lines[0], no: g.n, why: `Not in the OR Range of ${repName(c.cur.rec, c.K)}: skipped.` }); return; }
      if (f.ors.some((x) => x.form === fm && x.serial === g.n)) { problems.push({ line: g.lines[0], no: g.n, why: 'Already encoded.' }); return; }
      if (fm !== form && !/^cancel/i.test(String(g.items[0]?.p || '')) && g.items.length && g.items.every((i) => i.p === FIXED_PART[form])) g.items = g.items.map((i) => ({ ...i, p: FIXED_PART[fm] || NO_PART }));
      add.push({ ...g, form: fm, bookletId: b ? b.id : '', reportId: placeIn(ch, g.date, g.n, fm) });
    });
    return { add, problems, form };
  };
  const show = (bg, p) => {
    const box = $('#oi-res', bg);
    if (p.error) { box.innerHTML = `<div class="msg bad">${esc(p.error)}</div>`; return; }
    const iss = p.add.filter((x) => !x.cancelled), cx = p.add.length - iss.length;
    const np = iss.filter((x) => x.items.some((i) => i.p === NO_PART)).length, nb = p.add.filter((x) => !x.bookletId).length;
    const ns = p.add.filter((x) => !x.reportId).length;
    box.innerHTML = `<div class="oi-sum"><b>${p.add.length} OR${p.add.length === 1 ? '' : 's'} of ${esc(FORM_SHORT[p.form] || p.form)} to add</b> · ₱ ${money(r2(iss.reduce((t, x) => t + x.items.reduce((u, i) => u + i.amt, 0), 0)))}
        ${cx ? `<span>${cx} read as Cancelled</span>` : ''}${np ? `<span class="warn-t">${np} with No particular</span>` : ''}${nb ? `<span class="warn-t">${nb} not in a booklet of this officer</span>` : ''}${ns ? `<span>${ns} not yet in an SCD</span>` : ''}</div>
      ${p.add.length ? `<div class="af-tbl oi-prev"><table class="af-reg"><thead><tr><th>OR No.</th><th>Date</th><th>Particular</th><th class="r">Amount</th></tr></thead><tbody>${p.add.slice(0, 200).map((x) => `<tr><td class="mono">${x.n}</td><td>${esc(fmtDate(x.date))}</td><td>${x.cancelled ? '<span class="pill p-stock">Cancelled</span>' : esc(x.items.map((i) => i.p).join('; '))}</td><td class="r">${x.cancelled ? '0.00' : money(r2(x.items.reduce((t, i) => t + i.amt, 0)))}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${p.problems.length ? `<div class="af-probs"><b>Rows not imported (${p.problems.length})</b>${p.problems.slice(0, 60).map((q) => `<div>Row ${q.line}${q.no ? ` · OR ${q.no}` : ''} — ${esc(q.why)}</div>`).join('')}</div>` : ''}`;
  };
  const v = await modal({ title: `Import ORs · ${FORM_SHORT[form] || form}`, wide: true,
    body: `<p class="af-note">Excel columns: <b>Date, OR No., Particular, Amount</b>. Particular "Cancelled" → a cancelled OR; blank → "${NO_PART}"; anything else (e.g. Various) is kept as written. Rows with the same OR No. become one OR. ORs go to the SCD whose OR Range has their number; the fund is ${esc(curFund)}.</p>
      <div class="field"><label for="oi-file">Excel file</label><input class="input" type="file" id="oi-file" accept=".xlsx,.xls,.csv"></div>
      <div id="oi-res"></div>`,
    onOpen: (bg) => { $('#oi-file', bg).onchange = async (e) => { const fl = e.target.files[0]; if (!fl) return; $('#oi-res', bg).innerHTML = '<p class="af-note">Reading…</p>';
      try { plan = await read(fl); show(bg, plan); } catch (err) { plan = null; $('#oi-res', bg).innerHTML = `<div class="msg bad">${esc(err.message || String(err))}</div>`; } }; },
    buttons: [{ label: 'Cancel', value: null }, { label: 'Import', cls: 'primary', value: 'go', check: () => { if (!plan || plan.error) { toast('Choose the Excel file first.', 'bad'); return false; } if (!plan.add.length) { toast('Nothing to import.', 'bad'); return false; } return true; } }] });
  if (v !== 'go') return;
  for (const x of plan.add) {
    await store.save('cer_ors', newId('ceror'), { lguId: c.audit.lguId, officerId: o.id, form: x.form || plan.form, bookletId: x.bookletId, serial: x.n, date: x.date, status: x.cancelled ? 'cancelled' : 'issued',
      items: x.cancelled ? [] : x.items, amount: x.cancelled ? 0 : r2(x.items.reduce((t, i) => t + i.amt, 0)), fund: curFund, reportId: x.reportId,
      ...(begOr(f, { date: x.date, serial: x.n, bookletId: x.bookletId, officerId: o.id, form: plan.form }, c.exam.lastExamDate, begRangesOf(c.exam)) ? { beg: true } : {}) }, by(refs), { quiet: true });
  }
  // An RCD with its OR Range: what is still to encode, and the entry line set at the first of them.
  if (c.rMode) {
    const left = c.rRec.ranges.map(([a, z], i) => { const fk = rangeFormAt(c.rRec, i);
      const used = new Set([...f.ors.filter((x) => x.officerId === o.id && sameF(fk, x.form)).flatMap(serialsOf), ...plan.add.filter((x) => sameF(fk, x.form || plan.form)).map((x) => x.n)]);
      const miss = []; if (z - a < 5000) for (let n = a; n <= z; n++) if (!used.has(n)) miss.push([n, n]);
      return miss.length ? `${remFormName(fk)}: ${rangesText(mergeRanges(miss))}` : ''; }).filter(Boolean);
    LASTC.goMiss = true;
    emitChange('local');
    if (left.length) await modal({ title: `${plan.add.length} OR${plan.add.length === 1 ? '' : 's'} imported · still to encode`, body: `<p style="margin:0 0 6px">Not yet encoded in the OR Range of ${esc(repName(c.cur.rec, c.K))}:</p>${left.map((t) => `<div class="mono">${esc(t)}</div>`).join('')}<p class="af-note">The entry line is set at the first of them: type the rest one OR at a time.</p>`, buttons: [{ label: 'OK', cls: 'primary', value: null }] });
    else toast(`${plan.add.length} OR${plan.add.length === 1 ? '' : 's'} imported. All ORs of the range are encoded.`, 'ok');
    return;
  }
  emitChange('local'); toast(`${plan.add.length} OR${plan.add.length === 1 ? '' : 's'} imported.`, 'ok');
}

/* ---------- + SCD / SCR / RCD and Edit: one window ---------- */
async function reportModal(c, K, g) {
  const { refs, f, audit, o, fig, curFund, isLO, exam } = c;
  const isNew = !g, rec = g ? g.rec : {};
  // A pure Liquidating Officer (not also collecting): no OR Range; the collectors' SCR / RCD remitted to her are ticked instead.
  const pureLO = isLO && !(exam.functions || []).includes('collecting');
  const fund0 = isNew ? curFund : rec.fund;
  const chainOf = (fund) => fig.chains[`${K}|${fund}`];
  const firstOf = (fund) => (isNew ? !(chainOf(fund)?.figs.length) : chainOf(rec.fund)?.figs[0]?.id === g.id);
  const UND = K === 'SCR' ? 'Unremitted' : 'Undeposited';
  const pend0 = chainOf(fund0)?.pend;
  const beg0 = isNew ? (pend0?.rec?.begTyped ? money(pend0.rec.begTyped) : '') : (rec.begTyped ? money(rec.begTyped) : '');
  let act = null, out = null;
  // The remittances typed in this report (Collections tab): counted with the ticked ones against the hard copy.
  const typedIn = isNew ? [] : (rec.remittances || []).filter((m) => !m.fromCol && !m.beg);
  const typedT = r2(typedIn.reduce((n, m) => n + (+m.amount || 0), 0));
  // OR Range: one row per series with its form (as on the LO's lines).
  const rfOpts = [...new Set([...(exam.forms || []), ...f.booklets.filter((b) => b.officerId === o.id && b.form !== 'chk' && !b.noSerial).map((b) => b.form)])].filter(Boolean);
  const rfName = (k) => (REM_FORMS.some(([x]) => x === remForm(k)) ? remFormName(k) : FORM_SHORT[k] || k);
  const rRow = (a = '', z = '', fk = '') => `<div class="rp-rrow"><select class="input rp-rf" aria-label="Form"><option value="">— Form —</option>${[...new Set([...rfOpts, ...(fk ? [fk] : [])])].map((k) => `<option value="${esc(k)}" ${k === fk ? 'selected' : ''}>${esc(rfName(k))}</option>`).join('')}</select>
      <input class="input mono rp-ra" inputmode="numeric" placeholder="OR From" value="${esc(a)}" aria-label="OR From"><input class="input mono rp-rz" inputmode="numeric" placeholder="OR To" value="${esc(z)}" aria-label="OR To">
      <button class="btn sm rp-rx" type="button" aria-label="Remove this range" title="Remove this range">✕</button></div>`;
  const rows0 = (rec.ranges || []).length ? rec.ranges.map(([a, z], i) => rRow(a, z, rangeFormAt({ ...rec, officerId: o.id }, i))) : [rRow()];
  const readRows = (bg) => {
    const list = [];
    for (const r of $$('.rp-rrow', bg)) {
      const a = +$('.rp-ra', r).value.replace(/\D/g, ''), z = +$('.rp-rz', r).value.replace(/\D/g, '') || a, fk = $('.rp-rf', r).value;
      if (!a && !$('.rp-rz', r).value.trim()) continue;
      if (!a) return { error: 'Type the OR From of each range.' };
      if (z < a) return { error: `${a}–${z}: the first number is after the last.` };
      if (z - a > 20000) return { error: `${a}–${z} has ${z - a + 1} numbers. Check the range.` };
      if (!fk) return { error: `Choose the form of ${a}–${z}.` };
      list.push([a, z, fk]);
    }
    list.sort((x, y) => x[0] - y[0]);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (sameF(list[i][2], list[j][2]) && list[j][0] <= list[i][1] && list[i][0] <= list[j][1]) return { error: 'The ranges of the same form overlap.' };
    return { ranges: list.map(([a, z]) => [a, z]), rangeForms: list.map((x) => x[2]) };
  };
  const wireRows = (bg) => {
    const box = $('#rp-rows', bg);
    const wire1 = (r) => {
      $('.rp-rx', r).onclick = () => { if ($$('.rp-rrow', box).length > 1) r.remove(); else { $('.rp-ra', r).value = ''; $('.rp-rz', r).value = ''; } preview(bg); };
      $('.rp-rf', r).onchange = () => { r.dataset.picked = '1'; preview(bg); };
      const auto = () => { const n = +$('.rp-ra', r).value.replace(/\D/g, ''); if (!n || r.dataset.picked) return; const fk = bkFormAt(n, o.id);
        if (fk) { const sel = $('.rp-rf', r); if (![...sel.options].some((x) => x.value === fk)) sel.add(new Option(rfName(fk), fk)); sel.value = fk; } };
      $('.rp-ra', r).addEventListener('change', () => { auto(); preview(bg); });
      ['.rp-ra', '.rp-rz'].forEach((k) => $(k, r).addEventListener('input', () => preview(bg)));
      auto();
    };
    $$('.rp-rrow', box).forEach(wire1);
    $('#rp-addr', bg).onclick = (e) => { e.preventDefault(); const d = document.createElement('div'); d.innerHTML = rRow(); const r = d.firstElementChild; box.append(r); wire1(r); $('.rp-ra', r).focus(); };
  };
  const preview = (bg) => {
    const box = $('#rp-prev', bg), date = $('#rp-date', bg).value, fund = $('#rp-fund', bg).value, ch = chainOf(fund);
    $('#rp-begbox', bg).hidden = !firstOf(fund);
    if (pureLO) { const tk = isNew ? [] : (rec.remittances || []).filter((m) => m.fromCol && !m.beg), t = r2(tk.reduce((n, m) => n + (+m.amount || 0), 0)), hard = num($('#rp-hard', bg).value);
      const all = r2(t + typedT), n = typedIn.length + tk.length;
      box.innerHTML = isNew ? `Then, in tab 2 · Collections, type the remittances of the hard copy or tick those already in the app.${hard ? ` Hard copy ₱ ${money(hard)}.` : ''}`
        : `Remittances in this ${K}: <b>${n}</b> (typed ${typedIn.length}, ticked ${tk.length}) · <b>₱ ${money(all)}</b>${hard ? ` · hard copy ₱ ${money(hard)}: ${Math.abs(hard - all) < 0.005 ? '<b class="ok-t">agrees</b>' : `<b class="warn-t">difference ₱ ${money(Math.abs(r2(hard - all)))}</b>`}` : ''}.`; return; }
    const rr = readRows(bg);
    if (rr.error) { box.innerHTML = `<b class="warn-t">${esc(rr.error)}</b>`; return; }
    if (!rr.ranges.length) { box.textContent = `Type the OR Range of the ${K} to see which ORs go into it.`; return; }
    const rrec = { ...rr, officerId: o.id };
    const n = rr.ranges.reduce((t, [a, z]) => t + z - a + 1, 0), all = f.ors.filter((x) => x.officerId === o.id && inRec(rrec, x.serial, x.form));
    const other = all.filter((x) => x.reportId && x.reportId !== (g ? g.id : '')).length;
    const deps = isNew && date && ch ? (ch.pend.rec?.deposits || []).filter((d) => depWith(ch, d, (x) => inRec(rrec, x.serial, x.form), date)) : [];
    const hard = num($('#rp-hard', bg).value), coll = r2(all.reduce((t, x) => t + orAmount(x), 0));
    box.innerHTML = `The range has <b>${n} OR${n > 1 ? 's' : ''}</b>; <b>${all.length}</b> encoded so far (₱ ${money(coll)})${other ? `, ${other} of them in another ${K}` : ''}.${deps.length ? ` <b>${deps.length} ${K === 'SCR' ? 'remittance' : 'deposit'}${deps.length === 1 ? '' : 's'}</b> dated on or before ${esc(fmtDate(date))} also go in.` : ''}${hard ? ` Hard copy ₱ ${money(hard)}: ${Math.abs(hard - coll) <= 0.004 ? '<b>balanced</b>' : `<b class="warn-t">₱ ${money(Math.abs(r2(hard - coll)))} ${hard > coll ? 'more' : 'less'} than the ORs encoded</b>`}.` : ''}`;
  };
  const read = (bg) => {
    const no = $('#rp-no', bg).value.trim(), date = $('#rp-date', bg).value, fund = $('#rp-fund', bg).value, hard = $('#rp-hard', bg).value.trim();
    if (!date) return bad(`Enter the ${K} date.`) || null;
    { const hit = f.reports.find((r) => !r.pending && !orphanShell(f, r) && r.id !== (g ? g.id : '') && r.officerId === o.id && (r.kind || K) === K && String(r.no).trim().toUpperCase() === no.toUpperCase()); if (no && hit) return bad(hit.madeFrom ? `${K} No. ${no} is already here (made from ${hit.madeFrom.name || 'the LO'}'s RCD${hit.madeFrom.no ? ' No. ' + hit.madeFrom.no : ''}). Open it to encode its collections.` : `${K} No. ${no} is already encoded for this officer.`); }
    const rr = pureLO ? { ranges: [], rangeForms: [] } : readRows(bg);
    if (rr.error) return bad(rr.error) || null;
    if (!pureLO && !rr.ranges.length) return bad(`Type the OR Range of the ${K}: the form, OR From and OR To of each series.`) || null;
    const clash = (chainOf(fund)?.figs || []).find((x) => x.id !== (g ? g.id : '') && hasRange(x) && x.rec.ranges.some(([a, z], i) => rr.ranges.some(([p, q], j) => p <= z && a <= q && sameF(rangeFormAt(x.rec, i), rr.rangeForms[j]))));
    if (clash) {
      const same = clash.rec.date === date && rangesTyped(clash.rec.ranges) === rangesTyped(rr.ranges);
      return bad(same ? `This ${K} is already entered (${repName(clash.rec, K)}).` : `Part of that range is already in ${repName(clash.rec, K)}.`) || null;
    }
    const v = { no, date, fund, ranges: rr.ranges, rangeForms: rr.rangeForms, hardTotal: hard ? num(hard) : null, received: $('#rp-recv', bg).value, dupe: no ? 0 : dupeOf(f, o.id, K, date, fund, g ? g.id : undefined) };
    if (firstOf(fund)) { const t = num($('#rp-beg', bg).value); v.begTyped = t === null ? '' : t; }
    return v;
  };
  await modal({ title: isNew ? `New ${K} · ${KIND_NAME[K]}` : `Edit ${repName(rec, K)}`, wide: true,
    body: `<div class="rp-grid">
        <div class="field"><label for="rp-no">${K} No. (if any)</label><input class="input mono" id="rp-no" value="${esc(rec.no || '')}" placeholder="Leave blank if none" autocomplete="off"></div>
        <div class="field"><label for="rp-date">${K} Date</label><input class="input" type="date" id="rp-date" value="${esc(rec.date || '')}"></div>
        <div class="field"><label for="rp-fund">Fund</label><select class="input" id="rp-fund">${fig.funds.map((x) => `<option ${x === fund0 ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
        ${pureLO ? '' : `<div class="field rp-wide"><span class="cd-lbl">OR Range (from the ${K}) · one row per series</span><div id="rp-rows">${rows0.join('')}</div><a href="#" class="cd-link" id="rp-addr">+ Range</a></div>`}
        <div class="field"><label for="rp-hard">Total per Hard Copy</label><input class="input r" id="rp-hard" inputmode="decimal" placeholder="0.00" value="${rec.hardTotal !== null && rec.hardTotal !== undefined && rec.hardTotal !== '' ? esc(money(rec.hardTotal)) : ''}"></div>
        <div class="field"><label for="rp-recv">Date Received</label><input class="input" type="date" id="rp-recv" value="${esc(rec.received || '')}"></div>
        <div class="field" id="rp-begbox"><label for="rp-beg">${UND} per last ${K} (first in the app)</label><input class="input r" id="rp-beg" inputmode="decimal" placeholder="0.00" value="${esc(beg0)}"></div>
      </div>

      <p class="af-note">${pureLO ? `${K} Date: the date written on the ${K}. Its remittances are typed or ticked in tab 2 · Collections.` : `${K} Date: the date written on the ${K}; if none, the date of the last OR it covers. ORs go into the ${K} by their number in the OR Range.`}</p>
      <p class="af-note" id="rp-prev"></p>`,
    onOpen: (bg) => { if ($('#rp-rows', bg)) wireRows(bg); $$('#rp-date, #rp-fund, #rp-hard, [data-rpk]', bg).forEach((el) => { el.addEventListener('input', () => preview(bg)); el.addEventListener('change', () => preview(bg)); }); preview(bg); },
    buttons: [...(isNew ? [] : [{ label: 'Delete', cls: 'danger', value: 'del' }]), { label: 'Cancel', value: null },
      { label: `Save ${K}`, cls: 'primary', value: 'save', check: (bg) => { out = read(bg); return !!out; } }] }).then((v) => { act = v; });
  if (act === 'del') return deleteReport(c, K, g);
  if (act !== 'save' || !out) return;
  if (out.dupe > 1) {
    const ok = await modal({ title: `Another ${K} of ${fmtDate(out.date)}?`, body: `<p style="margin:0">An unnumbered ${K} of ${esc(out.fund)} dated ${esc(fmtDate(out.date))} is already encoded for this officer. Save this as a separate ${K}? It will be shown as <b>${esc(repName({ kind: K, date: out.date, dupe: out.dupe }))}</b>.</p>`,
      buttons: [{ label: 'Cancel', value: false }, { label: 'Save as Separate', cls: 'primary', value: true }] });
    if (!ok) return;
  }
  // Ticked remittances: in this report only (taken out of the officer's other reports).
  const oneHome = async (keepId) => { if (!out.colIn) return; for (const r of f.reports.filter((y) => y.officerId === o.id && !y.pending && y.id !== keepId && (y.colIn || []).some((k) => out.colIn.includes(k))))
    await store.save('cer_reports', r.id, { ...strip(r), colIn: (r.colIn || []).filter((k) => !out.colIn.includes(k)) }, by(refs), { quiet: true }); };
  if (isNew) { const id = await createReport(c, K, out); await oneHome(id); emitChange('local'); toast(`${repName({ kind: K, ...out })} saved.`, 'ok'); go({ r: id }); return; }
  await oneHome(g.id);
  if (out.fund !== rec.fund) for (const x of g.ors) await store.save('cer_ors', x.id, { ...strip(x), fund: out.fund }, by(refs), { quiet: true });
  await store.save('cer_reports', g.id, { ...strip(rec), deposits: (rec.deposits || []).filter((d) => !d.fromLO), remittances: (rec.remittances || []).filter((m) => !m.fromCol), ...out }, by(refs));
  toast(`${repName({ kind: K, ...out })} saved.`, 'ok');
}
async function deleteReport(c, K, g) {
  const { refs, f, audit, o, isLO } = c, rec = g.rec;
  const ok = await modal({ title: `Delete ${repName(rec, K)}?`, body: `<p style="margin:0">Its ${g.ors.length} OR${g.ors.length === 1 ? '' : 's'}, deposits${isLO ? ' and remittances' : ''} become <b>Not yet in an ${K}</b> (they go into another ${K} that covers them). Use this only for an encoding mistake.</p>`,
    buttons: [{ label: 'Cancel', value: false }, { label: 'Delete', cls: 'primary', value: true }] });
  if (!ok) return;
  for (const x of g.ors) await store.save('cer_ors', x.id, { ...strip(x), reportId: '' }, by(refs), { quiet: true });
  const pid = pendId(o.id, K, rec.fund); const p = f.reports.find((r) => r.id === pid);
  const pbase = p ? strip(p) : { lguId: audit.lguId, officerId: o.id, kind: K, fund: rec.fund, pending: true, deposits: [], remittances: [] };
  await store.save('cer_reports', pid, { ...pbase, pending: true, deposits: [...(pbase.deposits || []).filter((d) => !d.fromLO), ...(rec.deposits || []).filter((d) => !d.fromLO)], remittances: [...(pbase.remittances || []).filter((m) => !m.fromCol), ...(rec.remittances || []).filter((m) => !m.fromCol)] }, by(refs), { quiet: true });
  await store.save('cer_reports', g.id, strip(rec), by(refs), { deleted: true, quiet: true });
  emitChange('local'); toast(`${K} deleted.`, 'ok'); go({ r: pid });
}

/* ---------- + SCD / RCD ---------- */
async function newReportModal(c, K) {
  const { refs, f, audit, o, fig, curFund } = c;
  const chainOf = (fund) => fig.chains[`${K}|${fund}`];
  let out = null;
  const preview = (bg) => {
    const fund = $('#nr-fund', bg).value, date = $('#nr-date', bg).value;
    const p = chainOf(fund)?.pend;
    if (!p || !date) { $('#nr-prev', bg).innerHTML = 'Enter the date to see what goes into this ' + K + '.'; return; }
    const ors = p.ors.filter((x) => x.date <= date), deps = (p.rec?.deposits || []).filter((d) => depWith(chainOf(fund), d, (x) => x.date <= date, date)), rems = (p.rec?.remittances || []).filter((m) => m.date <= date);
    $('#nr-prev', bg).innerHTML = `Moves into this ${K}: <b>${ors.length} OR${ors.length === 1 ? '' : 's'}</b> (₱ ${money(ors.reduce((n, x) => n + orAmount(x), 0))})${ors.length ? ', ' + esc(rangeByForm(ors)) : ''}; <b>${deps.length} ${K === 'SCR' ? 'remittance' : 'deposit'}${deps.length === 1 ? '' : 's'}</b>${c.isLO ? `; <b>${rems.length} remittance${rems.length === 1 ? '' : 's'}</b>` : ''} of ${esc(fund)} not yet reported, dated on or before ${esc(fmtDate(date))}. ORs encoded later while this ${K} is selected also go into it.`;
  };
  await modal({ title: `+ ${K} · ${KIND_NAME[K]}`,
    body: `<div class="cd-g2"><div class="field"><label for="nr-no">${K} No. (if any)</label><input class="input mono" id="nr-no" autocomplete="off" placeholder="Leave blank if none"></div>
        <div class="field"><label for="nr-date">${K} Date</label><input class="input" type="date" id="nr-date"></div>
        <div class="field"><label for="nr-fund">Fund</label><select class="input" id="nr-fund">${fig.funds.map((x) => `<option ${x === curFund ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
        <div class="field"><label for="nr-hard">Total per Hard Copy (optional)</label><input class="input r" id="nr-hard" inputmode="decimal" placeholder="0.00"></div>
        <div class="field"><label for="nr-recv">Date Received by the Team (optional)</label><input class="input" type="date" id="nr-recv"></div></div>
      <p class="af-note">${K} Date: the date written on the ${K}. If it has none, use the date of the last OR it covers.</p>
      <p class="af-note" id="nr-prev"></p>`,
    onOpen: (bg) => { ['#nr-date', '#nr-fund'].forEach((s) => { $(s, bg).oninput = () => preview(bg); $(s, bg).onchange = () => preview(bg); }); preview(bg); },
    buttons: [{ label: 'Cancel', value: null }, { label: `Save ${K}`, cls: 'primary', value: 'ok', check: (bg) => {
      const no = $('#nr-no', bg).value.trim(), date = $('#nr-date', bg).value, fund = $('#nr-fund', bg).value, hard = $('#nr-hard', bg).value.trim();
      if (!date) return bad(`Enter the ${K} date.`);
      { const hit = f.reports.find((r) => !r.pending && !orphanShell(f, r) && r.officerId === o.id && (r.kind || K) === K && String(r.no).trim().toUpperCase() === no.toUpperCase()); if (no && hit) return bad(hit.madeFrom ? `${K} No. ${no} is already here (made from ${hit.madeFrom.name || 'the LO'}'s RCD${hit.madeFrom.no ? ' No. ' + hit.madeFrom.no : ''}). Open it to encode its collections.` : `${K} No. ${no} is already encoded for this officer.`); }
      out = { no, date, fund, hardTotal: hard ? num(hard) : null, received: $('#nr-recv', bg).value, dupe: no ? 0 : dupeOf(f, o.id, K, date, fund) }; return true;
    } }] });
  if (!out) return;
  if (out.dupe > 1) {
    const ok = await modal({ title: `Another ${K} of ${fmtDate(out.date)}?`, body: `<p style="margin:0">An unnumbered ${K} of ${esc(out.fund)} dated ${esc(fmtDate(out.date))} is already encoded for this officer. Save this as a separate ${K}? It will be shown as <b>${esc(repName({ kind: K, date: out.date, dupe: out.dupe }))}</b>.</p>`,
      buttons: [{ label: 'Cancel', value: false }, { label: 'Save as Separate', cls: 'primary', value: true }] });
    if (!ok) return;
  }
  const p = chainOf(out.fund).pend;
  const prec = p.rec && p.rec.lguId ? p.rec : null;
  const deps = (prec?.deposits || []).filter((d) => !d.fromLO), rems = (prec?.remittances || []).filter((m) => !m.fromCol);   // stored lines only
  const id = newId('cerr');
  const first = !chainOf(out.fund).figs.length;
  const goes = (d) => depWith(chainOf(out.fund), d, (x) => x.date <= out.date, out.date);
  await store.save('cer_reports', id, { lguId: audit.lguId, officerId: o.id, kind: K, ...out, begTyped: first ? (num(prec?.begTyped) || 0) : 0,
    deposits: deps.filter(goes), remittances: rems.filter((m) => m.date <= out.date) }, by(refs), { quiet: true });
  if (prec) await store.save('cer_reports', p.id, { ...strip(prec), pending: true, begTyped: 0, deposits: deps.filter((d) => !goes(d)), remittances: rems.filter((m) => m.date > out.date) }, by(refs), { quiet: true });
  for (const x of p.ors.filter((x) => x.date <= out.date)) await store.save('cer_ors', x.id, { ...strip(x), reportId: id, fund: out.fund }, by(refs), { quiet: true });
  emitChange('local'); toast(`${repName({ kind: K, ...out })} saved.`, 'ok'); go({ r: id });
}

/* ---------- Edit an OR ---------- */
async function editOrModal(c, x) {
  if (!x) return;
  const { refs, f, o, lgu } = c;
  const K = kindOfForm(lgu, x.form);
  const reps = f.reports.filter((r) => !r.pending && r.officerId === o.id && (r.kind || kindOf(lgu)) === K).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const items = (x.items || []).length ? x.items : [{}];
  let act = null;
  await modal({ title: `Edit ${FORM_SHORT[x.form] || x.form} ${x.serial}`, wide: true,
    body: `<div class="cd-g2"><div class="field"><label for="eo-date">Date of Collection</label><input class="input" type="date" id="eo-date" value="${esc(x.date)}"></div>
        <div class="field"><label for="eo-st">Status</label><select class="input" id="eo-st"><option value="issued" ${x.status !== 'cancelled' ? 'selected' : ''}>Issued</option><option value="cancelled" ${x.status === 'cancelled' ? 'selected' : ''}>Cancelled</option></select></div>
        <div class="field"><label for="eo-rep">${K}</label><select class="input" id="eo-rep"><option value="">Not yet reported</option>${reps.map((r) => `<option value="${esc(r.id)}" ${r.id === x.reportId ? 'selected' : ''}>${esc(`${repName(r, K)}${r.no ? ' · ' + fmtDate(r.date) : ''} · ${r.fund}`)}</option>`).join('')}</select></div>
        <div class="field"><label for="eo-fund">Fund (when not yet reported)</label><select class="input" id="eo-fund">${c.fig.funds.map((fd) => `<option ${fd === x.fund ? 'selected' : ''}>${esc(fd)}</option>`).join('')}</select></div></div>
      <div class="cd-parts" id="eo-parts"><div class="cd-phead"><span>Particulars</span><span class="r">Amount (₱)</span><span></span></div>
        <div id="eo-rows">${items.map((p, i) => `<div class="cd-prow"><label class="sr-only" for="eo-p${i}">Particular ${i + 1}</label><input class="input cd-p" id="eo-p${i}" list="cd-parts" value="${esc(p.p || '')}"><label class="sr-only" for="eo-a${i}">Amount ${i + 1}</label><input class="input r cd-a" id="eo-a${i}" inputmode="decimal" value="${p.amt ? esc(money(p.amt)) : ''}"><button class="btn sm cd-x" type="button" aria-label="Remove particular">✕</button></div>`).join('')}</div>
        <button class="cd-link" type="button" id="eo-add">+ Add Particular</button></div>`,
    onOpen: (bg) => {
      const rows = $('#eo-rows', bg);
      const wire = () => $$('.cd-x', rows).forEach((b) => { b.onclick = () => { if ($$('.cd-prow', rows).length > 1) b.closest('.cd-prow').remove(); }; });
      wire();
      $('#eo-add', bg).onclick = () => { const i = $$('.cd-prow', rows).length; const d = document.createElement('div'); d.innerHTML = partRowHtml(i).replace(/cd-p(\d)/g, 'eo-p$1').replace(/cd-a(\d)/g, 'eo-a$1'); rows.appendChild(d.firstElementChild); wire(); };
      const st = $('#eo-st', bg); const sync = () => { $('#eo-parts', bg).hidden = st.value === 'cancelled'; }; st.onchange = sync; sync();
    },
    buttons: [{ label: 'Delete OR', value: 'del' }, { label: 'Cancel', value: null }, { label: 'Save', cls: 'primary', value: 'save', check: (bg) => {
      const date = $('#eo-date', bg).value, st = $('#eo-st', bg).value, rep = $('#eo-rep', bg).value;
      if (!date) return bad('Enter the date of collection.');
      const its = [];
      if (st === 'issued') {
        for (const r of $$('.cd-prow', bg)) { const p = $('.cd-p', r).value.trim().replace(/\s+/g, ' '), a = num($('.cd-a', r).value); if (!p && !a) continue; if (!p) return bad('Type the particular for each amount.'); if (!a || a <= 0) return bad(`Enter the amount of "${p}".`); its.push({ p, amt: a }); }
        if (!its.length) return bad('Enter at least one particular and its amount, or mark the OR as Cancelled.');
      }
      const r = reps.find((y) => y.id === rep);
      act = { date, status: st, items: st === 'cancelled' ? [] : its, amount: st === 'cancelled' ? 0 : r2(its.reduce((n, i) => n + i.amt, 0)), reportId: rep, fund: r ? r.fund : $('#eo-fund', bg).value };
      return true;
    } }] }).then((v) => { if (v === 'del') act = 'del'; });
  if (!act) return;
  if (act === 'del') {
    const ok = await modal({ title: `Delete ${FORM_SHORT[x.form] || x.form} ${x.serial}?`, body: '<p style="margin:0">Only for an encoding mistake. A cancelled OR is encoded as Cancelled, not deleted.</p>', buttons: [{ label: 'Keep', value: false }, { label: 'Delete', cls: 'primary', value: true }] });
    if (!ok) return;
    await store.save('cer_ors', x.id, strip(x), by(refs), { deleted: true }); toast('OR deleted.', 'ok'); return;
  }
  await store.save('cer_ors', x.id, { ...strip(x), ...act }, by(refs)); toast(`OR ${x.serial} saved.`, 'ok');
}

/* ---------- funds of the auditee ---------- */
async function fundsModal(refs, f, lguId) {
  const list = [...fundsOf(f, lguId)];
  const used = (x) => f.ors.some((o) => o.lguId === lguId && o.fund === x) || f.reports.some((r) => r.lguId === lguId && r.fund === x && !r.pending);
  const enc = canEncode(refs);
  const v = await modal({ title: `Funds · ${agencyName(refs, refs.lgu[lguId])}`,
    body: `<p class="hint" style="margin:0">The funds of this auditee. Each ${kindOf(refs.lgu[lguId])} is for one fund, and its ORs follow that fund.</p>
      <div class="list-edit" id="fd-list"></div>
      ${enc ? '<div class="af-pair"><label class="sr-only" for="fd-new">New fund</label><input class="input" id="fd-new" placeholder="e.g. 20% Development Fund"><button class="btn" type="button" id="fd-add">Add Fund</button></div>' : ''}`,
    onOpen: (bg) => {
      const draw = () => { $('#fd-list', bg).innerHTML = list.map((x, i) => `<div><span class="txt">${esc(x)}</span>${enc && !used(x) ? `<button class="btn sm" type="button" data-rm="${i}">Remove</button>` : used(x) ? '<span class="dim">in use</span>' : ''}</div>`).join('');
        $$('[data-rm]', bg).forEach((btn) => { btn.onclick = () => { list.splice(+btn.dataset.rm, 1); draw(); }; }); };
      draw();
      const add = $('#fd-add', bg), inp = $('#fd-new', bg);
      if (add) { const doAdd = () => { const x = inp.value.trim().replace(/\s+/g, ' '); if (!x) return; if (list.some((y) => y.toUpperCase() === x.toUpperCase())) { toast('That fund is already in the list.', 'bad'); return; } list.push(x); inp.value = ''; draw(); inp.focus(); };
        add.onclick = doAdd; inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } }; }
    },
    buttons: enc ? [{ label: 'Cancel', value: null }, { label: 'Save Funds', cls: 'primary', value: 'save' }] : [{ label: 'Close', cls: 'primary', value: null }] });
  if (v !== 'save') return;
  if (!list.length) return bad('Keep at least one fund.');
  await store.save('cer_settings', 'funds|' + lguId, { list }, by(refs));
  toast('Funds saved.', 'ok');
}
