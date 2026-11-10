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
import { FORMS, fixBrgyForm, hasRole, by, mayView, cycleOk, loadCer, pickAudit, pickExam, remember, getPick, agencyName, fmtDate, money, num } from './cer.js';
import { loadForms, FORM_SHORT, exportXlsx, rangesText, mergeRanges, bookletUnused, countRanges, loadXlsx, excelDate } from './forms.js';

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
const strip = (x) => { const { id, sameDay, ...rest } = x; return rest; };   // sameDay is worked out on loading, never saved
const bad = (m) => { toast(m, 'bad'); return false; };
const DEPSHOW = { v: 'all' };
const KSEL = {};   // the report type shown per officer (SCD / RCD or SCR), remembered while the app is open
const KIND_PICK = { SCD: 'SCD – Collections and Deposits', RCD: 'RCD – Collections and Deposits', SCR: 'SCR – Collections and Remittances' };   // deposits register: all of the officer, or the selected report
const go = (params) => { const q = new URLSearchParams(location.hash.split('?')[1] || ''); Object.entries(params).forEach(([k, v]) => (v ? q.set(k, v) : q.delete(k))); location.hash = location.hash.split('?')[0] + '?' + q.toString(); };

// Kept between screen refreshes (each save redraws the screen).
// One section open at a time (opening one folds the others); Collections is open to start.
const OPEN = { rep: true, col: false, dep: false };   // which tab is shown (one at a time); 1 SCD when the screen is opened
export const resetTabs = () => { Object.keys(OPEN).forEach((k) => { OPEN[k] = k === 'rep'; }); };
const NO_PART = 'No particular';   // an imported OR whose particular was left blank
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
const outOfBooklets = (f, o, x) => !f.booklets.some((b) => b.officerId === o.id && b.form === x.form && !b.noSerial && b.from <= +x.serial && (x.range ? +x.serialTo : +x.serial) <= b.to);
const orAmount = (o) => (o.status === 'cancelled' || o.beg ? 0 : r2((o.items || []).reduce((n, i) => n + (+i.amt || 0), 0)));
const maxSer = (x) => (x.range ? +x.serialTo : +x.serial);
export const serialsOf = (x) => { const out = []; for (let n = +x.serial, z = maxSer(x); n <= z && out.length < 5001; n++) out.push(n); return out; };
function rangeByForm(list) {
  const by = {}; list.forEach((o) => { (by[o.form] = by[o.form] || []).push(o.serial, maxSer(o)); });
  return Object.entries(by).map(([k, ns]) => `${FORM_SHORT[k] || k} ${Math.min(...ns)} – ${Math.max(...ns)}`).join('; ');
}
// Every report of the officer (and the "Not yet reported" of each fund), in order, with its figures and checks.
// exam (optional): its Audit Setup beginning balances open the first report of each report type (General Fund), unless the
// first report has its own "undeposited per last report" typed; the beginning ORs in it stay at nil (Before the period).
export function figuresOf(f, o, funds, countDate, lgu, exam = null) {
  const kinds = kindsOf(lgu);
  const ors = f.ors.filter((x) => x.officerId === o.id);
  // A beginning carried from the officer's previous cash exam: the reports up to that count belong to it.
  const carriedFrom = exam && exam.lastExamDate && Object.entries(exam.balances || {}).some(([k, v]) => (k.startsWith('col-') || k === 'liq') && v?.source === 'carried') ? exam.lastExamDate : '';
  const reals = f.reports.filter((r) => r.officerId === o.id && !r.pending && !(carriedFrom && r.date && r.date <= carriedFrom));
  const allFunds = [...new Set([...funds, ...reals.map((r) => r.fund), ...ors.map((x) => x.fund).filter(Boolean)])];
  const begR = begRangesOf(exam);
  // An OR dated before the last cash exam is of the beginning (Before the period), tagged or not yet.
  const lx = exam?.lastExamDate || '';
  const isBeg = (x) => !!x.beg || !!(lx && x.date && x.date < lx);
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
  // Remittances to this officer (as the Liquidating Officer) typed on the collectors' side, with their OR series (cashbook only):
  // they show in this LO's remittances received, so the LO's book is not typed again.
  const nm = (v) => String(v || '').toLowerCase().replace(/[^a-z]/g, '');
  const colLines = f.reports.filter((r) => r.officerId !== o.id).flatMap((r) => (r.deposits || []).filter((d) => d.toLO && !d.fromLO && d.from && nm(d.ref) && nm(d.ref) === nm(o.name))
    .map((d) => ({ date: d.date, collectorId: r.officerId, reportNo: '', amount: +d.amount || 0, from: d.from, to: d.to || d.from, fromCol: true, fund: r.fund || '' })));
  // A collector's remittances recorded by a Liquidating Officer (from the LO's cashbook): the collector's remittances to the LO.
  const loLines = f.reports.filter((r) => r.officerId !== o.id).flatMap((r) => (r.remittances || []).filter((m) => m.collectorId === o.id && !m.beg && m.date)
    .map((m) => ({ date: m.date, ref: f.officers.find((x) => x.id === r.officerId)?.name || 'Liquidating Officer', amount: +m.amount || 0, toLO: true, fromLO: true, form: m.form || '', from: m.from || '', to: m.to || '', fund: r.fund || '' })));
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
      const mine = new Set(ors.flatMap(serialsOf));
      fig.rangeN = rs.reduce((n, [a, z]) => n + z - a + 1, 0);
      const miss = []; rs.forEach(([a, z]) => { if (z - a < 5000) for (let n = a; n <= z; n++) if (!mine.has(n)) miss.push([n, n]); });
      fig.rangeIn = fig.rangeN - miss.length;
      if (miss.length) fig.issues.push(`${miss.length} OR${miss.length > 1 ? 's' : ''} of the range not yet encoded: ${rangesText(mergeRanges(miss))}.`);
    }
    if (rec && !rec.pending && rec.hardTotal !== null && rec.hardTotal !== undefined && rec.hardTotal !== '') fig.balanced = Math.abs(+rec.hardTotal - fig.coll) <= 0.004;
    const byForm = {}; list.forEach((x) => { (byForm[x.form] = byForm[x.form] || []).push(x.serial, maxSer(x)); });
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
      if (cr) { const cf = quickColl(f, cr); if (Math.abs(cf - (+m.amount || 0)) > 0.004) fig.issues.push(`Remittance of ${esc(f.officers.find((x) => x.id === m.collectorId)?.name || 'a collector')} (${esc(repName(cr))}) is ₱${money(m.amount)}; that report's collections are ₱${money(cf)}.`); }
    });
    // Each deposit / remittance with its own OR series: the ORs encoded in it (by form), those dated before the last cash exam,
    // and the numbers of the officer's booklets not encoded; the amount is checked against them.
    fig.serOf = new Map();
    (rec?.deposits || []).filter((d) => d.from && !d.fromLO).forEach((d) => {
      const a = +d.from, z = +(d.to || d.from); if (!(a > 0) || z < a || z - a > 5000) return;
      const ins = ors.filter((x) => x.status !== 'cancelled' && +x.serial >= a && maxSer(x) <= z);
      const tot = r2(ins.reduce((n, x) => n + rawAmt(x), 0)), ctc = r2(ins.filter((x) => isCtc(x.form)).reduce((n, x) => n + rawAmt(x), 0)), beg = r2(ins.filter((x) => x.beg).reduce((n, x) => n + rawAmt(x), 0));
      const mineBk = f.booklets.filter((b) => b.officerId === o.id && !b.noSerial && b.from <= z && b.to >= a);
      const miss = []; for (let n = a; n <= z; n++) if (mineBk.some((b) => b.from <= n && n <= b.to && !(encoded[b.form] && encoded[b.form].has(n)))) miss.push([n, n]);
      const info = { a, z, tot, ctc, af: r2(tot - ctc), beg, miss: mergeRanges(miss), ok: Math.abs(tot - (+d.amount || 0)) <= 0.004 };
      fig.serOf.set(d, info);
      if (!info.ok && (tot > 0.004 || miss.length)) fig.issues.push(`Series ${a}–${z}: ₱${money(d.amount)} ${d.toLO ? 'remitted' : 'deposited'} on ${fmtDate(d.date)}; ORs encoded in it ₱${money(tot)}${beg ? ` (₱${money(beg)} of them dated before the last cash exam)` : ''}${miss.length ? `; not encoded: ${rangesText(info.miss)}` : ''}.`);
    });
    if (fig.end < -0.004) fig.issues.push('Deposits are more than the undeposited balance and the collections.');
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
    const figs = list.map((r, i) => { const fg = build(r.id, r, ors.filter((x) => x.reportId === r.id), i === 0 ? start : beg, add[r.id] || 0); if (fg.begAdd) fg.begSer = serTxt; if (i === 0) markOpening(fg, op); beg = fg.end; return fg; });
    const pr0 = prec ? { ...prec, pending: true } : { pending: true, kind, fund, deposits: [], remittances: [] };
    const myLo = loLines.filter((m) => (m.fund || allFunds[0]) === fund && (m.form ? kindOfForm(lgu, m.form) : kinds[0]) === kind && !(pr0.deposits || []).some((d) => (d.from && m.from && String(d.from) === String(m.from)) || (d.date === m.date && Math.abs((+d.amount || 0) - m.amount) < 0.005)));
    if (myLo.length) pr0.deposits = [...(pr0.deposits || []), ...myLo].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const myCol = colLines.filter((m) => (m.fund || allFunds[0]) === fund && kind === kinds[0] && !(pr0.remittances || []).some((x) => x.collectorId === m.collectorId && ((x.from && String(x.from) === String(m.from)) || (x.date === m.date && Math.abs((+x.amount || 0) - m.amount) < 0.005))));
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
    (fg.rec?.remittances || []).forEach((m) => items.push({ date: m.date, from: f.officers.find((x) => x.id === m.collectorId)?.name || '', no: m.reportNo || (m.reportId ? f.reports.find((r) => r.id === m.reportId)?.no : '') || '', amount: +m.amount || 0, fund: fg.rec?.fund || fg.fund }));
    const own = {}; fg.ors.filter((x) => x.status !== 'cancelled').forEach((x) => { own[x.date] = r2((own[x.date] || 0) + orAmount(x)); });
    Object.entries(own).forEach(([d, a]) => items.push({ date: d, from: 'Own collections (ORs)', no: '', amount: a, own: true, fund: fg.rec?.fund || fg.fund }));
    (fg.rec?.deposits || []).forEach((d) => deps.push({ ...d, amount: +d.amount || 0, fund: fg.rec?.fund || fg.fund }));
  }));
  const out = [];
  [...new Set(Object.values(chains).map((c) => c.fund))].forEach((fund) => {
    const its = items.filter((x) => x.fund === fund).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const ds = deps.filter((x) => x.fund === fund).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    let di = 0, left = ds[0] ? ds[0].amount : 0;
    its.forEach((it) => {
      let need = it.amount, dep = null;
      while (need > 0.004 && di < ds.length) { const take = Math.min(need, left); need = r2(need - take); left = r2(left - take); dep = ds[di]; if (left <= 0.004) { di++; left = ds[di] ? ds[di].amount : 0; } }
      out.push({ ...it, depDate: need > 0.004 ? '' : dep?.date || '', depRef: need > 0.004 ? '' : dep?.ref || '', days: it.date ? Math.max(0, days(it.date, need > 0.004 ? countDate : dep?.date || it.date)) : null, undeposited: need > 0.004 });
    });
  });
  return out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/* ---------- screen ---------- */
