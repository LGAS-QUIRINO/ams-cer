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
//   cer_reports  one SCD / RCD  { lguId, officerId, kind: 'SCD' | 'RCD', no, date, fund, hardTotal, begTyped, deposits[{ date, ref, amount }],
//                                 remittances[{ date, collectorId, reportId, reportNo, amount }] }
//                id 'nyr|<officerId>|<fund>' (pending: true) holds the deposits and remittances not yet reported.
//   cer_settings 'funds|<lguId>' { list }  the auditee's funds (General Fund, Special Education Fund, Trust Fund, plus any added)
import { store, newId, emitChange } from '../../js/store.js';
import { esc, modal, toast, $, $$ } from '../../js/ui.js';
import { FORMS, fixBrgyForm, hasRole, by, mayView, agencyName, fmtDate, money, num } from './cer.js';
import { loadForms, FORM_SHORT, exportXlsx, rangesText, mergeRanges, bookletUnused, countRanges } from './forms.js';

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
const kindOf = (l) => kindsOf(l)[0];
// A report's name: its number, or (barangay SCDs often have none) its date, with (2), (3)… for a second unnumbered one of the same date and fund.
export const repName = (r, kind) => { const K = (r && r.kind) || kind || 'RCD'; return r && String(r.no || '').trim() ? `${K} No. ${r.no}` : `${K} of ${fmtDate(r && r.date)}${r && r.dupe ? ` (${r.dupe})` : ''}`; };
const KIND_NAME = { SCD: 'Summary of Collections and Deposits', SCR: 'Summary of Collections and Remittances', RCD: 'Report of Collections and Deposits' };
const pendId = (officerId, kind, fund) => `nyr|${officerId}|${kind}|${fund}`;
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const int = (s) => { const v = parseInt(String(s ?? '').replace(/[^\d]/g, ''), 10); return isNaN(v) ? null : v; };
const r2 = (n) => Math.round(n * 100) / 100;
const sum = (list, k) => r2(list.reduce((n, x) => n + (+x[k] || 0), 0));
const flat = (r) => ({ id: r.id, ...r.data });
const strip = (x) => { const { id, ...rest } = x; return rest; };
const bad = (m) => { toast(m, 'bad'); return false; };
const go = (params) => { const q = new URLSearchParams(location.hash.split('?')[1] || ''); Object.entries(params).forEach(([k, v]) => (v ? q.set(k, v) : q.delete(k))); location.hash = location.hash.split('?')[0] + '?' + q.toString(); };

// Kept between screen refreshes (each save redraws the screen).
// One section open at a time (opening one folds the others); Collections is open to start.
const OPEN = { rep: true, col: false, dep: false };   // which tab is shown (one at a time); 1 SCD when the screen is opened
export const resetTabs = () => { Object.keys(OPEN).forEach((k) => { OPEN[k] = k === 'rep'; }); };
const LASTC = { key: '', form: '', bookletId: '', serial: '', date: '', auto: true, status: 'issued', focus: '' };

