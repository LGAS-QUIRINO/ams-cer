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

const FORM_SHORT = { af51: 'AF 51', ctci: 'CTC – Individual', ctcc: 'CTC – Corporate', af54: 'AF 54', af56: 'AF 56' };
const RECEIVED_FROM = ['Provincial Treasurer', 'National Printing Office', 'Others'];
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
async function loadForms() {
  const cer = await loadCer();
  const [booklets, checks, raaf, settings] = await Promise.all([store.list('cer_booklets'), store.list('cer_formcheck'), store.list('cer_raaf'), store.list('cer_settings')]);
  const flat = (r) => ({ id: r.id, ...r.data });
  return { ...cer, booklets: booklets.map(flat), checks: checks.map(flat), raaf: raaf.map(flat), settings: Object.fromEntries(settings.map((s) => [s.id, s.data])) };
}
// Custodian LGUs: the province and the municipalities. A barangay's booklets are in its municipality's register.
const registerOf = (refs, lguId) => { const l = refs.lgu[lguId]; return l && l.data.kind === 'barangay' ? l.data.parentId : lguId; };
function registers(refs) {
  return refs.lgus.filter((l) => (l.data.kind === 'municipality' || l.data.kind === 'province') && mayView(refs, l))
    .sort((a, b) => (a.data.kind === 'province' ? -1 : b.data.kind === 'province' ? 1 : a.data.name.localeCompare(b.data.name)));
}
const officersOf = (refs, f, lguId) => f.officers.filter((o) => registerOf(refs, o.lguId) === lguId).sort((a, b) => a.name.localeCompare(b.name));
const officerLabel = (refs, o) => o ? `${o.name}${o.designation ? ' · ' + o.designation : ''}` : '';