export async function collectionsView(ctx) {
  const { refs, q } = ctx;
  const f = await loadForms();
  f.reports = tagSameDay((await store.list('cer_reports')).map(flat));
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
  // ORs dated before the last cash exam (entered one by one or imported before this rule): tagged Before the period once.
  const oldOrs = exam.lastExamDate ? f.ors.filter((x) => x.officerId === o.id && !x.beg && x.date && x.date < exam.lastExamDate) : [];
  if (canEncode(refs) && oldOrs.length) { for (const x of oldOrs) await store.save('cer_ors', x.id, { ...strip(x), beg: true }, by(refs), { quiet: true }); return collectionsView(ctx); }
  // Records dated on or before a submitted report go into it (e.g. ORs encoded after the SCD was added).
  if (canEncode(refs) && misplaced(fig)) { await sweepChains(f, fig, refs); return collectionsView(ctx); }
  const isLO = (exam.functions || []).includes('liquidating');
  const allForms = [...new Set(((exam.forms || []).length ? exam.forms : f.ors.filter((x) => x.officerId === o.id).map((x) => x.form)).map((k) => fixBrgyForm(lgu, k)))];
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
  const collectors = f.officers.filter((x) => x.id !== o.id && x.lguId === audit.lguId).sort((a, b) => a.name.localeCompare(b.name));
  const remRow = (m = {}) => `<tr class="cd-rem"><td><input class="input" type="date" data-k="date" value="${esc(m.date || '')}" aria-label="Date received" ${enc ? '' : 'disabled'}></td>
      <td><select class="input" data-k="collectorId" aria-label="From collector" ${enc ? '' : 'disabled'}><option value="">— Collector —</option>${collectors.map((c) => `<option value="${esc(c.id)}" ${c.id === m.collectorId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></td>
      <td><input class="input mono" data-k="reportNo" list="cd-crlist" value="${esc(m.reportNo || '')}" aria-label="Collector's RCD No." ${enc ? '' : 'disabled'}></td>
      <td><input class="input mono" data-k="from" inputmode="numeric" value="${esc(m.from || '')}" aria-label="OR From" ${enc ? '' : 'disabled'}></td><td><input class="input mono" data-k="to" inputmode="numeric" value="${esc(m.to || '')}" aria-label="OR To" ${enc ? '' : 'disabled'}></td>
      <td><input class="input r" data-k="amount" inputmode="decimal" value="${m.amount !== undefined && m.amount !== '' ? esc(money(m.amount)) : ''}" aria-label="Amount" ${enc ? '' : 'disabled'}>${m.beg ? '<br><span class="pill p-beg">Before the period</span>' : ''}</td>
      <td>${enc ? '<button class="btn sm cd-x" type="button" aria-label="Remove remittance">✕</button>' : ''}</td></tr>`;
  const crList = f.reports.filter((r) => !r.pending && collectors.some((c) => c.id === r.officerId)).map((r) => r.no);
  const remBlock = isLO ? `<div class="cd-block"><h3 class="cer-h3">Remittances received from collectors</h3>
      <div class="af-tbl cd-tblbox"><table class="af-reg cd-edit"><thead><tr><th scope="col">Date Received</th><th scope="col">From Collector</th><th scope="col">Collector's RCD No.</th><th scope="col">OR From</th><th scope="col">OR To</th><th scope="col" class="r">Amount (₱)</th><th scope="col"></th></tr></thead>
        <tbody id="cd-rems">${(cur.rec?.remittances || []).filter((m) => !m.fromCol).map(remRow).join('')}</tbody></table></div>
      ${(cur.rec?.remittances || []).some((m) => m.fromCol) ? `<h3 class="cer-h3" style="margin-top:10px">From the collectors' records <small class="dim">(remittances to this LO with their OR series)</small></h3>
        <div class="af-tbl cd-tblbox"><table class="af-reg"><thead><tr><th>Date</th><th>Collector</th><th>OR Series</th><th class="r">Amount (₱)</th></tr></thead>
        <tbody>${cur.rec.remittances.filter((m) => m.fromCol).map((m) => `<tr><td>${esc(fmtDate(m.date))}</td><td>${esc(f.officers.find((x) => x.id === m.collectorId)?.name || '')}</td><td class="mono">${esc(m.from)}–${esc(m.to)}</td><td class="r">${money(m.amount)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <datalist id="cd-crlist">${[...new Set(crList)].map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      ${enc ? `<div class="cd-actions"><button class="btn sm" type="button" id="cd-addrem">+ Add Remittance</button><button class="btn primary" type="button" id="cd-saverem">Save Remittances</button></div>` : ''}
      <p class="af-note">Each collector's remittance, with the date it was received (and the OR range, from the LO's cashbook). When the collector's RCD is in the app, its collections are compared with the amount; by OR range, the collector's cashbook is compared in Verification. A remittance dated before the last cash exam is in the beginning balance.</p></div>` : '';
  // SCD tab: the entry line on top (a new report, or the selected one to edit), a notice of records not yet in a report,
  // then the table of the officer's submitted reports (click a row to select it).
  const realFigs = fig.keys.filter((k) => usedKinds.includes(fig.chains[k].kind)).flatMap((k) => fig.chains[k].figs).sort((a, b) => byDate(a.rec, b.rec) || (a.rec.dupe || 0) - (b.rec.dupe || 0));
  const pends = fig.keys.map((k) => fig.chains[k]).filter((ch) => usedKinds.includes(ch.kind) && (ch.pend.nOrs || ch.pend.dep || ch.pend.remTotal));
  const notice = pends.map((ch) => { const p = ch.pend, last = ch.figs[ch.figs.length - 1];
    const what = [p.nOrs ? `${p.nOrs} OR${p.nOrs > 1 ? 's' : ''} (₱ ${money(p.orsTotal)})` : '', p.dep ? `₱ ${money(p.dep)} ${ch.kind === 'SCR' ? 'remitted' : 'deposits'}` : '', p.remTotal ? `₱ ${money(p.remTotal)} remittances received` : ''].filter(Boolean).join(' and ');
    return `<div>${what} of ${esc(ch.fund)}${!last ? '' : ch.figs.some(hasRange) ? ` outside the OR ranges of the ${ch.kind}s encoded` : ` dated after ${esc(fmtDate(last.rec.date))}`} ${p.nOrs + (p.rec?.deposits || []).length > 1 ? 'are not yet in an ' + ch.kind + '. They go' : 'is not yet in an ' + ch.kind + '. It goes'} into the next ${ch.kind} when you add it.</div>`; }).join('');
  const isNew = cur.pending;
  // A report with a series not matching its ORs, or ORs outside the received booklets: flagged in the list (details under its summary).
  const chkPill = (g) => { const t = g.issues.filter((x) => x.startsWith('Series ') || x.startsWith(NIB)); return t.length ? ` <span class="pill p-flag" title="${esc(t.join('\n'))}">⚠ Check</span>` : ''; };
  const sumTable = (pick) => realFigs.length ? `<div class="af-tbl"><table class="af-reg cd-sumtbl"><thead><tr><th scope="col">${KS0}</th><th scope="col">Fund</th><th scope="col">Date</th><th scope="col">Period</th><th scope="col">OR Range</th><th scope="col" class="r">ORs</th><th scope="col" class="r">Collections</th><th scope="col" class="r">${isRem ? 'Remitted' : 'Deposited'}</th><th scope="col" class="r">${isRem ? 'Unremitted' : 'Undeposited'}</th>${pick && enc ? '<th scope="col"></th>' : ''}</tr></thead>
      <tbody>${realFigs.map((g) => `<tr ${pick ? `data-pick="${esc(g.id)}" tabindex="0"` : ''} class="${g.id === selId ? 'cd-on' : ''}"><td><b>${esc(repName({ ...g.rec, sameDay: false, dupe: 0 }, g.kind))}</b>${chkPill(g)}</td><td>${esc(g.rec.fund)}</td><td>${esc(fmtDate(g.rec.date))}</td>
        <td>${g.from ? esc(`${fmtDate(g.from)}–${fmtDate(g.to)}`) : '<span class="dim">—</span>'}</td><td class="cd-rng">${hasRange(g) ? `<span class="cd-rngt" title="${esc(rangesTyped(g.rec.ranges).replace(/-/g, ' – '))}">${esc(rangesTyped(g.rec.ranges).replace(/-/g, ' – '))}</span> <small class="dim">· ${g.rangeIn} of ${g.rangeN}</small>` : `<span class="cd-rngt">${esc(g.range.replace(/Accountable Form 51 – (Barangay|LGU) /g, 'AF 51 ')) || '—'}</span> <small class="dim">· no range</small>`}</td><td class="r">${g.nOrs}${g.nCancelled ? ` <span class="dim">(${g.nCancelled} cancelled)</span>` : ''}</td>
        <td class="r">${money(g.coll)}</td><td class="r">${money(g.dep)}</td><td class="r">${money(g.end)}</td>
${pick && enc ? `<td><button class="btn sm" type="button" data-editrep="${esc(g.id)}">Edit</button></td>` : ''}</tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="5">Total, all ${KS0}</td><td class="r">${realFigs.reduce((n, g) => n + g.nOrs, 0)}</td><td class="r">${money(r2(realFigs.reduce((n, g) => n + g.coll, 0)))}</td><td class="r">${money(r2(realFigs.reduce((n, g) => n + g.dep, 0)))}</td><td></td>${pick && enc ? '<td></td>' : ''}</tr></tfoot></table></div>`
    : `<div class="empty"><b>No ${KS0} encoded for this officer yet.</b>${enc ? `Press + ${K} to enter one.` : ''}</div>`;
  const tip = `Each ${K} is entered once, from the hard copy. ORs, deposits${isLO ? ' and remittances' : ''} dated on or before an ${K}'s date go into it; those dated after the last ${K} wait for the next one. The ${isRem ? 'unremitted' : 'undeposited'} balance carries from one ${K} to the next of the same fund.${usedKinds.includes('SCR') ? ' The SCD is for AF 51 deposited in the bank; the SCR is for CTC remitted to the MTO.' : ''}`;
  const repBody = `<div class="cd-scdhead"><h3 class="cer-h3">${KS0} of this officer</h3><span class="crumb-i" title="${esc(tip)}">ⓘ</span>
      <span class="cd-scdbtns">${enc ? usedKinds.map((k) => `<button class="btn primary sm" type="button" data-newrep="${k}">+ ${k}</button>`).join('') : ''}<button class="btn sm" type="button" id="cd-funds">Funds (${funds.length})</button><button class="btn sm" type="button" id="cd-sumxls2">Export to Excel</button></span></div>
    ${sumTable(true)}
    ${remBlock}`;

  /* ----- 2 · Collections ----- */
  const myBooklets = (form) => f.booklets.filter((b) => b.form === form && b.officerId === o.id && b.status !== 'lost' && !b.noSerial).sort((a, b) => a.from - b.from);
  const ckey = o.id + '|' + selId;
  const cbook = exam.records === 'cashbook', cbMode = cbook || f.ors.some((x) => x.officerId === o.id && x.range);
  if (LASTC.key !== ckey) Object.assign(LASTC, { key: ckey, form: '', bookletId: '', serial: '', focus: '', mode: cbook ? 'range' : 'one' });
  if (!cbMode) LASTC.mode = 'one';
  const form = forms.includes(LASTC.form) ? LASTC.form : forms[0] || '';
  const bks = myBooklets(form);
  // Unused per the Forms Register: numbers used before the beginning (partly used) and ORs already encoded are both taken out.
  const unusedOfBk = (b) => countRanges(bookletUnused(b));
  const bk = LASTC.bookletId === '__none' ? null : bks.find((b) => b.id === LASTC.bookletId) || bks.find((b) => unusedOfBk(b) > 0 && b.status === 'issued') || bks[0] || null;
  // Next OR: the first number after the last one used (skipped numbers below it are not offered).
  const nextSerial = (b) => { if (!b) return ''; const rs = bookletUnused(b); const last = rs[rs.length - 1]; return last && last[1] === b.to ? last[0] : ''; };
  const serial = LASTC.serial !== '' && LASTC.serial !== undefined ? LASTC.serial : nextSerial(bk);
  const parts = [...new Set(f.ors.filter((x) => x.lguId === audit.lguId).flatMap((x) => (x.items || []).map((i) => i.p)).filter((p) => p && p !== NO_PART))].sort();
  const show = q.get('show') === 'sel' ? 'sel' : q.get('show') === 'all' || cur.pending ? 'all' : 'sel';
  const listOrs = (show === 'all' ? f.ors.filter((x) => x.officerId === o.id) : cur.ors).slice().sort((a, b) => String(a.form).localeCompare(String(b.form)) || a.serial - b.serial);
  const repPill = (x) => { if (!x.reportId) return `<span class="pill p-part">Not yet in an ${K}</span>`; const r = f.reports.find((y) => y.id === x.reportId); return `<span class="pill p-stock">${esc(r ? (r.no ? `${K} ${r.no}` : repName(r, K)) : '—')}</span>`; };
  // The first line also carries the Date of Collection (one date per OR); the other lines leave that column empty.
  const dateCell = `<div class="cd-dcell"><label class="sr-only" for="cd-ordate">Date of Collection</label><input class="input" type="date" id="cd-ordate" value="${esc(LASTC.date)}"></div>`;
  // The OR on one line: OR No., next, status, date, particular, amount, ✕, Enter. More particulars line up below.
  const orCells = `<div class="cd-ocell"><label class="sr-only" for="cd-or">OR No.</label><input class="input mono cd-orno" id="cd-or" inputmode="numeric" value="${esc(serial)}" autocomplete="off"></div>
      <label class="cd-auto" title="Auto-next: the next OR No. is filled in after saving"><input type="checkbox" id="cd-autonext" ${LASTC.auto ? 'checked' : ''}> next</label>
      <div class="seg cd-st" role="group" aria-label="Status"><a href="#" data-st="issued" class="${LASTC.status !== 'cancelled' ? 'on' : ''}" aria-pressed="${LASTC.status !== 'cancelled'}">Issued</a><a href="#" data-st="cancelled" class="${LASTC.status === 'cancelled' ? 'on' : ''}" aria-pressed="${LASTC.status === 'cancelled'}">Cancelled</a></div>`;
  const partRow = (p = {}, i = 0) => `<div class="cd-prow">${i ? '<span></span><span></span><span></span><span></span>' : orCells + dateCell}<label class="sr-only" for="cd-p${i}">Particular ${i + 1}</label><input class="input cd-p" id="cd-p${i}" list="cd-parts" value="${esc(p.p || '')}" placeholder="Type to search or add a new particular…" autocomplete="off">
      <label class="sr-only" for="cd-a${i}">Amount ${i + 1}</label><input class="input r cd-a" id="cd-a${i}" inputmode="decimal" value="${p.amt ? esc(money(p.amt)) : ''}" placeholder="0.00" autocomplete="off">
      <button class="btn sm cd-x" type="button" aria-label="Remove particular">✕</button>${i ? '<span></span>' : '<button class="btn primary" type="button" id="cd-enter">Enter</button>'}</div>`;
  const colBody = !forms.length ? `<div class="cd-info">This officer has no accountable forms ticked in Audit Setup${isLO ? '. A Liquidating Officer who issues ORs himself needs Collecting and the forms ticked there' : ''}. ${isLO ? 'Remittances and deposits are entered in parts 1 and 3.' : ''}</div>`
    : `${enc ? `<div class="cd-set">
        <div class="field"><label for="cd-form">Form Type</label><select class="input" id="cd-form">${forms.map((k) => `<option value="${esc(k)}" ${k === form ? 'selected' : ''}>${esc(FORMS.find(([x]) => x === k)?.[1] || k)}</option>`).join('')}</select></div>
        <div class="field"><label for="cd-bk">Booklet</label><select class="input" id="cd-bk">${bks.map((b) => `<option value="${esc(b.id)}" ${bk && b.id === bk.id ? 'selected' : ''}>${b.from} – ${b.to} · ${unusedOfBk(b)} unused</option>`).join('')}<option value="" ${bk ? '' : 'selected'}>Not in the Forms Register</option></select></div>
        <span class="cd-goes">Goes to: <b>${esc(cur.pending ? `the ${K} whose OR Range has its number` : repName(cur.rec, K))} · ${esc(curFund)}</b> <span class="crumb-i" title="Enter moves along: Date → Particulars → Amount → saves the OR, then back to Date for the next OR (Alt + Enter in Amount adds another particular). The fund follows the ${K}. Cancelled ORs have no particulars and a zero amount.">ⓘ</span></span>
      </div>
      ${cbMode ? '' : '<!--'}<div class="seg cd-mode" role="group" aria-label="How to encode"><a href="#" data-cmode="one" class="${LASTC.mode !== 'range' ? 'on' : ''}">One OR at a time</a><a href="#" data-cmode="range" class="${LASTC.mode === 'range' ? 'on' : ''}">By OR range</a></div>${cbMode ? '' : '-->'}
      ${LASTC.mode === 'range' ? `<div class="sd-line cd-rgentry" id="cd-rgform">
        <div class="sd-f sd-w-date"><label for="rg-date">Date</label><input class="input" type="date" id="rg-date" value="${esc(LASTC.date)}"></div>
        <div class="sd-f sd-w-no"><label for="rg-from">OR From</label><input class="input mono" id="rg-from" inputmode="numeric" value="${esc(LASTC.rgNext || '')}"></div>
        <div class="sd-f sd-w-no"><label for="rg-to">OR To</label><input class="input mono" id="rg-to" inputmode="numeric"></div>
        <div class="sd-f sd-w-amt"><label for="rg-amt">Total (₱)</label><input class="input r" id="rg-amt" inputmode="decimal"></div>
        <div class="sd-f sd-w-txt"><label for="rg-cx">Cancelled (optional)</label><input class="input mono" id="rg-cx" placeholder="e.g. 6827281, 6827290"></div>
        <div class="sd-f sd-w-btn"><label>&nbsp;</label><button class="btn primary" type="button" id="rg-enter">Enter</button></div></div>
        <p class="af-note">From a cashbook when the ${K} is not available: one line per day, its OR range and total. The whole range counts as used.${exam.lastExamDate ? ` A line dated before ${esc(fmtDate(exam.lastExamDate))} (the last cash exam) is tagged "Before the period": its ORs are used, its amount is in the beginning balance.` : ''}</p>
        <label class="cer-tick cd-rga"><input type="checkbox" id="rg-a" ${f.settings?.['orrange|' + o.id]?.noA ? '' : 'checked'}> ORs of a booklet before the first range of the period were used before the last cash exam (not flagged as missing)</label>` : ''}
      <div class="cd-entry cd-one" ${LASTC.mode === 'range' ? 'hidden' : ''}>
        <div class="cd-parts cd-entryt ${LASTC.status === 'cancelled' ? 'cd-cxl' : ''}" id="cd-partsbox">
          <div class="cd-phead"><span>OR No.</span><span></span><span>Status</span><span>Date of Collection</span><span>Particulars</span><span class="r">Amount (₱)</span><span></span><span></span></div>
          <div id="cd-prows">${partRow({}, 0)}</div>
          <div class="cd-pfoot"><span></span><span></span><span></span><span></span><span><button class="cd-link" type="button" id="cd-addp" ${LASTC.status === 'cancelled' ? 'hidden' : ''}>+ Add Particular</button></span>
            <span class="cd-ortotal" id="cd-ortotbox" hidden>OR Total <b id="cd-ortot">₱ 0.00</b></span><span></span><span></span></div>
        </div>
        <div id="cd-skip"></div>
        <datalist id="cd-parts">${parts.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
      </div>` : ''}
      <div class="cd-listhead"><h3 class="cer-h3">Encoded ORs</h3>
        <label class="sr-only" for="cd-search">Search ORs</label><input class="input af-sm" id="cd-search" placeholder="Search OR No. or particular…">
        <label class="sr-only" for="cd-show">Show</label><select class="input af-sm" id="cd-show"><option value="sel" ${show === 'sel' ? 'selected' : ''}>${esc(cur.pending ? `Not yet in an ${K} · ` + cur.fund : repName(cur.rec, K))}</option><option value="all" ${show === 'all' ? 'selected' : ''}>All of this officer</option></select>
        <span class="cd-total">Total <b>₱ ${money(listOrs.reduce((n, x) => n + orAmount(x), 0))}</b></span>
        ${enc && forms.length ? '<a href="#" class="cd-link cd-tpl" id="cd-ortpl">Template</a><button class="btn" type="button" id="cd-orimp">Import from Excel</button>' : ''}<button class="btn" type="button" id="cd-xls">Export to Excel</button></div>
      ${listOrs.length ? `<div class="af-tbl cd-orscroll"><table class="af-reg cd-ors"><thead><tr><th scope="col">No.</th><th scope="col">OR No.</th><th scope="col">Date</th><th scope="col">Particulars</th><th scope="col" class="r">Amount (₱)</th><th scope="col">Status</th><th scope="col">${K}</th><th scope="col" class="r"></th></tr></thead>
        <tbody>${listOrs.map((x, i) => `<tr data-or="${esc(x.id)}" data-s="${esc((x.serial + ' ' + (x.items || []).map((p) => p.p).join(' ')).toLowerCase())}"><td>${i + 1}</td><td class="mono" title="${esc(FORM_SHORT[x.form] || x.form)}">${x.range ? `${x.serial}–${x.serialTo} <small class="dim">${maxSer(x) - x.serial + 1} ORs</small>` : x.serial}${x.beg ? ' <span class="pill p-beg" title="Dated before the last cash exam: in the beginning balance">Before the period</span>' : ''}${outOfBooklets(f, o, x) && !inBegRanges(begRangesOf(exam), x) ? ' <span class="pill p-flag" title="Its number is in no booklet received or issued to this officer in the Forms Register">Not in a received booklet</span>' : ''}</td><td>${esc(fmtDate(x.date))}</td>
          ${(() => { const one = enc && x.status !== 'cancelled' && (x.items || []).length <= 1, p = (x.items || [])[0]?.p || '';
            return `<td ${one ? `class="cd-ed" data-ip="${esc(x.id)}" tabindex="0" title="Click to change the particular"` : ''}>${x.status === 'cancelled' ? '<span class="dim">—</span>' : (x.items || []).length > 1 ? esc(x.items.map((q) => q.p).join('; ')) : p === NO_PART || !p ? `<span class="cd-nopart">${NO_PART}</span>` : esc(p)}</td>
            <td class="r ${one ? 'cd-ed' : ''}" ${one ? `data-ia="${esc(x.id)}" tabindex="0" title="Click to change the amount"` : ''}>${x.beg ? `<span class="dim" title="In the beginning balance, not this period's">${money(+x.amount || 0)}</span>` : money(orAmount(x))}</td>`; })()}
          <td><span class="pill ${x.status === 'cancelled' ? 'p-stock' : 'p-done'}">${x.status === 'cancelled' ? 'Cancelled' : 'Issued'}</span></td><td>${repPill(x)}</td>
          <td class="r">${enc ? (x.range ? `<button class="btn sm" type="button" data-rgdel="${esc(x.id)}" aria-label="Delete range ${x.serial}">Delete</button>` : `<button class="btn sm" type="button" data-edit="${esc(x.id)}" aria-label="Edit OR ${x.serial}">Edit</button>`) : ''}</td></tr>`).join('')}</tbody></table></div>
        <p class="af-note">In OR No. order. Click a particular or an amount to change it (an OR with several particulars: Edit). Delete is only for an encoding mistake; a cancelled OR is encoded as Cancelled, not deleted.</p>`
      : `<div class="empty"><b>No ORs encoded here yet.</b>${enc ? 'Encode them above, one OR at a time.' : ''}</div>`}`;

  /* ----- 3 · Deposits (SCR: remittances to the MTO) ----- */

  // A collector who remits to the Liquidating Officer (Audit Setup): same report (RCD / SCD), each entry a remittance to the LO.
  const toLO = !isRem && !!exam.remitToLO;
  const remish = isRem || toLO;
  const DEP = isRem ? 'Remittance' : toLO ? 'Remittance to LO' : 'Deposit', DEPS = isRem ? 'Remittances' : toLO ? 'Remittances to LO' : 'Deposits';
  // Cashbook only: each deposit / remittance with the OR series it covers. The next series starts after the last one.
  const lastTo = Math.max(0, ...f.reports.filter((r) => r.officerId === o.id).flatMap((r) => (r.deposits || []).filter((d) => !d.fromLO).map((d) => +d.to || 0)));
  const firstOr = Math.min(Infinity, ...f.ors.filter((x) => x.officerId === o.id && !x.beg && (!exam.lastExamDate || x.date >= exam.lastExamDate)).map((x) => +x.serial));
  const sCell = (d) => (cbook ? `<td><input class="input mono" data-k="from" inputmode="numeric" value="${esc(d.from || '')}" aria-label="OR From" ${enc ? '' : 'disabled'}></td><td><input class="input mono" data-k="to" inputmode="numeric" value="${esc(d.to || '')}" aria-label="OR To" ${enc ? '' : 'disabled'}></td>` : '');
  const depRow = (d = {}) => `<tr class="cd-dep"><td><input class="input" type="date" data-k="date" value="${esc(d.date || '')}" aria-label="${toLO ? 'Date remitted' : 'Deposit date'}" ${enc ? '' : 'disabled'}></td>
      <td><input class="input" data-k="ref" value="${esc(d.ref || '')}" list="cd-reflist" placeholder="${remish ? 'Choose or type the name' : 'Choose or type'}" aria-label="${remish ? 'Liquidating Officer' : 'Reference'}" ${enc ? '' : 'disabled'}></td>
      ${remish ? '' : `<td><input class="input mono" data-k="no" value="${esc(d.no || '')}" placeholder="Optional" aria-label="Deposit slip No." ${enc ? '' : 'disabled'}></td>`}
      ${sCell(d)}<td><input class="input r" data-k="amount" inputmode="decimal" value="${d.amount !== undefined && d.amount !== '' ? esc(money(d.amount)) : ''}" aria-label="Amount" ${enc ? '' : 'disabled'}></td>
      <td>${enc ? '<button class="btn sm cd-x" type="button" aria-label="Remove deposit">✕</button>' : ''}</td></tr>`;
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
  const shownDeps = DEPSHOW.v === 'sel' ? allDeps.filter((d) => d.g.id === selId) : allDeps;
  const depReg = `<div class="cd-block cd-depreg"><div class="cd-orhead"><h3 class="cer-h3">${remish ? 'Remittances' : 'Deposits'} register</h3><span class="pill">${shownDeps.length}</span>
      <label class="sr-only" for="cd-depshow">Show</label><select class="input af-sm" id="cd-depshow"><option value="all" ${DEPSHOW.v !== 'sel' ? 'selected' : ''}>All of this officer</option><option value="sel" ${DEPSHOW.v === 'sel' ? 'selected' : ''}>${esc(cur.pending ? `Not yet in an ${K} · ` + cur.fund : repName(cur.rec, K))}</option></select>
      <button class="btn sm" type="button" id="cd-depxls">Export to Excel</button></div>
    ${shownDeps.length ? `<div class="af-tbl cd-depscroll"><table class="af-reg cd-deptbl"><thead><tr><th scope="col">Date</th><th scope="col">${remish ? 'Liquidating Officer' : 'Reference'}</th><th scope="col" class="r">Amount (₱)</th>${dSplit ? '<th scope="col" class="r">AF 51</th><th scope="col" class="r">CTC</th>' : ''}${dHasSer ? '<th scope="col">Check</th>' : ''}<th scope="col">${isRem ? 'SCR' : usedKinds.filter((k) => k !== 'SCR').join(' / ')}</th><th scope="col">Fund</th></tr></thead>
      <tbody>${shownDeps.map((d) => `<tr data-pickdep="${esc(d.g.id)}" tabindex="0" class="${d.g.id === selId ? 'cd-on' : ''}"><td>${esc(fmtDate(d.date))}</td><td class="mono">${esc(depRefText(d, d.kind === 'SCR'))}</td><td class="r">${money(+d.amount || 0)}</td>${dSplit ? `<td class="r">${money(r2((+d.amount || 0) - dCtc(d)))}</td><td class="r">${money(dCtc(d))}</td>` : ''}${dHasSer ? `<td>${dChk(d)}</td>` : ''}<td>${esc(d.g.pending ? `Not yet in an ${d.kind}` : repName(d.g.rec, d.kind))}</td><td>${esc(d.fund)}</td></tr>`).join('')}</tbody>
      <tfoot><tr class="cd-foot"><td colspan="2">Total</td><td class="r">${money(r2(shownDeps.reduce((n, d) => n + (+d.amount || 0), 0)))}</td>${dSplit ? `<td class="r">${money(r2(shownDeps.reduce((n, d) => n + (+d.amount || 0) - dCtc(d), 0)))}</td><td class="r">${money(r2(shownDeps.reduce((n, d) => n + dCtc(d), 0)))}</td>` : ''}${dHasSer ? '<td></td>' : ''}<td colspan="2"></td></tr></tfoot></table></div>`
      : `<div class="empty"><b>No ${remish ? 'remittance' : 'deposit'} encoded yet.</b></div>`}</div>`;
  const depBody = `<div class="af-tbl cd-tblbox"><table class="af-reg cd-edit"><thead><tr><th scope="col">${isRem ? 'Date Received by MTO' : toLO ? 'Date Remitted to LO' : 'Deposit Date'}</th><th scope="col">${remish ? 'Liquidating Officer' : 'Reference'}</th>${remish ? '' : '<th scope="col">No.</th>'}${cbook ? '<th scope="col">OR From</th><th scope="col">OR To</th>' : ''}<th scope="col" class="r">Amount (₱)</th><th scope="col"></th></tr></thead>
      <tbody id="cd-deps" data-next="${lastTo ? lastTo + 1 : isFinite(firstOr) ? firstOr : ''}">${(cur.rec?.deposits || []).filter((d) => !d.fromLO).map(depRow).join('')}</tbody></table></div>
    ${(cur.rec?.deposits || []).some((d) => d.fromLO) ? `<div class="cd-block"><h3 class="cer-h3">Received by the Liquidating Officer <small class="dim">(from the LO's cashbook)</small></h3>
      <div class="af-tbl cd-tblbox"><table class="af-reg"><thead><tr><th>Date</th><th>Liquidating Officer</th><th>OR Range</th><th class="r">Amount (₱)</th></tr></thead>
      <tbody>${cur.rec.deposits.filter((d) => d.fromLO).map((d) => `<tr><td>${esc(fmtDate(d.date))}</td><td>${esc(d.ref)}</td><td class="mono">${d.from ? `${esc(d.from)}–${esc(d.to || d.from)}` : ''}</td><td class="r">${money(d.amount)}</td></tr>`).join('')}</tbody></table></div>
      <p class="af-note">Entered in the Liquidating Officer's Collections (remittances received). They count as this officer's remittances; not typed again here.</p></div>` : ''}
    <datalist id="cd-reflist">${(remish ? loNames(refs, f, lgu) : depRefs(f, audit.lguId)).map((v) => `<option value="${esc(v)}">`).join('')}</datalist>
    ${enc ? `<div class="cd-actions"><button class="btn sm" type="button" id="cd-adddep">+ Add ${DEP}</button><button class="btn primary" type="button" id="cd-savedep">Save ${DEPS}</button></div>` : ''}
    <div class="cd-sum">
      <b class="cd-sumh">Summary (computed) · ${esc(cur.pending ? `Not yet in an ${K} · ` + cur.fund : repName(cur.rec, K))}</b>
      <div><span>${remish ? 'Unremitted' : 'Undeposited'}, last ${K}</span><span>${money(cur.beg)}</span></div>
      ${cur.begAdd ? `<div><span>Add: Beginning balance, last cash exam (ORs in this ${cur.pending ? 'list' : K}${cur.begSer ? `: ${esc(cur.begSer)}` : ''})</span><span>${money(cur.begAdd)}</span></div>` : ''}
      <div><span>Add: Collections${isLO ? ' (ORs ₱' + money(cur.orsTotal) + ' + remittances ₱' + money(cur.remTotal) + ')' : ''}</span><span>${money(cur.coll)}</span></div>
      <div><span>Less: ${DEPS}</span><span>${money(cur.dep)}</span></div>
      <div class="cd-sumt"><span>${remish ? 'Unremitted' : 'Undeposited'}, end</span><span>${money(cur.end)}</span></div>
      ${agree}${cur.issues.filter((t) => t.startsWith('Series ') || t.startsWith(NIB)).map((t) => `<p class="cd-serchk">⚠ ${esc(t)}</p>`).join('')}</div>
    ${isLO ? `<div class="cd-block"><h3 class="cer-h3">Days with the LO · received → deposited</h3>
      ${lo.length ? `<div class="af-tbl cd-tblbox"><table class="af-reg"><thead><tr><th scope="col">Date Received</th><th scope="col">From</th><th scope="col">Collector's RCD No.</th><th scope="col">Fund</th><th scope="col" class="r">Amount (₱)</th><th scope="col">Deposited</th><th scope="col">Deposit Reference</th><th scope="col" class="r">Days with LO</th></tr></thead>
        <tbody>${lo.map((x) => `<tr><td>${esc(fmtDate(x.date))}</td><td>${esc(x.from)}</td><td class="mono">${esc(x.no || '')}</td><td>${esc(x.fund)}</td><td class="r">${money(x.amount)}</td>
          <td>${x.undeposited ? '<span class="pill p-stock">Undeposited</span>' : esc(fmtDate(x.depDate))}</td><td>${esc(x.depRef || '')}</td><td class="r">${x.days ?? '—'}${x.undeposited ? ' <span class="dim">to the count</span>' : ''}</td></tr>`).join('')}</tbody></table></div>
        <p class="af-note">Days with LO = date received to date deposited; deposits cover the remittances in date order. An undeposited remittance counts up to the cash count on ${esc(fmtDate(audit.countDate))}.</p>`
      : '<div class="empty"><b>No remittances received yet.</b>Enter them in part 1.</div>'}</div>` : ''}
    ${depReg}`;

  /* ----- Summary by report ----- */
  const allFigs = realFigs;
  const KS = usedKinds.join(' / ');
  const tot = (k) => r2(allFigs.reduce((n, g) => n + g[k], 0));
  const sumBody = sumTable(true);

  const nPend = pends.reduce((n, ch) => n + ch.pend.nOrs, 0);
  const subRep = cur.pending ? (nPend ? `${nPend} OR${nPend > 1 ? 's' : ''} not yet in an ${K}` : `${realFigs.length} ${K}${realFigs.length === 1 ? '' : 's'} · none selected`) : (cur.rec.no ? `${esc(repName(cur.rec, K))} · ${esc(fmtDate(cur.rec.date))}` : esc(repName(cur.rec, K)));
  // One compact panel on top: the two choices on one line, the three tabs under them.
  const body = hello() + topBar(kindPick, true) + `
    ${tabs([['rep', K, subRep, repBody], ['col', 'Collections', `${cur.nOrs} OR${cur.nOrs === 1 ? '' : 's'} · ₱ ${money(cur.orsTotal)}`, colBody],
      ['dep', isRem ? 'Remittances to MTO' : 'Deposits', `₱ ${money(cur.dep)} ${isRem ? 'remitted' : 'deposited'} · ₱ ${money(cur.end)} ${isRem ? 'unremitted' : 'undeposited'}`, depBody]])}
`;

  const ctxw = { refs, f, audit, lgu, K, KS, o, exam, fig, cur, curFund, curKey, selId, isLO, enc, funds, form, bk, bks, listOrs, allFigs, isFirst, toLO, cbook };
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
    'OR Range': g.range, 'No. of ORs': g.nOrs, Cancelled: g.nCancelled, 'Undeposited, Last': g.beg, 'Beginning, Last Cash Exam': g.begAdd || 0, 'Collections (ORs)': g.orsTotal, Remittances: g.remTotal, Deposited: g.dep, 'Undeposited, End': g.end,
    'Total per Hard Copy': g.pending ? '' : (g.rec.hardTotal ?? ''), 'Date Received': g.pending ? '' : fmtDate(g.rec.received), Checks: g.issues.join(' ') || 'Complete' })));
  ['#cd-sumxls', '#cd-sumxls2'].forEach((id) => { const b = $(id); if (b) b.onclick = sumX; });
  const xls = $('#cd-xls');
  if (xls) xls.onclick = () => exportXlsx(`ORs ${o.name} ${audit.countDate}.xlsx`, 'ORs', c.listOrs.map((x) => ({
    Form: FORM_SHORT[x.form] || x.form, 'OR No.': x.serial, Date: fmtDate(x.date), Particulars: (x.items || []).map((p) => p.p).join('; '), 'Amounts': (x.items || []).map((p) => money(p.amt)).join('; '),
    Fund: x.fund || '', Amount: orAmount(x), Status: x.status === 'cancelled' ? 'Cancelled' : 'Issued', [K]: x.reportId ? repName(f.reports.find((r) => r.id === x.reportId), K) : `Not yet in an ${K}` })));
  const sr = $('#cd-search');
  if (sr) sr.oninput = () => { const t = sr.value.trim().toLowerCase(); $$('tr[data-or]').forEach((tr) => { tr.hidden = !!t && !tr.dataset.s.includes(t); }); };
  const sh = $('#cd-show'); if (sh) sh.onchange = () => go({ show: sh.value === 'all' ? 'all' : 'sel' });
  if (!enc) return;

  /* SCD / RCD */
  // + SCD / + SCR opens a window for a new report; Edit on a row opens it for that report.
  $$('[data-newrep]').forEach((b) => { b.onclick = () => reportModal(c, b.dataset.newrep, null); });
  $$('[data-editrep]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); const g = c.fig.byId[b.dataset.editrep]; if (g) reportModal(c, g.kind, g); }; });
  const pendRec = async (patch) => {
    const id = cur.pending ? cur.id : selId;
    const base = cur.rec && cur.rec.lguId ? strip(cur.rec) : { lguId: audit.lguId, officerId: o.id, kind: K, fund: curFund, pending: true, deposits: [], remittances: [] };
    delete base.pending; if (cur.pending) base.pending = true;
    await store.save('cer_reports', id, { ...base, ...patch }, by(refs));
  };
  /* table editors (remittances, deposits) */
  const tbodyOf = (tr) => ({ querySelectorAll: () => [tr] });
  const wireRows = (box) => $$('.cd-x', box).forEach((b) => { b.onclick = () => b.closest('tr').remove(); });
  const remBox = $('#cd-rems');
  if (remBox) {
    wireRows(remBox);
    const blankRem = () => { const t = document.createElement('tbody'); t.innerHTML = remRowHtml(c); return t.firstElementChild; };
    $('#cd-addrem').onclick = () => { const tr = blankRem(); remBox.appendChild(tr); wireRows(remBox); $('input', tr).focus(); };
    $('#cd-saverem').onclick = async () => {
      const list = [];
      for (const tr of $$('tr', remBox)) {
        const g = (k) => $(`[data-k="${k}"]`, tr).value.trim();
        if (!g('date') && !g('amount') && !g('collectorId')) continue;
        if (!g('date')) return bad('Enter the date received of each remittance.');
        if (!g('collectorId')) return bad('Choose the collector of each remittance.');
        const amt = num(g('amount')); if (!amt) return bad('Enter the amount of each remittance.');
        const cr = f.reports.find((r) => !r.pending && r.officerId === g('collectorId') && String(r.no).trim().toUpperCase() === g('reportNo').toUpperCase());
        const fr = g('from').replace(/\D/g, ''), to = g('to').replace(/\D/g, '') || fr;
        if (fr && +to < +fr) return bad('OR To must not be before OR From.');
        list.push({ date: g('date'), collectorId: g('collectorId'), reportNo: g('reportNo'), reportId: cr ? cr.id : '', amount: amt, ...(fr ? { from: fr, to } : {}), ...(c.exam.lastExamDate && g('date') < c.exam.lastExamDate ? { beg: true } : {}) });
      }
      list.sort((a, b) => a.date.localeCompare(b.date));
      await pendRec({ remittances: list }); toast('Remittances saved.', 'ok');
    };
  }
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
    $('#cd-adddep').onclick = () => { const t = document.createElement('tbody'); t.innerHTML = depRowHtml(c.K === 'SCR' || c.toLO, c.toLO, c.cbook);
      if (c.cbook) { const tos = $$('[data-k="to"]', depBox).map((i) => +i.value || 0); const nx = Math.max(+depBox.dataset.next || 0, ...tos.map((v) => (v ? v + 1 : 0))); const fi = $('[data-k="from"]', t.firstElementChild); if (fi && nx) fi.value = nx; } const tr = t.firstElementChild; depBox.appendChild(tr); wireRows(depBox); if (c.cbook) wireSeries(tbodyOf(tr)); $('input', tr).focus(); };
    if (!depBox.children.length) $('#cd-adddep').click();
    $('#cd-savedep').onclick = async () => {
      const list = [];
      for (const tr of $$('tr', depBox)) {
        const g = (k) => { const el = $(`[data-k="${k}"]`, tr); return el ? el.value.trim() : ''; };
        if (!g('date') && !g('amount') && !g('ref') && !g('no')) continue;
        if (!g('date')) return bad('Enter the date of each deposit.');
        const amt = num(g('amount')); if (!amt) return bad('Enter the amount of each deposit.');
        const sf = g('from').replace(/\D/g, ''), stt = g('to').replace(/\D/g, '') || sf;
        if (sf && +stt < +sf) return bad('OR To must not be before OR From.');
        list.push({ date: g('date'), ref: g('ref'), ...(g('no') ? { no: g('no') } : {}), amount: amt, ...(c.toLO ? { toLO: true } : {}), ...(sf ? { from: sf, to: stt } : {}) });
      }
      list.sort((a, b) => a.date.localeCompare(b.date));
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
  $$('td[data-ip]').forEach((td) => { td.onclick = () => cellEdit(td, 'p'); td.onkeydown = (e) => { if (e.key === 'Enter') cellEdit(td, 'p'); }; });
  $$('td[data-ia]').forEach((td) => { td.onclick = () => cellEdit(td, 'a'); td.onkeydown = (e) => { if (e.key === 'Enter') cellEdit(td, 'a'); }; });
  const imp = $('#cd-orimp'); if (imp) imp.onclick = () => importOrs(c);
  const tpl = $('#cd-ortpl'); if (tpl) tpl.onclick = async (e) => { e.preventDefault(); try { const XLSX = await loadXlsx(); const ws = XLSX.utils.aoa_to_sheet([['Date', 'OR No.', 'Particular', 'Amount']]); ws['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 40 }, { wch: 12 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'ORs'); XLSX.writeFile(wb, 'OR Import Template.xlsx'); } catch (err) { toast(err.message || String(err), 'bad'); } };

  /* By OR range */
  $$('[data-cmode]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); LASTC.mode = a.dataset.cmode; emitChange('local'); }; });
  $$('[data-rgdel]').forEach((b) => { b.onclick = async () => { const x = f.ors.find((y) => y.id === b.dataset.rgdel);
    const ok = await modal({ title: `Delete ${x.serial}–${x.serialTo}?`, body: '<p style="margin:0">Only for an encoding mistake.</p>', buttons: [{ label: 'Keep', value: false }, { label: 'Delete', cls: 'danger', value: true }] });
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
      const beg = !!c.exam.lastExamDate && date < c.exam.lastExamDate;
      const rec = { lguId: audit.lguId, officerId: o.id, form, bookletId: bk ? bk.id : '', serial: a, serialTo: z, range: true, date, status: 'issued', items: [{ p: 'Collections (by OR range)', amt: r2(tot) }], amount: r2(tot), fund: c.curFund,
        reportId: c.cur.pending || hasRange(c.cur) ? placeIn(c.fig.chains[c.curKey], date, a) : c.selId, ...(cx.length ? { cancelledNos: cx } : {}), ...(beg ? { beg: true } : {}) };
      Object.assign(LASTC, { date, rgNext: String(z + 1) });
      await store.save('cer_ors', newId('ceror'), rec, by(refs));
      toast(`${a}–${z} saved${beg ? ' (before the period: in the beginning balance)' : ''}.`, 'ok');
      setTimeout(() => { const el = $('#rg-to'); if (el) el.focus(); }, 80);
    };
    $('#rg-enter').onclick = saveRg;
    $('#cd-rgform').onkeydown = (e) => { if (e.key !== 'Enter') return; e.preventDefault(); const els = ['#rg-date', '#rg-from', '#rg-to', '#rg-amt', '#rg-cx'].map((k) => $(k)); const i = els.indexOf(e.target); if (i < 0 || i >= els.length - 2) saveRg(); else els[i + 1].focus(); };
  }
  if ($('#cd-form') && LASTC.mode === 'range') $('#cd-form').onchange = (e) => { Object.assign(LASTC, { form: e.target.value, bookletId: '', serial: '' }); emitChange('local'); };

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
  dateIn.onkeydown = (e) => { if (e.key !== 'Enter') return; e.preventDefault(); LASTC.date = dateIn.value; if (LASTC.status === 'cancelled') enter.click(); else $('.cd-p', rows).focus(); };
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
      Object.assign(LASTC, { form, bookletId: nextBk, serial: next, date, focus: 'date' });
      await store.save('cer_ors', newId('ceror'), orData(c, b, n, date, st, items), by(refs));
      toast(`OR ${n} saved.`, 'ok');
    } finally { enter.disabled = false; }
  };
  // Focus after a save: the Date of the next OR (the OR No. after encoding skipped numbers).
  if (LASTC.focus) { const el = LASTC.focus === 'or' ? orIn : dateIn; if (el) el.focus(); LASTC.focus = ''; }
}
const orData = (c, b, serial, date, status, items) => ({ lguId: c.audit.lguId, officerId: c.o.id, form: $('#cd-form') ? $('#cd-form').value : (b ? b.form : ''), bookletId: b ? b.id : '', serial, date, status,
  items, amount: status === 'cancelled' ? 0 : r2(items.reduce((n, i) => n + i.amt, 0)), fund: c.curFund, reportId: c.cur.pending || hasRange(c.cur) ? placeIn(c.fig.chains[c.curKey], date, serial) : c.selId,
  ...(c.exam.lastExamDate && date && date < c.exam.lastExamDate ? { beg: true } : {}) });   // before the period: its amount is in the beginning balance
function partRowHtml(i) {
  return `<div class="cd-prow"><label class="sr-only" for="cd-p${i}">Particular ${i + 1}</label><input class="input cd-p" id="cd-p${i}" list="cd-parts" placeholder="Type to search or add a new particular…" autocomplete="off">
    <label class="sr-only" for="cd-a${i}">Amount ${i + 1}</label><input class="input r cd-a" id="cd-a${i}" inputmode="decimal" placeholder="0.00" autocomplete="off">
    <button class="btn sm cd-x" type="button" aria-label="Remove particular">✕</button></div>`;
}
function remRowHtml(c) {
  const collectors = c.f.officers.filter((x) => x.id !== c.o.id && x.lguId === c.audit.lguId).sort((a, b) => a.name.localeCompare(b.name));
  return `<tr class="cd-rem"><td><input class="input" type="date" data-k="date" aria-label="Date received"></td>
    <td><select class="input" data-k="collectorId" aria-label="From collector"><option value="">— Collector —</option>${collectors.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select></td>
    <td><input class="input mono" data-k="reportNo" list="cd-crlist" aria-label="Collector's RCD No."></td>
    <td><input class="input mono" data-k="from" inputmode="numeric" aria-label="OR From"></td><td><input class="input mono" data-k="to" inputmode="numeric" aria-label="OR To"></td>
    <td><input class="input r" data-k="amount" inputmode="decimal" aria-label="Amount"></td>
    <td><button class="btn sm cd-x" type="button" aria-label="Remove remittance">✕</button></td></tr>`;
}
function depRowHtml(rem, toLO = false, series = false) {
  return `<tr class="cd-dep"><td><input class="input" type="date" data-k="date" aria-label="${toLO ? 'Date remitted to LO' : rem ? 'Date received by MTO' : 'Deposit date'}"></td>
    <td><input class="input" data-k="ref" list="cd-reflist" placeholder="${rem ? 'Choose or type the name' : 'Choose or type'}" aria-label="${rem ? 'Liquidating Officer' : 'Reference'}"></td>
    ${rem ? '' : '<td><input class="input mono" data-k="no" placeholder="Optional" aria-label="Deposit slip No."></td>'}
    ${series ? '<td><input class="input mono" data-k="from" inputmode="numeric" aria-label="OR From"></td><td><input class="input mono" data-k="to" inputmode="numeric" aria-label="OR To"></td>' : ''}
    <td><input class="input r" data-k="amount" inputmode="decimal" aria-label="Amount"></td>
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
  const los = f.officers.filter((o) => o.lguId === mun && (/liquidating/i.test(o.designation || '') || f.exams.some((e) => e.officerId === o.id && (e.functions || []).includes('liquidating')))).map((o) => o.name);
  const typed = f.reports.filter((r) => r.kind === 'SCR' && inMun(r.lguId)).flatMap((r) => (r.deposits || []).map((d) => String(d.ref || '').trim())).filter((v) => v && !/^(mto\s*)?or\b|^\d+$/i.test(v));
  return [...new Set([...los, ...typed])].sort((a, b) => a.localeCompare(b));
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
function placeIn(chain, date, serial) {
  if (!chain) return '';
  if (serial) {
    const hit = chain.figs.find((g) => hasRange(g) && inRanges(g.rec.ranges, serial)); if (hit) return hit.id;
    return date ? chain.figs.find((g) => !hasRange(g) && String(g.rec.date || '') >= date)?.id || '' : '';
  }
  return date ? chain.figs.find((g) => String(g.rec.date || '') >= date)?.id || '' : '';
}
// ORs in a report with a range whose number is outside it (e.g. the range was corrected).
const strays = (ch) => ch.figs.filter(hasRange).flatMap((g) => g.ors.filter((x) => !inRanges(g.rec.ranges, x.serial)));
const byDate = (a, b) => String(a.date).localeCompare(String(b.date));
// An OR not yet in a report whose number is in the OR Range of a report of this officer (any fund or report type): it goes there.
const rangeHome = (fig, x) => { for (const ch of Object.values(fig.chains)) { const g = ch.figs.find((y) => hasRange(y) && inRanges(y.rec.ranges, +x.serial)); if (g) return { ch, id: g.id }; } return null; };
const pendOrs = (fig) => Object.values(fig.chains).flatMap((ch) => ch.pend.ors);
const misplaced = (fig) => pendOrs(fig).some((x) => rangeHome(fig, x)) || Object.values(fig.chains).some((ch) => ch.figs.length && (ch.pend.ors.some((x) => placeIn(ch, x.date, x.serial)) || strays(ch).length
  || (ch.pend.rec?.deposits || []).some((d) => placeIn(ch, d.date)) || (ch.pend.rec?.remittances || []).some((m) => placeIn(ch, m.date))));
// Moves the ORs, deposits and remittances not yet in a report into the report that covers their date.
async function sweepChains(f, fig, refs) {
  // First by OR Range, across funds and report types (e.g. ORs imported while another fund was selected).
  const moved = new Set();
  for (const x of pendOrs(fig)) { const h = rangeHome(fig, x); if (h) { moved.add(x.id); await store.save('cer_ors', x.id, { ...strip(x), reportId: h.id, fund: h.ch.fund }, by(refs), { quiet: true }); } }
  for (const ch of Object.values(fig.chains)) {
    if (!ch.figs.length) continue;
    const p = ch.pend;
    for (const x of strays(ch)) await store.save('cer_ors', x.id, { ...strip(x), reportId: placeIn(ch, x.date, x.serial) }, by(refs), { quiet: true });
    for (const x of p.ors.filter((y) => !moved.has(y.id))) { const to = placeIn(ch, x.date, x.serial); if (to) await store.save('cer_ors', x.id, { ...strip(x), reportId: to, fund: ch.fund }, by(refs), { quiet: true }); }
    const prec = p.rec && p.rec.lguId ? p.rec : null;
    if (!prec) continue;
    const moves = {};
    (prec.deposits || []).forEach((d) => { const t = placeIn(ch, d.date); if (t) (moves[t] = moves[t] || { d: [], r: [] }).d.push(d); });
    (prec.remittances || []).forEach((m) => { const t = placeIn(ch, m.date); if (t) (moves[t] = moves[t] || { d: [], r: [] }).r.push(m); });
    if (!Object.keys(moves).length) continue;
    for (const [t, v] of Object.entries(moves)) {
      const r = f.reports.find((y) => y.id === t);
      await store.save('cer_reports', t, { ...strip(r), deposits: [...(r.deposits || []), ...v.d].sort(byDate), remittances: [...(r.remittances || []), ...v.r].sort(byDate) }, by(refs), { quiet: true });
    }
    await store.save('cer_reports', p.id, { ...strip(prec), pending: true, deposits: (prec.deposits || []).filter((d) => !placeIn(ch, d.date)), remittances: (prec.remittances || []).filter((m) => !placeIn(ch, m.date)) }, by(refs), { quiet: true });
  }
}
// Saves a new report (SCD / SCR / RCD); the records not yet in a report dated on or before it move into it.
async function createReport(c, K, out) {
  const { refs, f, audit, o, fig } = c;
  const ch = fig.chains[`${K}|${out.fund}`];
  const p = ch.pend, prec = p.rec && p.rec.lguId ? p.rec : null;
  const deps = (prec?.deposits || []), rems = (prec?.remittances || []);
  const id = newId('cerr');
  const first = !ch.figs.length;
  await store.save('cer_reports', id, { lguId: audit.lguId, officerId: o.id, kind: K, ...out, begTyped: first ? (out.begTyped ?? (num(prec?.begTyped) || 0)) : 0,
    deposits: deps.filter((d) => d.date <= out.date), remittances: rems.filter((m) => m.date <= out.date) }, by(refs), { quiet: true });
  if (prec) await store.save('cer_reports', p.id, { ...strip(prec), pending: true, begTyped: first ? 0 : prec.begTyped, deposits: deps.filter((d) => d.date > out.date), remittances: rems.filter((m) => m.date > out.date) }, by(refs), { quiet: true });
  for (const x of p.ors.filter((x) => inRanges(out.ranges, x.serial))) await store.save('cer_ors', x.id, { ...strip(x), reportId: id, fund: out.fund }, by(refs), { quiet: true });
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
      g.lines.push(line); if (cancelled) g.cancelled = true; else g.items.push({ p: pTxt || NO_PART, amt: r2(amt) });
      byNo.set(n, g);
    });
    const taken = new Set(f.ors.filter((x) => x.form === form).map((x) => x.serial));
    const add = [];
    [...byNo.values()].sort((a, b) => a.n - b.n).forEach((g) => {
      if (taken.has(g.n)) { problems.push({ line: g.lines[0], no: g.n, why: 'Already encoded.' }); return; }
      const b = f.booklets.find((y) => y.form === form && y.officerId === o.id && !y.noSerial && y.from <= g.n && g.n <= y.to);
      add.push({ ...g, bookletId: b ? b.id : '', reportId: placeIn(ch, g.date, g.n) });
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
    await store.save('cer_ors', newId('ceror'), { lguId: c.audit.lguId, officerId: o.id, form: plan.form, bookletId: x.bookletId, serial: x.n, date: x.date, status: x.cancelled ? 'cancelled' : 'issued',
      items: x.cancelled ? [] : x.items, amount: x.cancelled ? 0 : r2(x.items.reduce((t, i) => t + i.amt, 0)), fund: curFund, reportId: x.reportId,
      ...(c.exam.lastExamDate && x.date && x.date < c.exam.lastExamDate ? { beg: true } : {}) }, by(refs), { quiet: true });
  }
  emitChange('local'); toast(`${plan.add.length} OR${plan.add.length === 1 ? '' : 's'} imported.`, 'ok');
}

/* ---------- + SCD / SCR / RCD and Edit: one window ---------- */
async function reportModal(c, K, g) {
  const { refs, f, audit, o, fig, curFund, isLO } = c;
  const isNew = !g, rec = g ? g.rec : {};
  const fund0 = isNew ? curFund : rec.fund;
  const chainOf = (fund) => fig.chains[`${K}|${fund}`];
  const firstOf = (fund) => (isNew ? !(chainOf(fund)?.figs.length) : chainOf(rec.fund)?.figs[0]?.id === g.id);
  const UND = K === 'SCR' ? 'Unremitted' : 'Undeposited';
  const pend0 = chainOf(fund0)?.pend;
  const beg0 = isNew ? (pend0?.rec?.begTyped ? money(pend0.rec.begTyped) : '') : (rec.begTyped ? money(rec.begTyped) : '');
  let act = null, out = null;
  const preview = (bg) => {
    const box = $('#rp-prev', bg), date = $('#rp-date', bg).value, fund = $('#rp-fund', bg).value, ch = chainOf(fund);
    $('#rp-begbox', bg).hidden = !firstOf(fund);
    const rr = readRanges($('#rp-range', bg).value);
    if (rr.error) { box.innerHTML = `<b class="warn-t">${esc(rr.error)}</b>`; return; }
    if (!rr.ranges.length) { box.textContent = `Type the OR Range of the ${K} to see which ORs go into it.`; return; }
    const n = rr.ranges.reduce((t, [a, z]) => t + z - a + 1, 0), all = f.ors.filter((x) => x.officerId === o.id && inRanges(rr.ranges, x.serial));
    const other = all.filter((x) => x.reportId && x.reportId !== (g ? g.id : '')).length;
    const deps = isNew && date && ch ? (ch.pend.rec?.deposits || []).filter((d) => d.date <= date) : [];
    const hard = num($('#rp-hard', bg).value), coll = r2(all.reduce((t, x) => t + orAmount(x), 0));
    box.innerHTML = `The range has <b>${n} OR${n > 1 ? 's' : ''}</b>; <b>${all.length}</b> encoded so far (₱ ${money(coll)})${other ? `, ${other} of them in another ${K}` : ''}.${deps.length ? ` <b>${deps.length} ${K === 'SCR' ? 'remittance' : 'deposit'}${deps.length === 1 ? '' : 's'}</b> dated on or before ${esc(fmtDate(date))} also go in.` : ''}${hard ? ` Hard copy ₱ ${money(hard)}: ${Math.abs(hard - coll) <= 0.004 ? '<b>balanced</b>' : `<b class="warn-t">₱ ${money(Math.abs(r2(hard - coll)))} ${hard > coll ? 'more' : 'less'} than the ORs encoded</b>`}.` : ''}`;
  };
  const read = (bg) => {
    const no = $('#rp-no', bg).value.trim(), date = $('#rp-date', bg).value, fund = $('#rp-fund', bg).value, hard = $('#rp-hard', bg).value.trim();
    if (!date) return bad(`Enter the ${K} date.`) || null;
    if (no && f.reports.some((r) => !r.pending && r.id !== (g ? g.id : '') && r.officerId === o.id && (r.kind || K) === K && String(r.no).trim().toUpperCase() === no.toUpperCase())) return bad(`${K} No. ${no} is already encoded for this officer.`) || null;
    const rr = readRanges($('#rp-range', bg).value);
    if (rr.error) return bad(rr.error) || null;
    if (!rr.ranges.length) return bad(`Type the OR Range of the ${K} (e.g. 3764059-3764100; 3765951-3765971).`) || null;
    const clash = (chainOf(fund)?.figs || []).find((x) => x.id !== (g ? g.id : '') && hasRange(x) && x.rec.ranges.some(([a, z]) => rr.ranges.some(([p, q]) => p <= z && a <= q)));
    if (clash) {
      const same = clash.rec.date === date && rangesTyped(clash.rec.ranges) === rangesTyped(rr.ranges);
      return bad(same ? `This ${K} is already entered (${repName(clash.rec, K)}).` : `Part of that range is already in ${repName(clash.rec, K)}.`) || null;
    }
    const v = { no, date, fund, ranges: rr.ranges, hardTotal: hard ? num(hard) : null, received: $('#rp-recv', bg).value, dupe: no ? 0 : dupeOf(f, o.id, K, date, fund, g ? g.id : undefined) };
    if (firstOf(fund)) { const t = num($('#rp-beg', bg).value); v.begTyped = t === null ? '' : t; }
    return v;
  };
  await modal({ title: isNew ? `New ${K} · ${KIND_NAME[K]}` : `Edit ${repName(rec, K)}`, wide: true,
    body: `<div class="rp-grid">
        <div class="field"><label for="rp-no">${K} No. (if any)</label><input class="input mono" id="rp-no" value="${esc(rec.no || '')}" placeholder="Leave blank if none" autocomplete="off"></div>
        <div class="field"><label for="rp-date">${K} Date</label><input class="input" type="date" id="rp-date" value="${esc(rec.date || '')}"></div>
        <div class="field"><label for="rp-fund">Fund</label><select class="input" id="rp-fund">${fig.funds.map((x) => `<option ${x === fund0 ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
        <div class="field rp-wide"><label for="rp-range">OR Range (from the ${K})</label><input class="input mono" id="rp-range" value="${esc(rangesTyped(rec.ranges))}" placeholder="e.g. 3764059-3764100; 3765951-3765971" autocomplete="off"></div>
        <div class="field"><label for="rp-hard">Total per Hard Copy</label><input class="input r" id="rp-hard" inputmode="decimal" placeholder="0.00" value="${rec.hardTotal !== null && rec.hardTotal !== undefined && rec.hardTotal !== '' ? esc(money(rec.hardTotal)) : ''}"></div>
        <div class="field"><label for="rp-recv">Date Received</label><input class="input" type="date" id="rp-recv" value="${esc(rec.received || '')}"></div>
        <div class="field" id="rp-begbox"><label for="rp-beg">${UND} per last ${K} (first in the app)</label><input class="input r" id="rp-beg" inputmode="decimal" placeholder="0.00" value="${esc(beg0)}"></div>
      </div>
      <p class="af-note">${K} Date: the date written on the ${K}; if none, the date of the last OR it covers. ORs go into the ${K} by their number in the OR Range.</p>
      <p class="af-note" id="rp-prev"></p>`,
    onOpen: (bg) => { $$('#rp-date, #rp-fund, #rp-range, #rp-hard', bg).forEach((el) => { el.addEventListener('input', () => preview(bg)); el.addEventListener('change', () => preview(bg)); }); preview(bg); },
    buttons: [...(isNew ? [] : [{ label: 'Delete', cls: 'danger', value: 'del' }]), { label: 'Cancel', value: null },
      { label: `Save ${K}`, cls: 'primary', value: 'save', check: (bg) => { out = read(bg); return !!out; } }] }).then((v) => { act = v; });
  if (act === 'del') return deleteReport(c, K, g);
  if (act !== 'save' || !out) return;
  if (out.dupe > 1) {
    const ok = await modal({ title: `Another ${K} of ${fmtDate(out.date)}?`, body: `<p style="margin:0">An unnumbered ${K} of ${esc(out.fund)} dated ${esc(fmtDate(out.date))} is already encoded for this officer. Save this as a separate ${K}? It will be shown as <b>${esc(repName({ kind: K, date: out.date, dupe: out.dupe }))}</b>.</p>`,
      buttons: [{ label: 'Cancel', value: false }, { label: 'Save as Separate', cls: 'primary', value: true }] });
    if (!ok) return;
  }
  if (isNew) { const id = await createReport(c, K, out); emitChange('local'); toast(`${repName({ kind: K, ...out })} saved.`, 'ok'); go({ r: id }); return; }
  if (out.fund !== rec.fund) for (const x of g.ors) await store.save('cer_ors', x.id, { ...strip(x), fund: out.fund }, by(refs), { quiet: true });
  await store.save('cer_reports', g.id, { ...strip(rec), ...out }, by(refs));
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
  await store.save('cer_reports', pid, { ...pbase, pending: true, deposits: [...(pbase.deposits || []), ...(rec.deposits || [])], remittances: [...(pbase.remittances || []), ...(rec.remittances || [])] }, by(refs), { quiet: true });
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
    const ors = p.ors.filter((x) => x.date <= date), deps = (p.rec?.deposits || []).filter((d) => d.date <= date), rems = (p.rec?.remittances || []).filter((m) => m.date <= date);
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
      if (no && f.reports.some((r) => !r.pending && r.officerId === o.id && (r.kind || K) === K && String(r.no).trim().toUpperCase() === no.toUpperCase())) return bad(`${K} No. ${no} is already encoded for this officer.`);
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
  const deps = (prec?.deposits || []), rems = (prec?.remittances || []);
  const id = newId('cerr');
  const first = !chainOf(out.fund).figs.length;
  await store.save('cer_reports', id, { lguId: audit.lguId, officerId: o.id, kind: K, ...out, begTyped: first ? (num(prec?.begTyped) || 0) : 0,
    deposits: deps.filter((d) => d.date <= out.date), remittances: rems.filter((m) => m.date <= out.date) }, by(refs), { quiet: true });
  if (prec) await store.save('cer_reports', p.id, { ...strip(prec), pending: true, begTyped: 0, deposits: deps.filter((d) => d.date > out.date), remittances: rems.filter((m) => m.date > out.date) }, by(refs), { quiet: true });
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
