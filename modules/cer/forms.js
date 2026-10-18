// CER · Accountable Forms (design approved 18 Oct 2026).
// One Forms Register per custodian LGU (municipality or province). Each booklet is encoded once, from receipt by the custodian
// to its last number used; barangay treasurers' booklets come from their municipality's register.
//
// Records:
//   cer_booklets   one booklet or pad   { lguId (custodian LGU), form, from, to, qty, receivedDate, receivedFrom, reference, source,
//                                          status: 'stock' | 'issued' | 'lost', officerId, issuedDate, usedBefore, history[] }
//   cer_formcheck  Physical Check of one booklet at one cash examination   id = examId|bookletId   { examId, bookletId, seen, unusedFrom, unusedTo }
//   cer_raaf       the custodian's RAAF for a month and form             id = lguId|YYYY-MM|form   { lguId, month, form, beg, rec, iss, end, receivedDate }
//   cer_settings   'aging|<lguId>'  { days }  flag a booklet held by an AO after this many days (blank = no flag)
import { store, newId, emitChange } from '../../js/store.js';
import { esc, modal, toast, $, $$ } from '../../js/ui.js';
import { FORMS, FORM_NAME, hasRole, isAuditor, by, mayView, agencyName, fmtDate, loadCer } from './cer.js';

export const FORM_SHORT = { af51: 'AF 51', ctci: 'CTC – Individual', ctcc: 'CTC – Corporate', af54: 'AF 54', af56: 'AF 56' };
const custOf = (l) => (l && l.data.kind === 'province' ? 'PTO' : 'MTO');   // the custodian's office
const RECEIVED_FROM = ['Provincial Treasurer', 'National Printing Office', 'Others'];
const DEFAULT_FUNDS = ['General Fund', 'Special Education Fund', 'Trust Fund'];
// Each register keeps its own fund list (starts with the three above; Add Fund for the municipality's other funds).
const fundsOf = (f, lguId) => f.settings['funds|' + lguId]?.list || DEFAULT_FUNDS;
const fundOpts = (f, lguId, sel = '') => `<option value="">No fund indicated</option>${fundsOf(f, lguId).map((x) => `<option ${x === sel ? 'selected' : ''}>${esc(x)}</option>`).join('')}`;
const PER_BOOKLET = 50;
const MAX_PCS = 10000;   // one entry covers at most this many pieces; a longer range is likely a typing mistake
const today = () => new Date().toISOString().slice(0, 10);
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const int = (s) => { const v = parseInt(String(s ?? '').replace(/[^\d]/g, ''), 10); return isNaN(v) ? null : v; };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (m) => (m ? `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}` : '');
// Encoding is for Team Staff (JO) and the auditors; OSA Staff view only.
const canEncode = (refs) => hasRole(refs, 'staff', 'member', 'atl', 'sa', 'admin');

/* ---------- data ---------- */
export async function loadForms() {
  const cer = await loadCer();
  const [booklets, checks, raaf, settings, ors] = await Promise.all([store.list('cer_booklets'), store.list('cer_formcheck'), store.list('cer_raaf'), store.list('cer_settings'), store.list('cer_ors')]);
  const flat = (r) => ({ id: r.id, ...r.data });
  const out = { ...cer, booklets: booklets.map(flat), checks: checks.map(flat), raaf: raaf.map(flat), settings: Object.fromEntries(settings.map((s) => [s.id, s.data])), ors: ors.map(flat) };
  // Numbers encoded in Collections & Deposits (issued or cancelled) are used numbers of their booklet.
  const byBk = {}; out.ors.forEach((o) => { if (o.bookletId) (byBk[o.bookletId] = byBk[o.bookletId] || []).push({ n: o.serial, d: o.date }); });
  out.booklets.forEach((b) => { b.orNos = byBk[b.id] || []; });
  return out;
}
// Custodian LGUs: the province and the municipalities. A barangay's booklets are in its municipality's register.
export const registerOf = (refs, lguId) => { const l = refs.lgu[lguId]; return l && l.data.kind === 'barangay' ? l.data.parentId : lguId; };
function registers(refs) {
  return refs.lgus.filter((l) => (l.data.kind === 'municipality' || l.data.kind === 'province') && mayView(refs, l))
    .sort((a, b) => (a.data.kind === 'province' ? -1 : b.data.kind === 'province' ? 1 : a.data.name.localeCompare(b.data.name)));
}
const officersOf = (refs, f, lguId) => f.officers.filter((o) => registerOf(refs, o.lguId) === lguId).sort((a, b) => a.name.localeCompare(b.name));
const officerLabel = (refs, o) => o ? `${o.name}${o.designation ? ' · ' + o.designation : ''}` : '';

/* ---------- booklet figures ---------- */
// Unused numbers of a booklet, as ranges [[from, to], …]. Unused numbers may sit between used ones (skipped ORs).
// Source for now: "Unused on Hand (as of last cash exam)" from the Issue import; plus the receipts encoded in Collections & Deposits.
const countRanges = (rs) => rs.reduce((n, [a, z]) => n + z - a + 1, 0);
export const rangesText = (rs) => rs.map(([a, z]) => (a === z ? `${a}` : `${a} – ${z}`)).join(', ');
// date (optional): only the receipts encoded on or before that date are taken out.
function rawUnused(b, date) {
  if (b.exhaustedDate) return [];   // marked exhausted from the logbook ("Exh" date)
  let base;
  if (Array.isArray(b.unusedAtStart)) base = b.unusedAtStart.map((r) => [r[0], r[1]]);
  else if (b.usedBefore) base = b.usedBefore <= b.to ? [[Math.max(b.from, b.usedBefore), b.to]] : [];   // older entries: first unused number
  else base = [[b.from, b.to]];
  const cut = (b.orNos || []).filter((x) => !date || x.d <= date).map((x) => [x.n, x.n]);
  return cut.length ? subtractRanges(base, cut) : base;
}
const unusedRanges = (b) => (b.status === 'lost' ? [] : rawUnused(b));
function usedOf(b) { return b.qty - countRanges(rawUnused(b)); }
// Unused numbers below the last number used: skipped ORs, for the auditor to confirm at the Physical Check.
function skippedOf(b) {
  const un = rawUnused(b); if (!un.length || usedOf(b) === 0) return [];
  let last = b.to;   // highest used number
  for (const [a, z] of un.slice().sort((x, y) => y[0] - x[0])) { if (z === last) last = a - 1; else break; }
  return un.filter(([a]) => a < last).map(([a, z]) => [a, Math.min(z, last)]);
}
// Reads "7311510, 7311516-7311550" into ranges inside the booklet. Returns { ranges } or { error }.
function parseRanges(text, from, to) {
  const t = String(text ?? '').trim();
  if (!t) return { ranges: [] };
  const out = [];
  for (const part of t.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d+)\s*(?:[-–—]|to)\s*(\d+)$/i.exec(part) || /^(\d+)$/.exec(part);
    if (!m) return { error: `"${part}" is not a number or a range.` };
    const a = +m[1], z = m[2] ? +m[2] : a;
    if (z < a) return { error: `${part}: From is after To.` };
    if (a < from || z > to) return { error: `${part} is outside the booklet ${from} – ${to}.` };
    out.push([a, z]);
  }
  out.sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < out.length; i++) if (out[i][0] <= out[i - 1][1]) return { error: 'The unused ranges overlap.' };
  return { ranges: out };
}
const sameRanges = (x, y) => x.length === y.length && x.every((r, i) => r[0] === y[i][0] && r[1] === y[i][1]);
function statusOf(b) {
  if (b.status === 'lost') return { key: 'lost', label: 'Lost / Destroyed', cls: 'p-flag' };
  if (b.status === 'stock') return { key: 'stock', label: 'In stock', cls: 'p-stock' };
  const u = usedOf(b);
  if (u >= b.qty) return { key: 'done', label: b.exhaustedDate ? 'Exhausted (per logbook)' : 'Exhausted', cls: 'p-done' };
  if (u > 0) return { key: 'part', label: 'Partly used', cls: 'p-part' };
  return { key: 'new', label: 'Issued, not yet used', cls: 'p-new' };
}
const unusedOf = (b) => countRanges(unusedRanges(b));
const unusedCell = (b) => { const rs = unusedRanges(b); return rs.length ? `${rangesText(rs)} <span class="dim">(${countRanges(rs)})</span>` : '<span class="dim">None</span>'; };
const held = (b) => b.status === 'issued' && statusOf(b).key !== 'done';
const daysWithAo = (b, asOf) => (held(b) && b.issuedDate ? Math.max(0, days(b.issuedDate, asOf)) : null);
const rangeText = (a, z) => `${a} – ${z}`;

// Out-of-sequence: an officer used a later booklet of a form while an earlier one still has unused numbers.
function outOfSequence(f) {
  const out = new Set();
  const byKey = {};
  f.booklets.filter(held).forEach((b) => { const k = b.officerId + '|' + b.form; (byKey[k] = byKey[k] || []).push(b); });
  Object.values(byKey).forEach((list) => {
    list.sort((a, b) => a.from - b.from);
    list.forEach((b, i) => { if (usedOf(b) > 0 && list.slice(0, i).some((e) => unusedOf(e) > 0)) out.add(b.id); });
  });
  return out;
}
function overlaps(f, form, from, to, skipId) {
  return f.booklets.filter((b) => b.id !== skipId && b.form === form && b.from <= to && from <= b.to);
}

/* ---------- router ---------- */
export async function formsView(ctx) {
  const { refs, q, parts } = ctx;
  const f = await loadForms();
  const regs = registers(refs);
  if (!regs.length) return { crumb: 'Accountable Forms', body: '<div class="msg bad">No LGU is assigned to your team yet.</div>' };
  const lguId = regs.some((r) => r.id === q.get('lgu')) ? q.get('lgu') : defaultRegister(refs, regs, f);
  const sub = parts[1] || '';
  if (sub === 'officer') return officerView(ctx, f, lguId);
  if (sub === 'raaf') return raafView(ctx, f, lguId);
  return registerView(ctx, f, lguId);
}
// Opens on the register of the latest cash examination, else the person's ticked municipality, else the first one.
function defaultRegister(refs, regs, f) {
  const latest = f.audits.filter((x) => regs.some((r) => r.id === registerOf(refs, x.lguId))).sort((x, y) => String(y.countDate).localeCompare(String(x.countDate)))[0];
  if (latest) return registerOf(refs, latest.lguId);
  const mine = refs.me?.data.munIds || [];
  return (regs.find((r) => mine.includes(r.id)) || regs.find((r) => r.data.kind === 'municipality') || regs[0]).id;
}
const go = (params) => { const q = new URLSearchParams(location.hash.split('?')[1] || ''); Object.entries(params).forEach(([k, v]) => (v ? q.set(k, v) : q.delete(k))); location.hash = location.hash.split('?')[0] + '?' + q.toString(); };