/* ---------- booklet figures ---------- */
// Numbers used. For now from the Starting Inventory (first unused number); Collections Entry adds the encoded receipts.
function usedOf(b) {
  if (b.exhaustedDate) return b.qty;   // marked exhausted from the logbook ("Exh" date)
  const before = b.usedBefore ? Math.max(0, Math.min(b.qty, b.usedBefore - b.from)) : 0;
  return before;
}
function statusOf(b) {
  if (b.status === 'lost') return { key: 'lost', label: 'Lost / Destroyed', cls: 'p-flag' };
  if (b.status === 'stock') return { key: 'stock', label: 'In stock', cls: 'p-stock' };
  const u = usedOf(b);
  if (u >= b.qty) return { key: 'done', label: b.exhaustedDate ? 'Exhausted (per logbook)' : 'Exhausted', cls: 'p-done' };
  if (u > 0) return { key: 'part', label: 'Partly used', cls: 'p-part' };
  return { key: 'new', label: 'Issued, not yet used', cls: 'p-new' };
}
const unusedOf = (b) => (b.status === 'lost' ? 0 : b.qty - usedOf(b));
const unusedRange = (b) => { const n = unusedOf(b); return n > 0 ? [b.to - n + 1, b.to] : null; };
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
    && (!fCust || (fCust === 'stock' ? b.status === 'stock' : b.officerId === fCust))
    && (fStat === 'all' || (fStat === 'open' ? statusOf(b).key !== 'done' : statusOf(b).key === fStat)));
  rows.sort(sort === 'days' ? (a, b) => (daysWithAo(b, asOf) ?? -1) - (daysWithAo(a, asOf) ?? -1) || a.form.localeCompare(b.form) || a.from - b.from
    : (a, b) => a.form.localeCompare(b.form) || a.from - b.from);
  const stock = mine.filter((b) => b.status === 'stock');
  const withAo = mine.filter(held);
  const done = mine.filter((b) => statusOf(b).key === 'done');
  const old = aging ? withAo.filter((b) => daysWithAo(b, asOf) > +aging) : [];
  const forCheck = new Set([...oos, ...old.map((b) => b.id)]);
  const enc = canEncode(refs);
  const pick = (name, opts, sel) => `<select class="input af-sm" data-filter="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const formsUsed = [...new Set(mine.map((b) => b.form))];
  const longest = withAo.slice().sort((a, b) => daysWithAo(b, asOf) - daysWithAo(a, asOf))[0];
  const body = `<div class="hello"><div><h1>Accountable Forms</h1><p>Each booklet is encoded once, from receipt by the custodian to its last number used. Status follows Collections Entry. Unused forms are counted, never treated as missing.</p></div>
      <div class="btn-row"><a class="btn" href="#/cer/forms/raaf?lgu=${esc(lguId)}">RAAF Reconciliation</a><a class="btn" href="#/cer/forms/officer?lgu=${esc(lguId)}">By Accountable Officer</a></div></div>

    <div class="panel af-bar">
      <div class="field"><label for="af-lgu">Forms Register of</label><select class="input" id="af-lgu">${registers(refs).map((l) => `<option value="${esc(l.id)}" ${l.id === lguId ? 'selected' : ''}>${esc(agencyName(refs, l))}</option>`).join('')}</select></div>
      <div class="field"><label for="af-asof">Days counted up to</label><input class="input" type="date" id="af-asof" value="${esc(asOf)}"></div>
      <div class="field"><label for="af-aging">Flag a booklet held by an AO after (days)</label><input class="input" id="af-aging" inputmode="numeric" placeholder="No flag" value="${esc(aging)}" ${isAuditor(refs) ? '' : 'disabled'}></div>
    </div>

    <div class="stats">
      <div class="stat"><span>In Stock · Custodian</span><b>${stock.length}</b><small>booklets · ${stock.reduce((n, b) => n + b.qty, 0)} pcs</small></div>
      <div class="stat"><span>With Accountable Officers</span><b style="color:#1d4fb8">${withAo.length}</b><small>booklets · ${withAo.reduce((n, b) => n + unusedOf(b), 0)} unused pcs</small></div>
      <div class="stat"><span>Exhausted</span><b style="color:var(--ok)">${done.length}</b><small>every number used or cancelled</small></div>
      <div class="stat"><span>For Checking</span><b class="${forCheck.size ? 'warn' : 'dim'}">${forCheck.size}</b><small>out of sequence${aging ? ', held too long' : ''}</small></div>
    </div>

    ${enc ? encodeHtml(refs, offs, q) : ''}

    <section class="panel" aria-labelledby="reg-h">
      <div class="panel-head"><h2 id="reg-h">Forms Register</h2><span class="pill">${rows.length}</span>
        <div class="af-filters">
          ${pick('form', [['', 'All forms'], ...FORMS.filter(([k]) => formsUsed.includes(k)).map(([k]) => [k, FORM_SHORT[k]])], fForm)}
          ${pick('cust', [['', 'All custody'], ['stock', 'In stock (custodian)'], ...offs.map((o) => [o.id, o.name])], fCust)}
          ${pick('st', [['open', 'Not exhausted'], ['all', 'All statuses'], ['stock', 'In stock'], ['new', 'Issued, not yet used'], ['part', 'Partly used'], ['done', 'Exhausted'], ['lost', 'Lost / Destroyed']], fStat)}
          ${pick('sort', [['days', 'Longest with AO first'], ['serial', 'By form and serial']], sort)}
        </div></div>
      ${rows.length ? `<div class="af-tbl"><table class="af-reg">
        <thead><tr><th scope="col">Form</th><th scope="col">Serial Range</th><th scope="col" class="r">Qty</th><th scope="col">Received</th><th scope="col">Custody</th><th scope="col">Issued</th><th scope="col" class="r">Days with AO</th><th scope="col" class="r">Used</th><th scope="col">Unused</th><th scope="col">Status</th></tr></thead>
        <tbody>${rows.map((b) => {
          const o = f.officers.find((x) => x.id === b.officerId); const st = statusOf(b); const d = daysWithAo(b, asOf); const ur = unusedRange(b);
          const flagOld = aging && d !== null && d > +aging, flagSeq = oos.has(b.id);
          return `<tr class="${flagOld || flagSeq ? 'flag' : ''}" data-bk="${esc(b.id)}" tabindex="0">
            <td>${esc(FORM_SHORT[b.form] || b.form)}</td><td class="mono">${rangeText(b.from, b.to)}</td><td class="r">${b.qty}</td>
            <td>${b.receivedDate ? esc(fmtDate(b.receivedDate)) : '<span class="dim">—</span>'}<small>${esc(b.receivedFrom || (b.source === 'logbook' ? 'From the barangay logbook' : b.source === 'starting' ? 'Starting inventory' : ''))}</small></td>
            <td>${b.status === 'issued' && o ? `<b>${esc(o.name)}</b><small>${esc([o.designation, agencyName(refs, refs.lgu[o.lguId])].filter(Boolean).join(' · '))}</small>` : b.status === 'lost' ? '<span class="dim">—</span>' : `In stock<small>${lgu.data.kind === 'province' ? 'Provincial' : 'Municipal'} Treasurer (custodian)</small>`}</td>
            <td>${b.status !== 'stock' && b.issuedDate ? esc(fmtDate(b.issuedDate)) : '<span class="dim">—</span>'}</td>
            <td class="r">${d === null ? '<span class="dim">—</span>' : `<b class="${flagOld ? 'warn-t' : ''}">${d}</b>`}</td>
            <td class="r">${usedOf(b)}</td>
            <td class="mono">${ur ? `${rangeText(ur[0], ur[1])} <span class="dim">(${unusedOf(b)})</span>` : '<span class="dim">None</span>'}</td>
            <td><span class="pill ${st.cls}">${st.label}</span>${flagSeq ? '<br><span class="pill p-flag">Out of sequence</span>' : ''}${flagOld ? '<br><span class="pill p-flag">Held too long</span>' : ''}</td></tr>`;
        }).join('')}</tbody></table></div>
        <p class="af-note">Click a booklet to see its history and to Issue, Transfer, Return or report it Lost.</p>`
      : `<div class="empty"><b>${mine.length ? 'No booklet matches these filters.' : 'No booklets in this register yet.'}</b>${mine.length ? '' : 'Encode the custodian\'s booklets with <b>Receive</b>, or the forms already out with <b>Starting Inventory</b>.'}</div>`}
    </section>

    <section class="panel" aria-labelledby="res-h">
      <div class="panel-head"><h2 id="res-h">Forms Control Results</h2></div>
      <div class="af-res">
        ${result(oos.size ? 'warn' : 'ok', oos.size ? `Out-of-sequence use · ${oos.size}` : 'No out-of-sequence use',
          oos.size ? [...oos].map((id) => { const b = mine.find((x) => x.id === id); const o = f.officers.find((x) => x.id === b.officerId); return `${esc(o ? o.name : 'An officer')} used ${FORM_SHORT[b.form]} ${rangeText(b.from, b.to)} while an earlier booklet still has unused numbers.`; }).join('<br>') : 'Each officer uses the earlier booklet of a form before starting the next.')}
        ${result(overlapCount(mine) ? 'warn' : 'ok', overlapCount(mine) ? `Overlapping serial ranges · ${overlapCount(mine)}` : 'No overlapping serial ranges', 'No number may appear in two booklets.')}
        ${result('info', longest ? `Longest with an AO · ${daysWithAo(longest, asOf)} days` : 'No booklet with an AO', longest ? `${esc(f.officers.find((o) => o.id === longest.officerId)?.name || '')}, ${FORM_SHORT[longest.form]} ${rangeText(longest.from, longest.to)}, issued ${esc(fmtDate(longest.issuedDate))}.` : 'Issue booklets to the accountable officers to start counting.')}
        ${result('info', `${withAo.reduce((n, b) => n + unusedOf(b), 0)} unused forms with AOs`, 'To be confirmed in each officer\'s Physical Check at the cash count.')}
        ${result('dim', 'Gaps in used numbers', 'Checked once Collections Entry is built (every number before the last one used must be encoded or cancelled).')}
        ${result('dim', 'Receipts used by the wrong officer', 'Checked once Collections Entry is built (every encoded number must be in a booklet issued to the officer who used it).')}
      </div>
    </section>`;
  return { crumb: 'Accountable Forms · Forms Register', body, wire: () => wireRegister(ctx, f, lguId, offs) };
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
const LAST = { form: 'af51', date: '', src: RECEIVED_FROM[0], off: '', per: PER_BOOKLET };
const sel = (a, b) => (a === b ? 'selected' : '');
function encodeHtml(refs, offs, q) {
  const mv = MOVES.some(([k]) => k === q.get('mv')) ? q.get('mv') : 'receive';
  const formSel = `<div class="field"><label for="e-form">Form Type</label><select class="input" id="e-form">${FORMS.map(([k, l]) => `<option value="${k}" ${sel(k, LAST.form)}>${esc(l)}</option>`).join('')}</select></div>`;
  const range = `<div class="field"><label for="e-from">Serial From</label><input class="input r" id="e-from" inputmode="numeric" autocomplete="off"></div>
    <div class="field"><label for="e-to">Serial To</label><input class="input r" id="e-to" inputmode="numeric" autocomplete="off"></div>`;
  const per = `<div class="field"><label for="e-per">Per Booklet</label><input class="input r" id="e-per" inputmode="numeric" value="${LAST.per}"></div>`;
  const offSel = (id, label, extra = '') => `<div class="field"><label for="${id}">${label}</label><select class="input" id="${id}">${extra.replace(`value="${LAST.off}"`, `value="${LAST.off}" selected`)}<option value="">— Choose the officer —</option>${offs.map((o) => `<option value="${esc(o.id)}" ${sel(o.id, LAST.off)}>${esc(officerLabel(refs, o))}</option>`).join('')}</select></div>`;
  let fields = '';
  if (mv === 'receive') fields = `<div class="af-enc g8">${formSel}${range}${per}
      <div class="field"><label for="e-date">Date Received</label><input class="input" type="date" id="e-date" value="${esc(LAST.date)}"></div>
      <div class="field"><label for="e-src">Received From</label><select class="input" id="e-src">${RECEIVED_FROM.map((s) => `<option ${sel(s, LAST.src)}>${esc(s)}</option>`).join('')}</select></div>
      <div class="field"><label for="e-ref">Reference (optional)</label><input class="input" id="e-ref" placeholder="e.g. RIS No."></div>
      <button class="btn primary" type="button" id="e-enter">Enter</button></div>`;
  if (mv === 'issue') fields = `<div class="af-enc g6">${formSel}${range}${offSel('e-off', 'Issued To')}
      <div class="field"><label for="e-date">Date Issued</label><input class="input" type="date" id="e-date" value="${esc(LAST.date)}"></div>
      <button class="btn primary" type="button" id="e-enter">Enter</button></div>`;
  if (mv === 'starting') fields = `<div class="af-enc g8">${formSel}${range}${per}
      ${offSel('e-off', 'Custody', '<option value="stock">In stock (custodian)</option>')}
      <div class="field"><label for="e-date">Date Issued / As of</label><input class="input" type="date" id="e-date" value="${esc(LAST.date)}"></div>
      <div class="field"><label for="e-next">First Unused No. (optional)</label><input class="input r" id="e-next" inputmode="numeric" placeholder="If partly used"></div>
      <button class="btn primary" type="button" id="e-enter">Enter</button></div>`;
  const help = mv === 'receive' ? 'The range is split into booklets. A serial number already in the register is refused, except a booklet first encoded from a barangay logbook: it is matched by serial and gets its receipt details.'
    : mv === 'issue' ? 'Every booklet in stock within the range is issued to the officer. Barangay treasurers are listed with the municipality\'s officers.'
    : 'Use once, to start the register: the custodian\'s stock and each officer\'s outstanding booklets as of one date. Also for a barangay treasurer\'s booklets copied from the logbook before the municipality\'s side is encoded.';
  return `<section class="panel" aria-labelledby="enc-h"><div class="af-encbox">
    <div class="af-headrow"><h2 id="enc-h" class="cer-h2">Encode</h2>
      <div class="af-headr"><button class="btn" type="button" id="af-import">Import from Excel</button>
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
  const imp = $('#af-import'); if (imp) imp.onclick = () => importModal(refs, f, lguId);
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
      src: $('#e-src') ? $('#e-src').value : LAST.src, off: $('#e-off') ? $('#e-off').value : LAST.off });
    try {
      const ok = mv === 'receive' ? await doReceive(refs, f, lguId) : mv === 'issue' ? await doIssue(refs, f, lguId) : await doStarting(refs, f, lguId);
      if (ok) ['#e-from', '#e-to', '#e-next', '#e-ref'].forEach((s) => { const el = $(s); if (el) el.value = ''; });
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
  const info = { receivedDate: date, receivedFrom: $('#e-src').value, reference: $('#e-ref').value.trim() };
  for (const s of plan) {
    if (s.match) {
      const b = s.match;
      await store.save('cer_booklets', b.id, { ...strip(b), ...info, history: [...(b.history || []), hist(refs, 'matched', date, { note: 'Receipt by the custodian matched to the logbook entry' })] }, by(refs));
    } else {
      await store.save('cer_booklets', newId('cerb'), { lguId, form, from: s.x, to: s.y, qty: s.y - s.x + 1, ...info, source: 'received', status: 'stock', officerId: '', issuedDate: '', usedBefore: null,
        history: [hist(refs, 'received', date, { note: info.receivedFrom })] }, by(refs));
    }
  }
  const m = plan.filter((s) => s.match).length;
  toast(`${plan.length} booklet${plan.length > 1 ? 's' : ''} received${m ? ` (${m} matched to logbook entries)` : ''}.`, 'ok');
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
  const form = $('#e-form').value, a = int($('#e-from').value), z = int($('#e-to').value), p = int($('#e-per').value) || PER_BOOKLET, cust = $('#e-off').value, date = $('#e-date').value, next = int($('#e-next').value);
  if (!a || !z || z < a) return bad('Enter the serial range (From must not be after To).');
  if (z - a + 1 > MAX_PCS) return bad(`That range has ${z - a + 1} pieces. Check the serial numbers (one entry takes up to ${MAX_PCS}).`);
  if (!cust) return bad('Choose the custody: in stock or the officer holding it.');
  if (!date) return bad('Enter the date issued (or the as-of date for stock).');
  const parts = splitRange(a, z, p);
  if (next && (next < a || next > z + 1)) return bad('The first unused number must be inside the range.');
  if (next && parts.length > 1) return bad('Enter a partly used booklet one at a time, with its own first unused number.');
  for (const [x, y] of parts) { const hit = overlaps(f, form, x, y); if (hit.length) return bad(`${FORM_SHORT[form]} ${rangeText(x, y)} overlaps ${rangeText(hit[0].from, hit[0].to)} already in the register.`); }
  const officer = cust !== 'stock' ? f.officers.find((o) => o.id === cust) : null;
  const fromLogbook = !!officer && refs.lgu[officer.lguId]?.data.kind === 'barangay';
  for (const [x, y] of parts) {
    await store.save('cer_booklets', newId('cerb'), { lguId, form, from: x, to: y, qty: y - x + 1, receivedDate: '', receivedFrom: '', reference: '',
      source: fromLogbook ? 'logbook' : 'starting', status: officer ? 'issued' : 'stock', officerId: officer ? officer.id : '', issuedDate: officer ? date : '',
      usedBefore: next || null, history: [hist(refs, officer ? (fromLogbook ? 'logbook' : 'starting') : 'starting', date, { officerId: officer ? officer.id : '', note: next ? `First unused number ${next}` : '' })] }, by(refs));
  }
  toast(`${parts.length} booklet${parts.length > 1 ? 's' : ''} added to the register.`, 'ok');
  return true;
}
const strip = (b) => { const { id, ...rest } = b; return rest; };