/* ---------- figures ---------- */
const orAmount = (o) => (o.status === 'cancelled' ? 0 : r2((o.items || []).reduce((n, i) => n + (+i.amt || 0), 0)));
function rangeByForm(list) {
  const by = {}; list.forEach((o) => { (by[o.form] = by[o.form] || []).push(o.serial); });
  return Object.entries(by).map(([k, ns]) => `${FORM_SHORT[k] || k} ${Math.min(...ns)} – ${Math.max(...ns)}`).join('; ');
}
// Every report of the officer (and the "Not yet reported" of each fund), in order, with its figures and checks.
export function figuresOf(f, o, funds, countDate, lgu) {
  const kinds = kindsOf(lgu);
  const ors = f.ors.filter((x) => x.officerId === o.id);
  const reals = f.reports.filter((r) => r.officerId === o.id && !r.pending);
  const allFunds = [...new Set([...funds, ...reals.map((r) => r.fund), ...ors.map((x) => x.fund).filter(Boolean)])];
  const encoded = {}; f.ors.forEach((x) => { (encoded[x.form] = encoded[x.form] || new Set()).add(x.serial); });
  const out = {};
  const build = (id, rec, list, beg) => {
    const own = list.filter((x) => x.status !== 'cancelled');
    const rem = (rec?.remittances || []);
    const fig = { id, rec, ors: list, beg, orsTotal: sum(own.map((x) => ({ a: orAmount(x) })), 'a'), remTotal: sum(rem, 'amount'), dep: sum(rec?.deposits || [], 'amount'),
      nOrs: list.length, nCancelled: list.length - own.length, from: '', to: '', range: rangeByForm(list), issues: [] };
    fig.coll = r2(fig.orsTotal + fig.remTotal);
    fig.end = r2(beg + fig.coll - fig.dep);
    const dates = [...list.map((x) => x.date), ...rem.map((x) => x.date)].filter(Boolean).sort();
    fig.from = dates[0] || ''; fig.to = dates[dates.length - 1] || '';
    // Checks
    if (rec && !rec.pending && rec.hardTotal !== null && rec.hardTotal !== undefined && rec.hardTotal !== '' && Math.abs(+rec.hardTotal - fig.coll) > 0.004)
      fig.issues.push(`Total per hard copy ₱${money(rec.hardTotal)}; per the encoded records ₱${money(fig.coll)} (₱${money(Math.abs(r2(+rec.hardTotal - fig.coll)))} ${+rec.hardTotal > fig.coll ? 'less' : 'more'} than the hard copy).`);
    // OR Range typed from the hard copy: how many of its numbers are encoded; the hard-copy total is checked against them.
    const rs = rec && !rec.pending && Array.isArray(rec.ranges) ? rec.ranges : [];
    if (rs.length) {
      const mine = new Set(ors.map((x) => x.serial));
      fig.rangeN = rs.reduce((n, [a, z]) => n + z - a + 1, 0);
      const miss = []; rs.forEach(([a, z]) => { if (z - a < 5000) for (let n = a; n <= z; n++) if (!mine.has(n)) miss.push([n, n]); });
      fig.rangeIn = fig.rangeN - miss.length;
      if (miss.length) fig.issues.push(`${miss.length} OR${miss.length > 1 ? 's' : ''} of the range not yet encoded: ${rangesText(mergeRanges(miss))}.`);
    }
    if (rec && !rec.pending && rec.hardTotal !== null && rec.hardTotal !== undefined && rec.hardTotal !== '') fig.balanced = Math.abs(+rec.hardTotal - fig.coll) <= 0.004;
    const byForm = {}; list.forEach((x) => { (byForm[x.form] = byForm[x.form] || []).push(x.serial); });
    if (!rs.length) Object.entries(byForm).forEach(([k, ns]) => {
      const lo = Math.min(...ns), hi = Math.max(...ns); const miss = [];
      if (hi - lo < 5000) for (let n = lo; n <= hi; n++) if (!encoded[k].has(n)) miss.push([n, n]);
      if (miss.length) fig.issues.push(`Missing ${FORM_SHORT[k] || k} in the range: ${rangesText(mergeRanges(miss))}.`);
    });
    const outside = list.filter((x) => { const b = f.booklets.find((y) => y.id === x.bookletId); return !b || b.officerId !== o.id; });
    if (outside.length) fig.issues.push(`${outside.length} OR${outside.length > 1 ? 's' : ''} not in a booklet issued to this officer in the Forms Register: ${outside.slice(0, 6).map((x) => x.serial).join(', ')}${outside.length > 6 ? '…' : ''}.`);
    rem.forEach((m) => {
      const cr = m.reportId ? f.reports.find((r) => r.id === m.reportId) : null;
      if (cr) { const cf = quickColl(f, cr); if (Math.abs(cf - (+m.amount || 0)) > 0.004) fig.issues.push(`Remittance of ${esc(f.officers.find((x) => x.id === m.collectorId)?.name || 'a collector')} (${esc(repName(cr))}) is ₱${money(m.amount)}; that report's collections are ₱${money(cf)}.`); }
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
    const figs = list.map((r, i) => { const fg = build(r.id, r, ors.filter((x) => x.reportId === r.id), i === 0 ? (num(r.begTyped) || 0) : beg); beg = fg.end; return fg; });
    const pid = pendId(o.id, kind, fund); const prec = f.reports.find((r) => r.id === pid) || null;
    const pend = build(pid, prec ? { ...prec, pending: true } : { pending: true, kind, fund, deposits: [], remittances: [] }, ors.filter((x) => !x.reportId && (x.fund || allFunds[0]) === fund && kindOfForm(lgu, x.form) === kind), figs.length ? beg : (num(prec?.begTyped) || 0));
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
  f.reports = (await store.list('cer_reports')).map(flat);
  const crumb = 'Collections & Deposits';
  const hello = (extra = '') => `<div class="hello"><div><h1>Collections &amp; Deposits</h1><p>Encode each OR as printed on the receipt in hand, then the deposits. Barangays file an SCD (Summary of Collections and Deposits) for AF 51 and an SCR (Summary of Collections and Remittances) for CTC remitted to the MTO; the LGU and PLGU file an RCD (Report of Collections and Deposits).</p></div>${extra}</div>`;
  const audits = f.audits.filter((a) => mayView(refs, refs.lgu[a.lguId])).sort((a, b) => String(b.countDate).localeCompare(String(a.countDate)));
  if (!audits.length) return { crumb, body: hello() + '<div class="panel"><div class="empty"><b>No cash examination yet.</b>The auditors set one up in Audit Setup; its accountable officers are listed here.</div></div>' };
  const audit = audits.find((a) => a.id === q.get('a')) || audits[0];
  const lgu = refs.lgu[audit.lguId];
  const exams = f.exams.filter((e) => e.auditId === audit.id).map((e) => ({ ...e, o: f.officers.find((x) => x.id === e.officerId) })).filter((e) => e.o);
  const exam = exams.find((e) => e.id === q.get('e')) || exams[0] || null;
  const topBar = (extra = '', open = false) => `<div class="panel ${open ? 'cd-head' : 'cd-bar'}">${open ? '<div class="cd-headrow">' : ''}
      <div class="field"><label for="cd-audit">Cash Examination</label><select class="input" id="cd-audit">${audits.map((a) => `<option value="${esc(a.id)}" ${a.id === audit.id ? 'selected' : ''}>${esc(agencyName(refs, refs.lgu[a.lguId]))} · ${esc(fmtDate(a.countDate))}</option>`).join('')}</select></div>
      <div class="field"><label for="cd-exam">Accountable Officer</label><select class="input" id="cd-exam">${exams.length ? exams.map((e) => `<option value="${esc(e.id)}" ${exam && e.id === exam.id ? 'selected' : ''}>${esc(e.o.name)}${e.o.designation ? ' · ' + esc(e.o.designation) : ''}</option>`).join('') : '<option value="">No officer in this examination</option>'}</select></div>
      ${extra}${open ? '</div>' : '</div>'}`;
  const wireTop = () => {
    $('#cd-audit').onchange = (e) => go({ a: e.target.value, e: '', r: '', show: '' });
    $('#cd-exam').onchange = (e) => go({ e: e.target.value, r: '', show: '' });
  };
  if (!exam) return { crumb, body: hello() + topBar() + '<div class="panel"><div class="empty"><b>No accountable officer in this cash examination.</b>Add the officers in Audit Setup.</div></div>', wire: wireTop };

  const o = exam.o;
  const funds = fundsOf(f, audit.lguId);
  let fig = figuresOf(f, o, funds, audit.countDate, lgu);
  // Records dated on or before a submitted report go into it (e.g. ORs encoded after the SCD was added).
  if (canEncode(refs) && misplaced(fig)) { await sweepChains(f, fig, refs); return collectionsView(ctx); }
  const isLO = (exam.functions || []).includes('liquidating');
  const allForms = [...new Set(((exam.forms || []).length ? exam.forms : f.ors.filter((x) => x.officerId === o.id).map((x) => x.form)).map((k) => fixBrgyForm(lgu, k)))];
  // Report types in use for this officer: from the forms ticked in Audit Setup, plus any already encoded.
  const active = (c) => c.figs.length || c.pend.nOrs || c.pend.dep || c.pend.remTotal || c.pend.beg;
  const usedKinds = fig.kinds.filter((k) => allForms.some((x) => kindOfForm(lgu, x) === k) || Object.values(fig.chains).some((c) => c.kind === k && active(c)));
  if (!usedKinds.length) usedKinds.push(fig.kinds[0]);
  // "Not yet reported" of the first fund of each report type, plus any other fund already in use (the rest come with + SCD / + RCD).
  const shownKeys = fig.keys.filter((k) => usedKinds.includes(fig.chains[k].kind) && (fig.chains[k].fund === fig.funds[0] || active(fig.chains[k]) || k === q.get('r')?.split('|').slice(2).join('|')));
  const enc = canEncode(refs);
  // The report being worked on: a submitted one, or "Not yet reported" of a fund.
  const realIds = Object.values(fig.chains).flatMap((c) => c.figs.map((g) => g.id));
  let selId = q.get('r');
  if (!selId || !fig.byId[selId]) selId = fig.chains[shownKeys[0]].pend.id;
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
      <td><input class="input r" data-k="amount" inputmode="decimal" value="${m.amount !== undefined && m.amount !== '' ? esc(money(m.amount)) : ''}" aria-label="Amount" ${enc ? '' : 'disabled'}></td>
      <td>${enc ? '<button class="btn sm cd-x" type="button" aria-label="Remove remittance">✕</button>' : ''}</td></tr>`;
  const crList = f.reports.filter((r) => !r.pending && collectors.some((c) => c.id === r.officerId)).map((r) => r.no);
  const remBlock = isLO ? `<div class="cd-block"><h3 class="cer-h3">Remittances received from collectors</h3>
      <div class="af-tbl cd-tblbox"><table class="af-reg cd-edit"><thead><tr><th scope="col">Date Received</th><th scope="col">From Collector</th><th scope="col">Collector's RCD No.</th><th scope="col" class="r">Amount (₱)</th><th scope="col"></th></tr></thead>
        <tbody id="cd-rems">${(cur.rec?.remittances || []).map(remRow).join('')}</tbody></table></div>
      <datalist id="cd-crlist">${[...new Set(crList)].map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      ${enc ? `<div class="cd-actions"><button class="btn sm" type="button" id="cd-addrem">+ Add Remittance</button><button class="btn primary" type="button" id="cd-saverem">Save Remittances</button></div>` : ''}
      <p class="af-note">Each collector's remittance, with the date it was received. When the collector's RCD is in the app, its collections are compared with the amount.</p></div>` : '';
  // SCD tab: the entry line on top (a new report, or the selected one to edit), a notice of records not yet in a report,
  // then the table of the officer's submitted reports (click a row to select it).
  const realFigs = fig.keys.filter((k) => usedKinds.includes(fig.chains[k].kind)).flatMap((k) => fig.chains[k].figs).sort((a, b) => byDate(a.rec, b.rec) || (a.rec.dupe || 0) - (b.rec.dupe || 0));
  const pends = fig.keys.map((k) => fig.chains[k]).filter((ch) => usedKinds.includes(ch.kind) && (ch.pend.nOrs || ch.pend.dep || ch.pend.remTotal));
  const notice = pends.map((ch) => { const p = ch.pend, last = ch.figs[ch.figs.length - 1];
    const what = [p.nOrs ? `${p.nOrs} OR${p.nOrs > 1 ? 's' : ''} (₱ ${money(p.orsTotal)})` : '', p.dep ? `₱ ${money(p.dep)} ${ch.kind === 'SCR' ? 'remitted' : 'deposits'}` : '', p.remTotal ? `₱ ${money(p.remTotal)} remittances received` : ''].filter(Boolean).join(' and ');
    return `<div>${what} of ${esc(ch.fund)}${!last ? '' : ch.figs.some(hasRange) ? ` outside the OR ranges of the ${ch.kind}s encoded` : ` dated after ${esc(fmtDate(last.rec.date))}`} ${p.nOrs + (p.rec?.deposits || []).length > 1 ? 'are not yet in an ' + ch.kind + '. They go' : 'is not yet in an ' + ch.kind + '. It goes'} into the next ${ch.kind} when you add it.</div>`; }).join('');
  const isNew = cur.pending;
  const sumTable = (pick) => realFigs.length ? `<div class="af-tbl"><table class="af-reg cd-sumtbl"><thead><tr><th scope="col">${KS0}</th><th scope="col">Fund</th><th scope="col">Date</th><th scope="col">Period</th><th scope="col">OR Range</th><th scope="col" class="r">ORs</th><th scope="col" class="r">Collections</th><th scope="col" class="r">${isRem ? 'Remitted' : 'Deposited'}</th><th scope="col" class="r">${isRem ? 'Unremitted' : 'Undeposited'}</th><th scope="col">Checks</th>${pick && enc ? '<th scope="col"></th>' : ''}</tr></thead>
      <tbody>${realFigs.map((g) => `<tr ${pick ? `data-pick="${esc(g.id)}" tabindex="0"` : ''} class="${g.id === selId ? 'cd-on' : ''}"><td><b>${esc(repName(g.rec, g.kind))}</b></td><td>${esc(g.rec.fund)}</td><td>${esc(fmtDate(g.rec.date))}</td>
        <td>${g.from ? esc(`${fmtDate(g.from)}–${fmtDate(g.to)}`) : '<span class="dim">—</span>'}</td><td class="cd-rng">${hasRange(g) ? `<span class="cd-rngt" title="${esc(rangesTyped(g.rec.ranges).replace(/-/g, ' – '))}">${esc(rangesTyped(g.rec.ranges).replace(/-/g, ' – '))}</span> <small class="${g.rangeIn < g.rangeN ? 'warn-t' : 'dim'}">· ${g.rangeIn} of ${g.rangeN}</small>` : `<span class="cd-rngt">${esc(g.range.replace(/Accountable Form 51 – (Barangay|LGU) /g, 'AF 51 ')) || '—'}</span> <small class="dim">· no range</small>`}</td><td class="r">${g.nOrs}${g.nCancelled ? ` <span class="dim">(${g.nCancelled} cancelled)</span>` : ''}</td>
        <td class="r">${money(g.coll)}</td><td class="r">${money(g.dep)}</td><td class="r">${money(g.end)}</td>
        <td>${g.balanced === true ? '<span class="pill p-done">Balanced</span> ' : g.balanced === false ? '<span class="pill p-flag">Not balanced</span> ' : ''}${g.issues.length ? `<details class="cd-chk" onclick="event.stopPropagation()" title="${esc(g.issues.join(' '))}"><summary>${g.issues.length} to check</summary><ul>${g.issues.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></details>` : g.balanced === undefined ? '<span class="pill p-done">Complete</span>' : ''}</td>${pick && enc ? `<td><button class="btn sm" type="button" data-editrep="${esc(g.id)}">Edit</button></td>` : ''}</tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="5">Total, all ${KS0}</td><td class="r">${realFigs.reduce((n, g) => n + g.nOrs, 0)}</td><td class="r">${money(r2(realFigs.reduce((n, g) => n + g.coll, 0)))}</td><td class="r">${money(r2(realFigs.reduce((n, g) => n + g.dep, 0)))}</td><td></td><td></td>${pick && enc ? '<td></td>' : ''}</tr></tfoot></table></div>`
    : `<div class="empty"><b>No ${KS0} encoded for this officer yet.</b>${enc ? `Press + ${K} to enter one.` : ''}</div>`;
  const tip = `Each ${K} is entered once, from the hard copy. ORs, deposits${isLO ? ' and remittances' : ''} dated on or before an ${K}'s date go into it; those dated after the last ${K} wait for the next one. The ${isRem ? 'unremitted' : 'undeposited'} balance carries from one ${K} to the next of the same fund.${usedKinds.includes('SCR') ? ' The SCD is for AF 51 deposited in the bank; the SCR is for CTC remitted to the MTO.' : ''}`;
  const repBody = `<div class="cd-scdhead"><h3 class="cer-h3">${KS0} of this officer</h3><span class="crumb-i" title="${esc(tip)}">ⓘ</span>
      <span class="cd-scdbtns">${enc ? usedKinds.map((k) => `<button class="btn primary sm" type="button" data-newrep="${k}">+ ${k}</button>`).join('') : ''}<button class="btn sm" type="button" id="cd-funds">Funds (${funds.length})</button><button class="btn sm" type="button" id="cd-sumxls2">Export to Excel</button></span></div>
    ${notice ? `<div class="cd-pendnote">${notice}</div>` : ''}
    ${sumTable(true)}
    ${remBlock}`;

  /* ----- 2 · Collections ----- */
  const myBooklets = (form) => f.booklets.filter((b) => b.form === form && b.officerId === o.id && b.status !== 'lost' && !b.noSerial).sort((a, b) => a.from - b.from);
  const ckey = o.id + '|' + selId;
  if (LASTC.key !== ckey) Object.assign(LASTC, { key: ckey, form: '', bookletId: '', serial: '', focus: '' });
  const form = forms.includes(LASTC.form) ? LASTC.form : forms[0] || '';
  const bks = myBooklets(form);
  // Unused per the Forms Register: numbers used before the beginning (partly used) and ORs already encoded are both taken out.
  const unusedOfBk = (b) => countRanges(bookletUnused(b));
  const bk = LASTC.bookletId === '__none' ? null : bks.find((b) => b.id === LASTC.bookletId) || bks.find((b) => unusedOfBk(b) > 0 && b.status === 'issued') || bks[0] || null;
  // Next OR: the first number after the last one used (skipped numbers below it are not offered).
  const nextSerial = (b) => { if (!b) return ''; const rs = bookletUnused(b); const last = rs[rs.length - 1]; return last && last[1] === b.to ? last[0] : ''; };
  const serial = LASTC.serial !== '' && LASTC.serial !== undefined ? LASTC.serial : nextSerial(bk);
  const parts = [...new Set(f.ors.filter((x) => x.lguId === audit.lguId).flatMap((x) => (x.items || []).map((i) => i.p)).filter(Boolean))].sort();
  const show = q.get('show') === 'sel' ? 'sel' : q.get('show') === 'all' || cur.pending ? 'all' : 'sel';
  const listOrs = (show === 'all' ? f.ors.filter((x) => x.officerId === o.id) : cur.ors).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.serial - a.serial);
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
      <div class="cd-entry cd-one">
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
        <button class="btn" type="button" id="cd-xls">Export to Excel</button></div>
      ${listOrs.length ? `<div class="af-tbl cd-orscroll"><table class="af-reg cd-ors"><thead><tr><th scope="col">No.</th><th scope="col">OR No.</th><th scope="col">Date</th><th scope="col">Particulars</th><th scope="col" class="r">Amount (₱)</th><th scope="col">Status</th><th scope="col">${K}</th><th scope="col" class="r"></th></tr></thead>
        <tbody>${listOrs.map((x, i) => `<tr data-or="${esc(x.id)}" data-s="${esc((x.serial + ' ' + (x.items || []).map((p) => p.p).join(' ')).toLowerCase())}"><td>${listOrs.length - i}</td><td class="mono" title="${esc(FORM_SHORT[x.form] || x.form)}">${x.serial}</td><td>${esc(fmtDate(x.date))}</td>
          <td>${x.status === 'cancelled' ? '<span class="dim">—</span>' : esc((x.items || []).map((p) => p.p).join('; '))}</td><td class="r">${money(orAmount(x))}</td>
          <td><span class="pill ${x.status === 'cancelled' ? 'p-stock' : 'p-done'}">${x.status === 'cancelled' ? 'Cancelled' : 'Issued'}</span></td><td>${repPill(x)}</td>
          <td class="r">${enc ? `<button class="btn sm" type="button" data-edit="${esc(x.id)}" aria-label="Edit OR ${x.serial}">Edit</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
        <p class="af-note">Latest ORs first. Delete is only for an encoding mistake; a cancelled OR is encoded as Cancelled, not deleted.</p>`
      : `<div class="empty"><b>No ORs encoded here yet.</b>${enc ? 'Encode them above, one OR at a time.' : ''}</div>`}`;

  /* ----- 3 · Deposits (SCR: remittances to the MTO) ----- */

  const DEP = isRem ? 'Remittance' : 'Deposit';
  const depRow = (d = {}) => `<tr class="cd-dep"><td><input class="input" type="date" data-k="date" value="${esc(d.date || '')}" aria-label="Deposit date" ${enc ? '' : 'disabled'}></td>
      <td><input class="input" data-k="ref" value="${esc(d.ref || '')}" placeholder="${isRem ? 'MTO OR No.' : 'Deposit slip / remittance'}" aria-label="Reference" ${enc ? '' : 'disabled'}></td>
      <td><input class="input r" data-k="amount" inputmode="decimal" value="${d.amount !== undefined && d.amount !== '' ? esc(money(d.amount)) : ''}" aria-label="Amount" ${enc ? '' : 'disabled'}></td>
      <td>${enc ? '<button class="btn sm cd-x" type="button" aria-label="Remove deposit">✕</button>' : ''}</td></tr>`;
  const agree = !cur.pending && cur.rec.hardTotal !== null && cur.rec.hardTotal !== undefined && cur.rec.hardTotal !== '' ? (Math.abs(+cur.rec.hardTotal - cur.coll) < 0.005 ? '<span class="pill p-done">Agrees with hard copy</span>' : `<span class="pill p-flag">Hard copy ₱${money(cur.rec.hardTotal)}</span>`) : '';
  const lo = isLO ? loDays(f, o, fig.chains, audit.countDate) : [];
  const depBody = `<div class="af-tbl cd-tblbox"><table class="af-reg cd-edit"><thead><tr><th scope="col">${isRem ? 'Date Received by MTO' : 'Deposit Date'}</th><th scope="col">${isRem ? 'Reference (MTO OR No.)' : 'Reference (deposit slip / remittance)'}</th><th scope="col" class="r">Amount (₱)</th><th scope="col"></th></tr></thead>
      <tbody id="cd-deps">${(cur.rec?.deposits || []).map(depRow).join('')}</tbody></table></div>
    ${enc ? `<div class="cd-actions"><button class="btn sm" type="button" id="cd-adddep">+ Add ${DEP}</button><button class="btn primary" type="button" id="cd-savedep">Save ${DEP}s</button></div>` : ''}
    <div class="cd-sum">
      <b class="cd-sumh">Summary (computed) · ${esc(cur.pending ? `Not yet in an ${K} · ` + cur.fund : repName(cur.rec, K))}</b>
      <div><span>${isRem ? 'Unremitted' : 'Undeposited'}, last ${K}</span><span>${money(cur.beg)}</span></div>
      <div><span>Add: Collections${isLO ? ' (ORs ₱' + money(cur.orsTotal) + ' + remittances ₱' + money(cur.remTotal) + ')' : ''}</span><span>${money(cur.coll)}</span></div>
      <div><span>Less: ${DEP}s</span><span>${money(cur.dep)}</span></div>
      <div class="cd-sumt"><span>${isRem ? 'Unremitted' : 'Undeposited'}, end</span><span>${money(cur.end)}</span></div>
      ${agree}</div>
    ${isLO ? `<div class="cd-block"><h3 class="cer-h3">Days with the LO · received → deposited</h3>
      ${lo.length ? `<div class="af-tbl cd-tblbox"><table class="af-reg"><thead><tr><th scope="col">Date Received</th><th scope="col">From</th><th scope="col">Collector's RCD No.</th><th scope="col">Fund</th><th scope="col" class="r">Amount (₱)</th><th scope="col">Deposited</th><th scope="col">Deposit Reference</th><th scope="col" class="r">Days with LO</th></tr></thead>
        <tbody>${lo.map((x) => `<tr><td>${esc(fmtDate(x.date))}</td><td>${esc(x.from)}</td><td class="mono">${esc(x.no || '')}</td><td>${esc(x.fund)}</td><td class="r">${money(x.amount)}</td>
          <td>${x.undeposited ? '<span class="pill p-flag">Undeposited</span>' : esc(fmtDate(x.depDate))}</td><td>${esc(x.depRef || '')}</td><td class="r">${x.days ?? '—'}${x.undeposited ? ' <span class="dim">to the count</span>' : ''}</td></tr>`).join('')}</tbody></table></div>
        <p class="af-note">Days with LO = date received to date deposited; deposits cover the remittances in date order. An undeposited remittance counts up to the cash count on ${esc(fmtDate(audit.countDate))}.</p>`
      : '<div class="empty"><b>No remittances received yet.</b>Enter them in part 1.</div>'}</div>` : ''}`;

  /* ----- Summary by report ----- */
  const allFigs = realFigs;
  const KS = usedKinds.join(' / ');
  const tot = (k) => r2(allFigs.reduce((n, g) => n + g[k], 0));
  const sumBody = sumTable(true);

  const nPend = pends.reduce((n, ch) => n + ch.pend.nOrs, 0);
  const subRep = cur.pending ? (nPend ? `${nPend} OR${nPend > 1 ? 's' : ''} not yet in an ${K}` : `${realFigs.length} ${K}${realFigs.length === 1 ? '' : 's'} · none selected`) : (cur.rec.no ? `${esc(repName(cur.rec, K))} · ${esc(fmtDate(cur.rec.date))}` : esc(repName(cur.rec, K)));
  // One compact panel on top: the two choices on one line, the three tabs under them.
  const body = hello() + topBar('', true) + `
    ${tabs([['rep', K, subRep, repBody], ['col', 'Collections', `${cur.nOrs} OR${cur.nOrs === 1 ? '' : 's'} · ₱ ${money(cur.orsTotal)}`, colBody],
      ['dep', isRem ? 'Remittances to MTO' : 'Deposits', `₱ ${money(cur.dep)} ${isRem ? 'remitted' : 'deposited'} · ₱ ${money(cur.end)} ${isRem ? 'unremitted' : 'undeposited'}`, depBody]])}
    <section class="panel" id="cd-sumpanel" aria-labelledby="cd-sumh" ${OPEN.rep ? 'hidden' : ''}><div class="panel-head"><h2 id="cd-sumh">Collections Summary by ${KS}</h2><span class="pill">${allFigs.length}</span><button class="btn" type="button" id="cd-sumxls" style="margin-left:auto">Export to Excel</button></div>${sumBody}</section>`;

  const ctxw = { refs, f, audit, lgu, K, KS, o, exam, fig, cur, curFund, curKey, selId, isLO, enc, funds, form, bk, bks, listOrs, allFigs, isFirst };
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
  $$('tr[data-pick]').forEach((tr) => { const pick = () => go({ r: tr.dataset.pick }); tr.onclick = pick; tr.onkeydown = (e) => { if (e.key === 'Enter') pick(); }; });
  const sumX = () => exportXlsx(`${K} Summary ${o.name} ${audit.countDate}.xlsx`, `${K} Summary`, c.allFigs.map((g) => ({
    [`${K}`]: g.pending ? 'Not yet in a report' : repName(g.rec, g.kind), [`${K} No.`]: g.pending ? '' : g.rec.no, Fund: g.pending ? g.fund : g.rec.fund, [`${K} Date`]: g.pending ? '' : fmtDate(g.rec.date), 'Period From': fmtDate(g.from), 'Period To': fmtDate(g.to),
    'OR Range': g.range, 'No. of ORs': g.nOrs, Cancelled: g.nCancelled, 'Undeposited, Last': g.beg, 'Collections (ORs)': g.orsTotal, Remittances: g.remTotal, Deposited: g.dep, 'Undeposited, End': g.end,
    'Total per Hard Copy': g.pending ? '' : (g.rec.hardTotal ?? ''), 'Date Received': g.pending ? '' : fmtDate(g.rec.received), Checks: g.issues.join(' ') || 'Complete' })));
  ['#cd-sumxls', '#cd-sumxls2'].forEach((id) => { const b = $(id); if (b) b.onclick = sumX; });
  const xls = $('#cd-xls');
  if (xls) xls.onclick = () => exportXlsx(`ORs ${o.name} ${audit.countDate}.xlsx`, 'ORs', c.listOrs.slice().reverse().map((x) => ({
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
        list.push({ date: g('date'), collectorId: g('collectorId'), reportNo: g('reportNo'), reportId: cr ? cr.id : '', amount: amt });
      }
      list.sort((a, b) => a.date.localeCompare(b.date));
      await pendRec({ remittances: list }); toast('Remittances saved.', 'ok');
    };
  }
  const depBox = $('#cd-deps');
  if (depBox) {
    wireRows(depBox);
    $('#cd-adddep').onclick = () => { const t = document.createElement('tbody'); t.innerHTML = depRowHtml(c.K === 'SCR'); const tr = t.firstElementChild; depBox.appendChild(tr); wireRows(depBox); $('input', tr).focus(); };
    if (!depBox.children.length) $('#cd-adddep').click();
    $('#cd-savedep').onclick = async () => {
      const list = [];
      for (const tr of $$('tr', depBox)) {
        const g = (k) => $(`[data-k="${k}"]`, tr).value.trim();
        if (!g('date') && !g('amount') && !g('ref')) continue;
        if (!g('date')) return bad('Enter the date of each deposit.');
        const amt = num(g('amount')); if (!amt) return bad('Enter the amount of each deposit.');
        list.push({ date: g('date'), ref: g('ref'), amount: amt });
      }
      list.sort((a, b) => a.date.localeCompare(b.date));
      await pendRec({ deposits: list }); toast(K === 'SCR' ? 'Remittances saved.' : 'Deposits saved.', 'ok');
    };
  }
  $$('[data-edit]').forEach((b) => { b.onclick = () => editOrModal(c, f.ors.find((x) => x.id === b.dataset.edit)); });

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
  items, amount: status === 'cancelled' ? 0 : r2(items.reduce((n, i) => n + i.amt, 0)), fund: c.curFund, reportId: c.cur.pending || hasRange(c.cur) ? placeIn(c.fig.chains[c.curKey], date, serial) : c.selId });
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
    <td><input class="input r" data-k="amount" inputmode="decimal" aria-label="Amount"></td>
    <td><button class="btn sm cd-x" type="button" aria-label="Remove remittance">✕</button></td></tr>`;
}
function depRowHtml(rem) {
  return `<tr class="cd-dep"><td><input class="input" type="date" data-k="date" aria-label="${rem ? 'Date received by MTO' : 'Deposit date'}"></td>
    <td><input class="input" data-k="ref" placeholder="${rem ? 'MTO OR No.' : 'Deposit slip / remittance'}" aria-label="Reference"></td>
    <td><input class="input r" data-k="amount" inputmode="decimal" aria-label="Amount"></td>
    <td><button class="btn sm cd-x" type="button" aria-label="Remove deposit">✕</button></td></tr>`;
}

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
const misplaced = (fig) => Object.values(fig.chains).some((ch) => ch.figs.length && (ch.pend.ors.some((x) => placeIn(ch, x.date, x.serial)) || strays(ch).length
  || (ch.pend.rec?.deposits || []).some((d) => placeIn(ch, d.date)) || (ch.pend.rec?.remittances || []).some((m) => placeIn(ch, m.date))));
// Moves the ORs, deposits and remittances not yet in a report into the report that covers their date.
async function sweepChains(f, fig, refs) {
  for (const ch of Object.values(fig.chains)) {
    if (!ch.figs.length) continue;
    const p = ch.pend;
    for (const x of strays(ch)) await store.save('cer_ors', x.id, { ...strip(x), reportId: placeIn(ch, x.date, x.serial) }, by(refs), { quiet: true });
    for (const x of p.ors) { const to = placeIn(ch, x.date, x.serial); if (to) await store.save('cer_ors', x.id, { ...strip(x), reportId: to, fund: ch.fund }, by(refs), { quiet: true }); }
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
    if (clash) return bad(`Part of that range is already in ${repName(clash.rec, K)}.`) || null;
    const v = { no, date, fund, ranges: rr.ranges, hardTotal: hard ? num(hard) : null, received: $('#rp-recv', bg).value, dupe: no ? 0 : dupeOf(f, o.id, K, date, fund, g ? g.id : undefined) };
    if (firstOf(fund)) v.begTyped = num($('#rp-beg', bg).value) || 0;
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