/* ================= 1 · Forms Register ================= */
function registerView(ctx, f, lguId) {
  const { refs, q } = ctx;
  const lgu = refs.lgu[lguId];
  const asOf = q.get('asof') || today();
  const aging = f.settings['aging|' + lguId]?.days || '';
  const offs = officersOf(refs, f, lguId);
  const mine = f.booklets.filter((b) => b.lguId === lguId);
  const oos = outOfSequence({ booklets: mine });
  const fForm = q.get('form') || '', fCust = q.get('cust') || '', fStat = q.get('st') || 'open', sort = q.get('sort') || 'days';
  let rows = mine.filter((b) => (!fForm || b.form === fForm)
    && (!fCust || (fCust === 'stock' ? b.status === 'stock' : fCust === 'direct' ? !!b.receivedDirect : b.officerId === fCust))
    && (fStat === 'all' || (fStat === 'open' ? statusOf(b).key !== 'done' : statusOf(b).key === fStat)));
  rows.sort(sort === 'days' ? (a, b) => (daysWithAo(b, asOf) ?? -1) - (daysWithAo(a, asOf) ?? -1) || a.form.localeCompare(b.form) || a.from - b.from
    : (a, b) => a.form.localeCompare(b.form) || a.from - b.from);
  const stock = mine.filter((b) => b.status === 'stock');
  const withAo = mine.filter(held);
  const done = mine.filter((b) => statusOf(b).key === 'done');
  const old = aging ? withAo.filter((b) => daysWithAo(b, asOf) > +aging) : [];
  const skipped = mine.filter(held).filter((b) => skippedOf(b).length);
  const forCheck = new Set([...oos, ...old.map((b) => b.id), ...skipped.map((b) => b.id)]);
  const wrong = f.ors.map((x) => ({ ...x, bk: mine.find((b) => b.id === x.bookletId) })).filter((x) => x.bk && x.bk.officerId !== x.officerId);
  const enc = canEncode(refs);
  const pick = (name, opts, sel) => `<select class="input af-sm" data-filter="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const formsUsed = [...new Set(mine.map((b) => b.form))];
  const longest = withAo.slice().sort((a, b) => daysWithAo(b, asOf) - daysWithAo(a, asOf))[0];
  const body = `<div class="hello"><div><h1>Accountable Forms</h1><p>Each booklet is encoded once, from receipt by the custodian to its last number used. Status follows Collections &amp; Deposits. Unused forms are counted, never treated as missing.</p></div>
      <div class="btn-row"><a class="btn" href="#/cer/forms/raaf?lgu=${esc(lguId)}">RAAF Reconciliation</a><a class="btn" href="#/cer/forms/officer?lgu=${esc(lguId)}">By Accountable Officer</a>
        <button class="btn" type="button" id="af-xls">Export to Excel</button></div></div>

    <div class="panel af-bar">
      <div class="field"><label for="af-lgu">Forms Register of</label><select class="input" id="af-lgu">${registers(refs).map((l) => `<option value="${esc(l.id)}" ${l.id === lguId ? 'selected' : ''}>${esc(agencyName(refs, l))}</option>`).join('')}</select></div>
      <div class="field"><label for="af-asof">Days counted up to</label><input class="input" type="date" id="af-asof" value="${esc(asOf)}"></div>
      <div class="field"><label for="af-aging">Flag a booklet held by an AO after (days)</label><input class="input" id="af-aging" inputmode="numeric" placeholder="No flag" value="${esc(aging)}" ${isAuditor(refs) ? '' : 'disabled'}></div>
    </div>

    <div class="stats">
      <div class="stat"><span>In Stock · Custodian</span><b>${stock.length}</b><small>booklets · ${stock.reduce((n, b) => n + b.qty, 0)} pcs</small></div>
      <div class="stat"><span>With Accountable Officers</span><b style="color:#1d4fb8">${withAo.length}</b><small>booklets · ${withAo.reduce((n, b) => n + unusedOf(b), 0)} unused pcs</small></div>
      <div class="stat"><span>Exhausted</span><b style="color:var(--ok)">${done.length}</b><small>every number used or cancelled</small></div>
      <div class="stat"><span>For Checking</span><b class="${forCheck.size ? 'warn' : 'dim'}">${forCheck.size}</b><small>out of sequence, skipped numbers${aging ? ', held too long' : ''}</small></div>
    </div>

    ${enc ? encodeHtml(refs, Object.assign(offs, { lguId, f }), q) : ''}

    <section class="panel" aria-labelledby="reg-h">
      <div class="panel-head"><h2 id="reg-h">Forms Register</h2><span class="pill">${rows.length}</span>
        <div class="af-filters">
          ${pick('form', [['', 'All form types'], ...FORMS.filter(([k]) => formsUsed.includes(k)).map(([k]) => [k, FORM_SHORT[k]])], fForm)}
          ${pick('cust', [['', 'All custody'], ['stock', 'In stock (custodian)'], ['direct', 'Received directly by an AO'], ...offs.map((o) => [o.id, o.name])], fCust)}
          ${pick('st', [['open', 'Not exhausted'], ['all', 'All statuses'], ['stock', 'In stock'], ['new', 'Issued, not yet used'], ['part', 'Partly used'], ['done', 'Exhausted'], ['lost', 'Lost / Destroyed']], fStat)}
          ${pick('sort', [['days', 'Longest with AO first'], ['serial', 'By form and serial']], sort)}
        </div></div>
      ${rows.length ? `<div class="af-tbl"><table class="af-reg">
        <thead><tr><th scope="col">Form</th><th scope="col">Serial Range</th><th scope="col" class="r">Qty</th><th scope="col">Received</th><th scope="col">Custody</th><th scope="col">Issued</th><th scope="col" class="r">Days with AO</th><th scope="col" class="r">Used</th><th scope="col">Unused</th><th scope="col">Status</th></tr></thead>
        <tbody>${rows.map((b) => {
          const o = f.officers.find((x) => x.id === b.officerId); const st = statusOf(b); const d = daysWithAo(b, asOf); const sk = skippedOf(b);
          const flagOld = aging && d !== null && d > +aging, flagSeq = oos.has(b.id);
          return `<tr class="${flagOld || flagSeq ? 'flag' : ''}" data-bk="${esc(b.id)}" tabindex="0">
            <td>${esc(FORM_SHORT[b.form] || b.form)}</td><td class="mono">${rangeText(b.from, b.to)}</td><td class="r">${b.qty}</td>
            <td>${b.receivedDate ? esc(fmtDate(b.receivedDate)) : '<span class="dim">—</span>'}<small>${b.receivedDirect ? `<b class="af-direct">Received directly</b> · ` : ''}${esc(b.receivedFrom || (b.source === 'logbook' ? 'From the barangay logbook' : b.source === 'import' ? 'Imported from Excel' : b.source === 'starting' ? 'Starting inventory' : ''))}</small></td>
            <td>${b.status === 'issued' && o ? `<b>${esc(o.name)}</b><small>${esc([o.designation, agencyName(refs, refs.lgu[o.lguId])].filter(Boolean).join(' · '))}</small>` : b.status === 'lost' ? '<span class="dim">—</span>' : `In stock<small>Custodian (${custOf(lgu)})</small>`}</td>
            <td>${b.status !== 'stock' && b.issuedDate ? esc(fmtDate(b.issuedDate)) : '<span class="dim">—</span>'}</td>
            <td class="r">${d === null ? '<span class="dim">—</span>' : `<b class="${flagOld ? 'warn-t' : ''}">${d}</b>`}</td>
            <td class="r">${usedOf(b)}</td>
            <td class="mono">${unusedCell(b)}</td>
            <td><span class="pill ${st.cls}">${st.label}</span>${flagSeq ? '<br><span class="pill p-flag">Out of sequence</span>' : ''}${sk.length ? '<br><span class="pill p-flag">Skipped numbers</span>' : ''}${flagOld ? '<br><span class="pill p-flag">Held too long</span>' : ''}</td></tr>`;
        }).join('')}</tbody></table></div>
        <p class="af-note">Click a booklet to see its history and to Issue, Transfer, Return or report it Lost.</p>`
      : `<div class="empty"><b>${mine.length ? 'No booklet matches these filters.' : 'No booklets in this register yet.'}</b>${mine.length ? '' : 'Encode the custodian\'s booklets with <b>Receive</b>, or the forms already out with <b>Starting Inventory</b>.'}</div>`}
    </section>

    <section class="panel" aria-labelledby="res-h">
      <div class="panel-head"><h2 id="res-h">Forms Control Results</h2></div>
      <div class="af-res">
        ${result(oos.size ? 'warn' : 'ok', oos.size ? `Out-of-sequence use · ${oos.size}` : 'No out-of-sequence use',
          oos.size ? [...oos].map((id) => { const b = mine.find((x) => x.id === id); const o = f.officers.find((x) => x.id === b.officerId); return `${esc(o ? o.name : 'An officer')} used ${FORM_SHORT[b.form]} ${rangeText(b.from, b.to)} while an earlier booklet still has unused numbers.`; }).join('<br>') : 'Each officer uses the earlier booklet of a form before starting the next.')}
        ${result(skipped.length ? 'warn' : 'ok', skipped.length ? `Skipped numbers between used ORs · ${skipped.reduce((n, b) => n + countRanges(skippedOf(b)), 0)}` : 'No skipped numbers between used ORs',
          skipped.length ? skipped.map((b) => `${esc(f.officers.find((o) => o.id === b.officerId)?.name || '')}, ${FORM_SHORT[b.form]} ${rangeText(b.from, b.to)}: ${rangesText(skippedOf(b))}`).join('<br>') + '<br>Confirm each at the Physical Check: on hand, cancelled, or not on hand.' : 'Unused numbers come after the last number used in each booklet.')}
        ${result(overlapCount(mine) ? 'warn' : 'ok', overlapCount(mine) ? `Overlapping serial ranges · ${overlapCount(mine)}` : 'No overlapping serial ranges', 'No number may appear in two booklets.')}
        ${result('info', longest ? `Longest with an AO · ${daysWithAo(longest, asOf)} days` : 'No booklet with an AO', longest ? `${esc(f.officers.find((o) => o.id === longest.officerId)?.name || '')}, ${FORM_SHORT[longest.form]} ${rangeText(longest.from, longest.to)}, issued ${esc(fmtDate(longest.issuedDate))}.` : 'Issue booklets to the accountable officers to start counting.')}
        ${result('info', `${withAo.reduce((n, b) => n + unusedOf(b), 0)} unused forms with AOs`, 'To be confirmed in each officer\'s Physical Check at the cash count.')}
        ${result(wrong.length ? 'warn' : 'ok', wrong.length ? `Receipts used by another officer · ${wrong.length}` : 'No receipt used by another officer',
          wrong.length ? wrong.slice(0, 12).map((x) => `${esc(f.officers.find((o) => o.id === x.officerId)?.name || '')} encoded ${FORM_SHORT[x.form] || x.form} ${x.serial}, in a booklet ${x.bk.status === 'issued' ? 'issued to ' + esc(f.officers.find((o) => o.id === x.bk.officerId)?.name || 'another officer') : 'not issued to anyone'}.`).join('<br>') + (wrong.length > 12 ? '<br>…' : '') : 'Every receipt encoded in Collections is in a booklet issued to the officer who used it.')}
      </div>
    </section>`;
  const exportRows = () => rows.map((b) => { const o = f.officers.find((x) => x.id === b.officerId); const d = daysWithAo(b, asOf);
    return { Form: FORM_SHORT[b.form] || b.form, 'Series From': b.from, 'Series To': b.to, Qty: b.qty, 'Date Received': fmtDate(b.receivedDate), 'Received From': b.receivedFrom || '',
      'Received Directly': b.receivedDirect ? 'Yes' : '', Custody: b.status === 'issued' && o ? o.name : b.status === 'stock' ? `Custodian (${custOf(lgu)})` : '', Designation: b.status === 'issued' && o ? (o.designation || '') : '',
      'Date Issued': b.status !== 'stock' ? fmtDate(b.issuedDate) : '', 'Days with AO': d ?? '', Used: usedOf(b), 'Unused (ranges)': rangesText(unusedRanges(b)), 'Unused Qty': unusedOf(b),
      'Skipped Numbers': rangesText(skippedOf(b)), Status: statusOf(b).label, 'Date Exhausted': fmtDate(b.exhaustedDate) }; });
  return { crumb: 'Accountable Forms · Forms Register', body, wire: () => {
    wireRegister(ctx, f, lguId, offs);
    $('#af-xls').onclick = () => exportXlsx(`Forms Register ${agencyName(refs, lgu)} ${asOf}.xlsx`, 'Forms Register', exportRows());
  } };
}
function overlapCount(list) {
  let n = 0;
  list.forEach((a, i) => list.slice(i + 1).forEach((b) => { if (a.form === b.form && a.from <= b.to && b.from <= a.to) n++; }));
  return n;
}
const result = (kind, title, text) => `<div class="af-r ${kind}"><b>${esc(title)}</b><span>${text}</span></div>`;

/* ---------- Encode ---------- */
const MOVES = [['receive', 'Receive'], ['issue', 'Issue'], ['starting', 'Starting Inventory']];
// The last form, date and choices stay filled in for the next entry (the screen refreshes after each save).
const LAST = { form: 'af51', date: '', src: RECEIVED_FROM[0], off: '', per: PER_BOOKLET, rby: 'custodian' };
const sel = (a, b) => (a === b ? 'selected' : '');
function encodeHtml(refs, offs, q) {
  const mv = MOVES.some(([k]) => k === q.get('mv')) ? q.get('mv') : 'receive';
  const formSel = `<div class="field"><label for="e-form">Form Type</label><select class="input" id="e-form">${FORMS.map(([k, l]) => `<option value="${k}" ${sel(k, LAST.form)}>${esc(l)}</option>`).join('')}</select></div>`;
  const range = `<div class="field"><label for="e-from">Serial From</label><input class="input r" id="e-from" inputmode="numeric" autocomplete="off"></div>
    <div class="field"><label for="e-to">Serial To</label><input class="input r" id="e-to" inputmode="numeric" autocomplete="off"></div>`;
  const per = `<div class="field"><label for="e-per">Per Booklet</label><input class="input r" id="e-per" inputmode="numeric" value="${LAST.per}"></div>`;
  const offSel = (id, label, extra = '') => `<div class="field"><label for="${id}">${label}</label><select class="input" id="${id}">${extra.replace(`value="${LAST.off}"`, `value="${LAST.off}" selected`)}<option value="">— Choose the officer —</option>${offs.map((o) => `<option value="${esc(o.id)}" ${sel(o.id, LAST.off)}>${esc(officerLabel(refs, o))}</option>`).join('')}</select></div>`;
  let fields = '';
  const custName = refs.lgu[offs.lguId]?.data.kind === 'province' ? 'PTO' : 'MTO';
  if (mv === 'receive') fields = `<div class="af-enc g9">${formSel}${range}${per}
      <div class="field"><label for="e-date">Date Received</label><input class="input" type="date" id="e-date" value="${esc(LAST.date)}"></div>
      <div class="field"><label for="e-rby">Received By</label><select class="input" id="e-rby"><option value="custodian">Custodian (${custName})</option>
        <optgroup label="Directly by AO">${offs.map((o) => `<option value="${esc(o.id)}" ${sel(o.id, LAST.rby)}>${esc(officerLabel(refs, o))}</option>`).join('')}</optgroup></select></div>
      <div class="field"><label for="e-src">Received From</label><select class="input" id="e-src">${RECEIVED_FROM.map((s) => `<option ${sel(s, LAST.src)}>${esc(s)}</option>`).join('')}</select></div>
      <div class="field"><label for="e-ref">Reference (optional)</label><input class="input" id="e-ref" placeholder="e.g. RIS No."></div>
      <button class="btn primary" type="button" id="e-enter">Enter</button></div>`;
  if (mv === 'issue') fields = `<div class="af-enc g6">${formSel}${range}${offSel('e-off', 'Issued To')}
      <div class="field"><label for="e-date">Date Issued</label><input class="input" type="date" id="e-date" value="${esc(LAST.date)}"></div>
      <button class="btn primary" type="button" id="e-enter">Enter</button></div>`;
  if (mv === 'starting') fields = `<div class="af-enc g6s">${formSel}${range}${per}
      <div class="field"><label for="e-date">As of</label><input class="input" type="date" id="e-date" value="${esc(LAST.date)}"></div>
      <button class="btn primary" type="button" id="e-enter">Enter</button></div>`;
  const help = mv === 'receive' ? 'The range is split into booklets. Received by the custodian: the booklets go into stock. Received directly by an accountable officer (e.g. a barangay treasurer supplied by the Provincial Treasurer): they go straight into that officer\'s custody and are left out of the custodian\'s RAAF. A serial already in the register is refused, except a booklet first encoded from a logbook: it is matched by serial and gets its receipt details.'
    : mv === 'issue' ? 'Every booklet in stock within the range is issued to the officer. Barangay treasurers are listed with the municipality\'s officers.'
    : 'Only the custodian\'s stock on the start date. Every issuance is recorded through Issue: new ones one by one, and past issuances (issuance list, logbook) with the Issue import.';
  return `<section class="panel" aria-labelledby="enc-h"><div class="af-encbox">
    <div class="af-headrow"><h2 id="enc-h" class="cer-h2">Encode</h2>
      <div class="af-headr">${mv !== 'starting' ? `<a href="#" class="af-tpl" id="af-tpl">Download ${mv === 'receive' ? 'Receive' : 'Issue'} Template</a><button class="btn" type="button" id="af-import">Import ${mv === 'receive' ? 'Receipts' : 'Issuances'} from Excel</button>` : ''}
      <div class="seg" role="group" aria-label="Movement">${MOVES.map(([k, l]) => `<a href="#" data-mv="${k}" class="${k === mv ? 'on' : ''}" aria-pressed="${k === mv}">${l}</a>`).join('')}</div></div></div>
    ${fields}
    <p class="af-note" id="e-help">${esc(help)}</p></div></section>`;
}

function wireRegister(ctx, f, lguId, offs) {
  const { refs } = ctx;
  $('#af-lgu').onchange = (e) => go({ lgu: e.target.value, cust: '' });
  $('#af-asof').onchange = (e) => go({ asof: e.target.value });
  const ag = $('#af-aging');
  if (ag && !ag.disabled) ag.onchange = async () => {
    const v = int(ag.value);
    await store.save('cer_settings', 'aging|' + lguId, { days: v || '' }, by(refs));
    toast(v ? `Booklets held more than ${v} days are flagged.` : 'No flag for days held.', 'ok');
  };
  $$('[data-filter]').forEach((s) => { s.onchange = () => go({ [s.dataset.filter]: s.value }); });
  $$('[data-mv]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); go({ mv: a.dataset.mv }); }; });
  const kind = $('.seg a.on')?.dataset.mv === 'receive' ? 'receive' : 'issue';
  const imp = $('#af-import'); if (imp) imp.onclick = () => importModal(refs, f, lguId, kind);
  const tpl = $('#af-tpl'); if (tpl) tpl.onclick = async (e) => { e.preventDefault(); try { await downloadTemplate(kind); } catch (err) { toast(err.message || String(err), 'bad'); } };
  $$('tr[data-bk]').forEach((tr) => {
    const open = () => bookletModal(ctx, f, f.booklets.find((b) => b.id === tr.dataset.bk), offs);
    tr.onclick = open; tr.onkeydown = (e) => { if (e.key === 'Enter') open(); };
  });
  const enter = $('#e-enter');
  if (!enter) return;
  const mv = $('.seg a.on')?.dataset.mv || 'receive';
  const per = $('#e-per');
  const help = $('#e-help');
  const preview = () => {
    const a = int($('#e-from').value), z = int($('#e-to').value), p = int(per?.value) || PER_BOOKLET;
    if (mv === 'issue' || !a || !z || z < a) return;
    if (z - a + 1 > MAX_PCS) { help.innerHTML = `<b class="warn-t">That range has ${z - a + 1} pieces. Check the serial numbers.</b>`; return; }
    const n = Math.ceil((z - a + 1) / p);
    help.innerHTML = `Splits into <b>${n} booklet${n > 1 ? 's' : ''}</b>${n <= 4 ? ': ' + splitRange(a, z, p).map(([x, y]) => rangeText(x, y)).join(', ') : ''}.`;
  };
  ['#e-from', '#e-to', '#e-per'].forEach((s) => { const el = $(s); if (el) el.oninput = preview; });
  $('#e-from').addEventListener('change', () => { const a = int($('#e-from').value), t = $('#e-to'); if (a && !t.value && mv !== 'issue') t.value = a + (int(per?.value) || PER_BOOKLET) - 1; preview(); });
  enter.onclick = async () => {
    enter.disabled = true;
    Object.assign(LAST, { form: $('#e-form').value, date: $('#e-date').value, per: int(per?.value) || LAST.per,
      src: $('#e-src') ? $('#e-src').value : LAST.src, off: $('#e-off') ? $('#e-off').value : LAST.off, rby: $('#e-rby') ? $('#e-rby').value : LAST.rby });
    try {
      const ok = mv === 'receive' ? await doReceive(refs, f, lguId) : mv === 'issue' ? await doIssue(refs, f, lguId) : await doStarting(refs, f, lguId);
      if (ok) ['#e-from', '#e-to', '#e-ref'].forEach((s) => { const el = $(s); if (el) el.value = ''; });
    } finally { enter.disabled = false; }
  };
}
function splitRange(a, z, p) { const out = []; for (let x = a; x <= z; x += p) out.push([x, Math.min(z, x + p - 1)]); return out; }
const hist = (refs, action, date, extra = {}) => ({ action, date, by: by(refs), at: new Date().toISOString(), ...extra });
const bad = (m) => { toast(m, 'bad'); return false; };

async function doReceive(refs, f, lguId) {
  const form = $('#e-form').value, a = int($('#e-from').value), z = int($('#e-to').value), p = int($('#e-per').value) || PER_BOOKLET, date = $('#e-date').value;
  if (!a || !z || z < a) return bad('Enter the serial range (From must not be after To).');
  if (z - a + 1 > MAX_PCS) return bad(`That range has ${z - a + 1} pieces. Check the serial numbers (one entry takes up to ${MAX_PCS}).`);
  if (!date) return bad('Enter the date received.');
  const parts = splitRange(a, z, p);
  const plan = [];
  for (const [x, y] of parts) {
    const hit = overlaps(f, form, x, y);
    // A booklet first encoded from a barangay logbook (no receipt yet) and with the same range is matched, not refused.
    if (hit.length === 1 && hit[0].from === x && hit[0].to === y && !hit[0].receivedDate) plan.push({ match: hit[0], x, y });
    else if (hit.length) return bad(`${FORM_SHORT[form]} ${rangeText(x, y)} overlaps ${rangeText(hit[0].from, hit[0].to)} already in the register.`);
    else plan.push({ x, y });
  }
  const rby = $('#e-rby').value;
  const officer = rby !== 'custodian' ? f.officers.find((o) => o.id === rby) : null;
  if (rby !== 'custodian' && !officer) return bad('Choose who received the booklets.');
  const info = { receivedDate: date, receivedFrom: $('#e-src').value, reference: $('#e-ref').value.trim(), receivedDirect: !!officer };
  for (const s of plan) {
    if (s.match) {
      const b = s.match;
      if (officer && b.officerId && b.officerId !== officer.id) return bad(`${rangeText(b.from, b.to)} is recorded with another officer. Check the logbook entry first.`);
      if (officer && b.issuedDate && b.issuedDate < date) return bad(`${rangeText(b.from, b.to)} was already in the officer's hands on ${fmtDate(b.issuedDate)}, before this receipt date.`);
    }
  }
  for (const s of plan) {
    if (s.match) {
      const b = s.match;
      // Matched to an earlier logbook / import entry: the receipt details are added; nothing is doubled.
      await store.save('cer_booklets', b.id, { ...strip(b), ...info, history: [...(b.history || []), hist(refs, officer ? 'matcheddirect' : 'matched', date,
        { officerId: officer ? officer.id : '', note: officer ? `Received directly from ${info.receivedFrom}; matched to the logbook entry` : 'Receipt by the custodian matched to the logbook entry' })] }, by(refs), { quiet: true });
    } else if (officer) {
      await store.save('cer_booklets', newId('cerb'), { lguId, form, from: s.x, to: s.y, qty: s.y - s.x + 1, ...info, source: 'direct', status: 'issued', officerId: officer.id, issuedDate: date, usedBefore: null,
        history: [hist(refs, 'direct', date, { officerId: officer.id, note: info.receivedFrom })] }, by(refs), { quiet: true });
    } else {
      await store.save('cer_booklets', newId('cerb'), { lguId, form, from: s.x, to: s.y, qty: s.y - s.x + 1, ...info, source: 'received', status: 'stock', officerId: '', issuedDate: '', usedBefore: null,
        history: [hist(refs, 'received', date, { note: info.receivedFrom })] }, by(refs), { quiet: true });
    }
  }
  emitChange('local');
  const m = plan.filter((s) => s.match).length;
  toast(`${plan.length} booklet${plan.length > 1 ? 's' : ''} received${officer ? ' directly by ' + officer.name : ''}${m ? ` (${m} matched to logbook entries)` : ''}.`, 'ok');
  return true;
}
async function doIssue(refs, f, lguId) {
  const form = $('#e-form').value, a = int($('#e-from').value), z = int($('#e-to').value) || a, off = $('#e-off').value, date = $('#e-date').value;
  if (!a) return bad('Enter the serial range of the booklets to issue.');
  if (z < a || z - a + 1 > MAX_PCS) return bad('Check the serial range (From must not be after To).');
  if (!off) return bad('Choose the officer.');
  if (!date) return bad('Enter the date issued.');
  const list = f.booklets.filter((b) => b.lguId === lguId && b.form === form && b.status === 'stock' && b.from >= a && b.to <= z);
  const partial = f.booklets.filter((b) => b.lguId === lguId && b.form === form && b.from <= z && a <= b.to && !list.includes(b));
  if (!list.length) return bad(partial.length ? `No booklet in stock fits that range. ${rangeText(partial[0].from, partial[0].to)} is ${statusOf(partial[0]).label.toLowerCase()}.` : 'No booklet in stock within that range.');
  for (const b of list) {
    if (b.receivedDate && date < b.receivedDate) return bad(`${rangeText(b.from, b.to)} was received ${fmtDate(b.receivedDate)}, after the date issued.`);
  }
  for (const b of list) await store.save('cer_booklets', b.id, { ...strip(b), status: 'issued', officerId: off, issuedDate: date, history: [...(b.history || []), hist(refs, 'issued', date, { officerId: off })] }, by(refs));
  toast(`${list.length} booklet${list.length > 1 ? 's' : ''} issued.`, 'ok');
  return true;
}
async function doStarting(refs, f, lguId) {
  const form = $('#e-form').value, a = int($('#e-from').value), z = int($('#e-to').value), p = int($('#e-per').value) || PER_BOOKLET, date = $('#e-date').value;
  if (!a || !z || z < a) return bad('Enter the serial range (From must not be after To).');
  if (z - a + 1 > MAX_PCS) return bad(`That range has ${z - a + 1} pieces. Check the serial numbers (one entry takes up to ${MAX_PCS}).`);
  if (!date) return bad('Enter the as-of date.');
  const parts = splitRange(a, z, p);
  for (const [x, y] of parts) { const hit = overlaps(f, form, x, y); if (hit.length) return bad(`${FORM_SHORT[form]} ${rangeText(x, y)} overlaps ${rangeText(hit[0].from, hit[0].to)} already in the register.`); }
  for (const [x, y] of parts) {
    await store.save('cer_booklets', newId('cerb'), { lguId, form, from: x, to: y, qty: y - x + 1, receivedDate: '', receivedFrom: '', reference: '',
      source: 'starting', status: 'stock', officerId: '', issuedDate: '', history: [hist(refs, 'starting', date, { note: 'Custodian\'s stock on the start date' })] }, by(refs), { quiet: true });
  }
  emitChange('local');
  toast(`${parts.length} booklet${parts.length > 1 ? 's' : ''} added to the custodian's stock.`, 'ok');
  return true;
}
const strip = (b) => { const { id, ...rest } = b; return rest; };