/* ---------- one booklet: history and moves ---------- */
const ACTION = { received: 'Received by the custodian', issued: 'Issued', transferred: 'Transferred', returned: 'Returned to the custodian', lost: 'Reported lost / destroyed',
  starting: 'Starting inventory', logbook: 'Encoded from the barangay logbook', matched: 'Receipt by the custodian matched',
  imported: 'Imported from Excel · issued', exhausted: 'Exhausted (per logbook)' };
function historyHtml(refs, f, b) {
  const name = (id) => f.officers.find((o) => o.id === id)?.name || '';
  return `<ol class="af-hist">${(b.history || []).map((h) => `<li><b>${esc(ACTION[h.action] || h.action)}${h.officerId ? ' · ' + esc(name(h.officerId)) : ''}</b>
      <small>${esc(fmtDate(h.date))}${h.note ? ' · ' + esc(h.note) : ''}${h.by ? ' · by ' + esc(refs.users.find((u) => u.data.email === h.by)?.data.name || h.by) : ''}</small></li>`).join('')}
    ${usedOf(b) ? `<li><b>${usedOf(b)} used · ${rangeText(b.from, b.from + usedOf(b) - 1)}</b><small>${b.usedBefore ? 'before the register started' : 'from Collections Entry'}</small></li>` : ''}</ol>`;
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
    onOpen: (bg) => { const act = $('#m-act', bg); if (!act) return; const sync = () => { $('#m-offbox', bg).hidden = !['issue', 'transfer'].includes(act.value); }; act.onchange = sync; sync(); },
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
  const checkRows = exam ? mine.filter((b) => b.status !== 'stock' && b.issuedDate && b.issuedDate <= exam.audit.countDate && statusOf(b).key !== 'done' && b.status !== 'lost') : [];
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
          Tick each booklet seen and type the unused range actually on hand. This fills the SAAF (Annex B) and the unused forms in the GF-74A.</div>
        ${checkRows.length ? `<div class="af-tbl"><table class="af-reg">
          <thead><tr><th scope="col">Seen</th><th scope="col">Form</th><th scope="col">Booklet</th><th scope="col" class="r">Days in Hand</th><th scope="col">Unused per Register</th><th scope="col">Unused per Count</th><th scope="col" class="r">Difference</th><th scope="col">Result</th></tr></thead>
          <tbody>${checkRows.map((b) => {
            const c = chk(b) || {}; const ur = unusedRange(b); const n = unusedOf(b);
            const cnt = c.unusedFrom && c.unusedTo ? c.unusedTo - c.unusedFrom + 1 : null;
            const diff = cnt === null ? null : n - cnt;
            const res = !c.seen ? (c.id ? ['p-flag', 'Not seen'] : ['p-stock', 'Not yet checked']) : diff === 0 && (!ur || (c.unusedFrom === ur[0] && c.unusedTo === ur[1])) ? ['p-done', 'Agrees'] : cnt === null && !n ? ['p-done', 'Agrees'] : ['p-flag', 'For checking'];
            return `<tr data-ck="${esc(b.id)}"><td><input type="checkbox" class="af-seen" ${c.seen ? 'checked' : ''} ${auditor ? '' : 'disabled'} aria-label="Seen: ${esc(FORM_SHORT[b.form])} ${b.from} to ${b.to}"></td>
              <td>${esc(FORM_SHORT[b.form])}</td><td class="mono">${rangeText(b.from, b.to)}</td><td class="r">${days(b.issuedDate, exam.audit.countDate)}</td>
              <td class="mono">${ur ? `${rangeText(ur[0], ur[1])} (${n})` : 'None'}</td>
              <td><div class="af-pair"><input class="input af-sm mono af-uf" value="${esc(c.unusedFrom ?? (ur ? ur[0] : ''))}" aria-label="Unused from" ${auditor ? '' : 'disabled'}><span>–</span><input class="input af-sm mono af-ut" value="${esc(c.unusedTo ?? (ur ? ur[1] : ''))}" aria-label="Unused to" ${auditor ? '' : 'disabled'}></div></td>
              <td class="r">${diff === null ? '<span class="dim">—</span>' : diff}</td><td><span class="pill ${res[0]}">${res[1]}</span></td></tr>`;
          }).join('')}</tbody></table></div>
          <div class="af-foot"><p class="af-note">A booklet not seen, or a difference, goes to Verification for the auditor's judgment. It is never concluded as missing by the system.</p>
            ${auditor ? '<button class="btn primary" type="button" id="af-savecheck">Save Physical Check</button>' : '<span class="dim">The auditor does the Physical Check.</span>'}</div>`
        : '<div class="empty"><b>No booklets in this officer\'s hands on the count date.</b>Booklets issued on or before the cash count, not yet exhausted, are listed here.</div>'}`;
  } else {
    const list = tab === 'hand' ? inHand : mine.slice().sort((a, b) => String(b.issuedDate).localeCompare(String(a.issuedDate)));
    tabBody = list.length ? `<div class="af-tbl"><table class="af-reg"><thead><tr><th scope="col">Form</th><th scope="col">Booklet</th><th scope="col">Issued</th><th scope="col" class="r">Days in Hand</th><th scope="col" class="r">Used</th><th scope="col">Unused</th><th scope="col">Status</th></tr></thead>
      <tbody>${list.map((b) => { const st = statusOf(b); const ur = unusedRange(b); const d = daysWithAo(b, asOf);
        return `<tr data-bk="${esc(b.id)}" tabindex="0"><td>${esc(FORM_SHORT[b.form])}</td><td class="mono">${rangeText(b.from, b.to)}</td><td>${esc(fmtDate(b.issuedDate))}</td><td class="r">${d ?? '<span class="dim">—</span>'}</td><td class="r">${usedOf(b)}</td>
          <td class="mono">${ur ? `${rangeText(ur[0], ur[1])} <span class="dim">(${unusedOf(b)})</span>` : '<span class="dim">None</span>'}</td><td><span class="pill ${st.cls}">${st.label}</span></td></tr>`; }).join('')}</tbody></table></div>
      <p class="af-note">Click a booklet to see its history and to Transfer, Return or report it Lost.</p>`
      : `<div class="empty"><b>${tab === 'hand' ? 'No booklets in this officer\'s hands.' : 'No booklets issued to this officer yet.'}</b></div>`;
  }
  const body = `<div class="hello"><div><a href="#/cer/forms/officer?lgu=${esc(lguId)}" class="af-back">← All officers</a><h1>${esc(o.name)}</h1><p>${esc([o.designation, agencyName(refs, refs.lgu[o.lguId])].filter(Boolean).join(' · '))} · booklets issued by the ${refs.lgu[lguId].data.kind === 'province' ? 'Provincial' : 'Municipal'} Treasurer</p></div>
      <div class="btn-row"><a class="btn" href="#/cer/forms?lgu=${esc(lguId)}&cust=${esc(o.id)}">Open in Forms Register</a><button class="btn" type="button" id="af-clear">Print Clearance List</button></div></div>
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
  return { crumb: 'Accountable Forms · By Accountable Officer', body, wire: () => wireOfficer(ctx, f, lguId, o, exam, offs) };
}
function clearanceHtml(refs, f, o, mine, lguId) {
  const list = mine.filter(held).sort((a, b) => a.form.localeCompare(b.form) || a.from - b.from);
  return `<h2>Accountable Forms in the Officer's Hands</h2>
    <p><b>${esc(o.name)}</b>, ${esc(o.designation || '')} · ${esc(agencyName(refs, refs.lgu[o.lguId]))} · as of ${esc(fmtDate(today()))}</p>
    <table><thead><tr><th>Form</th><th>Booklet</th><th>Date Issued</th><th>Used</th><th>Unused Range</th><th>Unused Qty</th></tr></thead>
    <tbody>${list.length ? list.map((b) => { const ur = unusedRange(b); return `<tr><td>${esc(FORM_SHORT[b.form])}</td><td>${rangeText(b.from, b.to)}</td><td>${esc(fmtDate(b.issuedDate))}</td><td>${usedOf(b)}</td><td>${ur ? rangeText(ur[0], ur[1]) : 'None'}</td><td>${unusedOf(b)}</td></tr>`; }).join('')
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
        const uf = int($('.af-uf', tr).value), ut = int($('.af-ut', tr).value);
        if ((uf && !ut) || (!uf && ut) || (uf && ut && ut < uf)) { toast('Check an unused range: both numbers, From not after To.', 'bad'); return; }
        await store.save('cer_formcheck', id, { examId: exam.id, bookletId: tr.dataset.ck, seen: $('.af-seen', tr).checked, unusedFrom: uf, unusedTo: ut }, by(refs));
      }
      toast('Physical Check saved.', 'ok');
    } finally { save.disabled = false; }
  };
}

/* ================= 3 · RAAF Reconciliation ================= */
// Pieces in the custodian's stock, from each booklet's history: received / starting in stock / returned add; issued / lost from stock subtract.
function stockFlows(list, start, end) {
  const out = {};
  list.forEach((b) => {
    const r = out[b.form] = out[b.form] || { beg: 0, rec: 0, iss: 0 };
    let inStock = false;
    (b.history || []).slice().sort((x, y) => String(x.date).localeCompare(String(y.date))).forEach((h) => {
      const into = h.action === 'received' || h.action === 'matched' || h.action === 'returned' || (h.action === 'starting' && !h.officerId);
      const outof = (h.action === 'issued' || h.action === 'logbook' || h.action === 'lost') && inStock;
      const pcs = h.action === 'returned' ? b.qty - usedOf(b) : b.qty;
      if (h.date < start) { if (into) inStock = true; if (outof) inStock = false; return; }
      if (h.date > end) return;
      // Starting inventory in stock was already on hand: it counts in the beginning balance, not as received.
      if (h.action === 'starting' && !h.officerId) { if (!inStock) { r.beg += pcs; inStock = true; } return; }
      if (into && !inStock) { r.rec += pcs; inStock = true; }
      if (outof) { r.iss += pcs; inStock = false; }
    });
    // Beginning: what was in stock before the month.
    let s = false;
    (b.history || []).filter((h) => h.date < start).sort((x, y) => String(x.date).localeCompare(String(y.date))).forEach((h) => {
      if (h.action === 'received' || h.action === 'matched' || h.action === 'returned' || (h.action === 'starting' && !h.officerId)) s = true;
      if (h.action === 'issued' || h.action === 'logbook' || h.action === 'lost') s = false;
    });
    if (s) r.beg += b.qty;
  });
  Object.values(out).forEach((r) => { r.end = r.beg + r.rec - r.iss; });
  return out;
}
function raafView(ctx, f, lguId) {
  const { refs, q } = ctx;
  const now = today().slice(0, 7);
  const m = /^\d{4}-\d{2}$/.test(q.get('m') || '') ? q.get('m') : now;
  const start = m + '-01';
  const end = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10);
  const mine = f.booklets.filter((b) => b.lguId === lguId);
  const flows = stockFlows(mine, start, end);
  const forms = FORMS.map(([k]) => k).filter((k) => mine.some((b) => b.form === k) || f.raaf.some((r) => r.lguId === lguId && r.month === m && r.form === k));
  const typed = (k) => f.raaf.find((r) => r.id === `${lguId}|${m}|${k}`) || {};
  const recDate = f.raaf.find((r) => r.lguId === lguId && r.month === m && r.receivedDate)?.receivedDate || '';
  const enc = canEncode(refs);
  const cell = (k, fld, v) => `<td><label class="sr-only" for="r-${k}-${fld}">${esc(FORM_SHORT[k])} ${fld} per RAAF</label><input class="input af-cell" id="r-${k}-${fld}" data-r="${k}" data-f="${fld}" inputmode="numeric" value="${v ?? ''}" ${enc ? '' : 'disabled'}></td>`;
  const body = `<div class="hello"><div><a href="#/cer/forms?lgu=${esc(lguId)}" class="af-back">← Forms Register</a><h1>RAAF Reconciliation</h1><p>Type the custodian's Report of Accountability for Accountable Forms. The register's own figures are computed beside it, in pieces, and any difference is flagged for the auditor.</p></div></div>
    <div class="panel af-bar">
      <div class="field"><label for="r-lgu">Custodian</label><select class="input" id="r-lgu">${registers(refs).map((l) => `<option value="${esc(l.id)}" ${l.id === lguId ? 'selected' : ''}>${esc(agencyName(refs, l))} · ${l.data.kind === 'province' ? 'Provincial' : 'Municipal'} Treasurer</option>`).join('')}</select></div>
      <div class="field"><label for="r-m">RAAF Month</label><input class="input" type="month" id="r-m" value="${esc(m)}"></div>
      <div class="field"><label for="r-rec">RAAF Received</label><input class="input" type="date" id="r-rec" value="${esc(recDate)}" ${enc ? '' : 'disabled'}></div>
    </div>
    <section class="panel" aria-labelledby="rec-h">
      <div class="panel-head"><h2 id="rec-h">Balances in Pieces · ${esc(monthLabel(m))}</h2></div>
      ${forms.length ? `<div class="af-tbl"><table class="af-raaf">
        <thead><tr class="g"><th></th><th colspan="4">Per RAAF (typed)</th><th colspan="4">Per Forms Register (computed)</th><th></th><th></th></tr>
          <tr><th scope="col" class="l">Form</th><th scope="col">Beginning</th><th scope="col">Received</th><th scope="col">Issued</th><th scope="col">Ending</th><th scope="col">Beginning</th><th scope="col">Received</th><th scope="col">Issued</th><th scope="col">Ending</th><th scope="col">Difference</th><th scope="col" class="l">Result</th></tr></thead>
        <tbody>${forms.map((k) => {
          const t = typed(k), c = flows[k] || { beg: 0, rec: 0, iss: 0, end: 0 };
          const has = ['beg', 'rec', 'iss', 'end'].some((x) => t[x] !== undefined && t[x] !== null && t[x] !== '');
          const same = has && ['beg', 'rec', 'iss', 'end'].every((x) => +(t[x] || 0) === c[x]);
          const diff = has ? (+(t.end || 0) - c.end) : null;
          return `<tr><td class="l"><b>${esc(FORM_SHORT[k])}</b></td>${cell(k, 'beg', t.beg)}${cell(k, 'rec', t.rec)}${cell(k, 'iss', t.iss)}${cell(k, 'end', t.end)}
            <td class="reg">${c.beg}</td><td class="reg">${c.rec}</td><td class="reg">${c.iss}</td><td class="reg"><b>${c.end}</b></td>
            <td class="${diff ? 'warn-t' : ''}">${diff === null ? '<span class="dim">—</span>' : `<b>${diff}</b>`}</td>
            <td class="l">${!has ? '<span class="pill p-stock">Not yet typed</span>' : same ? '<span class="pill p-done">Agrees</span>' : '<span class="pill p-flag">For checking</span>'}</td></tr>`;
        }).join('')}</tbody></table></div>
        <div class="af-foot"><p class="af-note">Ending = Beginning + Received − Issued. Received includes booklets returned to the custodian; Issued includes booklets reported lost from stock. Any column that differs is For checking.</p>
          ${enc ? '<button class="btn primary" type="button" id="r-save">Save RAAF</button>' : ''}</div>`
      : '<div class="empty"><b>No booklets in this register yet.</b>Encode the custodian\'s booklets first.</div>'}
    </section>`;
  return { crumb: 'Accountable Forms · RAAF Reconciliation', body, wire: () => {
    $('#r-lgu').onchange = (e) => go({ lgu: e.target.value });
    $('#r-m').onchange = (e) => go({ m: e.target.value });
    const s = $('#r-save');
    if (s) s.onclick = async () => {
      s.disabled = true;
      try {
        const rd = $('#r-rec').value;
        for (const k of forms) {
          const v = (fld) => { const el = $(`#r-${k}-${fld}`); const n = int(el.value); return el.value.trim() === '' ? '' : n ?? 0; };
          const rec = { lguId, month: m, form: k, beg: v('beg'), rec: v('rec'), iss: v('iss'), end: v('end'), receivedDate: rd };
          if (['beg', 'rec', 'iss', 'end'].some((x) => rec[x] !== '') || rd) await store.save('cer_raaf', `${lguId}|${m}|${k}`, rec, by(refs));
        }
        toast('RAAF saved.', 'ok');
      } finally { s.disabled = false; }
    };
  } };
}

