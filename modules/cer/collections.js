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
import { loadForms, FORM_SHORT, exportXlsx, rangesText, mergeRanges } from './forms.js';

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
const OPEN = { rep: true, col: true, dep: true };
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
    const byForm = {}; list.forEach((x) => { (byForm[x.form] = byForm[x.form] || []).push(x.serial); });
    Object.entries(byForm).forEach(([k, ns]) => {
      const lo = Math.min(...ns), hi = Math.max(...ns); const miss = [];
      if (hi - lo < 5000) for (let n = lo; n <= hi; n++) if (!encoded[k].has(n)) miss.push([n, n]);
      if (miss.length) fig.issues.push(`Missing ${FORM_SHORT[k] || k} in the range: ${rangesText(mergeRanges(miss))}.`);
    });
    const outside = list.filter((x) => { const b = f.booklets.find((y) => y.id === x.bookletId); return !b || b.officerId !== o.id; });
    if (outside.length) fig.issues.push(`${outside.length} OR${outside.length > 1 ? 's' : ''} not in a booklet issued to this officer in the Forms Register: ${outside.slice(0, 6).map((x) => x.serial).join(', ')}${outside.length > 6 ? '…' : ''}.`);
    rem.forEach((m) => {
      const cr = m.reportId ? f.reports.find((r) => r.id === m.reportId) : null;
      if (cr) { const cf = quickColl(f, cr); if (Math.abs(cf - (+m.amount || 0)) > 0.004) fig.issues.push(`Remittance of ${esc(f.officers.find((x) => x.id === m.collectorId)?.name || 'a collector')} (${cr.kind || 'RCD'} No. ${esc(cr.no)}) is ₱${money(m.amount)}; that report's collections are ₱${money(cf)}.`); }
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
  const topBar = (extra = '') => `<div class="panel cd-bar">
      <div class="field"><label for="cd-audit">Cash Examination</label><select class="input" id="cd-audit">${audits.map((a) => `<option value="${esc(a.id)}" ${a.id === audit.id ? 'selected' : ''}>${esc(agencyName(refs, refs.lgu[a.lguId]))} · ${esc(fmtDate(a.countDate))}</option>`).join('')}</select></div>
      <div class="field"><label for="cd-exam">Accountable Officer</label><select class="input" id="cd-exam">${exams.length ? exams.map((e) => `<option value="${esc(e.id)}" ${exam && e.id === exam.id ? 'selected' : ''}>${esc(e.o.name)}${e.o.designation ? ' · ' + esc(e.o.designation) : ''}</option>`).join('') : '<option value="">No officer in this examination</option>'}</select></div>
      ${extra}</div>`;
  const wireTop = () => {
    $('#cd-audit').onchange = (e) => go({ a: e.target.value, e: '', r: '', show: '' });
    $('#cd-exam').onchange = (e) => go({ e: e.target.value, r: '', show: '' });
  };
  if (!exam) return { crumb, body: hello() + topBar() + '<div class="panel"><div class="empty"><b>No accountable officer in this cash examination.</b>Add the officers in Audit Setup.</div></div>', wire: wireTop };

  const o = exam.o;
  const funds = fundsOf(f, audit.lguId);
  const fig = figuresOf(f, o, funds, audit.countDate, lgu);
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
  const forms = allForms.filter((x) => kindOfForm(lgu, x) === K);
  const isFirst = (() => { const c = fig.chains[curKey]; return cur.pending ? !c.figs.length : c.figs[0]?.id === selId; })();
  const label = (g) => (g.pending ? `Not yet reported · ${usedKinds.length > 1 ? g.kind + ' · ' : ''}${g.fund}` : `${g.kind} No. ${g.rec.no} · ${fmtDate(g.rec.date)} · ${g.rec.fund}`);
  const repOpts = [
    ...shownKeys.map((key) => { const g = fig.chains[key].pend; return `<option value="${esc(g.id)}" ${g.id === selId ? 'selected' : ''}>${esc(label(g))}${g.nOrs ? ` (${g.nOrs} OR${g.nOrs > 1 ? 's' : ''})` : ''}</option>`; }),
    realIds.length ? `<optgroup label="Submitted ${usedKinds.join(' / ')}">${realIds.map((id) => fig.byId[id]).sort((a, b) => String(b.rec.date).localeCompare(String(a.rec.date))).map((g) => `<option value="${esc(g.id)}" ${g.id === selId ? 'selected' : ''}>${esc(label(g))}</option>`).join('')}</optgroup>` : ''].join('');
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
  const repBody = `<div class="cd-pick">
      <div class="field cd-grow"><label for="cd-rep">${K}</label><select class="input" id="cd-rep">${repOpts}</select></div>
      ${enc ? usedKinds.map((k) => `<button class="btn primary" type="button" data-newrep="${k}">+ ${k}</button>`).join('') : ''}<button class="btn" type="button" id="cd-funds">Funds (${funds.length})</button></div>
    ${cur.pending ? `<div class="cd-info">ORs, deposits${isLO ? ' and remittances' : ''} encoded before the ${K} is submitted stay here. When the ${K} comes in, press <b>+ ${K}</b>: the ${cur.fund} records dated on or before its date are moved into it.${K === 'SCR' ? ' The SCR is for CTC, remitted to the MTO.' : K === 'SCD' && usedKinds.includes('SCR') ? ' CTCs go to the SCR.' : ''}</div>
      <div class="cd-g4">${ro('Accountable Officer', esc(o.name))}${ro('Period', cur.from ? esc(`${fmtDate(cur.from)} – ${fmtDate(cur.to)}`) : '')}${ro('ORs', cur.nOrs ? esc(`${cur.range} · ${cur.nOrs}`) : '', 'mono')}${ro('Collections not yet reported', '₱ ' + money(cur.coll), 'r')}</div>
      ${isFirst ? `<div class="cd-g4"><div class="field"><label for="cd-beg">Undeposited per last ${K} (first in the app)</label><input class="input r" id="cd-beg" inputmode="decimal" value="${esc(cur.rec?.begTyped ? money(cur.rec.begTyped) : '')}" placeholder="0.00" ${enc ? '' : 'disabled'}></div></div>` : ''}`
    : `<div class="cd-g5">
        <div class="field"><label for="cd-no">${K} No.</label><input class="input mono" id="cd-no" value="${esc(cur.rec.no)}" ${enc ? '' : 'disabled'}></div>
        <div class="field"><label for="cd-date">${K} Date</label><input class="input" type="date" id="cd-date" value="${esc(cur.rec.date)}" ${enc ? '' : 'disabled'}></div>
        <div class="field"><label for="cd-fund">Fund</label><select class="input" id="cd-fund" ${enc ? '' : 'disabled'}>${fig.funds.map((x) => `<option ${x === cur.rec.fund ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
        <div class="field"><label for="cd-hard">Total per Hard Copy (optional)</label><input class="input r" id="cd-hard" inputmode="decimal" value="${cur.rec.hardTotal !== null && cur.rec.hardTotal !== undefined && cur.rec.hardTotal !== '' ? esc(money(cur.rec.hardTotal)) : ''}" ${enc ? '' : 'disabled'}></div>
        ${isFirst ? `<div class="field"><label for="cd-beg">Undeposited per last ${K} (first in the app)</label><input class="input r" id="cd-beg" inputmode="decimal" value="${esc(cur.rec.begTyped ? money(cur.rec.begTyped) : '')}" placeholder="0.00" ${enc ? '' : 'disabled'}></div>` : ''}
      </div>
      <div class="cd-g4">${ro('Accountable Officer', esc(o.name))}${ro('Period Covered', cur.from ? esc(`${fmtDate(cur.from)} – ${fmtDate(cur.to)}`) : '')}${ro('ORs Covered', cur.nOrs ? esc(`${cur.range} · ${cur.nOrs}`) : '', 'mono')}${ro(isLO ? 'Collections (ORs + remittances)' : 'Collections per ORs', '₱ ' + money(cur.coll), 'r')}</div>
      <p class="af-note">Shaded fields are filled in by the app from the encoded ORs${isLO ? ' and remittances' : ''}.</p>
      ${enc ? `<div class="cd-actions"><button class="btn sm" type="button" id="cd-delrep">Delete this ${K}</button><button class="btn primary" type="button" id="cd-saverep">Save ${K}</button></div>` : ''}`}
    ${remBlock}`;

  /* ----- 2 · Collections ----- */
  const myBooklets = (form) => f.booklets.filter((b) => b.form === form && b.officerId === o.id && b.status !== 'lost').sort((a, b) => a.from - b.from);
  const ckey = o.id + '|' + selId;
  if (LASTC.key !== ckey) Object.assign(LASTC, { key: ckey, form: '', bookletId: '', serial: '', focus: '' });
  const form = forms.includes(LASTC.form) ? LASTC.form : forms[0] || '';
  const bks = myBooklets(form);
  const unusedOfBk = (b) => { const used = new Set(f.ors.filter((x) => x.bookletId === b.id).map((x) => x.serial)); let n = 0; for (let s = b.from; s <= b.to; s++) if (!used.has(s)) n++; return n; };
  const bk = LASTC.bookletId === '__none' ? null : bks.find((b) => b.id === LASTC.bookletId) || bks.find((b) => unusedOfBk(b) > 0 && b.status === 'issued') || bks[0] || null;
  const nextSerial = (b) => { if (!b) return ''; const used = new Set(f.ors.filter((x) => x.bookletId === b.id).map((x) => x.serial)); const mx = Math.max(b.from - 1, ...used); return mx < b.to ? mx + 1 : ''; };
  const serial = LASTC.serial !== '' && LASTC.serial !== undefined ? LASTC.serial : nextSerial(bk);
  const parts = [...new Set(f.ors.filter((x) => x.lguId === audit.lguId).flatMap((x) => (x.items || []).map((i) => i.p)).filter(Boolean))].sort();
  const show = q.get('show') === 'all' ? 'all' : 'sel';
  const listOrs = (show === 'all' ? f.ors.filter((x) => x.officerId === o.id) : cur.ors).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.serial - a.serial);
  const repName = (x) => { if (!x.reportId) return '<span class="pill p-part">Not yet reported</span>'; const r = f.reports.find((y) => y.id === x.reportId); return `<span class="pill p-stock">${esc(r ? `${K} ${r.no}` : '—')}</span>`; };
  const partRow = (p = {}, i = 0) => `<div class="cd-prow"><label class="sr-only" for="cd-p${i}">Particular ${i + 1}</label><input class="input cd-p" id="cd-p${i}" list="cd-parts" value="${esc(p.p || '')}" placeholder="Type to search or add a new particular…" autocomplete="off">
      <label class="sr-only" for="cd-a${i}">Amount ${i + 1}</label><input class="input r cd-a" id="cd-a${i}" inputmode="decimal" value="${p.amt ? esc(money(p.amt)) : ''}" placeholder="0.00" autocomplete="off">
      <button class="btn sm cd-x" type="button" aria-label="Remove particular">✕</button></div>`;
  const colBody = !forms.length ? `<div class="cd-info">This officer has no accountable forms ticked in Audit Setup${isLO ? '. A Liquidating Officer who issues ORs himself needs Collecting and the forms ticked there' : ''}. ${isLO ? 'Remittances and deposits are entered in parts 1 and 3.' : ''}</div>`
    : `${enc ? `<div class="cd-g4 cd-top">
        <div class="field"><label for="cd-form">Form Type</label><select class="input" id="cd-form">${forms.map((k) => `<option value="${esc(k)}" ${k === form ? 'selected' : ''}>${esc(FORMS.find(([x]) => x === k)?.[1] || k)}</option>`).join('')}</select></div>
        <div class="field"><label for="cd-bk">Booklet</label><select class="input" id="cd-bk">${bks.map((b) => `<option value="${esc(b.id)}" ${bk && b.id === bk.id ? 'selected' : ''}>${b.from} – ${b.to} · ${unusedOfBk(b)} unused</option>`).join('')}<option value="" ${bk ? '' : 'selected'}>Not in the Forms Register</option></select></div>
        ${ro('Fund (follows the ' + K + ')', esc(curFund))}
        ${ro('Goes to', esc(cur.pending ? 'Not yet reported' : `${K} No. ${cur.rec.no}`))}
      </div>
      <div class="cd-entry">
        <div class="cd-g4 cd-orrow">
          <div class="field"><label for="cd-or">OR No.</label><input class="input mono cd-orno" id="cd-or" inputmode="numeric" value="${esc(serial)}" autocomplete="off"></div>
          <label class="cd-auto"><input type="checkbox" id="cd-autonext" ${LASTC.auto ? 'checked' : ''}> Auto-next</label>
          <div class="field"><label for="cd-ordate">Date of Collection</label><input class="input" type="date" id="cd-ordate" value="${esc(LASTC.date)}"></div>
          <div class="field"><span class="cd-lbl">Status</span><div class="seg" role="group" aria-label="Status"><a href="#" data-st="issued" class="${LASTC.status !== 'cancelled' ? 'on' : ''}" aria-pressed="${LASTC.status !== 'cancelled'}">Issued</a><a href="#" data-st="cancelled" class="${LASTC.status === 'cancelled' ? 'on' : ''}" aria-pressed="${LASTC.status === 'cancelled'}">Cancelled</a></div></div>
        </div>
        <div id="cd-skip"></div>
        <div class="cd-parts" id="cd-partsbox" ${LASTC.status === 'cancelled' ? 'hidden' : ''}>
          <div class="cd-phead"><span>Particulars</span><span class="r">Amount (₱)</span><span></span></div>
          <div id="cd-prows">${partRow({}, 0)}</div>
        </div>
        <datalist id="cd-parts">${parts.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
        <div class="cd-actions"><button class="cd-link" type="button" id="cd-addp" ${LASTC.status === 'cancelled' ? 'hidden' : ''}>+ Add Particular</button>
          <span class="cd-ortotal">OR Total <b id="cd-ortot">₱ 0.00</b></span><button class="btn primary" type="button" id="cd-enter">Enter</button></div>
        <p class="af-note">Press Enter to save and go to the next OR. Fund follows the ${K}. Cancelled ORs have no particulars and a zero amount.</p>
      </div>` : ''}
      <div class="cd-listhead"><h3 class="cer-h3">Encoded ORs</h3>
        <label class="sr-only" for="cd-search">Search ORs</label><input class="input af-sm" id="cd-search" placeholder="Search OR No. or particular…">
        <label class="sr-only" for="cd-show">Show</label><select class="input af-sm" id="cd-show"><option value="sel" ${show === 'sel' ? 'selected' : ''}>${esc(cur.pending ? 'Not yet reported · ' + cur.fund : `${K} No. ${cur.rec.no}`)}</option><option value="all" ${show === 'all' ? 'selected' : ''}>All of this officer</option></select>
        <span class="cd-total">Total <b>₱ ${money(listOrs.reduce((n, x) => n + orAmount(x), 0))}</b></span>
        <button class="btn" type="button" id="cd-xls">Export to Excel</button></div>
      ${listOrs.length ? `<div class="af-tbl"><table class="af-reg cd-ors"><thead><tr><th scope="col">No.</th><th scope="col">Form</th><th scope="col">OR No.</th><th scope="col">Date</th><th scope="col">Particulars</th><th scope="col">Fund</th><th scope="col" class="r">Amount (₱)</th><th scope="col">Status</th><th scope="col">${K}</th><th scope="col" class="r"></th></tr></thead>
        <tbody>${listOrs.map((x, i) => `<tr data-or="${esc(x.id)}" data-s="${esc((x.serial + ' ' + (x.items || []).map((p) => p.p).join(' ')).toLowerCase())}"><td>${listOrs.length - i}</td><td>${esc(FORM_SHORT[x.form] || x.form)}</td><td class="mono">${x.serial}</td><td>${esc(fmtDate(x.date))}</td>
          <td>${x.status === 'cancelled' ? '<span class="dim">—</span>' : esc((x.items || []).map((p) => p.p).join('; '))}</td><td>${esc(x.fund || '')}</td><td class="r">${money(orAmount(x))}</td>
          <td><span class="pill ${x.status === 'cancelled' ? 'p-stock' : 'p-done'}">${x.status === 'cancelled' ? 'Cancelled' : 'Issued'}</span></td><td>${repName(x)}</td>
          <td class="r">${enc ? `<button class="btn sm" type="button" data-edit="${esc(x.id)}" aria-label="Edit OR ${x.serial}">Edit</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
        <p class="af-note">Latest ORs first. Delete is only for an encoding mistake; a cancelled OR is encoded as Cancelled, not deleted.</p>`
      : `<div class="empty"><b>No ORs encoded here yet.</b>${enc ? 'Encode them above, one OR at a time.' : ''}</div>`}`;

  /* ----- 3 · Deposits (SCR: remittances to the MTO) ----- */
  const isRem = K === 'SCR';
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
      <b class="cd-sumh">Summary (computed) · ${esc(cur.pending ? 'Not yet reported · ' + cur.fund : `${K} No. ${cur.rec.no}`)}</b>
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
  const allFigs = shownKeys.flatMap((key) => { const c = fig.chains[key]; return [...c.figs, ...(c.pend.nOrs || c.pend.dep || c.pend.remTotal || c.pend.beg ? [c.pend] : [])]; });
  const KS = usedKinds.join(' / ');
  const tot = (k) => r2(allFigs.reduce((n, g) => n + g[k], 0));
  const sumBody = allFigs.length ? `<div class="af-tbl"><table class="af-reg cd-sumtbl"><thead><tr><th scope="col">${KS} No.</th><th scope="col">Fund</th><th scope="col">Date</th><th scope="col">Period</th><th scope="col">OR Range</th><th scope="col" class="r">No. of ORs</th><th scope="col" class="r">Collections (₱)</th><th scope="col" class="r">Deposited (₱)</th><th scope="col" class="r">Undeposited (₱)</th><th scope="col">Checks</th></tr></thead>
      <tbody>${allFigs.map((g) => `<tr data-pick="${esc(g.id)}" tabindex="0" class="${g.id === selId ? 'cd-on' : ''}"><td>${g.pending ? `<span class="pill p-part">Not yet reported${usedKinds.length > 1 ? ' · ' + g.kind : ''}</span>` : `${usedKinds.length > 1 ? `<small>${g.kind}</small> ` : ''}<b class="mono">${esc(g.rec.no)}</b>`}</td><td>${esc(g.pending ? g.fund : g.rec.fund)}</td><td>${g.pending ? '<span class="dim">—</span>' : esc(fmtDate(g.rec.date))}</td>
        <td>${g.from ? esc(`${fmtDate(g.from)} – ${fmtDate(g.to)}`) : '<span class="dim">—</span>'}</td><td class="mono">${esc(g.range) || '<span class="dim">—</span>'}</td><td class="r">${g.nOrs}${g.nCancelled ? ` <span class="dim">(${g.nCancelled} cancelled)</span>` : ''}</td>
        <td class="r">${money(g.coll)}</td><td class="r">${money(g.dep)}</td><td class="r">${money(g.end)}</td>
        <td>${g.issues.length ? g.issues.map((t) => `<span class="pill p-flag" title="${esc(t)}">For checking</span>`).slice(0, 1).join('') + `<small class="cd-issues">${g.issues.map((t) => esc(t)).join('<br>')}</small>` : '<span class="pill p-done">Complete</span>'}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="5">Total, all ${KS}</td><td class="r">${allFigs.reduce((n, g) => n + g.nOrs, 0)}</td><td class="r">${money(tot('coll'))}</td><td class="r">${money(tot('dep'))}</td><td></td><td></td></tr></tfoot></table></div>
      <p class="af-note">Click a row to work on that report. Checks: total not agreeing with the hard copy, missing ORs in the range, ORs not in the officer's booklets, deposits more than the balance${isLO ? ', remittances not agreeing with the collector\'s RCD' : ''}. The undeposited balance carries from one report to the next of the same type and fund.</p>`
    : `<div class="empty"><b>No ${KS} or OR encoded for this officer yet.</b></div>`;

  const subRep = cur.pending ? `Not yet reported · ${esc(cur.fund)}` : `${K} No. ${esc(cur.rec.no)} · ${esc(fmtDate(cur.rec.date))}`;
  const body = hello() + topBar() + `
    ${acc('rep', K, subRep, repBody)}
    ${acc('col', 'Collections', `${cur.nOrs} OR${cur.nOrs === 1 ? '' : 's'} · ₱ ${money(cur.orsTotal)}`, colBody)}
    ${acc('dep', isRem ? 'Remittances to MTO' : 'Deposits', `₱ ${money(cur.dep)} ${isRem ? 'remitted' : 'deposited'} · ₱ ${money(cur.end)} ${isRem ? 'unremitted' : 'undeposited'}`, depBody)}
    <section class="panel" aria-labelledby="cd-sumh"><div class="panel-head"><h2 id="cd-sumh">Collections Summary by ${KS}</h2><span class="pill">${allFigs.length}</span><button class="btn" type="button" id="cd-sumxls" style="margin-left:auto">Export to Excel</button></div>${sumBody}</section>`;

  const ctxw = { refs, f, audit, lgu, K, KS, o, exam, fig, cur, curFund, curKey, selId, isLO, enc, funds, form, bk, bks, listOrs, allFigs, isFirst };
  return { crumb, body, wire: () => { wireTop(); wireAll(ctxw); } };
}

/* ---------- wiring ---------- */
function wireAll(c) {
  const { refs, f, audit, K, o, cur, curFund, selId, isLO, enc } = c;
  $$('details.cd-acc').forEach((d) => { d.ontoggle = () => { OPEN[d.dataset.acc] = d.open; }; });
  $('#cd-rep').onchange = (e) => go({ r: e.target.value });
  $('#cd-funds').onclick = () => fundsModal(refs, f, audit.lguId);
  $$('tr[data-pick]').forEach((tr) => { const pick = () => go({ r: tr.dataset.pick }); tr.onclick = pick; tr.onkeydown = (e) => { if (e.key === 'Enter') pick(); }; });
  $('#cd-sumxls').onclick = () => exportXlsx(`${K} Summary ${o.name} ${audit.countDate}.xlsx`, `${K} Summary`, c.allFigs.map((g) => ({
    [`${K} No.`]: g.pending ? 'Not yet reported' : g.rec.no, Fund: g.pending ? g.fund : g.rec.fund, [`${K} Date`]: g.pending ? '' : fmtDate(g.rec.date), 'Period From': fmtDate(g.from), 'Period To': fmtDate(g.to),
    'OR Range': g.range, 'No. of ORs': g.nOrs, Cancelled: g.nCancelled, 'Undeposited, Last': g.beg, 'Collections (ORs)': g.orsTotal, Remittances: g.remTotal, Deposited: g.dep, 'Undeposited, End': g.end,
    'Total per Hard Copy': g.pending ? '' : (g.rec.hardTotal ?? ''), Checks: g.issues.join(' ') || 'Complete' })));
  const xls = $('#cd-xls');
  if (xls) xls.onclick = () => exportXlsx(`ORs ${o.name} ${audit.countDate}.xlsx`, 'ORs', c.listOrs.slice().reverse().map((x) => ({
    Form: FORM_SHORT[x.form] || x.form, 'OR No.': x.serial, Date: fmtDate(x.date), Particulars: (x.items || []).map((p) => p.p).join('; '), 'Amounts': (x.items || []).map((p) => money(p.amt)).join('; '),
    Fund: x.fund || '', Amount: orAmount(x), Status: x.status === 'cancelled' ? 'Cancelled' : 'Issued', [K]: x.reportId ? (f.reports.find((r) => r.id === x.reportId)?.no || '') : 'Not yet reported' })));
  const sr = $('#cd-search');
  if (sr) sr.oninput = () => { const t = sr.value.trim().toLowerCase(); $$('tr[data-or]').forEach((tr) => { tr.hidden = !!t && !tr.dataset.s.includes(t); }); };
  const sh = $('#cd-show'); if (sh) sh.onchange = () => go({ show: sh.value === 'all' ? 'all' : '' });
  if (!enc) return;

  /* SCD / RCD */
  $$('[data-newrep]').forEach((b) => { b.onclick = () => newReportModal(c, b.dataset.newrep); });
  const pendRec = async (patch) => {
    const id = cur.pending ? cur.id : selId;
    const base = cur.rec && cur.rec.lguId ? strip(cur.rec) : { lguId: audit.lguId, officerId: o.id, kind: K, fund: curFund, pending: true, deposits: [], remittances: [] };
    delete base.pending; if (cur.pending) base.pending = true;
    await store.save('cer_reports', id, { ...base, ...patch }, by(refs));
  };
  const begIn = $('#cd-beg');
  if (begIn && cur.pending) begIn.onchange = async () => { await pendRec({ begTyped: num(begIn.value) || 0 }); toast('Undeposited per last ' + K + ' saved.', 'ok'); };
  const sv = $('#cd-saverep');
  if (sv) sv.onclick = async () => {
    const no = $('#cd-no').value.trim(), date = $('#cd-date').value, fund = $('#cd-fund').value, hard = $('#cd-hard').value.trim();
    if (!no) return bad(`Enter the ${K} No.`);
    if (!date) return bad(`Enter the ${K} date.`);
    if (f.reports.some((r) => !r.pending && r.id !== selId && r.officerId === o.id && (r.kind || K) === K && String(r.no).trim().toUpperCase() === no.toUpperCase())) return bad(`${K} No. ${no} is already encoded for this officer.`);
    const patch = { no, date, fund, hardTotal: hard ? num(hard) : null };
    if (begIn) patch.begTyped = num(begIn.value) || 0;
    if (fund !== cur.rec.fund) for (const x of cur.ors) await store.save('cer_ors', x.id, { ...strip(x), fund }, by(refs), { quiet: true });
    await store.save('cer_reports', selId, { ...strip(cur.rec), ...patch }, by(refs));
    toast(`${K} saved.`, 'ok');
  };
  const del = $('#cd-delrep');
  if (del) del.onclick = async () => {
    const ok = await modal({ title: `Delete ${K} No. ${cur.rec.no}?`, body: `<p style="margin:0">Its ${cur.ors.length} OR${cur.ors.length === 1 ? '' : 's'}, deposits${isLO ? ' and remittances' : ''} go back to <b>Not yet reported · ${esc(cur.rec.fund)}</b>. Use this only for an encoding mistake.</p>`,
      buttons: [{ label: 'Cancel', value: false }, { label: 'Delete', cls: 'primary', value: true }] });
    if (!ok) return;
    for (const x of cur.ors) await store.save('cer_ors', x.id, { ...strip(x), reportId: '' }, by(refs), { quiet: true });
    const pid = pendId(o.id, K, cur.rec.fund); const p = f.reports.find((r) => r.id === pid);
    const pbase = p ? strip(p) : { lguId: audit.lguId, officerId: o.id, kind: K, fund: cur.rec.fund, pending: true, deposits: [], remittances: [] };
    await store.save('cer_reports', pid, { ...pbase, deposits: [...(pbase.deposits || []), ...(cur.rec.deposits || [])], remittances: [...(pbase.remittances || []), ...(cur.rec.remittances || [])] }, by(refs), { quiet: true });
    await store.save('cer_reports', selId, strip(cur.rec), by(refs), { deleted: true, quiet: true });
    emitChange('local'); toast(`${K} deleted.`, 'ok'); go({ r: pid });
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
  const total = () => { const t = $$('.cd-a', rows).reduce((n, i) => n + (num(i.value) || 0), 0); $('#cd-ortot').textContent = '₱ ' + money(LASTC.status === 'cancelled' ? 0 : t); };
  const wireParts = () => {
    $$('.cd-prow', rows).forEach((r) => {
      $('.cd-x', r).onclick = () => { if ($$('.cd-prow', rows).length > 1) r.remove(); else { $('.cd-p', r).value = ''; $('.cd-a', r).value = ''; } total(); };
      $('.cd-a', r).oninput = total;
      $('.cd-a', r).onblur = (e) => { const v = num(e.target.value); if (v !== null) e.target.value = money(v); };
      $('.cd-a', r).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); enter.click(); } };
      $('.cd-p', r).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('.cd-a', r).focus(); } };
    });
  };
  const addPart = () => { const n = $$('.cd-prow', rows).length; const d = document.createElement('div'); d.innerHTML = partRowHtml(n); rows.appendChild(d.firstElementChild); wireParts(); $$('.cd-p', rows).pop().focus(); };
  $('#cd-addp').onclick = addPart;
  wireParts(); total();
  $$('[data-st]').forEach((a) => { a.onclick = (e) => {
    e.preventDefault(); LASTC.status = a.dataset.st;
    $$('[data-st]').forEach((x) => { x.classList.toggle('on', x === a); x.setAttribute('aria-pressed', String(x === a)); });
    $('#cd-partsbox').hidden = LASTC.status === 'cancelled'; $('#cd-addp').hidden = LASTC.status === 'cancelled'; total();
  }; });
  // Skipped-OR notice: numbers between the last one encoded in the booklet and this OR No.
  const skipBox = $('#cd-skip');
  const checkSkip = () => {
    skipBox.innerHTML = '';
    const b = bkOf(), n = int(orIn.value);
    if (!b || !n || n < b.from || n > b.to) return;
    const used = new Set(f.ors.filter((x) => x.bookletId === b.id).map((x) => x.serial));
    const below = [...used].filter((x) => x < n); const last = below.length ? Math.max(...below) : b.from - 1;
    const gap = []; for (let s = last + 1; s < n; s++) if (!used.has(s)) gap.push(s);
    if (!gap.length) return;
    const txt = gap.length === 1 ? `<b>${gap[0]} was skipped.</b>` : `<b>${gap[0]} – ${gap[gap.length - 1]} were skipped (${gap.length}).</b>`;
    skipBox.innerHTML = `<div class="cer-alert" role="status"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4"/><path d="M12 17h.01"/></svg>
      <span>${txt} ${last >= b.from ? `The last OR encoded in this booklet is ${last}.` : 'No OR of this booklet is encoded yet.'}</span>
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
  orIn.onkeydown = (e) => { if (e.key !== 'Enter') return; e.preventDefault(); if (LASTC.status === 'cancelled') enter.click(); else $('.cd-p', rows).focus(); };
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
      Object.assign(LASTC, { form, bookletId: nextBk, serial: next, date, focus: 'p' });
      await store.save('cer_ors', newId('ceror'), orData(c, b, n, date, st, items), by(refs));
      toast(`OR ${n} saved.`, 'ok');
    } finally { enter.disabled = false; }
  };
  // Focus after a save: the first particular (or the OR No. when cancelled).
  if (LASTC.focus) { const el = LASTC.focus === 'or' || LASTC.status === 'cancelled' ? orIn : $('.cd-p', rows); if (el) el.focus(); LASTC.focus = ''; }
}
const orData = (c, b, serial, date, status, items) => ({ lguId: c.audit.lguId, officerId: c.o.id, form: $('#cd-form') ? $('#cd-form').value : (b ? b.form : ''), bookletId: b ? b.id : '', serial, date, status,
  items, amount: status === 'cancelled' ? 0 : r2(items.reduce((n, i) => n + i.amt, 0)), fund: c.curFund, reportId: c.cur.pending ? '' : c.selId });
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
    body: `<div class="cd-g2"><div class="field"><label for="nr-no">${K} No.</label><input class="input mono" id="nr-no" autocomplete="off"></div>
        <div class="field"><label for="nr-date">${K} Date</label><input class="input" type="date" id="nr-date"></div>
        <div class="field"><label for="nr-fund">Fund</label><select class="input" id="nr-fund">${fig.funds.map((x) => `<option ${x === curFund ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
        <div class="field"><label for="nr-hard">Total per Hard Copy (optional)</label><input class="input r" id="nr-hard" inputmode="decimal" placeholder="0.00"></div></div>
      <p class="af-note" id="nr-prev"></p>`,
    onOpen: (bg) => { ['#nr-date', '#nr-fund'].forEach((s) => { $(s, bg).oninput = () => preview(bg); $(s, bg).onchange = () => preview(bg); }); preview(bg); },
    buttons: [{ label: 'Cancel', value: null }, { label: `Save ${K}`, cls: 'primary', value: 'ok', check: (bg) => {
      const no = $('#nr-no', bg).value.trim(), date = $('#nr-date', bg).value, fund = $('#nr-fund', bg).value, hard = $('#nr-hard', bg).value.trim();
      if (!no) return bad(`Enter the ${K} No.`);
      if (!date) return bad(`Enter the ${K} date.`);
      if (f.reports.some((r) => !r.pending && r.officerId === o.id && (r.kind || K) === K && String(r.no).trim().toUpperCase() === no.toUpperCase())) return bad(`${K} No. ${no} is already encoded for this officer.`);
      out = { no, date, fund, hardTotal: hard ? num(hard) : null }; return true;
    } }] });
  if (!out) return;
  const p = chainOf(out.fund).pend;
  const prec = p.rec && p.rec.lguId ? p.rec : null;
  const deps = (prec?.deposits || []), rems = (prec?.remittances || []);
  const id = newId('cerr');
  const first = !chainOf(out.fund).figs.length;
  await store.save('cer_reports', id, { lguId: audit.lguId, officerId: o.id, kind: K, ...out, begTyped: first ? (num(prec?.begTyped) || 0) : 0,
    deposits: deps.filter((d) => d.date <= out.date), remittances: rems.filter((m) => m.date <= out.date) }, by(refs), { quiet: true });
  if (prec) await store.save('cer_reports', p.id, { ...strip(prec), pending: true, begTyped: 0, deposits: deps.filter((d) => d.date > out.date), remittances: rems.filter((m) => m.date > out.date) }, by(refs), { quiet: true });
  for (const x of p.ors.filter((x) => x.date <= out.date)) await store.save('cer_ors', x.id, { ...strip(x), reportId: id, fund: out.fund }, by(refs), { quiet: true });
  emitChange('local'); toast(`${K} No. ${out.no} saved.`, 'ok'); go({ r: id });
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
        <div class="field"><label for="eo-rep">${K}</label><select class="input" id="eo-rep"><option value="">Not yet reported</option>${reps.map((r) => `<option value="${esc(r.id)}" ${r.id === x.reportId ? 'selected' : ''}>${esc(`${K} No. ${r.no} · ${fmtDate(r.date)} · ${r.fund}`)}</option>`).join('')}</select></div>
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