/* ---------- one booklet: history and moves ---------- */
const ACTION = { received: 'Received by the custodian', issued: 'Issued', transferred: 'Transferred', returned: 'Returned to the custodian', lost: 'Reported lost / destroyed',
  starting: 'Starting inventory', logbook: 'Encoded from the barangay logbook', matched: 'Receipt by the custodian matched',
  imported: 'Imported from Excel · issued', exhausted: 'Exhausted (per logbook)',
  direct: 'Received directly by the accountable officer', matcheddirect: 'Direct receipt by the accountable officer matched' };
function historyHtml(refs, f, b) {
  const name = (id) => f.officers.find((o) => o.id === id)?.name || '';
  return `<ol class="af-hist">${(b.history || []).map((h) => `<li><b>${esc(ACTION[h.action] || h.action)}${h.officerId ? ' · ' + esc(name(h.officerId)) : ''}</b>
      <small>${esc(fmtDate(h.date))}${h.note ? ' · ' + esc(h.note) : ''}${h.by ? ' · by ' + esc(refs.users.find((u) => u.data.email === h.by)?.data.name || h.by) : ''}</small></li>`).join('')}
    ${usedOf(b) && !b.exhaustedDate ? `<li><b>${usedOf(b)} used · unused ${rangesText(rawUnused(b)) || 'none'}</b><small>${b.unusedAtStart || b.usedBefore ? 'as of the last cash exam, from the issuance record' : 'from Collections &amp; Deposits'}</small></li>` : ''}
    ${skippedOf(b).length ? `<li><b>Skipped numbers · ${rangesText(skippedOf(b))}</b><small>unused numbers below the last one used; confirm at the Physical Check</small></li>` : ''}</ol>`;
}
async function bookletModal(ctx, f, b, offs) {
  const { refs } = ctx;
  if (!b) return;
  const enc = canEncode(refs);
  const st = statusOf(b);
  const moves = !enc ? [] : b.status === 'stock' ? [['issue', 'Issue']] : held(b) ? [['transfer', 'Transfer to Another AO'], ['return', 'Return to Custodian'], ['lost', 'Report Lost / Destroyed']] : [];
  const offOpts = (skip) => offs.filter((o) => o.id !== skip).map((o) => `<option value="${esc(o.id)}">${esc(officerLabel(refs, o))}</option>`).join('');
  const v = await modal({ title: `${FORM_SHORT[b.form]} ${rangeText(b.from, b.to)}`, wide: true,
    body: `<div class="af-mhead"><span class="pill ${st.cls}">${st.label}</span><span>${b.qty} pcs · used ${usedOf(b)} · unused ${unusedOf(b)}</span></div>
      <h4 class="cer-h3">Booklet History</h4>${historyHtml(refs, f, b)}
      ${moves.length ? `<h4 class="cer-h3">Move this Booklet</h4>
        <div class="af-move">
          <div class="field"><label for="m-act">Movement</label><select class="input" id="m-act">${moves.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
          <div class="field" id="m-offbox"><label for="m-off">To Officer</label><select class="input" id="m-off"><option value="">— Choose the officer —</option>${offOpts(b.officerId)}</select></div>
          <div class="field"><label for="m-date">Date</label><input class="input" type="date" id="m-date" value="${today()}"></div>
          <div class="field" id="m-notebox"><label for="m-note">Note (optional)</label><input class="input" id="m-note"></div>
        </div>` : ''}`,
    onOpen: (bg) => {
      const act = $('#m-act', bg); if (!act) return; const sync = () => { $('#m-offbox', bg).hidden = !['issue', 'transfer'].includes(act.value); }; act.onchange = sync; sync(); },
    buttons: moves.length ? [{ label: 'Close', value: null }, { label: 'Save Movement', cls: 'primary', value: 'save', check: (bg) => {
      const act = $('#m-act', bg).value, off = $('#m-off', bg).value, date = $('#m-date', bg).value;
      if (['issue', 'transfer'].includes(act) && !off) { toast('Choose the officer.', 'bad'); return false; }
      if (!date) { toast('Enter the date.', 'bad'); return false; }
      bookletModal.pending = { act, off, date, note: $('#m-note', bg).value.trim() };
      return true;
    } }] : [{ label: 'Close', cls: 'primary', value: null }] });
  if (v !== 'save') return;
  const { act, off, date, note } = bookletModal.pending;
  const next = { ...strip(b), history: [...(b.history || [])] };
  if (act === 'issue') Object.assign(next, { status: 'issued', officerId: off, issuedDate: date }), next.history.push(hist(refs, 'issued', date, { officerId: off, note }));
  if (act === 'transfer') Object.assign(next, { officerId: off, issuedDate: date }), next.history.push(hist(refs, 'transferred', date, { officerId: off, note: `From ${f.officers.find((o) => o.id === b.officerId)?.name || 'previous officer'}${note ? '. ' + note : ''}` }));
  if (act === 'return') Object.assign(next, { status: 'stock', officerId: '', issuedDate: '' }), next.history.push(hist(refs, 'returned', date, { officerId: b.officerId, note }));
  if (act === 'lost') Object.assign(next, { status: 'lost' }), next.history.push(hist(refs, 'lost', date, { officerId: b.officerId, note }));
  await store.save('cer_booklets', b.id, next, by(refs));
  toast('Movement saved.', 'ok');
}

/* ================= 2 · Accountable Officer view ================= */
function officerView(ctx, f, lguId) {
  const { refs, q } = ctx;
  const offs = officersOf(refs, f, lguId);
  const withBk = offs.filter((o) => f.booklets.some((b) => b.officerId === o.id));
  const oid = q.get('o');
  const o = offs.find((x) => x.id === oid);
  if (!o) {
    const body = `<div class="hello"><div><a href="#/cer/forms?lgu=${esc(lguId)}" class="af-back">← Forms Register</a><h1>By Accountable Officer</h1><p>${esc(agencyName(refs, refs.lgu[lguId]))} and its barangays. Choose an officer to see the booklets in their hands, the Physical Check and the Clearance List.</p></div></div>
      <div class="panel"><div class="panel-head"><h2>Accountable Officers</h2><span class="pill">${offs.length}</span></div>
      ${offs.length ? offs.map((x) => { const bk = f.booklets.filter((b) => b.officerId === x.id); const h = bk.filter(held);
          return `<a class="t-row click af-orow" href="#/cer/forms/officer?lgu=${esc(lguId)}&o=${esc(x.id)}"><span><b>${esc(x.name)}</b><small>${esc([x.designation, agencyName(refs, refs.lgu[x.lguId])].filter(Boolean).join(' · '))}</small></span>
            <span>${h.length} in hand · ${h.reduce((n, b) => n + unusedOf(b), 0)} unused pcs</span><span class="dim">${bk.length} issued in all</span></a>`; }).join('')
        : '<div class="empty"><b>No accountable officers yet.</b>Officers are added in Audit Setup.</div>'}</div>`;
    return { crumb: 'Accountable Forms · By Accountable Officer', body, wire: () => {} };
  }
  const mine = f.booklets.filter((b) => b.officerId === o.id);
  const inHand = mine.filter(held).sort((a, b) => a.form.localeCompare(b.form) || a.from - b.from);
  const exams = f.exams.filter((e) => e.officerId === o.id).map((e) => ({ ...e, audit: f.audits.find((a) => a.id === e.auditId) })).filter((e) => e.audit)
    .sort((a, b) => b.audit.countDate.localeCompare(a.audit.countDate));
  const exam = exams.find((e) => e.id === q.get('exam')) || exams[0] || null;
  const asOf = exam ? exam.audit.countDate : today();   // days in hand are counted up to the cash count
  const tab = ['check', 'hand', 'all'].includes(q.get('tab')) ? q.get('tab') : 'check';
  const longest = inHand.map((b) => daysWithAo(b, asOf)).sort((a, b) => b - a)[0];
  const checkRows = exam ? mine.filter((b) => b.status !== 'stock' && b.issuedDate && b.issuedDate <= exam.audit.countDate && statusOf(b).key !== 'done' && b.status !== 'lost').sort((a, b) => a.form.localeCompare(b.form) || a.from - b.from) : [];
  const chk = (b) => f.checks.find((c) => c.id === exam.id + '|' + b.id) || null;
  const seen = checkRows.filter((b) => chk(b)?.seen).length;
  const byForm = {}; inHand.forEach((b) => { byForm[b.form] = (byForm[b.form] || 0) + unusedOf(b); });
  const auditor = isAuditor(refs);
  const tabs = [['check', 'Physical Check'], ['hand', 'Booklets in Hand'], ['all', 'All Booklets Issued']];
  const link = (t) => `#/cer/forms/officer?lgu=${esc(lguId)}&o=${esc(o.id)}${exam ? '&exam=' + esc(exam.id) : ''}&tab=${t}`;
  let tabBody = '';
  if (tab === 'check') {
    tabBody = !exam ? '<div class="empty"><b>No cash examination for this officer yet.</b>Set one up in Audit Setup; the Physical Check is done at its cash count.</div>'
      : `<div class="af-note top">Cash count of ${esc(fmtDate(exam.audit.countDate))}${exams.length > 1 ? ` · <label for="af-exam" class="sr-only">Cash examination</label><select class="input af-sm" id="af-exam">${exams.map((e) => `<option value="${esc(e.id)}" ${e.id === exam.id ? 'selected' : ''}>${esc(fmtDate(e.audit.countDate))}</option>`).join('')}</select>` : ''}.
          Tick each booklet seen and type the unused numbers actually on hand, as ranges (e.g. 7311510, 7311516-7311550). This fills the SAAF (Annex B) and the unused forms in the GF-74A.</div>
        ${checkRows.length ? `<div class="af-tbl"><table class="af-reg">
          <thead><tr><th scope="col">Seen</th><th scope="col">Form</th><th scope="col">Booklet</th><th scope="col" class="r">Days in Hand</th><th scope="col">Unused per Register</th><th scope="col">Unused per Count</th><th scope="col" class="r">Difference</th><th scope="col">Result</th></tr></thead>
          <tbody>${checkRows.map((b) => {
            const c = chk(b) || {}; const reg = unusedRanges(b); const n = countRanges(reg); const sk = skippedOf(b);
            const counted = Array.isArray(c.ranges) ? c.ranges : (c.unusedFrom && c.unusedTo ? [[c.unusedFrom, c.unusedTo]] : null);
            const diff = counted === null ? null : n - countRanges(counted);
            const res = !c.seen ? (c.id ? ['p-flag', 'Not seen'] : ['p-stock', 'Not yet checked']) : counted && sameRanges(counted, reg) ? ['p-done', 'Agrees'] : ['p-flag', 'For checking'];
            return `<tr data-ck="${esc(b.id)}"><td><input type="checkbox" class="af-seen" ${c.seen ? 'checked' : ''} ${auditor ? '' : 'disabled'} aria-label="Seen: ${esc(FORM_SHORT[b.form])} ${b.from} to ${b.to}"></td>
              <td>${esc(FORM_SHORT[b.form])}</td><td class="mono">${rangeText(b.from, b.to)}</td><td class="r">${days(b.issuedDate, exam.audit.countDate)}</td>
              <td class="mono">${reg.length ? `${rangesText(reg)} (${n})` : 'None'}${sk.length ? `<small class="warn-t">Skipped: ${rangesText(sk)} · on hand, cancelled or not on hand?</small>` : ''}</td>
              <td><input class="input af-sm mono af-ur" value="${esc(counted ? rangesText(counted).replace(/ – /g, '-') : rangesText(reg).replace(/ – /g, '-'))}" aria-label="Unused per count" ${auditor ? '' : 'disabled'}></td>
              <td class="r">${diff === null ? '<span class="dim">—</span>' : diff}</td><td><span class="pill ${res[0]}">${res[1]}</span></td></tr>`;
          }).join('')}</tbody></table></div>
          <div class="af-foot"><p class="af-note">A booklet not seen, or a difference, goes to Verification for the auditor's judgment. It is never concluded as missing by the system.</p>
            ${auditor ? '<button class="btn primary" type="button" id="af-savecheck">Save Physical Check</button>' : '<span class="dim">The auditor does the Physical Check.</span>'}</div>`
        : '<div class="empty"><b>No booklets in this officer\'s hands on the count date.</b>Booklets issued on or before the cash count, not yet exhausted, are listed here.</div>'}`;
  } else {
    const list = tab === 'hand' ? inHand : mine.slice().sort((a, b) => String(b.issuedDate).localeCompare(String(a.issuedDate)));
    tabBody = list.length ? `<div class="af-tbl"><table class="af-reg"><thead><tr><th scope="col">Form</th><th scope="col">Booklet</th><th scope="col">Issued</th><th scope="col" class="r">Days in Hand</th><th scope="col" class="r">Used</th><th scope="col">Unused</th><th scope="col">Status</th></tr></thead>
      <tbody>${list.map((b) => { const st = statusOf(b); const d = daysWithAo(b, asOf);
        return `<tr data-bk="${esc(b.id)}" tabindex="0"><td>${esc(FORM_SHORT[b.form])}</td><td class="mono">${rangeText(b.from, b.to)}</td><td>${esc(fmtDate(b.issuedDate))}</td><td class="r">${d ?? '<span class="dim">—</span>'}</td><td class="r">${usedOf(b)}</td>
          <td class="mono">${unusedCell(b)}</td><td><span class="pill ${st.cls}">${st.label}</span>${skippedOf(b).length ? '<br><span class="pill p-flag">Skipped numbers</span>' : ''}</td></tr>`; }).join('')}</tbody></table></div>
      <p class="af-note">Click a booklet to see its history and to Transfer, Return or report it Lost.</p>`
      : `<div class="empty"><b>${tab === 'hand' ? 'No booklets in this officer\'s hands.' : 'No booklets issued to this officer yet.'}</b></div>`;
  }
  const body = `<div class="hello"><div><a href="#/cer/forms/officer?lgu=${esc(lguId)}" class="af-back">← All officers</a><h1>${esc(o.name)}</h1><p>${esc([o.designation, agencyName(refs, refs.lgu[o.lguId])].filter(Boolean).join(' · '))} · booklets issued by the ${custOf(refs.lgu[lguId])}</p></div>
      <div class="btn-row"><a class="btn" href="#/cer/forms?lgu=${esc(lguId)}&cust=${esc(o.id)}">Open in Forms Register</a><button class="btn" type="button" id="af-oxls">Export to Excel</button><button class="btn" type="button" id="af-clear">Print Clearance List</button></div></div>
    <div class="stats">
      <div class="stat"><span>Booklets in Hand</span><b>${inHand.length}</b><small>not yet exhausted</small></div>
      <div class="stat"><span>Unused per Register</span><b style="color:#1d4fb8">${inHand.reduce((n, b) => n + unusedOf(b), 0)} pcs</b><small>${Object.entries(byForm).map(([k, n]) => `${FORM_SHORT[k]} ${n}`).join(' · ') || '—'}</small></div>
      <div class="stat"><span>Longest in Hand</span><b>${longest ?? 0} days</b><small>${!inHand.length ? 'nothing in hand' : exam ? 'up to the cash count' : 'as of today'}</small></div>
      <div class="stat"><span>Physical Check</span><b class="${exam && checkRows.length && seen === checkRows.length ? '' : 'dim'}" style="${exam && checkRows.length && seen === checkRows.length ? 'color:var(--ok)' : ''}">${exam ? `${seen} of ${checkRows.length}` : '—'}</b><small>${exam ? 'seen at the cash count' : 'no cash examination yet'}</small></div>
    </div>
    <section class="panel" aria-label="Officer's forms">
      <nav class="cer-tabs af-tabs" aria-label="Views">${tabs.map(([k, l]) => `<a href="${link(k)}" class="${k === tab ? 'on' : ''}" ${k === tab ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
      ${tabBody}
    </section>
    <div id="cer-print" class="af-print" hidden>${clearanceHtml(refs, f, o, mine, lguId)}</div>`;
  const exportRows = () => mine.slice().sort((a, b) => a.form.localeCompare(b.form) || a.from - b.from).map((b) => {
    const c = exam ? f.checks.find((x) => x.id === exam.id + '|' + b.id) : null;
    const counted = c ? (Array.isArray(c.ranges) ? c.ranges : (c.unusedFrom && c.unusedTo ? [[c.unusedFrom, c.unusedTo]] : [])) : null;
    return { Form: FORM_SHORT[b.form] || b.form, 'Series From': b.from, 'Series To': b.to, Qty: b.qty, 'Date Issued': fmtDate(b.issuedDate), 'Days in Hand': daysWithAo(b, asOf) ?? '',
      Used: usedOf(b), 'Unused per Register': rangesText(unusedRanges(b)), 'Unused Qty': unusedOf(b), 'Skipped Numbers': rangesText(skippedOf(b)), Status: statusOf(b).label,
      ...(exam ? { 'Cash Count': fmtDate(exam.audit.countDate), Seen: c ? (c.seen ? 'Yes' : 'No') : '', 'Unused per Count': counted ? rangesText(counted) : '' } : {}) }; });
  return { crumb: 'Accountable Forms · By Accountable Officer', body, wire: () => {
    wireOfficer(ctx, f, lguId, o, exam, offs);
    $('#af-oxls').onclick = () => exportXlsx(`Accountable Forms ${o.name}${exam ? ' ' + exam.audit.countDate : ''}.xlsx`, 'Booklets', exportRows());
  } };
}
function clearanceHtml(refs, f, o, mine, lguId) {
  const list = mine.filter(held).sort((a, b) => a.form.localeCompare(b.form) || a.from - b.from);
  return `<h2>Accountable Forms in the Officer's Hands</h2>
    <p><b>${esc(o.name)}</b>, ${esc(o.designation || '')} · ${esc(agencyName(refs, refs.lgu[o.lguId]))} · as of ${esc(fmtDate(today()))}</p>
    <table><thead><tr><th>Form</th><th>Booklet</th><th>Date Issued</th><th>Used</th><th>Unused Range</th><th>Unused Qty</th></tr></thead>
    <tbody>${list.length ? list.map((b) => `<tr><td>${esc(FORM_SHORT[b.form])}</td><td>${rangeText(b.from, b.to)}</td><td>${esc(fmtDate(b.issuedDate))}</td><td>${usedOf(b)}</td><td>${rangesText(unusedRanges(b)) || 'None'}</td><td>${unusedOf(b)}</td></tr>`).join('')
      : '<tr><td colspan="6">No accountable forms in this officer\'s hands.</td></tr>'}</tbody></table>
    <p>Total unused: ${list.reduce((n, b) => n + unusedOf(b), 0)} pcs. From the Forms Register of ${esc(agencyName(refs, refs.lgu[lguId]))}.</p>`;
}
function wireOfficer(ctx, f, lguId, o, exam, offs) {
  const { refs } = ctx;
  $('#af-clear').onclick = () => { document.body.classList.add('af-printing'); $('#cer-print').hidden = false; window.print(); $('#cer-print').hidden = true; document.body.classList.remove('af-printing'); };
  const ex = $('#af-exam'); if (ex) ex.onchange = () => go({ exam: ex.value });
  $$('tr[data-bk]').forEach((tr) => { const open = () => bookletModal(ctx, f, f.booklets.find((b) => b.id === tr.dataset.bk), offs); tr.onclick = open; tr.onkeydown = (e) => { if (e.key === 'Enter') open(); }; });
  const save = $('#af-savecheck');
  if (save) save.onclick = async () => {
    save.disabled = true;
    try {
      for (const tr of $$('tr[data-ck]')) {
        const id = exam.id + '|' + tr.dataset.ck;
        const b = f.booklets.find((x) => x.id === tr.dataset.ck);
        const p = parseRanges($('.af-ur', tr).value, b.from, b.to);
        if (p.error) { toast(`${FORM_SHORT[b.form]} ${rangeText(b.from, b.to)}: ${p.error}`, 'bad'); return; }
        await store.save('cer_formcheck', id, { examId: exam.id, bookletId: b.id, seen: $('.af-seen', tr).checked, ranges: p.ranges }, by(refs), { quiet: true });
      }
      emitChange('local');
      toast('Physical Check saved.', 'ok');
    } finally { save.disabled = false; }
  };
}

/* ================= 3 · RAAF Reconciliation ================= */
// The register's own RAAF, in the hard-copy layout (Beginning, Receipt, Issued, Ending: quantity and inclusive serial numbers),
// for the custodian (MTO / PTO), each accountable officer, or all of them consolidated. Accountable forms are not reported by fund.
// Issued = what was on hand or received but is no longer on hand at month end (issued to AOs, used, returned, lost).
const NO_FUND = 'No fund indicated';
export function mergeRanges(rs) {
  const out = [];
  rs.slice().sort((x, y) => x[0] - y[0]).forEach(([a, z]) => { const l = out[out.length - 1]; if (l && a <= l[1] + 1) l[1] = Math.max(l[1], z); else out.push([a, z]); });
  return out;
}
function subtractRanges(rs, cut) {
  let out = mergeRanges(rs);
  for (const [c, d] of mergeRanges(cut)) {
    const next = [];
    out.forEach(([a, z]) => { if (d < a || c > z) next.push([a, z]); else { if (a < c) next.push([a, c - 1]); if (z > d) next.push([d + 1, z]); } });
    out = next;
  }
  return out;
}
const INTO_CUSTODIAN = ['received', 'matched', 'returned'];
const TO_OFFICER = ['issued', 'imported', 'direct', 'matcheddirect', 'transferred', 'logbook'];
// Who held the booklet after each dated event: 'mto' (custodian), an officer id, or 'gone' (lost).
function holderEvents(b) {
  const order = (h) => (INTO_CUSTODIAN.includes(h.action) || h.action === 'starting' ? 0 : 1);
  return (b.history || []).slice().sort((x, y) => String(x.date).localeCompare(String(y.date)) || order(x) - order(y))
    .map((h) => ({ date: h.date, action: h.action,
      holder: h.action === 'lost' ? 'gone' : INTO_CUSTODIAN.includes(h.action) ? 'mto' : h.action === 'starting' ? (h.officerId || 'mto') : TO_OFFICER.includes(h.action) ? h.officerId : null }))
    .filter((e) => e.holder);
}
const holderAt = (evs, date) => { let h = null; evs.forEach((e) => { if (e.date <= date) h = e.holder; }); return h; };
// Numbers still unused on a date: none once exhausted or lost; the whole booklet while with the custodian.
function piecesAt(b, holder, date) {
  if (!holder || holder === 'gone') return [];
  if (b.exhaustedDate && b.exhaustedDate <= date) return [];
  if (holder === 'mto') return (b.history || []).some((h) => h.action === 'returned' && h.date <= date) ? rawUnused(b, date) : [[b.from, b.to]];
  return rawUnused(b, date);
}
const prevDay = (d) => new Date(Date.parse(d) - 864e5).toISOString().slice(0, 10);
function raafFigures(list, who, start, end) {
  const inX = (h) => !!h && h !== 'gone' && (who === 'all' ? true : who === 'mto' ? h === 'mto' : h === who);
  const rows = {};
  list.forEach((b) => {
    const evs = holderEvents(b);
    const key = b.form;
    const r = rows[key] = rows[key] || { form: b.form, beg: [], rec: [], end: [] };
    const h0 = holderAt(evs, prevDay(start));
    if (inX(h0)) r.beg.push(...piecesAt(b, h0, prevDay(start)));
    let cur = h0;
    evs.filter((e) => e.date >= start && e.date <= end).forEach((e) => {
      // Starting inventory dated inside the month was already on hand: it belongs to the beginning balance.
      if (e.action === 'starting' && !inX(cur) && inX(e.holder)) r.beg.push(...piecesAt(b, e.holder, e.date));
      else if (!inX(cur) && inX(e.holder)) r.rec.push(...piecesAt(b, e.holder, e.date));
      cur = e.holder;
    });
    const h1 = holderAt(evs, end);
    if (inX(h1)) r.end.push(...piecesAt(b, h1, end));
  });
  Object.values(rows).forEach((r) => { r.beg = mergeRanges(r.beg); r.rec = mergeRanges(r.rec); r.end = mergeRanges(r.end); r.iss = subtractRanges([...r.beg, ...r.rec], r.end); });
  return Object.values(rows).filter((r) => r.beg.length || r.rec.length || r.iss.length || r.end.length);
}
function raafView(ctx, f, lguId) {
  const { refs, q } = ctx;
  const lgu = refs.lgu[lguId];
  const m = /^\d{4}-\d{2}$/.test(q.get('m') || '') ? q.get('m') : today().slice(0, 7);
  const start = m + '-01';
  const end = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10);
  const mine = f.booklets.filter((b) => b.lguId === lguId);
  const offs = officersOf(refs, f, lguId).filter((o) => mine.some((b) => (b.history || []).some((h) => h.officerId === o.id)));
  const who = q.get('who') === 'all' || q.get('who') === 'mto' || offs.some((o) => o.id === q.get('who')) ? q.get('who') : 'mto';
  const whoName = who === 'all' ? `Consolidated · ${custOf(lgu)} and all accountable officers` : who === 'mto' ? `Custodian (${custOf(lgu)})` : officerLabel(refs, f.officers.find((o) => o.id === who));
  const rows = raafFigures(mine, who, start, end);
  const sections = rows.length ? [['', rows]] : [];
  const typedId = (fund, form) => `${lguId}|${who}|${m}|${fund}|${form}`;
  const typed = (fund, form) => f.raaf.find((r) => r.id === typedId(fund, form)) || {};
  const enc = canEncode(refs);
  const cols = ['beg', 'rec', 'iss', 'end'];
  const cell = (rs) => `<td class="r">${countRanges(rs)}</td><td class="mono">${rs.length ? rs.map(([a]) => `<div>${a}</div>`).join('') : ''}</td><td class="mono">${rs.length ? rs.map(([, z]) => `<div>${z}</div>`).join('') : ''}</td>`;
  const sectionHtml = ([fund, list]) => `${list.sort((a, b) => a.form.localeCompare(b.form)).map((r) => {
      const t = typed(fund, r.form); const has = cols.some((c) => t[c] !== undefined && t[c] !== '' && t[c] !== null);
      const same = has && cols.every((c) => +(t[c] || 0) === countRanges(r[c]));
      return `<tr class="reg"><th scope="row" class="l">${esc(FORM_SHORT[r.form] || r.form)}</th>${cols.map((c) => cell(r[c])).join('')}<td class="l res">${!has ? '' : same ? '<span class="pill p-done">Agrees</span>' : '<span class="pill p-flag">For checking</span>'}</td></tr>
        <tr class="af-typed"><td class="l dim">Per submitted RAAF</td>${cols.map((c) => `<td class="r"><label class="sr-only" for="t-${esc(fund)}-${r.form}-${c}">${esc(fund)} ${esc(FORM_SHORT[r.form])} ${c} per submitted RAAF</label><input class="input af-cell" id="t-${esc(fund)}-${r.form}-${c}" data-fund="${esc(fund)}" data-form="${r.form}" data-c="${c}" inputmode="numeric" value="${t[c] ?? ''}" ${enc ? '' : 'disabled'}></td><td colspan="2" class="dim">${has && +(t[c] || 0) !== countRanges(r[c]) ? `<span class="warn-t">difference ${(+(t[c] || 0)) - countRanges(r[c])}</span>` : ''}</td>`).join('')}<td></td></tr>`;
    }).join('')}`;
  const body = `<div class="hello"><div><a href="#/cer/forms?lgu=${esc(lguId)}" class="af-back">← Forms Register</a><h1>RAAF Reconciliation</h1><p>The register's own Report of Accountability for Accountable Forms, in the hard-copy layout. Lay the submitted RAAF beside it, or type its quantities on the "Per submitted RAAF" lines to flag the differences.</p></div>
      <div class="btn-row"><button class="btn" type="button" id="r-xls">Export to Excel</button><button class="btn" type="button" id="r-print">Print</button></div></div>
    <div class="panel af-bar">
      <div class="field"><label for="r-lgu">LGU</label><select class="input" id="r-lgu">${registers(refs).map((l) => `<option value="${esc(l.id)}" ${l.id === lguId ? 'selected' : ''}>${esc(agencyName(refs, l))}</option>`).join('')}</select></div>
      <div class="field"><label for="r-who">RAAF of</label><select class="input" id="r-who">
        <option value="mto" ${who === 'mto' ? 'selected' : ''}>Custodian (${custOf(lgu)})</option>
        <option value="all" ${who === 'all' ? 'selected' : ''}>Consolidated (${custOf(lgu)} and all AOs)</option>
        <optgroup label="Accountable officer">${offs.map((o) => `<option value="${esc(o.id)}" ${who === o.id ? 'selected' : ''}>${esc(officerLabel(refs, o))}</option>`).join('')}</optgroup></select></div>
      <div class="field"><label for="r-m">Month</label><input class="input" type="month" id="r-m" value="${esc(m)}"></div>
    </div>
    <section class="panel" id="cer-print" aria-labelledby="rec-h">
      <div class="panel-head af-raafhead"><h2 id="rec-h">Report of Accountability for Accountable Forms</h2><span class="dim">${esc(agencyName(refs, lgu))} · ${esc(whoName)} · ${esc(monthLabel(m))}</span></div>
      ${sections.length ? `<div class="af-tbl"><table class="af-raaf2">
        <thead><tr class="g"><th rowspan="2" scope="col" class="l">Name of Form</th><th colspan="3" scope="colgroup">Beginning Balance</th><th colspan="3" scope="colgroup">Receipt</th><th colspan="3" scope="colgroup">Issued</th><th colspan="3" scope="colgroup">Ending Balance</th><th rowspan="2" scope="col" class="l">Result</th></tr>
          <tr>${cols.map(() => '<th scope="col" class="r">Qty</th><th scope="col">From</th><th scope="col">To</th>').join('')}</tr></thead>
        <tbody>${sections.map(sectionHtml).join('')}</tbody></table></div>
        <div class="af-foot af-noprint"><p class="af-note">${who !== 'mto' && who !== 'all' ? 'For an accountable officer, Issued includes the ORs encoded in Collections &amp; Deposits. ' : ''}Ending = Beginning + Receipt − Issued.</p>
          ${enc ? '<button class="btn primary" type="button" id="r-save">Save Submitted Figures</button>' : ''}</div>`
      : '<div class="empty"><b>Nothing to report for this month.</b>No booklet was on hand, received or issued.</div>'}
    </section>`;
  const exportRows = () => sections.flatMap(([fund, list]) => list.map((r) => ({ Form: FORM_SHORT[r.form] || r.form,
    'Beginning Qty': countRanges(r.beg), 'Beginning Serials': rangesText(r.beg), 'Receipt Qty': countRanges(r.rec), 'Receipt Serials': rangesText(r.rec),
    'Issued Qty': countRanges(r.iss), 'Issued Serials': rangesText(r.iss), 'Ending Qty': countRanges(r.end), 'Ending Serials': rangesText(r.end) })));
  return { crumb: 'Accountable Forms · RAAF Reconciliation', body, wire: () => {
    $('#r-lgu').onchange = (e) => go({ lgu: e.target.value, who: '' });
    $('#r-who').onchange = (e) => go({ who: e.target.value });
    $('#r-m').onchange = (e) => go({ m: e.target.value });
    $('#r-print').onclick = () => printPart();
    $('#r-xls').onclick = () => exportXlsx(`RAAF ${agencyName(refs, lgu)} ${whoName.split(' · ')[0]} ${m}.xlsx`, 'RAAF', exportRows());
    const s = $('#r-save');
    if (s) s.onclick = async () => {
      s.disabled = true;
      try {
        const got = {};
        $$('input[data-c]').forEach((el) => { const k = el.dataset.fund + '|' + el.dataset.form; (got[k] = got[k] || { fund: el.dataset.fund, form: el.dataset.form })[el.dataset.c] = el.value.trim() === '' ? '' : (int(el.value) ?? 0); });
        for (const g of Object.values(got)) await store.save('cer_raaf', typedId(g.fund, g.form), { lguId, who, month: m, ...g }, by(refs), { quiet: true });
        emitChange('local'); toast('Submitted RAAF figures saved.', 'ok');
      } finally { s.disabled = false; }
    };
  } };
}
// Prints only the part with id "cer-print".
function printPart() { document.body.classList.add('af-printing'); const p = $('#cer-print'); const was = p.hidden; p.hidden = false; window.print(); p.hidden = was; document.body.classList.remove('af-printing'); }
export async function exportXlsx(file, sheet, rows) {
  try {
    if (!rows.length) { toast('Nothing to export.', 'bad'); return; }
    const XLSX = await loadXlsx();
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = Object.keys(rows[0]).map((k) => ({ wch: Math.min(48, Math.max(10, k.length + 2, ...rows.map((r) => String(r[k] ?? '').length + 1))) }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, sheet);
    XLSX.writeFile(wb, file.replace(/[\\/:*?"<>|]/g, '-'));
  } catch (e) { toast(e.message || String(e), 'bad'); }
}

/* ================= Import from Excel ================= */
// Two imports, each with its own template: Receive (booklets received) and Issue (issuances: new ones from stock, and past
// issuances from the issuance list or logbook). Only booklets not yet in the register are added; the rest are skipped.
let xlsxReady = null;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!xlsxReady) xlsxReady = new Promise((res, rej) => {
    const sc = document.createElement('script'); sc.src = 'lib/xlsx.full.min.js';
    sc.onload = () => res(window.XLSX); sc.onerror = () => { xlsxReady = null; rej(new Error('The Excel reader could not load. Check the internet connection and try again.')); };
    document.head.appendChild(sc);
  });
  return xlsxReady;
}
const KINDS = {
  receive: {
    title: 'Import Receipts from Excel', file: 'Receive Import Template.xlsx',
    heads: ['Date Received', 'Series From', 'Series To', 'Per Booklet', 'Received From', 'Reference', 'Received By'],
    widths: [14, 12, 12, 11, 26, 16, 30],
    cols: [['date', /date\s*rec|^\s*date\s*$/i], ['from', /series\s*fr|^\s*from\s*$/i], ['to', /series\s*t|^\s*to\s*$/i], ['per', /per\s*book/i],
      ['src', /received\s*fr|^\s*source/i], ['ref', /ref/i], ['rby', /received\s*by/i]],
    notes: ['One row per receipt. A row may cover several booklets: it is split by Per Booklet (blank = 50).',
      'Date Received: an Excel date or mm/dd/yyyy.',
      'Received From: Provincial Treasurer, National Printing Office or Others.',
      'Received By: leave blank when the custodian (MTO / PTO) received the booklets.',
      'Received By: type the accountable officer\'s name when the officer received them directly (e.g. a barangay treasurer). The officer must already be in the app (Audit Setup or an earlier Issue import).',
      'Reference (optional): e.g. RIS No.',
      'The Form Type (AF 51, CTC…) is chosen in the app when importing; use one file per form type.'] },
  issue: {
    title: 'Import Issuances from Excel', file: 'Issue Import Template.xlsx',
    heads: ['No.', 'Date Issued', 'Series From', 'Series To', 'Accountable Officer', 'Agency', 'Position', 'Unused on Hand (as of last cash exam)', 'Date Exhausted'],
    widths: [6, 12, 12, 12, 28, 30, 32, 34, 14],
    cols: [['no', /^\s*no\.?\s*$|^\s*#\s*$/i], ['issued', /date\s*iss|^\s*date\s*$/i], ['from', /series\s*fr|^\s*from\s*$/i], ['to', /series\s*t|^\s*to\s*$/i],
      ['officer', /officer|^\s*name/i], ['agency', /agency/i], ['position', /position|designation/i], ['unused', /unused/i], ['exh', /exh/i]],
    notes: ['One booklet per row.',
      'A booklet already in stock in the app (received or starting inventory) is issued to the officer on Date Issued.',
      'A booklet not yet in the app (issued before the register started, e.g. from the logbook) is recorded as a past issuance.',
      'Unused on Hand (as of last cash exam): only for a booklet the officer already held at the last cash exam. Type the unused numbers as ranges, e.g. 7311510, 7311516-7311550 (this is the ending balance of the last SAAF). Leave blank for a booklet issued after the last cash exam.',
      'Date Exhausted: the logbook "Exh" date, if the booklet is already used up.',
      'Agency: for a barangay treasurer, the barangay (e.g. BLGU - Abbag), so a new officer is placed under the right barangay.',
      'No.: the logbook line number (optional), to trace a row back to the logbook.',
      'The Form Type (AF 51, CTC…) is chosen in the app when importing; use one file per form type.'] }
};
function findColumns(rows, cols) {
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const map = {};
    rows[r].forEach((cell, c) => { const t = String(cell || ''); cols.forEach(([k, re]) => { if (map[k] === undefined && re.test(t) && !(k === 'issued' && /exh/i.test(t)) && !(k === 'officer' && /unused/i.test(t))) map[k] = c; }); });
    if (map.from !== undefined && map.to !== undefined) return { header: r, map };
  }
  return null;
}
function excelDate(XLSX, v) {
  if (v === '' || v === null || v === undefined) return '';
  if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); return d ? `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}` : ''; }
  const t = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(t);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
  return null;   // not a date
}
const nameKey = (s) => String(s || '').toUpperCase().replace(/\s+/g, ' ').replace(/\s*\.\s*/g, '. ').trim();
function readSheet(XLSX, wb, cols) {
  for (const n of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' });
    const c = findColumns(rows, cols);
    if (c) return { rows, ...c };
  }
  return null;
}
// A barangay named in the Agency column (e.g. "BLGU - Abbag", "Barangay Abbag", "Abbag") under this municipality.
function barangayFromAgency(refs, lguId, agency) {
  const k = String(agency || '').toUpperCase().replace(/^\s*(BLGU|BRGY\.?|BARANGAY)\s*[-–:]?\s*/, '').trim();
  if (!k) return null;
  return refs.lgus.find((l) => l.data.kind === 'barangay' && l.data.parentId === lguId && (l.data.name.toUpperCase() === k || String(l.data.formerName || '').toUpperCase() === k)) || null;
}

// The Fund cell: blank, or one of the register's funds (any capitalization). Returns { fund } or { error }.
function readFund(f, lguId, v) {
  const t = String(v ?? '').trim(); if (!t) return { fund: '' };
  const hit = fundsOf(f, lguId).find((x) => x.toUpperCase() === t.toUpperCase());
  return hit ? { fund: hit } : { error: `Fund "${t}" is not in this LGU's fund list. Add it with the Funds button first.` };
}
function planReceive(XLSX, sheet, f, refs, lguId, form) {
  const M = sheet.map, get = (row, k) => (M[k] === undefined ? '' : row[M[k]]);
  const offs = officersOf(refs, f, lguId);
  const known = new Map(offs.map((o) => [nameKey(o.name), o]));
  const taken = f.booklets.filter((b) => b.form === form).map((b) => ({ ...b }));
  const plan = { kind: 'receive', form, add: [], same: [], problems: [] };
  for (let i = sheet.header + 1; i < sheet.rows.length; i++) {
    const row = sheet.rows[i], line = i + 1;
    const a = int(get(row, 'from')), z = int(get(row, 'to'));
    if (!a && !z && !String(get(row, 'date')).trim()) continue;
    const date = excelDate(XLSX, get(row, 'date'));
    const p = int(get(row, 'per')) || PER_BOOKLET;
    const srcIn = String(get(row, 'src') || '').trim();
    const src = RECEIVED_FROM.find((x) => x.toUpperCase() === srcIn.toUpperCase());
    const rbyIn = String(get(row, 'rby') || '').trim();
    const bad = (why) => plan.problems.push({ line, text: `${a || '?'} – ${z || '?'}`, why });
    if (!a || !z) { bad('Series From or Series To is missing.'); continue; }
    if (z < a) { bad('Series From is after Series To.'); continue; }
    if (z - a + 1 > MAX_PCS) { bad(`${z - a + 1} pieces in one row. Check the series.`); continue; }
    if (!date) { bad(date === null ? 'Date Received is not a date.' : 'Date Received is missing.'); continue; }
    if (!src) { bad(srcIn ? `Received From "${srcIn}" is not in the list (Provincial Treasurer, National Printing Office, Others).` : 'Received From is missing.'); continue; }
    const officer = rbyIn ? known.get(nameKey(rbyIn)) : null;
    if (rbyIn && !officer) { bad(`Received By "${rbyIn}" is not an officer of this LGU or its barangays. Add the officer first.`); continue; }
    const parts = splitRange(a, z, p), items = [];
    let why = '';
    for (const [x, y] of parts) {
      const hit = taken.filter((b) => b.from <= y && x <= b.to);
      const exact = hit.length === 1 && hit[0].from === x && hit[0].to === y ? hit[0] : null;
      if (exact && exact.receivedDate) { plan.same.push({ line, text: rangeText(x, y) }); continue; }
      if (exact && !exact.receivedDate) {
        if (officer && exact.officerId && exact.officerId !== officer.id) { why = `${rangeText(x, y)} is recorded with another officer.`; break; }
        if (officer && exact.issuedDate && exact.issuedDate < date) { why = `${rangeText(x, y)} was in the officer's hands on ${fmtDate(exact.issuedDate)}, before this receipt date.`; break; }
        if (!officer && exact.status !== 'stock' && exact.issuedDate && exact.issuedDate < date) { why = `${rangeText(x, y)} was issued on ${fmtDate(exact.issuedDate)}, before this receipt date.`; break; }
        items.push({ x, y, match: exact.id }); continue;
      }
      if (hit.length) { why = `${rangeText(x, y)} overlaps ${rangeText(hit[0].from, hit[0].to)} already in the register.`; break; }
      items.push({ x, y });
    }
    if (why) { bad(why); continue; }
    items.forEach((it) => { plan.add.push({ line, ...it, date, src, ref: String(get(row, 'ref') || '').trim(), officerId: officer ? officer.id : '' }); if (!it.match) taken.push({ form, from: it.x, to: it.y, receivedDate: date }); else taken.find((b) => b.id === it.match).receivedDate = date; });
  }
  return plan;
}

function planIssue(XLSX, sheet, f, refs, lguId, form) {
  const M = sheet.map, get = (row, k) => (M[k] === undefined ? '' : row[M[k]]);
  const offs = officersOf(refs, f, lguId);
  const known = new Map(offs.map((o) => [nameKey(o.name), o]));
  const newOff = new Map();
  const taken = f.booklets.filter((b) => b.form === form).map((b) => ({ ...b }));
  const plan = { kind: 'issue', form, add: [], same: [], problems: [], newOfficers: [] };
  for (let i = sheet.header + 1; i < sheet.rows.length; i++) {
    const row = sheet.rows[i], line = i + 1;
    const a = int(get(row, 'from')), z = int(get(row, 'to'));
    const nm = String(get(row, 'officer') || '').trim();
    if (!a && !z && !nm) continue;
    const issued = excelDate(XLSX, get(row, 'issued')), exh = excelDate(XLSX, get(row, 'exh'));
    const no = String(get(row, 'no') || '').trim();
    const bad = (why) => plan.problems.push({ line, no, text: `${a || '?'} – ${z || '?'}${nm ? ' · ' + nm : ''}`, why });
    if (!a || !z) { bad('Series From or Series To is missing.'); continue; }
    if (z < a) { bad('Series From is after Series To.'); continue; }
    if (z - a + 1 > MAX_PCS) { bad(`${z - a + 1} pieces in one row. Check the series.`); continue; }
    if (!nm) { bad('Accountable Officer is missing. Booklets in stock are recorded with Receive or Starting Inventory.'); continue; }
    if (issued === null) { bad('Date Issued is not a date.'); continue; }
    if (!issued) { bad('Date Issued is missing.'); continue; }
    if (exh === null) { bad('Date Exhausted is not a date.'); continue; }
    if (exh && exh < issued) { bad('Date Exhausted is before Date Issued.'); continue; }
    const un = parseRanges(get(row, 'unused'), a, z);
    if (un.error) { bad(`Unused on Hand: ${un.error}`); continue; }
    if (un.ranges.length && exh) { bad('Unused on Hand and Date Exhausted cannot both be filled.'); continue; }
    const key = nameKey(nm);
    let o = known.get(key) || newOff.get(key);
    const hit = taken.filter((b) => b.from <= z && a <= b.to);
    const exact = hit.length === 1 && hit[0].from === a && hit[0].to === z ? hit[0] : null;
    if (exact && exact.status === 'issued') {
      if (o && exact.officerId === o.id) { plan.same.push({ line, no, text: rangeText(a, z) }); continue; }
      bad(`Already issued to ${f.officers.find((x) => x.id === exact.officerId)?.name || 'another officer'}.`); continue;
    }
    if (exact && exact.status === 'lost') { bad('This booklet is recorded as lost / destroyed.'); continue; }
    if (exact && exact.status === 'stock') {
      if (exact.receivedDate && issued < exact.receivedDate) { bad(`Issued before it was received (${fmtDate(exact.receivedDate)}).`); continue; }
      if (un.ranges.length) { bad('Unused on Hand is only for a booklet already held at the last cash exam, not one issued from stock.'); continue; }
    } else if (hit.length) { bad(`Overlaps ${rangeText(hit[0].from, hit[0].to)}${hit[0].lguId !== lguId ? ' in another register' : ''}.`); continue; }
    if (!o) {
      const brgy = barangayFromAgency(refs, lguId, get(row, 'agency'));
      o = { id: newId('cero'), name: key, designation: String(get(row, 'position') || '').trim(), agency: String(get(row, 'agency') || '').trim(), lguId: brgy ? brgy.id : lguId };
      newOff.set(key, o);
    }
    plan.add.push({ line, no, from: a, to: z, issued, exh, unused: un.ranges, officerId: o.id, fromStock: exact ? exact.id : '' });
    if (exact) exact.status = 'issued', exact.officerId = o.id; else taken.push({ form, from: a, to: z, lguId, status: 'issued', officerId: o.id });
  }
  plan.newOfficers = [...newOff.values()];
  return plan;
}

async function importModal(refs, f, lguId, kind) {
  const K = KINDS[kind];
  let plan = null;
  const lgu = refs.lgu[lguId];
  const ok = await modal({ title: K.title, wide: true,
    body: `<p class="hint" style="margin:0">Forms Register of <b>${esc(agencyName(refs, lgu))}</b>. Booklets already in the register are skipped, so the same file can be imported again after new rows are added. Use the <b>${esc(K.file.replace('.xlsx', ''))}</b>.</p>
      <div class="two">
        <div class="field"><label for="i-form">Form Type</label><select class="input" id="i-form">${FORMS.map(([k, l]) => `<option value="${k}" ${k === LAST.form ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
        <div class="field"><label for="i-file">Excel file (.xlsx, .xls or .csv)</label><input class="input" type="file" id="i-file" accept=".xlsx,.xls,.csv"></div>
      </div>
      <p class="hint" style="margin:0">Headings read: ${esc(K.heads.join(', '))}.</p>
      <div id="i-prev"></div>`,
    onOpen: (bg) => {
      const fileIn = $('#i-file', bg), formIn = $('#i-form', bg), prev = $('#i-prev', bg);
      const run = async () => {
        plan = null;
        const file = fileIn.files[0]; if (!file) { prev.innerHTML = ''; return; }
        prev.innerHTML = '<p class="hint">Reading the file…</p>';
        try {
          const XLSX = await loadXlsx();
          const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
          const sheet = readSheet(XLSX, wb, K.cols);
          if (!sheet) { prev.innerHTML = '<div class="msg bad">No sheet with "Series From" and "Series To" headings was found.</div>'; return; }
          plan = kind === 'receive' ? planReceive(XLSX, sheet, f, refs, lguId, formIn.value) : planIssue(XLSX, sheet, f, refs, lguId, formIn.value);
          prev.innerHTML = previewHtml(refs, f, plan);
        } catch (e) { prev.innerHTML = `<div class="msg bad">${esc(e.message || e)}</div>`; }
      };
      fileIn.onchange = run; formIn.onchange = run;
    },
    buttons: [{ label: 'Cancel', value: null }, { label: 'Import New Booklets', cls: 'primary', value: 'go', check: () => {
      if (!plan) { toast('Choose the Excel file first.', 'bad'); return false; }
      if (!plan.add.length) { toast('Nothing new to import.', 'bad'); return false; }
      return true;
    } }] });
  if (ok !== 'go' || !plan) return;
  toast(`Importing ${plan.add.length} booklets…`);
  const q = { quiet: true };
  if (plan.kind === 'receive') {
    for (const it of plan.add) {
      const info = { receivedDate: it.date, receivedFrom: it.src, reference: it.ref, receivedDirect: !!it.officerId };
      const note = `Excel row ${it.line}`;
      if (it.match) {
        const b = f.booklets.find((x) => x.id === it.match);
        await store.save('cer_booklets', b.id, { ...strip(b), ...info, history: [...(b.history || []), hist(refs, it.officerId ? 'matcheddirect' : 'matched', it.date, { officerId: it.officerId, note: `${note}; matched to the earlier entry` })] }, by(refs), q);
      } else if (it.officerId) {
        await store.save('cer_booklets', newId('cerb'), { lguId, form: plan.form, from: it.x, to: it.y, qty: it.y - it.x + 1, ...info, source: 'direct', status: 'issued', officerId: it.officerId, issuedDate: it.date,
          history: [hist(refs, 'direct', it.date, { officerId: it.officerId, note: `${it.src} · ${note}` })] }, by(refs), q);
      } else {
        await store.save('cer_booklets', newId('cerb'), { lguId, form: plan.form, from: it.x, to: it.y, qty: it.y - it.x + 1, ...info, source: 'received', status: 'stock', officerId: '', issuedDate: '',
          history: [hist(refs, 'received', it.date, { note: `${it.src} · ${note}` })] }, by(refs), q);
      }
    }
  } else {
    for (const o of plan.newOfficers) await store.save('cer_officers', o.id, { lguId: o.lguId, name: o.name, designation: o.designation, agency: o.agency }, by(refs), q);
    for (const it of plan.add) {
      const note = `Excel row ${it.line}${it.no ? ' · logbook No. ' + it.no : ''}`;
      if (it.fromStock) {
        const b = f.booklets.find((x) => x.id === it.fromStock);
        const history = [...(b.history || []), hist(refs, 'issued', it.issued, { officerId: it.officerId, note })];
        if (it.exh) history.push(hist(refs, 'exhausted', it.exh, { officerId: it.officerId }));
        await store.save('cer_booklets', b.id, { ...strip(b), status: 'issued', officerId: it.officerId, issuedDate: it.issued, exhaustedDate: it.exh || '', history }, by(refs), q);
      } else {
        const history = [hist(refs, 'imported', it.issued, { officerId: it.officerId, note: note + (it.unused.length ? ` · unused on hand at the last cash exam: ${rangesText(it.unused)}` : '') })];
        if (it.exh) history.push(hist(refs, 'exhausted', it.exh, { officerId: it.officerId }));
        await store.save('cer_booklets', newId('cerb'), { lguId, form: plan.form, from: it.from, to: it.to, qty: it.to - it.from + 1, receivedDate: '', receivedFrom: '', reference: '',
          source: 'import', status: 'issued', officerId: it.officerId, issuedDate: it.issued, exhaustedDate: it.exh || '', unusedAtStart: it.unused.length ? it.unused : null, history }, by(refs), q);
      }
    }
  }
  emitChange('local');
  const n = plan.add.length, s = plan.same.length, no = (plan.newOfficers || []).length;
  toast(`${n} booklet${n > 1 ? 's' : ''} imported${no ? `, ${no} new officer${no > 1 ? 's' : ''} added` : ''}.${s ? ` ${s} already in the register ${s > 1 ? 'were' : 'was'} skipped.` : ''}`, 'ok');
}
function previewHtml(refs, f, plan) {
  const name = (id) => (plan.newOfficers || []).find((o) => o.id === id)?.name || f.officers.find((o) => o.id === id)?.name || '';
  let boxes;
  if (plan.kind === 'receive') {
    const direct = plan.add.filter((x) => x.officerId).length, matched = plan.add.filter((x) => x.match).length;
    boxes = `<div><b>${plan.add.length}</b><span>booklets to import</span><small>${plan.add.length - direct} to the custodian · ${direct} received directly${matched ? ` · ${matched} matched to earlier entries` : ''}</small></div>`;
  } else {
    const stock = plan.add.filter((x) => x.fromStock).length, past = plan.add.length - stock, exh = plan.add.filter((x) => x.exh).length, part = plan.add.filter((x) => x.unused.length).length;
    boxes = `<div><b>${plan.add.length}</b><span>booklets to import</span><small>${stock} issued from stock · ${past} past issuances${part ? ` (${part} with unused on hand)` : ''}${exh ? ` · ${exh} exhausted` : ''}</small></div>`;
  }
  return `<div class="af-imp">${boxes}
      <div><b>${plan.same.length}</b><span>already in the register</span><small>or repeated in the file · skipped</small></div>
      <div><b>${(plan.newOfficers || []).length}</b><span>new officers</span><small>${plan.kind === 'receive' ? 'none: Received By must already exist' : 'added once'}</small></div>
      <div class="${plan.problems.length ? 'warn' : ''}"><b>${plan.problems.length}</b><span>rows not imported</span><small>listed below</small></div>
    </div>
    ${(plan.newOfficers || []).length ? `<p class="hint" style="margin:0"><b>New officers:</b> ${plan.newOfficers.map((o) => `${esc(o.name)}${o.designation ? ` (${esc(o.designation)})` : ''}${refs.lgu[o.lguId]?.data.kind === 'barangay' ? ` · ${esc(agencyName(refs, refs.lgu[o.lguId]))}` : ''}`).join(', ')}</p>` : ''}
    ${plan.problems.length ? `<div class="af-probs"><b>Rows not imported</b>${plan.problems.slice(0, 60).map((p) => `<div>Row ${p.line}${p.no ? ` · No. ${esc(p.no)}` : ''} · ${esc(p.text)} — ${esc(p.why)}</div>`).join('')}${plan.problems.length > 60 ? `<div>…and ${plan.problems.length - 60} more</div>` : ''}</div>` : ''}`;
}

// An empty Excel file with exactly the headings the import reads, plus a sheet of instructions.
async function downloadTemplate(kind) {
  const K = KINDS[kind];
  const XLSX = await loadXlsx();
  const ws = XLSX.utils.aoa_to_sheet([K.heads]);
  ws['!cols'] = K.widths.map((w) => ({ wch: w }));
  const notes = XLSX.utils.aoa_to_sheet([['How to fill in'], ...K.notes.map((n) => [n])]);
  notes['!cols'] = [{ wch: 110 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, kind === 'receive' ? 'Receipts' : 'Issuances');
  XLSX.utils.book_append_sheet(wb, notes, 'How to fill in');
  XLSX.writeFile(wb, K.file);
}

/* ---------- funds of a register ---------- */
async function fundsModal(refs, f, lguId) {
  const list = [...fundsOf(f, lguId)];
  const used = (x) => f.booklets.some((b) => b.lguId === lguId && b.fund === x);
  const enc = canEncode(refs);
  const v = await modal({ title: `Funds · ${agencyName(refs, refs.lgu[lguId])}`,
    body: `<p class="hint" style="margin:0">The funds this LGU uses for its accountable forms. Booklets with no fund are reported under "No fund indicated".</p>
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
  await store.save('cer_settings', 'funds|' + lguId, { list }, by(refs));
  toast('Funds saved.', 'ok');
}