/* ================= Import from Excel ================= */
// Reads an issuance list or a typed logbook (one row per booklet) and adds only the booklets not yet in the register.
// Columns are found by their headings: Date Issued, Series From, Series To, Accountable Officer, Agency, Position, Date Exhausted (Exh), No.
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
const COLS = [
  ['no', /^\s*no\.?\s*$|^\s*#\s*$/i], ['issued', /date\s*iss|^\s*date\s*$/i], ['from', /series\s*fr|^\s*from\s*$/i], ['to', /series\s*t|^\s*to\s*$/i],
  ['officer', /officer|^\s*name/i], ['agency', /agency/i], ['position', /position|designation/i], ['exh', /exh/i]];
function findColumns(rows) {
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const map = {};
    rows[r].forEach((cell, c) => { const t = String(cell || ''); COLS.forEach(([k, re]) => { if (map[k] === undefined && re.test(t) && !(k === 'issued' && /exh/i.test(t))) map[k] = c; }); });
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

function planImport(XLSX, wb, f, refs, lguId, form) {
  let rows = null, cols = null;
  for (const n of wb.SheetNames) {
    const r = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' });
    const c = findColumns(r);
    if (c) { rows = r; cols = c; break; }
  }
  if (!cols) return { error: 'No sheet with "Series From" and "Series To" headings was found.' };
  const M = cols.map, get = (row, k) => (M[k] === undefined ? '' : row[M[k]]);
  const offs = officersOf(refs, f, lguId);
  const known = new Map(offs.map((o) => [nameKey(o.name), o]));
  const newOff = new Map();
  const taken = f.booklets.filter((b) => b.form === form);
  const plan = { add: [], same: [], problems: [], newOfficers: [] };
  for (let i = cols.header + 1; i < rows.length; i++) {
    const row = rows[i], line = i + 1;
    const a = int(get(row, 'from')), z = int(get(row, 'to'));
    const nm = String(get(row, 'officer') || '').trim();
    if (!a && !z && !nm) continue;   // empty row
    const issued = excelDate(XLSX, get(row, 'issued')), exh = excelDate(XLSX, get(row, 'exh'));
    const no = String(get(row, 'no') || '').trim();
    const bad = (why) => plan.problems.push({ line, no, text: `${a || '?'} – ${z || '?'}${nm ? ' · ' + nm : ''}`, why });
    if (!a || !z) { bad('Series From or Series To is missing.'); continue; }
    if (z < a) { bad('Series From is after Series To.'); continue; }
    if (z - a + 1 > MAX_PCS) { bad(`${z - a + 1} pieces in one row. Check the series.`); continue; }
    if (issued === null) { bad('Date Issued is not a date.'); continue; }
    if (exh === null) { bad('Date Exhausted is not a date.'); continue; }
    if (nm && !issued) { bad('Date Issued is missing.'); continue; }
    if (exh && !nm) { bad('Exhausted, but no accountable officer.'); continue; }
    if (exh && issued && exh < issued) { bad('Date Exhausted is before Date Issued.'); continue; }
    const same = taken.find((b) => b.from === a && b.to === z);
    if (same) { plan.same.push({ line, no, text: rangeText(a, z) }); continue; }
    const hit = taken.find((b) => b.from <= z && a <= b.to);
    if (hit) { bad(`Overlaps ${rangeText(hit.from, hit.to)}${hit.lguId !== lguId ? ' in another register' : ''}.`); continue; }
    let officerKey = '';
    if (nm) {
      officerKey = nameKey(nm);
      if (!known.has(officerKey) && !newOff.has(officerKey)) newOff.set(officerKey, { id: newId('cero'), name: officerKey, designation: String(get(row, 'position') || '').trim(), agency: String(get(row, 'agency') || '').trim() });
    }
    const item = { line, no, from: a, to: z, issued, exh, officerKey };
    plan.add.push(item);
    taken.push({ form, from: a, to: z, lguId });   // a repeated row later in the file counts as already added
  }
  plan.newOfficers = [...newOff.values()];
  plan.officerOf = (k) => known.get(k) || newOff.get(k) || null;
  return plan;
}

async function importModal(refs, f, lguId) {
  let plan = null, XLSX = null;
  const lgu = refs.lgu[lguId];
  const go2 = await modal({ title: 'Import from Excel', wide: true,
    body: `<p class="hint" style="margin:0">Forms Register of <b>${esc(agencyName(refs, lgu))}</b>. One row per booklet. Booklets already in the register are skipped, so the same file can be imported again after new rows are added.</p>
      <div class="two">
        <div class="field"><label for="i-form">Form Type</label><select class="input" id="i-form">${FORMS.map(([k, l]) => `<option value="${k}" ${k === LAST.form ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
        <div class="field"><label for="i-file">Excel file (.xlsx, .xls or .csv)</label><input class="input" type="file" id="i-file" accept=".xlsx,.xls,.csv"></div>
      </div>
      <p class="hint" style="margin:0">Headings read: Date Issued, Series From, Series To, Accountable Officer, Agency, Position, and if present Date Exhausted (Exh) and No. A row without an officer is in stock.</p>
      <div id="i-prev"></div>`,
    onOpen: (bg) => {
      const fileIn = $('#i-file', bg), formIn = $('#i-form', bg), prev = $('#i-prev', bg);
      const run = async () => {
        plan = null;
        const file = fileIn.files[0]; if (!file) { prev.innerHTML = ''; return; }
        prev.innerHTML = '<p class="hint">Reading the file…</p>';
        try {
          XLSX = await loadXlsx();
          const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
          plan = planImport(XLSX, wb, f, refs, lguId, formIn.value);
          prev.innerHTML = previewHtml(plan, formIn.value);
        } catch (e) { prev.innerHTML = `<div class="msg bad">${esc(e.message || e)}</div>`; }
      };
      fileIn.onchange = run; formIn.onchange = run;
    },
    buttons: [{ label: 'Cancel', value: null }, { label: 'Import New Booklets', cls: 'primary', value: 'go', check: () => {
      if (!plan || plan.error) { toast('Choose the Excel file first.', 'bad'); return false; }
      if (!plan.add.length) { toast('Nothing new to import.', 'bad'); return false; }
      return true;
    } }] });
  if (go2 !== 'go' || !plan) return;
  toast(`Importing ${plan.add.length} booklets…`);
  for (const o of plan.newOfficers) await store.save('cer_officers', o.id, { lguId, name: o.name, designation: o.designation, agency: o.agency }, by(refs), { quiet: true });
  const asOf = today();
  for (const it of plan.add) {
    const o = it.officerKey ? plan.officerOf(it.officerKey) : null;
    const note = `Excel row ${it.line}${it.no ? ' · logbook No. ' + it.no : ''}`;
    const history = o ? [hist(refs, 'imported', it.issued, { officerId: o.id, note })] : [hist(refs, 'starting', it.issued || asOf, { note })];
    if (o && it.exh) history.push(hist(refs, 'exhausted', it.exh, { officerId: o.id }));
    await store.save('cer_booklets', newId('cerb'), { lguId, form: plan.form || LAST.form, from: it.from, to: it.to, qty: it.to - it.from + 1, receivedDate: '', receivedFrom: '', reference: '',
      source: 'import', status: o ? 'issued' : 'stock', officerId: o ? o.id : '', issuedDate: o ? it.issued : '', usedBefore: null, exhaustedDate: o ? it.exh : '', history }, by(refs), { quiet: true });
  }
  emitChange('local');
  toast(`${plan.add.length} booklet${plan.add.length > 1 ? 's' : ''} imported${plan.newOfficers.length ? `, ${plan.newOfficers.length} new officer${plan.newOfficers.length > 1 ? 's' : ''} added` : ''}. ${plan.same.length ? `${plan.same.length} already in the register ${plan.same.length > 1 ? 'were' : 'was'} skipped.` : ''}`, 'ok');
}
function previewHtml(plan, form) {
  if (plan.error) return `<div class="msg bad">${esc(plan.error)}</div>`;
  plan.form = form;
  const iss = plan.add.filter((x) => x.officerKey && !x.exh).length, exh = plan.add.filter((x) => x.exh).length, stk = plan.add.filter((x) => !x.officerKey).length;
  return `<div class="af-imp">
      <div><b>${plan.add.length}</b><span>new booklets to import</span><small>${iss} issued · ${exh} exhausted · ${stk} in stock</small></div>
      <div><b>${plan.same.length}</b><span>already in the register</span><small>or repeated in the file · skipped</small></div>
      <div><b>${plan.newOfficers.length}</b><span>new officers</span><small>added to this LGU</small></div>
      <div class="${plan.problems.length ? 'warn' : ''}"><b>${plan.problems.length}</b><span>rows not imported</span><small>listed below</small></div>
    </div>
    ${plan.newOfficers.length ? `<p class="hint" style="margin:0"><b>New officers:</b> ${plan.newOfficers.map((o) => esc(o.name) + (o.designation ? ` (${esc(o.designation)})` : '')).join(', ')}</p>` : ''}
    ${plan.problems.length ? `<div class="af-probs"><b>Rows not imported</b>${plan.problems.slice(0, 50).map((p) => `<div>Row ${p.line}${p.no ? ` · No. ${esc(p.no)}` : ''} · ${esc(p.text)} — ${esc(p.why)}</div>`).join('')}${plan.problems.length > 50 ? `<div>…and ${plan.problems.length - 50} more</div>` : ''}</div>` : ''}`;
}
