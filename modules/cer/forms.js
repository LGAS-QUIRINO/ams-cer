// CER · Accountable Forms (design approved 18 Oct 2026).
// One Forms Register per custodian LGU (municipality or province). Each booklet is encoded once, from receipt by the custodian
// to its last number used; barangay treasurers' booklets come from their municipality's register.
//
// Records:
//   cer_booklets   one booklet or pad   { lguId (custodian LGU), form, from, to, qty, receivedDate, receivedFrom, reference, source,
//                                          status: 'stock' | 'issued' | 'lost', officerId, issuedDate, usedBefore, history[] }
//   cer_formcheck  Physical Check of one booklet at one cash examination   id = examId|bookletId   { examId, bookletId, seen, unusedFrom, unusedTo }
//   cer_raaf       the custodian's RAAF for a month and form             id = lguId|YYYY-MM|form   { lguId, month, form, beg, rec, iss, end, receivedDate }
import { store, newId, emitChange } from '../../js/store.js';
import { esc, modal, toast, $, $$ } from '../../js/ui.js';
import { FORMS, FORM_NAME, hasRole, isAuditor, by, mayView, agencyName, fmtDate, loadCer } from './cer.js';

export const FORM_SHORT = { af51: 'Accountable Form 51 – LGU', af51b: 'Accountable Form 51 – Barangay', ctci: 'CTC – Individual', ctcc: 'CTC – Corporate',
  af52: 'AF 52 – Transfer of Large Cattle', af53: 'AF 53 – Ownership of Large Cattle', af54: 'AF 54 – Marriage License', af56: 'AF 56', cash: 'Cash Tickets', chk: 'Checks' };
// Accountable forms with money value: face value per piece by default (a booklet may carry another denomination, set with Edit).
export const FACE = { af52: 10, af53: 5, af54: 2, cash: 5 };
export const faceOf = (b) => { const v = b && b.faceValue !== undefined && b.faceValue !== null && b.faceValue !== '' ? b.faceValue : FACE[b && b.form]; return v ? Number(v) : 0; };
const peso = (n) => '₱' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Cash tickets without serial numbers are counted by quantity. Each lot is stored on its own block of internal numbers
// (never shown), so the usual arithmetic (used, unused, RAAF) still works by count.
const NS_MAX = 20000, NS_STEP = 20000;
let nsLast = 0;
function nsBase() { let b = (Date.now() - 1.7e12) * NS_STEP; if (b <= nsLast) b = nsLast + NS_STEP; nsLast = b; return b; }
const serialText = (b) => (b.noSerial ? 'No serial' : rangeText(b.from, b.to));
const rt = (b, rs) => (b && b.noSerial ? `${countRanges(rs)} pcs` : rangesText(rs));
// The partly-used box for a lot without serials holds a number of pieces: unused (or used) pieces of the lot [a, z].
function nsUnused(pv, a, z) {
  const q = int(pv.text); const n = z - a + 1;
  if (q === null || q > n) return { error: `Type the number of ${pv.mode} pieces (0 to ${n}).` };
  const un = pv.mode === 'used' ? n - q : q;
  return { unused: un ? [[a, a + un - 1]] : [] };
}
// Accountable forms kept in the register: the collecting forms plus checkbooks (received directly by the officer from the bank).
const AF_FORMS = [...FORMS, ['chk', 'Checks']];
const custOf = (l) => (l && l.data.kind === 'province' ? 'PTO' : 'MTO');   // the custodian's office
const RECEIVED_FROM = ['Provincial Treasurer', 'National Printing Office', 'Bank', 'Others'];
// Received From is a flexible list kept per LGU register: the two usual suppliers, plus any source added with "+ Add source…".
const DEF_SRC = ['Provincial Treasurer', 'National Printing Office'];
const srcList = (f, lguId) => [...new Set([...DEF_SRC, ...(f.settings['srcs|' + lguId]?.list || [])])];
const ADD_SRC = '__add';
// Options of a Received From dropdown. extra: options put first (e.g. the custodian); cur: a saved value kept even if not in the list.
function srcOptions(f, lguId, { extra = [], cur = '', bank = false, direct = false } = {}) {
  const list = [...srcList(f, lguId), ...(bank ? ['Bank'] : [])];
  if (cur && !list.includes(cur) && !extra.some(([v]) => v === cur)) list.push(cur);
  return extra.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('')
    + list.map((x) => `<option value="${esc(x)}" ${x === cur ? 'selected' : ''}>${esc(x)}${direct ? ' (direct)' : ''}</option>`).join('')
    + `<option value="${ADD_SRC}">+ Add source…</option>`;
}
// "+ Add source…": asks for the name, keeps it in the register's list, and selects it.
function wireSrcSelect(sel, refs, f, lguId, after, direct = false) {
  if (!sel) return;
  let prev = sel.value === ADD_SRC ? '' : sel.value;
  sel.addEventListener('change', async () => {
    if (sel.value !== ADD_SRC) { prev = sel.value; if (after) after(); return; }
    let name = '';
    await modal({ title: 'Add a Source', body: '<div class="field"><label for="ns-name">Received From</label><input class="input" id="ns-name" placeholder="e.g. Department of Agriculture" autocomplete="off"></div><p class="af-note">Kept in this LGU\'s list for the next entries.</p>',
      buttons: [{ label: 'Cancel', value: null }, { label: 'Add', cls: 'primary', value: 'ok', check: (bg) => { name = $('#ns-name', bg).value.trim().replace(/\s+/g, ' '); if (!name) { toast('Type the source.', 'bad'); return false; } return true; } }] });
    if (!name) { sel.value = prev; return; }
    const have = srcList(f, lguId).find((x) => x.toUpperCase() === name.toUpperCase());
    if (!have) {
      const list = [...(f.settings['srcs|' + lguId]?.list || []), name];
      f.settings['srcs|' + lguId] = { list };
      await store.save('cer_settings', 'srcs|' + lguId, { list }, by(refs), { quiet: true });
      const o = document.createElement('option'); o.value = name; o.textContent = name + (direct ? ' (direct)' : '');
      sel.insertBefore(o, sel.querySelector(`option[value="${ADD_SRC}"]`));
    }
    sel.value = have || name; prev = sel.value; if (after) after();
  });
}
const DEFAULT_FUNDS = ['General Fund'];
// Each register keeps its own fund list (starts with General Fund; Add Fund for the others). A fund already used stays listed.
const fundsOf = (f, lguId) => f.settings['funds|' + lguId]?.list || [...new Set([...DEFAULT_FUNDS, ...(f.booklets || []).filter((b) => b.lguId === lguId && b.fund).map((b) => b.fund)])];
// Checkbooks come from the bank straight to the disbursing officer, so by default they are the AOs' only and stay out of the
// custodian's register (entered per officer with Add Checkbook). Ticked: the custodian controls the checks like other forms.
const chkByCustodian = (f, lguId) => !!f.settings['chkctl|' + lguId]?.on;
const formsFor = (f, lguId) => (chkByCustodian(f, lguId) ? AF_FORMS : AF_FORMS.filter(([k]) => k !== 'chk'));
const chkLabel = (b) => `${esc(FORM_SHORT[b.form] || b.form)}${b.form === 'chk' && b.bankAccount ? `<small>${esc(b.bankAccount)}</small>` : ''}`;
const fundOpts = (f, lguId, sel = '') => `<option value="">No fund indicated</option>${fundsOf(f, lguId).map((x) => `<option ${x === sel ? 'selected' : ''}>${esc(x)}</option>`).join('')}`;
const PER_BOOKLET = 50;
const MAX_PCS = 50000;   // one entry covers at most this many pieces; a longer range is likely a typing mistake
const BIG_PCS = 5000;    // above this, the encoder confirms the range before it is saved
// Asks before saving a large range (a wrong digit in Serial To would add thousands of booklets).
async function confirmBig(form, a, z, n) {
  const pcs = z - a + 1;
  if (pcs <= BIG_PCS) return true;
  const v = await modal({ title: 'Check the range',
    body: `<p>This will add <b>${n.toLocaleString('en-US')} booklets (${pcs.toLocaleString('en-US')} pcs)</b> of ${esc(FORM_SHORT[form] || form)}, ${a} – ${z}.</p><p>Is the range correct?</p>`,
    buttons: [{ label: 'Go Back', value: null }, { label: 'Yes, Save', cls: 'primary', value: 'yes' }] });
  return v === 'yes';
}
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
export function skippedOf(b) {
  if (b.noSerial) return [];
  const un = rawUnused(b); if (!un.length || usedOf(b) === 0) return [];
  let last = b.to;   // highest used number
  for (const [a, z] of un.slice().sort((x, y) => y[0] - x[0])) { if (z === last) last = a - 1; else break; }
  return un.filter(([a]) => a < last).map(([a, z]) => [a, Math.min(z, last)]);
}
// Reads "7311510, 7311516-7311550" into ranges inside the booklet. Returns { ranges } or { error }.
// where: how the error names the allowed span ('the booklet' or 'the range entered').
function parseRanges(text, from, to, where = 'the booklet') {
  const t = String(text ?? '').trim();
  if (!t) return { ranges: [] };
  const out = [];
  for (const part of t.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d+)\s*(?:[-–—]|to)\s*(\d+)$/i.exec(part) || /^(\d+)$/.exec(part);
    if (!m) return { error: `"${part}" is not a number or a range.` };
    const a = +m[1], z = m[2] ? +m[2] : a;
    if (z < a) return { error: `${part}: From is after To.` };
    if (a < from || z > to) return { error: `${part} is outside ${where} ${from} – ${to}.` };
    out.push([a, z]);
  }
  out.sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < out.length; i++) if (out[i][0] <= out[i - 1][1]) return { error: 'The numbers typed overlap.' };
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
const unusedCell = (b) => { const rs = unusedRanges(b), n = countRanges(rs), fv = faceOf(b);
  const amt = fv && n ? ` <span class="af-amt">${peso(n * fv)}</span>` : '';
  if (!rs.length) return '<span class="dim">None</span>';
  return b.noSerial ? `${n} pcs${amt}` : `${rangesText(rs)} <span class="dim">(${n})</span>${amt}`; };
const held = (b) => b.status === 'issued' && statusOf(b).key !== 'done';
const daysWithAo = (b, asOf) => (held(b) && b.issuedDate ? Math.max(0, days(b.issuedDate, asOf)) : null);
// Beginning booklets keep a tag for good, even after the real dates are edited in: whose beginning, and as of when.
//   custodian: the custodian's starting inventory (his stock as of his cut-off)
//   ao:        an AO's beginning (forms already in the AO's hands as of the AO's cut-off / last cash exam)
function beginOf(b) {
  if (b.beginAs) return { as: b.beginAs, date: b.beginDate || '' };
  if (b.source !== 'starting') return null;
  const h = (b.history || []).find((x) => x.action === 'starting');
  return h ? { as: h.officerId ? 'ao' : 'custodian', date: h.date } : null;
}
const begTag = (b) => { const g = beginOf(b); return g ? `<span class="af-tag ${g.as}">${g.as === 'ao' ? 'AO\'s beginning' : 'Starting inventory (custodian)'}${g.date ? ' · as of ' + esc(fmtDate(g.date)) : ''}</span>` : ''; };
// The real date issued is not known for a beginning booklet until it is edited in: the days are "at least" since the cut-off.
const daysText = (b, d) => (d === null || d === undefined ? '<span class="dim">—</span>' : b.issuedAsOf ? `≥ ${d}` : `${d}`);
// short: the register, where the beginning tag already shows the as-of date.
const issuedText = (b, short) => (b.issuedAsOf ? `<span class="dim af-nw">Not yet known</span>${short ? '' : `<small>on hand as of ${esc(fmtDate(b.issuedDate))}</small>`}` : esc(fmtDate(b.issuedDate)));
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
  return f.booklets.filter((b) => b.id !== skipId && !b.noSerial && b.form === form && b.from <= to && from <= b.to);
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
  const offs = officersOf(refs, f, lguId);
  const ctl = chkByCustodian(f, lguId);
  const allHere = f.booklets.filter((b) => b.lguId === lguId);
  const mine = ctl ? allHere : allHere.filter((b) => b.form !== 'chk');
  // Checkbooks put in the custodian's stock before checks were taken out of his register: to be issued to their officer or deleted.
  const strayChk = ctl ? [] : allHere.filter((b) => b.form === 'chk' && b.status === 'stock');
  const oos = outOfSequence({ booklets: mine });
  const fForm = q.get('form') || '', fCust = q.get('cust') || '', fStat = q.get('st') || 'open', sort = q.get('sort') || 'serial';   // series order by default, so a gap in the issued series is easy to see
  let rows = mine.filter((b) => (!fForm || b.form === fForm)
    && (!fCust || (fCust === 'stock' ? b.status === 'stock' : fCust === 'direct' ? !!b.receivedDirect : b.officerId === fCust))
    && (fStat === 'all' || (fStat === 'open' ? statusOf(b).key !== 'done' : statusOf(b).key === fStat)));
  rows.sort(sort === 'days' ? (a, b) => (daysWithAo(b, asOf) ?? -1) - (daysWithAo(a, asOf) ?? -1) || a.form.localeCompare(b.form) || a.from - b.from
    : (a, b) => a.form.localeCompare(b.form) || a.from - b.from);
  const stock = mine.filter((b) => b.status === 'stock');
  const withAo = mine.filter(held);
  const done = mine.filter((b) => statusOf(b).key === 'done');
  const skipped = mine.filter(held).filter((b) => skippedOf(b).length);
  const forCheck = new Set([...oos, ...skipped.map((b) => b.id)]);
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
      <div class="field af-span2"><label for="af-find">Find a Serial No.</label><div class="af-pair af-findbox"><input class="input mono" id="af-find" inputmode="numeric" placeholder="e.g. 7311510" autocomplete="off"><button class="btn" type="button" id="af-findgo">Find</button></div></div>
    </div>
    <div id="af-found" aria-live="polite"></div>
    ${strayChk.length ? `<div class="msg warn af-stray"><b>${strayChk.length} checkbook${strayChk.length > 1 ? 's are' : ' is'} in the custodian's stock from earlier entries.</b>
      Checks are not controlled by the custodian, so they are kept out of this register. Open each one to Issue it to its officer, or Delete it and enter it with Add Checkbook in By Accountable Officer.
      <div class="af-straylist">${strayChk.sort((a, b) => a.from - b.from).map((b) => `<button class="btn sm" type="button" data-open="${esc(b.id)}">Checks ${serialText(b)}</button>`).join('')}</div></div>` : ''}

    <div class="stats">
      <div class="stat"><span>In Stock · Custodian</span><b>${stock.length}</b><small>booklets · ${stock.reduce((n, b) => n + b.qty, 0)} pcs</small></div>
      <div class="stat"><span>With Accountable Officers</span><b style="color:#1d4fb8">${withAo.length}</b><small>booklets · ${withAo.reduce((n, b) => n + unusedOf(b), 0)} unused pcs</small></div>
      <div class="stat"><span>Exhausted</span><b style="color:var(--ok)">${done.length}</b><small>every number used or cancelled</small></div>
      <div class="stat"><span>For Checking</span><b class="${forCheck.size ? 'warn' : 'dim'}">${forCheck.size}</b><small>out of sequence, skipped numbers</small></div>
    </div>

    ${enc ? encodeHtml(refs, Object.assign(offs, { lguId, f }), q) : ''}

    <section class="panel" aria-labelledby="reg-h">
      <div class="panel-head"><h2 id="reg-h">Forms Register</h2><span class="pill">${rows.length}</span>
        <div class="af-filters">
          ${pick('form', [['', 'All form types'], ...formsFor(f, lguId).filter(([k]) => formsUsed.includes(k)).map(([k]) => [k, FORM_SHORT[k]])], fForm)}
          ${pick('cust', [['', 'All custody'], ['stock', 'In stock (custodian)'], ['direct', 'Received directly by an AO'], ...offs.map((o) => [o.id, o.name])], fCust)}
          ${pick('st', [['open', 'Not exhausted'], ['all', 'All statuses'], ['stock', 'In stock'], ['new', 'Issued, not yet used'], ['part', 'Partly used'], ['done', 'Exhausted'], ['lost', 'Lost / Destroyed']], fStat)}
          ${pick('sort', [['serial', 'By form and serial'], ['days', 'Longest with AO first']], sort)}
        </div></div>
      ${rows.length ? `<div class="af-tbl"><table class="af-reg">
        <thead><tr><th scope="col">Form</th><th scope="col">Serial Range</th><th scope="col" class="r">Qty</th><th scope="col">Received</th><th scope="col">Custody</th><th scope="col">Issued</th><th scope="col" class="r">Days with AO</th><th scope="col" class="r">Used</th><th scope="col">Unused</th><th scope="col">Status</th></tr></thead>
        <tbody>${rows.map((b) => {
          const o = f.officers.find((x) => x.id === b.officerId); const st = statusOf(b); const d = daysWithAo(b, asOf); const sk = skippedOf(b);
          const flagSeq = oos.has(b.id);
          return `<tr class="${flagSeq ? 'flag' : ''}" data-bk="${esc(b.id)}" tabindex="0">
            <td>${chkLabel(b)}</td><td class="mono">${serialText(b)}</td><td class="r">${b.qty}</td>
            <td>${b.receivedDate ? esc(fmtDate(b.receivedDate)) : '<span class="dim">—</span>'}<small>${b.receivedDirect ? `<b class="af-direct">Received directly</b> · ` : ''}${esc(b.receivedFrom || (b.source === 'logbook' ? 'From the barangay logbook' : b.source === 'import' ? 'Imported from Excel' : ''))}</small>${begTag(b)}</td>
            <td>${b.status === 'issued' && o ? `<b>${esc(o.name)}</b><small>${esc([o.designation, agencyName(refs, refs.lgu[o.lguId])].filter(Boolean).join(' · '))}</small>` : b.status === 'lost' ? '<span class="dim">—</span>' : `In stock<small>Custodian (${custOf(lgu)})</small>`}</td>
            <td>${b.status !== 'stock' && b.issuedDate ? issuedText(b, true) : '<span class="dim">—</span>'}</td>
            <td class="r">${d === null ? '<span class="dim">—</span>' : `<b>${daysText(b, d)}</b>`}</td>
            <td class="r">${usedOf(b)}</td>
            <td class="mono">${unusedCell(b)}</td>
            <td><span class="pill ${st.cls}">${st.label}</span>${flagSeq ? '<br><span class="pill p-flag">Out of sequence</span>' : ''}${sk.length ? '<br><span class="pill p-flag">Skipped numbers</span>' : ''}</td></tr>`;
        }).join('')}</tbody></table></div>
        <p class="af-note">Click a booklet to see its history and to Issue, Transfer, Return or report it Lost.</p>`
      : `<div class="empty"><b>${mine.length ? 'No booklet matches these filters.' : 'No booklets in this register yet.'}</b>${mine.length ? '' : 'Encode the custodian\'s booklets with <b>Receive</b>, or the forms already out with <b>Starting Inventory</b>.'}</div>`}
    </section>

    <section class="panel" aria-labelledby="res-h">
      <div class="panel-head"><h2 id="res-h">Forms Control Results</h2></div>
      <div class="af-res">
        ${result(oos.size ? 'warn' : 'ok', oos.size ? `Out-of-sequence use · ${oos.size}` : 'No out-of-sequence use',
          oos.size ? [...oos].map((id) => { const b = mine.find((x) => x.id === id); const o = f.officers.find((x) => x.id === b.officerId); return `${esc(o ? o.name : 'An officer')} used ${FORM_SHORT[b.form]} ${serialText(b)} while an earlier booklet still has unused numbers.`; }).join('<br>') : 'Each officer uses the earlier booklet of a form before starting the next.')}
        ${result(skipped.length ? 'warn' : 'ok', skipped.length ? `Skipped numbers between used ORs · ${skipped.reduce((n, b) => n + countRanges(skippedOf(b)), 0)}` : 'No skipped numbers between used ORs',
          skipped.length ? skipped.map((b) => `${esc(f.officers.find((o) => o.id === b.officerId)?.name || '')}, ${FORM_SHORT[b.form]} ${serialText(b)}: ${rangesText(skippedOf(b))}`).join('<br>') + '<br>Confirm each at the Physical Check: on hand, cancelled, or not on hand.' : 'Unused numbers come after the last number used in each booklet.')}
        ${result(overlapCount(mine) ? 'warn' : 'ok', overlapCount(mine) ? `Overlapping serial ranges · ${overlapCount(mine)}` : 'No overlapping serial ranges', 'No number may appear in two booklets.')}
        ${result('info', longest ? `Longest with an AO · ${longest.issuedAsOf ? '≥ ' : ''}${daysWithAo(longest, asOf)} days` : 'No booklet with an AO', longest ? `${esc(f.officers.find((o) => o.id === longest.officerId)?.name || '')}, ${FORM_SHORT[longest.form]} ${rangeText(longest.from, longest.to)}, ${longest.issuedAsOf ? 'on hand as of' : 'issued'} ${esc(fmtDate(longest.issuedDate))}.` : 'Issue booklets to the accountable officers to start counting.')}
        ${result('info', `${withAo.reduce((n, b) => n + unusedOf(b), 0)} unused forms with AOs`, 'To be confirmed in each officer\'s Physical Check at the cash count.')}
        ${result(wrong.length ? 'warn' : 'ok', wrong.length ? `Receipts used by another officer · ${wrong.length}` : 'No receipt used by another officer',
          wrong.length ? wrong.slice(0, 12).map((x) => `${esc(f.officers.find((o) => o.id === x.officerId)?.name || '')} encoded ${FORM_SHORT[x.form] || x.form} ${x.serial}, in a booklet ${x.bk.status === 'issued' ? 'issued to ' + esc(f.officers.find((o) => o.id === x.bk.officerId)?.name || 'another officer') : 'not issued to anyone'}.`).join('<br>') + (wrong.length > 12 ? '<br>…' : '') : 'Every receipt encoded in Collections is in a booklet issued to the officer who used it.')}
      </div>
    </section>`;
  const exportRows = () => rows.map((b) => { const o = f.officers.find((x) => x.id === b.officerId); const d = daysWithAo(b, asOf);
    return { Form: FORM_SHORT[b.form] || b.form, 'Series From': b.from, 'Series To': b.to, Qty: b.qty, 'Date Received': fmtDate(b.receivedDate), 'Received From': b.receivedFrom || '',
      'Received Directly': b.receivedDirect ? 'Yes' : '', Custody: b.status === 'issued' && o ? o.name : b.status === 'stock' ? `Custodian (${custOf(lgu)})` : '', Designation: b.status === 'issued' && o ? (o.designation || '') : '',
      'Date Issued': b.status !== 'stock' ? (b.issuedAsOf ? 'Not yet known (on hand as of ' + fmtDate(b.issuedDate) + ')' : fmtDate(b.issuedDate)) : '', 'Days with AO': d === null ? '' : (b.issuedAsOf ? '≥ ' + d : d), Beginning: (() => { const g = beginOf(b); return g ? (g.as === 'ao' ? "AO's beginning" : 'Starting inventory (custodian)') + (g.date ? ' as of ' + fmtDate(g.date) : '') : ''; })(), Used: usedOf(b), 'Unused (ranges)': rt(b, unusedRanges(b)), 'Unused Qty': unusedOf(b), 'Unused Amount': faceOf(b) ? unusedOf(b) * faceOf(b) : '',
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
const LAST = { form: 'af51', date: '', src: RECEIVED_FROM[0], off: '', per: PER_BOOKLET, rby: 'custodian', held: 'custodian' };
// The "Partly used" box: one tick, Unused or Used numbers, one text box (used in Starting Inventory and Edit).
const partBox = (pre, { on = false, mode = 'unused', text = '', note = '' } = {}) => `
  <div class="af-part">
    <label class="cer-chip"><input type="checkbox" id="${pre}-part" ${on ? 'checked' : ''}> ${note || 'Partly used booklets'}</label>
    <div class="af-partbox" id="${pre}-partbox" ${on ? '' : 'hidden'}>
      <div class="af-pmode" role="radiogroup" aria-label="Numbers typed"><span>I'm typing:</span>
        <label class="cer-chip"><input type="radio" name="${pre}-pmode" value="unused" ${mode === 'unused' ? 'checked' : ''}> Unused numbers</label>
        <label class="cer-chip"><input type="radio" name="${pre}-pmode" value="used" ${mode === 'used' ? 'checked' : ''}> Used numbers</label></div>
      <input class="input mono" id="${pre}-nums" value="${esc(text)}" autocomplete="off" placeholder="e.g. 1894906-1894909, 1894911, 1894913-1895000" aria-label="Numbers">
      <small class="af-note">Ranges or single numbers, separated by commas.</small>
    </div>
  </div>`;
const partVals = (pre, root = document) => ({ on: !!$(`#${pre}-part`, root)?.checked, mode: $(`input[name="${pre}-pmode"]:checked`, root)?.value || 'unused', text: $(`#${pre}-nums`, root)?.value || '' });
function wirePart(pre, root, onChange) {
  const tick = $(`#${pre}-part`, root); if (!tick) return;
  const sync = () => { $(`#${pre}-partbox`, root).hidden = !tick.checked; onChange && onChange(); };
  tick.onchange = sync;
  $$(`input[name="${pre}-pmode"]`, root).forEach((r) => { r.onchange = () => onChange && onChange(); });
  $(`#${pre}-nums`, root).oninput = () => onChange && onChange();
}
const sel = (a, b) => (a === b ? 'selected' : '');
function encodeHtml(refs, offs, q) {
  const mv = MOVES.some(([k]) => k === q.get('mv')) ? q.get('mv') : 'receive';
  const ctl = chkByCustodian(offs.f, offs.lguId);
  const formSel = `<div class="field"><label for="e-form">Form Type</label><select class="input" id="e-form">${formsFor(offs.f, offs.lguId).map(([k, l]) => `<option value="${k}" ${sel(k, LAST.form)}>${esc(l)}</option>`).join('')}</select></div>`;
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
      <div class="field"><label for="e-src">Received From</label><select class="input" id="e-src">${srcOptions(offs.f, offs.lguId, { cur: LAST.src, bank: chkByCustodian(offs.f, offs.lguId) })}</select></div>
      <div class="field"><label for="e-ref">Reference (optional)</label><input class="input" id="e-ref" placeholder="e.g. RIS No."></div>
      <button class="btn primary" type="button" id="e-enter">Enter</button></div>`;
  if (mv === 'issue') fields = `<div class="af-enc g6">${formSel}${range}${offSel('e-off', 'Issued To')}
      <div class="field"><label for="e-date">Date Issued</label><input class="input" type="date" id="e-date" value="${esc(LAST.date)}"></div>
      <button class="btn primary" type="button" id="e-enter">Enter</button></div>`;
  if (mv === 'starting') {
    const offHeld = LAST.held !== 'custodian' && offs.some((o) => o.id === LAST.held);
    fields = `<div class="af-enc g7s">${formSel}${range}${per}
      <div class="field"><label for="e-date">As of</label><input class="input" type="date" id="e-date" value="${esc(LAST.date)}"></div>
      <div class="field"><label for="e-held">Held By</label><select class="input" id="e-held"><option value="custodian">Custodian (${custName}) · in stock</option>
        <optgroup label="Accountable Officer">${offs.map((o) => `<option value="${esc(o.id)}" ${sel(o.id, LAST.held)}>${esc(officerLabel(refs, o))}</option>`).join('')}</optgroup></select></div>
      <button class="btn primary" type="button" id="e-enter">Enter</button></div>
    <div class="af-offrow one" id="e-offrow" ${offHeld ? '' : 'hidden'}>
      ${partBox('e')}
    </div>`;
  }
  const help = mv === 'receive' ? 'The range is split into booklets. Received by the custodian: the booklets go into stock. Received directly by an accountable officer (e.g. a barangay treasurer supplied by the Provincial Treasurer): they go straight into that officer\'s custody and are left out of the custodian\'s RAAF. A serial already in the register is refused, except a booklet first encoded from a logbook: it is matched by serial and gets its receipt details.'
    : mv === 'issue' ? 'Every booklet in stock within the range is issued to the officer. Barangay treasurers are listed with the municipality\'s officers.'
    : 'Booklets on hand on the start date, entered as complete series. Held By the custodian: unissued stock. Held By an accountable officer: booklets already in the officer\'s hands; tick Partly used for the booklets already in use and type their unused (or used) numbers.';
  return `<section class="panel" aria-labelledby="enc-h"><div class="af-encbox">
    <div class="af-headrow"><h2 id="enc-h" class="cer-h2">Encode</h2>
      <div class="af-headr">${mv !== 'starting' ? `<a href="#" class="af-tpl" id="af-tpl">Download ${mv === 'receive' ? 'Receive' : 'Issue'} Template</a><button class="btn" type="button" id="af-import">Import ${mv === 'receive' ? 'Receipts' : 'Issuances'} from Excel</button>` : ''}
      <div class="seg" role="group" aria-label="Movement">${MOVES.map(([k, l]) => `<a href="#" data-mv="${k}" class="${k === mv ? 'on' : ''}" aria-pressed="${k === mv}">${l}</a>`).join('')}</div></div></div>
    ${fields}
    ${mv !== 'issue' ? `<label class="af-chkctl af-nsbox" id="e-nsbox" hidden><input type="checkbox" id="e-ns"> Cash tickets without serial numbers <span class="dim">· counted by quantity: one lot is entered, Serial To becomes the quantity</span></label>` : ''}
    <label class="af-chkctl"><input type="checkbox" id="af-chkctl" ${ctl ? 'checked' : ''} ${isAuditor(refs) ? '' : 'disabled'}> Checks are controlled by the custodian (${custName})
      <span class="dim">${ctl ? '· checkbooks are received and issued here' : '· unticked: checkbooks are entered per officer (By Accountable Officer → Add Checkbook) and kept out of this register'}</span></label>
    <div class="af-note" id="e-help">${esc(help)}</div></div></section>`;
}

function wireRegister(ctx, f, lguId, offs) {
  const { refs } = ctx;
  $('#af-lgu').onchange = (e) => go({ lgu: e.target.value, cust: '' });
  $('#af-asof').onchange = (e) => go({ asof: e.target.value });
  const findIn = $('#af-find');
  const doFind = () => findSerial(ctx, f, lguId, offs, findIn.value);
  $('#af-findgo').onclick = doFind;
  findIn.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); doFind(); } };
  $$('[data-filter]').forEach((s) => { s.onchange = () => go({ [s.dataset.filter]: s.value }); });
  $$('[data-mv]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); go({ mv: a.dataset.mv }); }; });
  const kind = $('.seg a.on')?.dataset.mv === 'receive' ? 'receive' : 'issue';
  const imp = $('#af-import'); if (imp) imp.onclick = () => importModal(refs, f, lguId, kind);
  const tpl = $('#af-tpl'); if (tpl) tpl.onclick = async (e) => { e.preventDefault(); try { await downloadTemplate(kind); } catch (err) { toast(err.message || String(err), 'bad'); } };
  $$('tr[data-bk]').forEach((tr) => {
    const open = () => bookletModal(ctx, f, f.booklets.find((b) => b.id === tr.dataset.bk), offs);
    tr.onclick = open; tr.onkeydown = (e) => { if (e.key === 'Enter') open(); };
  });
  $$('.af-stray [data-open]').forEach((btn) => { btn.onclick = () => bookletModal(ctx, f, f.booklets.find((b) => b.id === btn.dataset.open), offs); });
  const ctlBox = $('#af-chkctl');
  if (ctlBox) ctlBox.onchange = async () => {
    const on = ctlBox.checked;
    const v = await modal({ title: on ? 'Checks controlled by the custodian?' : 'Checks kept by the officers only?',
      body: on ? `<p>Checkbooks will be received into the ${custOf(refs.lgu[lguId])}'s stock and issued to the officers from this register, like the other forms.</p>`
        : '<p>Checkbooks will be kept out of the custodian\'s register. Each officer\'s checkbooks are entered in By Accountable Officer → Add Checkbook.</p>',
      buttons: [{ label: 'Cancel', value: null }, { label: 'Confirm', cls: 'primary', value: 'yes' }] });
    if (v !== 'yes') { ctlBox.checked = !on; return; }
    if (!on && LAST.form === 'chk') LAST.form = 'af51';
    await store.save('cer_settings', 'chkctl|' + lguId, { on }, by(refs));
    toast(on ? 'Checks are now controlled by the custodian.' : 'Checks are now kept by the officers only.', 'ok');
  };
  const enter = $('#e-enter');
  if (!enter) return;
  const mv = $('.seg a.on')?.dataset.mv || 'receive';
  const per = $('#e-per');
  const help = $('#e-help');
  const helpText = help.innerHTML;
  const preview = () => {
    const a = int($('#e-from').value), z = int($('#e-to').value), p = int(per?.value) || PER_BOOKLET;
    if (mv === 'issue') return;
    if (isNs()) { if (!z) { help.innerHTML = helpText; return; }
      if (mv === 'starting') { help.innerHTML = startPreview(startPlan()); return; }
      help.innerHTML = z > NS_MAX ? `<b class="warn-t">One lot takes up to ${NS_MAX.toLocaleString('en-US')} pieces.</b>` : `One lot of <b>${z} cash tickets</b> without serial numbers · ${peso(z * FACE.cash)}.`; return; }
    if (!a || !z || z < a) { help.innerHTML = helpText; return; }
    if (z - a + 1 > MAX_PCS) { help.innerHTML = `<b class="warn-t">That range has ${(z - a + 1).toLocaleString('en-US')} pieces, more than one entry takes (${MAX_PCS.toLocaleString('en-US')}). Check the serial numbers.</b>`; return; }
    if (mv === 'starting') { help.innerHTML = startPreview(startPlan()); return; }
    const parts = splitRange(a, z, p), n = parts.length;
    const mid = bookletOf(a, p)[0] !== a ? ` <b class="warn-t">${a} is in the middle of booklet ${rangeText(...bookletOf(a, p))}; check the serial numbers.</b>` : '';
    help.innerHTML = `Splits into <b>${n} booklet${n > 1 ? 's' : ''}</b>${n <= 4 ? ': ' + parts.map(([x, y]) => rangeText(x, y)).join(', ') : ''}.${mid}`;
  };
  ['#e-from', '#e-to', '#e-per'].forEach((s) => { const el = $(s); if (el) el.oninput = preview; });
  // Cash tickets without serial numbers: only the quantity is typed.
  wireSrcSelect($('#e-src'), refs, f, lguId);
  const nsBox = $('#e-nsbox'), nsTick = $('#e-ns');
  const syncNs = () => { if (!nsBox) return; const cash = $('#e-form').value === 'cash'; nsBox.hidden = !cash; if (!cash) nsTick.checked = false;
    const on = isNs(); $('#e-from').closest('.field').hidden = on; if (per) per.closest('.field').hidden = on;
    $('label[for="e-to"]').textContent = on ? 'Quantity (pcs)' : 'Serial To'; preview(); };
  if (nsBox) { $('#e-form').addEventListener('change', syncNs); nsTick.onchange = syncNs; syncNs(); }
  const heldSel = $('#e-held');
  if (heldSel) heldSel.onchange = () => { $('#e-offrow').hidden = heldSel.value === 'custodian'; preview(); };
  wirePart('e', document, preview);
  $('#e-from').addEventListener('change', () => { const a = int($('#e-from').value), t = $('#e-to'); if (a && !t.value && mv !== 'issue') t.value = a + (int(per?.value) || PER_BOOKLET) - 1; preview(); });
  enter.onclick = async () => {
    enter.disabled = true;
    Object.assign(LAST, { form: $('#e-form').value, date: $('#e-date').value, per: int(per?.value) || LAST.per,
      src: $('#e-src') ? $('#e-src').value : LAST.src, off: $('#e-off') ? $('#e-off').value : LAST.off, rby: $('#e-rby') ? $('#e-rby').value : LAST.rby,
      held: heldSel ? heldSel.value : LAST.held });
    try {
      const ok = mv === 'receive' ? await doReceive(refs, f, lguId) : mv === 'issue' ? await doIssue(refs, f, lguId) : await doStarting(refs, f, lguId);
      if (ok) {
        ['#e-from', '#e-to', '#e-ref', '#e-nums'].forEach((s) => { const el = $(s); if (el) el.value = ''; });
        const tick = $('#e-part'); if (tick && tick.checked) { tick.checked = false; $('#e-partbox').hidden = true; }
        help.innerHTML = helpText;
      }
    } finally { enter.disabled = false; }
  };
}
// Find a Serial No.: the booklet holding the number, who has it, and whether the number is used (and in which SCD / RCD).
async function findSerial(ctx, f, lguId, offs, text) {
  const { refs } = ctx;
  const box = $('#af-found'); $$('tr.af-hit').forEach((tr) => tr.classList.remove('af-hit'));
  const n = int(text);
  if (!n) { box.innerHTML = ''; return; }
  const hits = f.booklets.filter((b) => !b.noSerial && b.from <= n && n <= b.to);
  if (!hits.length) { box.innerHTML = `<div class="af-find bad"><b>${n} is not in any booklet encoded in the app.</b><span>Check the number, or encode its booklet with Receive, Issue or Starting Inventory.</span></div>`; return; }
  const reports = (await store.list('cer_reports')).map((r) => ({ id: r.id, ...r.data }));
  box.innerHTML = hits.map((b) => {
    const o = f.officers.find((x) => x.id === b.officerId);
    const here = b.lguId === lguId;
    const or = f.ors.find((x) => x.bookletId === b.id && x.serial === n);
    const rep = or && or.reportId ? reports.find((r) => r.id === or.reportId) : null;
    const usedBy = or ? f.officers.find((x) => x.id === or.officerId) : null;
    const unused = unusedRanges(b).some(([a, z]) => a <= n && n <= z);
    const state = or ? `<b>${or.status === 'cancelled' ? 'Cancelled' : 'Issued'}</b> on ${esc(fmtDate(or.date))}${or.status === 'cancelled' ? '' : ` · ₱${(or.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`} · by ${esc(usedBy ? usedBy.name : '—')} · ${rep ? `${esc(rep.kind || 'RCD')} No. ${esc(rep.no)}` : 'Not yet reported'}${usedBy && b.officerId !== usedBy.id ? ' · <b class="warn-t">used by another officer</b>' : ''}`
      : b.status === 'stock' ? 'In stock, unused' : b.status === 'lost' ? 'Booklet reported lost / destroyed' : unused ? '<b>Unused</b>' : 'Used (per the issuance record or logbook, not encoded in Collections)';
    const sk = skippedOf(b).some(([a, z]) => a <= n && n <= z);
    return `<div class="af-find"><b>${esc(FORM_SHORT[b.form] || b.form)} ${n}</b>
      <span>Booklet ${serialText(b)} · ${b.status === 'issued' && o ? `with <b>${esc(o.name)}</b>${o.designation ? ', ' + esc(o.designation) : ''} since ${esc(fmtDate(b.issuedDate))}` : b.status === 'stock' ? `in stock with the custodian (${custOf(refs.lgu[b.lguId])})` : 'lost / destroyed'}${here ? '' : ` · in the register of ${esc(agencyName(refs, refs.lgu[b.lguId]))}`}</span>
      <span>Number: ${state}${sk ? ' · <b class="warn-t">skipped</b> (unused between used numbers)' : ''}</span>
      <span class="af-findbtns">${here ? `<button class="btn sm" type="button" data-open="${esc(b.id)}">Open booklet</button>` : `<a class="btn sm" href="#/cer/forms?lgu=${esc(b.lguId)}">Go to that register</a>`}</span></div>`;
  }).join('');
  $$('[data-open]', box).forEach((btn) => { btn.onclick = () => bookletModal(ctx, f, f.booklets.find((b) => b.id === btn.dataset.open), offs); });
  const row = $(`tr[data-bk="${hits[0].id}"]`);
  if (row) { row.classList.add('af-hit'); row.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  else if (hits[0].lguId === lguId) box.insertAdjacentHTML('beforeend', '<p class="af-note">The booklet is hidden by the register filters. <a href="#" id="af-clearf">Show all booklets</a></p>');
  const cl = $('#af-clearf'); if (cl) cl.onclick = (e) => { e.preventDefault(); go({ form: '', cust: '', st: 'all' }); };
}
// Booklets follow their printed numbering: at 100 per booklet they run …01 – …00 (e.g. 1895001 – 1895100),
// so a range that starts mid-booklet is cut at the booklet's real end, not 100 numbers after the first one typed.
const bookletOf = (n, p) => { const s = n - ((n - 1) % p); return [s, s + p - 1]; };
function splitRange(a, z, p) { const out = []; for (let x = a; x <= z;) { const y = Math.min(z, bookletOf(x, p)[1]); out.push([x, y]); x = y + 1; } return out; }
const intersect = (rs, a, z) => rs.filter(([x, y]) => y >= a && x <= z).map(([x, y]) => [Math.max(x, a), Math.min(y, z)]);
// Unused numbers of one booklet from what was typed: the unused numbers, or the used ones (the rest is unused).
// null = not mentioned, the whole booklet is unused.
function unusedFromTyped(ranges, mode, a, z) {
  const ins = intersect(ranges, a, z);
  if (!ins.length) return null;
  return mode === 'used' ? subtractRanges([[a, z]], ins) : ins;
}
const hist = (refs, action, date, extra = {}) => ({ action, date, by: by(refs), at: new Date().toISOString(), ...extra });
const bad = (m) => { toast(m, 'bad'); return false; };

const isNs = () => !!$('#e-ns')?.checked && $('#e-form')?.value === 'cash';
// Receive a lot of cash tickets without serial numbers.
async function doReceiveNs(refs, f, lguId) {
  const q = int($('#e-to').value), date = $('#e-date').value;
  if (!q) return bad('Enter the quantity of cash tickets.');
  if (q > NS_MAX) return bad(`One lot takes up to ${NS_MAX.toLocaleString('en-US')} pieces.`);
  if (!date) return bad('Enter the date received.');
  const rby = $('#e-rby').value;
  const officer = rby !== 'custodian' ? f.officers.find((o) => o.id === rby) : null;
  if (rby !== 'custodian' && !officer) return bad('Choose who received the cash tickets.');
  const base = nsBase();
  const info = { receivedDate: date, receivedFrom: $('#e-src').value, reference: $('#e-ref').value.trim(), receivedDirect: !!officer };
  await store.save('cer_booklets', newId('cerb'), { lguId, form: 'cash', noSerial: true, from: base, to: base + q - 1, qty: q, ...info, usedBefore: null,
    ...(officer ? { source: 'direct', status: 'issued', officerId: officer.id, issuedDate: date, history: [hist(refs, 'direct', date, { officerId: officer.id, note: `${q} cash tickets without serial numbers · ${info.receivedFrom}` })] }
      : { source: 'received', status: 'stock', officerId: '', issuedDate: '', history: [hist(refs, 'received', date, { note: `${q} cash tickets without serial numbers · ${info.receivedFrom}` })] }) }, by(refs));
  toast(`${q} cash tickets received${officer ? ' directly by ' + officer.name : ''}.`, 'ok');
  return true;
}
async function doReceive(refs, f, lguId) {
  if (isNs()) return doReceiveNs(refs, f, lguId);
  const form = $('#e-form').value, a = int($('#e-from').value), z = int($('#e-to').value), p = int($('#e-per').value) || PER_BOOKLET, date = $('#e-date').value;
  if (!a || !z || z < a) return bad('Enter the serial range (From must not be after To).');
  if (z - a + 1 > MAX_PCS) return bad(`That range has ${z - a + 1} pieces. Check the serial numbers (one entry takes up to ${MAX_PCS.toLocaleString('en-US')}).`);
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
  if (!(await confirmBig(form, a, z, plan.length))) return false;
  const info = { receivedDate: date, receivedFrom: $('#e-src').value, reference: $('#e-ref').value.trim(), receivedDirect: !!officer };
  for (const s of plan) {
    if (s.match) {
      const b = s.match;
      if (officer && b.officerId && b.officerId !== officer.id) return bad(`${serialText(b)} is recorded with another officer. Check the logbook entry first.`);
      if (officer && b.issuedDate && b.issuedDate < date) return bad(`${serialText(b)} was already in the officer's hands on ${fmtDate(b.issuedDate)}, before this receipt date.`);
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
    if (b.receivedDate && date < b.receivedDate) return bad(`${serialText(b)} was received ${fmtDate(b.receivedDate)}, after the date issued.`);
  }
  for (const b of list) await store.save('cer_booklets', b.id, { ...strip(b), status: 'issued', officerId: off, issuedDate: date, history: [...(b.history || []), hist(refs, 'issued', date, { officerId: off })] }, by(refs));
  toast(`${list.length} booklet${list.length > 1 ? 's' : ''} issued.`, 'ok');
  return true;
}
// Starting Inventory from the screen: { error } or { parts: [{ x, y, unused }], held, warn }.
// unused: null = the whole booklet is unused; ranges = its unused numbers (partly used).
function startPlan() {
  if (isNs()) {
    const q = int($('#e-to').value), held = $('#e-held').value;
    if (!q) return { error: 'Enter the quantity of cash tickets.' };
    if (q > NS_MAX) return { error: `One lot takes up to ${NS_MAX.toLocaleString('en-US')} pieces.` };
    const parts = [{ x: 1, y: q, unused: null }], pv = partVals('e');
    if (held !== 'custodian' && pv.on) { const r = nsUnused(pv, 1, q); if (r.error) return { error: r.error }; parts[0].unused = r.unused; }
    return { parts, held, ns: true, warn: '' };
  }
  const a = int($('#e-from').value), z = int($('#e-to').value), p = int($('#e-per').value) || PER_BOOKLET;
  if (!a || !z || z < a) return { error: 'Enter the serial range (From must not be after To).' };
  if (z - a + 1 > MAX_PCS) return { error: `That range has ${z - a + 1} pieces. Check the serial numbers (one entry takes up to ${MAX_PCS.toLocaleString('en-US')}).` };
  const [bs, be] = bookletOf(a, p);
  if (bs !== a) return { error: `${a} is in the middle of booklet ${rangeText(bs, be)}. Enter the complete series from ${bs}; if the booklet is already in use, choose the accountable officer under Held By and tick Partly used.` };
  const held = $('#e-held').value;
  const parts = splitRange(a, z, p).map(([x, y]) => ({ x, y, unused: null }));
  const pv = partVals('e');
  if (held !== 'custodian' && pv.on) {
    if (!pv.text.trim()) return { error: `Type the ${pv.mode} numbers of the booklets in use, or untick Partly used.` };
    const r = parseRanges(pv.text, a, z, 'the range entered');
    if (r.error) return { error: r.error };
    parts.forEach((s) => { s.unused = unusedFromTyped(r.ranges, pv.mode, s.x, s.y); });
    if (parts.every((s) => !s.unused)) return { error: 'None of the numbers typed changed a booklet. Check the numbers.' };
  }
  const last = parts[parts.length - 1];
  const warn = bookletOf(z, p)[1] !== z ? `${z} is not the end of its booklet (${rangeText(...bookletOf(z, p))}); the last booklet is entered as ${rangeText(last.x, last.y)}.` : '';
  return { parts, held, warn };
}
function startPreview(plan) {
  if (plan.error) return `<b class="warn-t">${esc(plan.error)}</b>`;
  const n = plan.parts.length, show = plan.parts.length <= 8 ? plan.parts : plan.parts.filter((s) => s.unused);
  if (plan.ns) { const s0 = plan.parts[0], q = s0.y, un = s0.unused ? countRanges(s0.unused) : q;
    return `Will add <b>one lot of ${q} cash tickets</b> without serial numbers ${plan.held === 'custodian' ? 'to the custodian\'s stock' : 'in the officer\'s hands'}: ${q - un} used · <b>${un} unused</b> · ${peso(un * FACE.cash)}.`; }
  const line = (s) => { if (!s.unused) return `<li>${rangeText(s.x, s.y)} · whole, unused</li>`;
    const q = countRanges(s.unused), used = s.y - s.x + 1 - q, sk = skippedOf({ from: s.x, to: s.y, qty: s.y - s.x + 1, unusedAtStart: s.unused });
    return `<li><b>${rangeText(s.x, s.y)}</b> · ${used} used · <b>${q} unused</b>${q ? ` (${rangesText(s.unused)})` : ''}${sk.length ? ` · <b class="warn-t">skipped ${rangesText(sk)}</b>` : ''}</li>`; };
  return `Will add <b>${n} booklet${n > 1 ? 's' : ''}</b> ${plan.held === 'custodian' ? 'to the custodian\'s stock' : 'in the officer\'s hands'}:
    <ul class="af-plan">${show.map(line).join('')}${show.length < n ? `<li class="dim">… and ${n - show.length} whole, unused booklets</li>` : ''}</ul>${plan.warn ? `<b class="warn-t">${esc(plan.warn)}</b>` : ''}`;
}
async function doStarting(refs, f, lguId) {
  const form = $('#e-form').value, date = $('#e-date').value;
  const plan = startPlan();
  if (plan.error) return bad(plan.error);
  if (!date) return bad('Enter the as-of date.');
  const officer = plan.held !== 'custodian' ? f.officers.find((o) => o.id === plan.held) : null;
  if (plan.held !== 'custodian' && !officer) return bad('Choose who holds the booklets.');
  if (!plan.ns) {
    for (const s of plan.parts) { const hit = overlaps(f, form, s.x, s.y); if (hit.length) return bad(`${FORM_SHORT[form]} ${rangeText(s.x, s.y)} overlaps ${rangeText(hit[0].from, hit[0].to)} already in the register.`); }
    if (!(await confirmBig(form, plan.parts[0].x, plan.parts[plan.parts.length - 1].y, plan.parts.length))) return false;
  }
  const shift = plan.ns ? nsBase() - 1 : 0;
  for (const s0 of plan.parts) {
    const s = { x: s0.x + shift, y: s0.y + shift, unused: s0.unused ? s0.unused.map(([a, z]) => [a + shift, z + shift]) : null };
    const base = { lguId, form, from: s.x, to: s.y, qty: s.y - s.x + 1, receivedDate: '', receivedFrom: '', reference: '', source: 'starting', ...(plan.ns ? { noSerial: true } : {}) };
    await store.save('cer_booklets', newId('cerb'), officer
      ? { ...base, status: 'issued', officerId: officer.id, issuedDate: date, issuedAsOf: true, beginAs: 'ao', beginDate: date, unusedAtStart: s.unused,
          history: [hist(refs, 'starting', date, { officerId: officer.id, note: s.unused ? `In the officer's hands on the start date, partly used: ${countRanges(s.unused)} unused` : 'In the officer\'s hands on the start date' })] }
      : { ...base, status: 'stock', officerId: '', issuedDate: '', beginAs: 'custodian', beginDate: date, history: [hist(refs, 'starting', date, { note: 'Custodian\'s stock on the start date' })] }, by(refs), { quiet: true });
  }
  emitChange('local');
  const n = plan.parts.length;
  toast(`${n} booklet${n > 1 ? 's' : ''} added ${officer ? 'in the hands of ' + officer.name : 'to the custodian\'s stock'}.`, 'ok');
  return true;
}
const strip = (b) => { const { id, orNos, ...rest } = b; return rest; };   // orNos is worked out on loading, never saved

/* ---------- one booklet: history and moves ---------- */
const ACTION = { received: 'Received by the custodian', issued: 'Issued', transferred: 'Transferred', returned: 'Returned to the custodian', lost: 'Reported lost / destroyed',
  starting: 'Starting inventory', logbook: 'Encoded from the barangay logbook', matched: 'Receipt by the custodian matched',
  imported: 'Imported from Excel · issued', exhausted: 'Exhausted (per logbook)',
  direct: 'Received directly by the accountable officer', matcheddirect: 'Direct receipt by the accountable officer matched', corrected: 'Corrected' };
function historyHtml(refs, f, b) {
  const name = (id) => f.officers.find((o) => o.id === id)?.name || '';
  return `<ol class="af-hist">${(b.history || []).map((h) => `<li><b>${esc(ACTION[h.action] || h.action)}${h.officerId ? ' · ' + esc(name(h.officerId)) : ''}</b>
      <small>${esc(fmtDate(h.date))}${h.note ? ' · ' + esc(h.note) : ''}${h.by ? ' · by ' + esc(refs.users.find((u) => u.data.email === h.by)?.data.name || h.by) : ''}</small></li>`).join('')}
    ${usedOf(b) && !b.exhaustedDate ? `<li><b>${usedOf(b)} used · unused ${rt(b, rawUnused(b)) || 'none'}</b><small>${b.unusedAtStart || b.usedBefore ? 'as of the last cash exam, from the issuance record' : 'from Collections &amp; Deposits'}</small></li>` : ''}
    ${skippedOf(b).length ? `<li><b>Skipped numbers · ${rangesText(skippedOf(b))}</b><small>unused numbers below the last one used; confirm at the Physical Check</small></li>` : ''}</ol>`;
}
async function bookletModal(ctx, f, b, offs) {
  const { refs } = ctx;
  if (!b) return;
  const enc = canEncode(refs);
  const st = statusOf(b);
  const moves = !enc ? [] : b.status === 'stock' ? [['issue', 'Issue']] : held(b) ? [['transfer', 'Transfer to Another AO'], ['return', 'Return to Custodian'], ['lost', 'Report Lost / Destroyed']] : [];
  const offOpts = (skip) => offs.filter((o) => o.id !== skip).map((o) => `<option value="${esc(o.id)}">${esc(officerLabel(refs, o))}</option>`).join('');
  const v = await modal({ title: `${FORM_SHORT[b.form]} ${serialText(b)}`, wide: true,
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
    buttons: [
      ...(isAuditor(refs) ? [{ label: 'Delete', cls: 'danger', value: 'del', check: () => { const why = whyNoDelete(f, b); if (why) toast(why, 'bad'); return !why; } }] : []),
      ...(enc ? [{ label: 'Edit', value: 'edit' }] : []),
      ...(moves.length ? [{ label: 'Close', value: null }, { label: 'Save Movement', cls: 'primary', value: 'save', check: (bg) => {
      const act = $('#m-act', bg).value, off = $('#m-off', bg).value, date = $('#m-date', bg).value;
      if (['issue', 'transfer'].includes(act) && !off) { toast('Choose the officer.', 'bad'); return false; }
      if (!date) { toast('Enter the date.', 'bad'); return false; }
      bookletModal.pending = { act, off, date, note: $('#m-note', bg).value.trim() };
      return true;
    } }] : [{ label: 'Close', cls: 'primary', value: null }])] });
  if (v === 'edit') return editBooklet(ctx, f, b, offs);
  if (v === 'del') return deleteBooklet(refs, f, b);
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

/* ---------- one booklet: Edit and Delete ---------- */
// A booklet can be deleted (encoded by mistake) only while nothing is recorded against it.
function whyNoDelete(f, b) {
  if ((b.orNos || []).length) return `This booklet has ${b.orNos.length} receipt${b.orNos.length > 1 ? 's' : ''} encoded in Collections & Deposits. Remove those first, or correct the booklet with Edit.`;
  if (f.checks.some((c) => c.bookletId === b.id)) return 'This booklet has a Physical Check record from a cash examination. Correct it with Edit instead.';
  return '';
}
async function deleteBooklet(refs, f, b) {
  const v = await modal({ title: 'Delete this booklet?',
    body: `<p><b>${esc(FORM_SHORT[b.form] || b.form)} ${serialText(b)}</b> (${b.qty} pcs, ${esc(statusOf(b).label.toLowerCase())}) will be removed from the register.</p>
      <p class="af-note">Use this only for a booklet encoded by mistake. The deletion is kept in the database log.</p>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Delete', cls: 'danger', value: 'yes' }] });
  if (v !== 'yes') return;
  await store.save('cer_booklets', b.id, strip(b), by(refs), { deleted: true });
  toast(`${FORM_SHORT[b.form] || b.form} ${serialText(b)} deleted.`, 'ok');
}
async function editBooklet(ctx, f, b, offs) {
  const { refs } = ctx;
  const locked = (b.orNos || []).length || f.checks.some((c) => c.bookletId === b.id);
  const withOff = b.status !== 'stock';
  const partly = Array.isArray(b.unusedAtStart);

  const dis = locked ? 'disabled' : '';
  const body = `<div class="af-edit">
      <div class="field"><label for="x-form">Form Type</label><select class="input" id="x-form" ${b.noSerial ? "disabled" : dis}>${(b.form === 'chk' ? AF_FORMS : formsFor(f, b.lguId)).map(([k, l]) => `<option value="${k}" ${sel(k, b.form)}>${esc(l)}</option>`).join('')}</select></div>
      ${b.noSerial ? `<div class="field af-span2"><label for="x-qty">Quantity (pcs) · no serial numbers</label><input class="input r mono" id="x-qty" inputmode="numeric" value="${b.qty}" ${dis}></div>`
        : `<div class="field"><label for="x-from">Serial From</label><input class="input r mono" id="x-from" inputmode="numeric" value="${b.from}" ${dis}></div>
      <div class="field"><label for="x-to">Serial To</label><input class="input r mono" id="x-to" inputmode="numeric" value="${b.to}" ${dis}></div>`}
      ${FACE[b.form] ? `<div class="field"><label for="x-face">Face Value (₱ per piece)</label><input class="input r" id="x-face" inputmode="decimal" value="${faceOf(b)}"><span class="hint">Default ₱${FACE[b.form]}</span></div>` : ''}
      ${locked ? '<p class="af-note af-span">Form type and serial range are locked: receipts or a Physical Check are already recorded against this booklet.</p>' : ''}
      <div class="field"><label for="x-rdate">Date Received</label><input class="input" type="date" id="x-rdate" value="${esc(b.receivedDate || '')}"></div>
      <div class="field"><label for="x-src">Received From</label><select class="input" id="x-src">${srcOptions(f, b.lguId, { extra: [['', '—']], cur: b.receivedFrom || '', bank: b.form === 'chk' || chkByCustodian(f, b.lguId) })}</select></div>
      <div class="field"><label for="x-ref">Reference</label><input class="input" id="x-ref" value="${esc(b.reference || '')}"></div>
      ${b.form === 'chk' ? `<div class="field af-span"><label for="x-acct">Bank / Account (optional)</label><input class="input" id="x-acct" value="${esc(b.bankAccount || '')}" placeholder="e.g. LBP – General Fund"></div>` : ''}
      ${withOff ? `<div class="field af-span2"><label for="x-off">Accountable Officer</label><select class="input" id="x-off"><option value="">— Choose the officer —</option>${offs.map((o) => `<option value="${esc(o.id)}" ${sel(o.id, b.officerId)}>${esc(officerLabel(refs, o))}</option>`).join('')}</select></div>
      <div class="field"><label for="x-idate">Date Issued</label><input class="input" type="date" id="x-idate" value="${esc(b.issuedAsOf ? '' : b.issuedDate || '')}">${b.issuedAsOf ? `<span class="hint">Not yet known · on hand as of ${esc(fmtDate(b.issuedDate))}. Enter the real date if known.</span>` : ''}</div>
      <div class="af-span">${partBox('x', { on: partly, text: partly ? (b.noSerial ? String(countRanges(b.unusedAtStart)) : rangesText(b.unusedAtStart)) : '', note: b.noSerial ? 'Partly used (type the number of pieces)' : 'Partly used (unused on hand as of the start / last cash exam)' })}
        <p class="af-note">Receipts encoded in Collections &amp; Deposits are taken out on top of this. Ticked with the box blank (unused numbers): the booklet is fully used.</p></div>` : ''}
      <div class="field af-span"><label for="x-why">Reason for the correction (optional)</label><input class="input" id="x-why" placeholder="e.g. wrong serial range encoded"></div>
    </div>
    <div class="af-note" id="x-prev"></div>`;
  let out = null;
  const read = (bg) => {
    const form = $('#x-form', bg).value;
    let a, z;
    if (b.noSerial) { const q = int($('#x-qty', bg).value); if (!q || q > NS_MAX) return { error: `Enter the quantity (1 to ${NS_MAX.toLocaleString('en-US')}).` }; a = b.from; z = b.from + q - 1; }
    else {
      a = int($('#x-from', bg).value); z = int($('#x-to', bg).value);
      if (!a || !z || z < a) return { error: 'Enter the serial range (From must not be after To).' };
      if (z - a + 1 > MAX_PCS) return { error: `That range has ${z - a + 1} pieces. Check the serial numbers.` };
      const hit = overlaps(f, form, a, z, b.id);
      if (hit.length) return { error: `${FORM_SHORT[form]} ${rangeText(a, z)} overlaps ${rangeText(hit[0].from, hit[0].to)} already in the register.` };
    }
    const next = { form, from: a, to: z, qty: z - a + 1, receivedDate: $('#x-rdate', bg).value, receivedFrom: $('#x-src', bg).value, reference: $('#x-ref', bg).value.trim() };
    if ($('#x-acct', bg)) next.bankAccount = $('#x-acct', bg).value.trim();
    if ($('#x-face', bg)) { const v = parseFloat(String($('#x-face', bg).value).replace(/[,₱\s]/g, '')); if (isNaN(v) || v <= 0) return { error: 'Enter the face value per piece.' }; next.faceValue = v; }
    if (withOff) {
      next.officerId = $('#x-off', bg).value; next.issuedDate = $('#x-idate', bg).value;
      if (b.issuedAsOf) { if (!next.issuedDate) next.issuedDate = b.issuedDate; else { next.issuedAsOf = false; if (next.issuedDate > b.issuedDate) return { error: `The date issued must be on or before ${fmtDate(b.issuedDate)}, the date the booklet was already on hand.` }; } }
      if (!next.officerId) return { error: 'Choose the accountable officer.' };
      if (next.receivedDate && next.issuedDate && next.issuedDate < next.receivedDate) return { error: 'The date issued is before the date received.' };
      const pv = partVals('x', bg);
      if (!pv.on) next.unusedAtStart = null;
      else if (!pv.text.trim()) next.unusedAtStart = pv.mode === 'used' ? null : [];
      else if (b.noSerial) { const r = nsUnused(pv, a, z); if (r.error) return { error: r.error }; next.unusedAtStart = r.unused; }
      else { const r = parseRanges(pv.text, a, z); if (r.error) return { error: r.error }; next.unusedAtStart = pv.mode === 'used' ? subtractRanges([[a, z]], r.ranges) : r.ranges; }
    }
    return { next };
  };
  const showPrev = (bg) => {
    const r = read(bg), box = $('#x-prev', bg);
    if (r.error) { box.innerHTML = `<b class="warn-t">${esc(r.error)}</b>`; return; }
    if (!withOff) { box.innerHTML = ''; return; }
    const n = r.next, un = n.unusedAtStart === null ? [[n.from, n.to]] : n.unusedAtStart, q = countRanges(un);
    const sk = n.unusedAtStart ? skippedOf({ from: n.from, to: n.to, qty: n.qty, unusedAtStart: un }) : [];
    box.innerHTML = `Before receipts in Collections: ${n.qty - q} used · <b>${q} unused</b>${q && q < n.qty && !b.noSerial ? ` (${rangesText(un)})` : ''}${faceOf({ ...b, ...n }) && q ? ` · ${peso(q * faceOf({ ...b, ...n }))}` : ''}${sk.length ? ` · <b class="warn-t">skipped ${rangesText(sk)}</b>` : ''}.`;
  };
  const v = await modal({ title: `Edit ${FORM_SHORT[b.form] || b.form} ${serialText(b)}`, wide: true, body,
    onOpen: (bg) => { wireSrcSelect($('#x-src', bg), refs, f, b.lguId); $$('#x-from, #x-to, #x-form, #x-qty, #x-face', bg).forEach((el) => { el.oninput = () => showPrev(bg); el.onchange = () => showPrev(bg); }); wirePart('x', bg, () => showPrev(bg)); showPrev(bg); },
    buttons: [{ label: 'Cancel', value: null }, { label: 'Save Correction', cls: 'primary', value: 'save', check: (bg) => {
      const r = read(bg); if (r.error) { toast(r.error, 'bad'); return false; }
      out = { next: r.next, why: $('#x-why', bg).value.trim() }; return true; } }] });
  if (v !== 'save' || !out) return;
  const n = out.next, offName = (id) => f.officers.find((o) => o.id === id)?.name || '—';
  const un = (x) => (Array.isArray(x) ? (x.length ? rt(b, x) : 'none') : 'whole booklet');
  const changes = [];
  if (n.form !== b.form) changes.push(`form ${FORM_SHORT[b.form]} → ${FORM_SHORT[n.form]}`);
  if (n.from !== b.from || n.to !== b.to) changes.push(b.noSerial ? `quantity ${b.qty} → ${n.qty}` : `serials ${serialText(b)} → ${rangeText(n.from, n.to)}`);
  if ('faceValue' in n && n.faceValue !== faceOf(b)) changes.push(`face value ₱${faceOf(b)} → ₱${n.faceValue}`);
  if ((n.receivedDate || '') !== (b.receivedDate || '')) changes.push(`date received ${fmtDate(b.receivedDate) || '—'} → ${fmtDate(n.receivedDate) || '—'}`);
  if ((n.receivedFrom || '') !== (b.receivedFrom || '')) changes.push(`received from ${b.receivedFrom || '—'} → ${n.receivedFrom || '—'}`);
  if ((n.reference || '') !== (b.reference || '')) changes.push(`reference ${b.reference || '—'} → ${n.reference || '—'}`);
  if ('bankAccount' in n && (n.bankAccount || '') !== (b.bankAccount || '')) changes.push(`bank / account ${b.bankAccount || '—'} → ${n.bankAccount || '—'}`);
  if (withOff && n.officerId !== b.officerId) changes.push(`officer ${offName(b.officerId)} → ${offName(n.officerId)}`);
  if (withOff && ((n.issuedDate || '') !== (b.issuedDate || '') || (b.issuedAsOf && n.issuedAsOf === false))) changes.push(`date issued ${b.issuedAsOf ? 'not yet known' : fmtDate(b.issuedDate) || '—'} → ${fmtDate(n.issuedDate) || '—'}`);
  if (withOff && un(n.unusedAtStart) !== un(b.unusedAtStart ?? null)) changes.push(`unused on hand ${un(b.unusedAtStart ?? null)} → ${un(n.unusedAtStart)}`);
  if (!changes.length) { toast('Nothing was changed.', 'ok'); return; }
  const history = (b.history || []).map((h) => ({ ...h }));
  // A corrected officer or date issued also corrects the entry that put the booklet in the officer's hands (used by the RAAF).
  if (withOff && (n.officerId !== b.officerId || n.issuedDate !== b.issuedDate)) {
    const h = history.slice().reverse().find((x) => TO_OFFICER.includes(x.action) || (x.action === 'starting' && x.officerId));
    if (h) { h.officerId = n.officerId; if (h.action !== 'starting' && h.date === b.issuedDate && n.issuedDate) h.date = n.issuedDate; }
  }
  history.push(hist(refs, 'corrected', today(), { note: changes.join('; ') + (out.why ? '. Reason: ' + out.why : '') }));
  const next = { ...strip(b), ...n, history };
  if (n.from !== b.from || n.to !== b.to) next.usedBefore = null;
  await store.save('cer_booklets', b.id, next, by(refs));
  toast('Correction saved.', 'ok');
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
            const isChk = b.form === 'chk', lc = c.lastCheck || b.lastCheck || {};
            const res = !c.seen ? (c.id ? ['p-flag', 'Not seen'] : ['p-stock', 'Not yet checked']) : isChk ? ['p-done', 'Last check recorded'] : counted && sameRanges(counted, reg) ? ['p-done', 'Agrees'] : ['p-flag', 'For checking'];
            return `<tr data-ck="${esc(b.id)}"><td><input type="checkbox" class="af-seen" ${c.seen ? 'checked' : ''} ${auditor ? '' : 'disabled'} aria-label="Seen: ${esc(FORM_SHORT[b.form])} ${b.from} to ${b.to}"></td>
              <td>${chkLabel(b)}</td><td class="mono">${serialText(b)}</td><td class="r">${b.issuedAsOf ? '≥ ' : ''}${days(b.issuedDate, exam.audit.countDate)}</td>
              <td class="mono">${reg.length ? (b.noSerial ? `${n} pcs` : `${rangesText(reg)} (${n})`) : 'None'}${faceOf(b) && n ? `<small>${peso(n * faceOf(b))}</small>` : ''}${sk.length ? `<small class="warn-t">Skipped: ${rangesText(sk)} · on hand, cancelled or not on hand?</small>` : ''}</td>
              <td>${isChk ? `<div class="af-lc"><input class="input af-sm mono af-lc-no" inputmode="numeric" placeholder="Last check No." value="${esc(lc.no || '')}" aria-label="Last check issued: check No." ${auditor ? '' : 'disabled'}>
                <input class="input af-sm af-lc-date" type="date" value="${esc(lc.date || '')}" aria-label="Last check issued: date" ${auditor ? '' : 'disabled'}>
                <input class="input af-sm af-lc-payee" placeholder="Payee / particulars" value="${esc(lc.payee || '')}" aria-label="Last check issued: payee or particulars" ${auditor ? '' : 'disabled'}>
                <input class="input af-sm r af-lc-amt" inputmode="decimal" placeholder="Amount" value="${lc.amount ? esc(Number(lc.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })) : ''}" aria-label="Last check issued: amount" ${auditor ? '' : 'disabled'}></div>
                <small class="dim">Unused (from the last check; mark a skipped or cancelled check by editing):</small>` : ''}<input class="input af-sm mono af-ur" ${b.noSerial ? 'inputmode="numeric" placeholder="pcs"' : ''} value="${esc(b.noSerial ? String(countRanges(counted || reg)) : counted ? rangesText(counted).replace(/ – /g, '-') : rangesText(reg).replace(/ – /g, '-'))}" aria-label="Unused per count${b.noSerial ? ' (pieces)' : ''}" ${auditor ? '' : 'disabled'}></td>
              <td class="r">${diff === null ? '<span class="dim">—</span>' : diff}</td><td><span class="pill ${res[0]}">${res[1]}</span></td></tr>`;
          }).join('')}</tbody></table></div>
          <div class="af-foot"><p class="af-note">A booklet not seen, or a difference, goes to Verification for the auditor's judgment. It is never concluded as missing by the system.</p>
            ${auditor ? '<button class="btn primary" type="button" id="af-savecheck">Save Physical Check</button>' : '<span class="dim">The auditor does the Physical Check.</span>'}</div>`
        : '<div class="empty"><b>No booklets in this officer\'s hands on the count date.</b>Booklets issued on or before the cash count, not yet exhausted, are listed here.</div>'}`;
  } else {
    const list = tab === 'hand' ? inHand : mine.slice().sort((a, b) => String(b.issuedDate).localeCompare(String(a.issuedDate)));
    tabBody = list.length ? `<div class="af-tbl"><table class="af-reg"><thead><tr><th scope="col">Form</th><th scope="col">Booklet</th><th scope="col">Issued</th><th scope="col" class="r">Days in Hand</th><th scope="col" class="r">Used</th><th scope="col">Unused</th><th scope="col">Status</th></tr></thead>
      <tbody>${list.map((b) => { const st = statusOf(b); const d = daysWithAo(b, asOf);
        return `<tr data-bk="${esc(b.id)}" tabindex="0"><td>${chkLabel(b)}</td><td class="mono">${serialText(b)}</td><td>${issuedText(b)}</td><td class="r">${daysText(b, d)}</td><td class="r">${usedOf(b)}</td>
          <td class="mono">${unusedCell(b)}</td><td><span class="pill ${st.cls}">${st.label}</span>${skippedOf(b).length ? '<br><span class="pill p-flag">Skipped numbers</span>' : ''}</td></tr>`; }).join('')}</tbody></table></div>
      <p class="af-note">Click a booklet to see its history and to Transfer, Return or report it Lost.</p>`
      : `<div class="empty"><b>${tab === 'hand' ? 'No booklets in this officer\'s hands.' : 'No booklets issued to this officer yet.'}</b></div>`;
  }
  const body = `<div class="hello"><div><a href="#/cer/forms/officer?lgu=${esc(lguId)}" class="af-back">← All officers</a><h1>${esc(o.name)}</h1><p>${esc([o.designation, agencyName(refs, refs.lgu[o.lguId])].filter(Boolean).join(' · '))} · booklets issued by the ${custOf(refs.lgu[lguId])}</p></div>
      <div class="btn-row">${canEncode(refs) && !chkByCustodian(f, lguId) ? '<button class="btn primary" type="button" id="af-addchk">Add Checkbook</button>' : ''}<a class="btn" href="#/cer/forms?lgu=${esc(lguId)}&cust=${esc(o.id)}">Open in Forms Register</a><button class="btn" type="button" id="af-oxls">Export to Excel</button><button class="btn" type="button" id="af-clear">Print Clearance List</button></div></div>
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
    return { Form: FORM_SHORT[b.form] || b.form, 'Bank / Account': b.bankAccount || '', 'Series From': b.from, 'Series To': b.to, Qty: b.qty, 'Date Issued': b.issuedAsOf ? 'Not yet known (on hand as of ' + fmtDate(b.issuedDate) + ')' : fmtDate(b.issuedDate), 'Days in Hand': daysWithAo(b, asOf) === null ? '' : (b.issuedAsOf ? '≥ ' : '') + daysWithAo(b, asOf),
      Used: usedOf(b), 'Unused per Register': rt(b, unusedRanges(b)), 'Unused Qty': unusedOf(b), 'Unused Amount': faceOf(b) ? unusedOf(b) * faceOf(b) : '', 'Skipped Numbers': rangesText(skippedOf(b)), Status: statusOf(b).label,
      ...(exam ? { 'Cash Count': fmtDate(exam.audit.countDate), Seen: c ? (c.seen ? 'Yes' : 'No') : '', 'Unused per Count': counted ? rt(b, counted) : '' } : {}) }; });
  return { crumb: 'Accountable Forms · By Accountable Officer', body, wire: () => {
    wireOfficer(ctx, f, lguId, o, exam, offs);
    $('#af-oxls').onclick = () => exportXlsx(`Accountable Forms ${o.name}${exam ? ' ' + exam.audit.countDate : ''}.xlsx`, 'Booklets', exportRows());
  } };
}
// Add Checkbook: checks received by the officer straight from the bank (kept out of the custodian's register).
const CHK_PER = 100;   // checks per checkbook, by default
const LASTCHK = { per: CHK_PER, acct: '' };
async function addCheckbook(refs, f, lguId, o) {
  const accts = [...new Set(f.booklets.filter((b) => b.form === 'chk' && b.bankAccount).map((b) => b.bankAccount))].sort();
  let plan = null;
  const read = (bg) => {
    const a = int($('#k-from', bg).value), z = int($('#k-to', bg).value), p = int($('#k-per', bg).value) || CHK_PER;
    if (!a || !z || z < a) return { error: 'Enter the check numbers (From must not be after To).' };
    if (z - a + 1 > MAX_PCS) return { error: `That range has ${(z - a + 1).toLocaleString('en-US')} checks. Check the numbers.` };
    const [bs, be] = bookletOf(a, p);
    if (bs !== a) return { error: `${a} is in the middle of checkbook ${rangeText(bs, be)}. Enter the complete series from ${bs}; tick Partly used for the checks already issued.` };
    const parts = splitRange(a, z, p).map(([x, y]) => ({ x, y, unused: null }));
    const pv = partVals('k', bg);
    if (pv.on) {
      if (!pv.text.trim()) return { error: `Type the ${pv.mode} check numbers, or untick Partly used.` };
      const r = parseRanges(pv.text, a, z, 'the range entered'); if (r.error) return { error: r.error };
      parts.forEach((s) => { s.unused = unusedFromTyped(r.ranges, pv.mode, s.x, s.y); });
      if (parts.every((s) => !s.unused)) return { error: 'None of the numbers typed changed a checkbook. Check the numbers.' };
    }
    for (const s of parts) { const hit = overlaps(f, 'chk', s.x, s.y); if (hit.length) return { error: `Checks ${rangeText(s.x, s.y)} overlap ${rangeText(hit[0].from, hit[0].to)} already encoded${hit[0].officerId ? ' with ' + (f.officers.find((x) => x.id === hit[0].officerId)?.name || 'another officer') : ''}.` }; }
    return { parts, per: p };
  };
  const show = (bg) => { const r = read(bg); const box = $('#k-prev', bg);
    if (!int($('#k-from', bg).value) || !int($('#k-to', bg).value)) { box.innerHTML = ''; return; }
    box.innerHTML = r.error ? `<b class="warn-t">${esc(r.error)}</b>` : startPreview({ parts: r.parts, held: o.id }).replace('in the officer\'s hands', 'in ' + esc(o.name) + '\'s hands').replace(/booklet/g, 'checkbook'); };
  const v = await modal({ title: `Add Checkbook · ${o.name}`, wide: true,
    body: `<div class="af-edit">
        <div class="field"><label for="k-from">Check No. From</label><input class="input r mono" id="k-from" inputmode="numeric" autocomplete="off"></div>
        <div class="field"><label for="k-to">Check No. To</label><input class="input r mono" id="k-to" inputmode="numeric" autocomplete="off"></div>
        <div class="field"><label for="k-per">Checks per Book</label><input class="input r" id="k-per" inputmode="numeric" value="${LASTCHK.per}"></div>
        <div class="field af-span2"><label for="k-acct">Bank / Account (optional)</label><input class="input" id="k-acct" list="k-accts" value="${esc(LASTCHK.acct)}" placeholder="e.g. LBP – General Fund"><datalist id="k-accts">${accts.map((x) => `<option value="${esc(x)}">`).join('')}</datalist></div>
        <div class="field"><label for="k-date">Date Received from the Bank</label><input class="input" type="date" id="k-date"></div>
        <div class="af-span">${partBox('k', { note: 'Partly used checkbooks (already in use at the start)' })}</div>
      </div>
      <p class="af-note">Enter the complete series. A date not known: use the start date of the register. These checkbooks show only on this officer's page, never in the custodian's register.</p>
      <div class="af-note" id="k-prev"></div>`,
    onOpen: (bg) => { $$('#k-from, #k-to, #k-per', bg).forEach((el) => { el.oninput = () => show(bg); });
      $('#k-from', bg).addEventListener('change', () => { const a = int($('#k-from', bg).value), t = $('#k-to', bg); if (a && !t.value) { t.value = bookletOf(a, int($('#k-per', bg).value) || CHK_PER)[1]; show(bg); } });
      wirePart('k', bg, () => show(bg)); },
    buttons: [{ label: 'Cancel', value: null }, { label: 'Save Checkbooks', cls: 'primary', value: 'save', check: (bg) => {
      const r = read(bg); if (r.error) { toast(r.error, 'bad'); return false; }
      const date = $('#k-date', bg).value; if (!date) { toast('Enter the date received from the bank.', 'bad'); return false; }
      plan = { ...r, date, acct: $('#k-acct', bg).value.trim() }; return true; } }] });
  if (v !== 'save' || !plan) return;
  if (!(await confirmBig('chk', plan.parts[0].x, plan.parts[plan.parts.length - 1].y, plan.parts.length))) return;
  Object.assign(LASTCHK, { per: plan.per, acct: plan.acct });
  for (const s of plan.parts) {
    await store.save('cer_booklets', newId('cerb'), { lguId, form: 'chk', from: s.x, to: s.y, qty: s.y - s.x + 1, receivedDate: plan.date, receivedFrom: 'Bank', reference: '',
      receivedDirect: true, bankAccount: plan.acct, source: 'officer', status: 'issued', officerId: o.id, issuedDate: plan.date, usedBefore: null, unusedAtStart: s.unused,
      history: [hist(refs, 'direct', plan.date, { officerId: o.id, note: 'From the bank' + (plan.acct ? ' · ' + plan.acct : '') + (s.unused ? ` · partly used: ${countRanges(s.unused)} unused` : '') })] }, by(refs), { quiet: true });
  }
  emitChange('local');
  toast(`${plan.parts.length} checkbook${plan.parts.length > 1 ? 's' : ''} added for ${o.name}.`, 'ok');
}
function clearanceHtml(refs, f, o, mine, lguId) {
  const list = mine.filter(held).sort((a, b) => a.form.localeCompare(b.form) || a.from - b.from);
  return `<h2>Accountable Forms in the Officer's Hands</h2>
    <p><b>${esc(o.name)}</b>, ${esc(o.designation || '')} · ${esc(agencyName(refs, refs.lgu[o.lguId]))} · as of ${esc(fmtDate(today()))}</p>
    <table><thead><tr><th>Form</th><th>Booklet</th><th>Date Issued</th><th>Used</th><th>Unused Range</th><th>Unused Qty</th></tr></thead>
    <tbody>${list.length ? list.map((b) => `<tr><td>${esc(FORM_SHORT[b.form])}</td><td>${serialText(b)}</td><td>${esc(fmtDate(b.issuedDate))}</td><td>${usedOf(b)}</td><td>${rt(b, unusedRanges(b)) || 'None'}</td><td>${unusedOf(b)}</td></tr>`).join('')
      : '<tr><td colspan="6">No accountable forms in this officer\'s hands.</td></tr>'}</tbody></table>
    <p>Total unused: ${list.reduce((n, b) => n + unusedOf(b), 0)} pcs. From the Forms Register of ${esc(agencyName(refs, refs.lgu[lguId]))}.</p>`;
}
function wireOfficer(ctx, f, lguId, o, exam, offs) {
  const { refs } = ctx;
  const addChk = $('#af-addchk'); if (addChk) addChk.onclick = () => addCheckbook(refs, f, lguId, o);
  $('#af-clear').onclick = () => { document.body.classList.add('af-printing'); $('#cer-print').hidden = false; window.print(); $('#cer-print').hidden = true; document.body.classList.remove('af-printing'); };
  const ex = $('#af-exam'); if (ex) ex.onchange = () => go({ exam: ex.value });
  $$('tr[data-bk]').forEach((tr) => { const open = () => bookletModal(ctx, f, f.booklets.find((b) => b.id === tr.dataset.bk), offs); tr.onclick = open; tr.onkeydown = (e) => { if (e.key === 'Enter') open(); }; });
  $$('tr[data-ck]').forEach((tr) => { const n = $('.af-lc-no', tr); if (!n) return;
    const b = f.booklets.find((x) => x.id === tr.dataset.ck);
    n.oninput = () => { const v = int(n.value); if (v && v >= b.from && v <= b.to) $('.af-ur', tr).value = v < b.to ? `${v + 1}-${b.to}` : ''; }; });
  const save = $('#af-savecheck');
  if (save) save.onclick = async () => {
    save.disabled = true;
    try {
      for (const tr of $$('tr[data-ck]')) {
        const id = exam.id + '|' + tr.dataset.ck;
        const b = f.booklets.find((x) => x.id === tr.dataset.ck);
        const p = b.noSerial ? (() => { const q = int($('.af-ur', tr).value) ?? 0; return q > b.qty ? { error: `more than the ${b.qty} pieces of the lot.` } : { ranges: q ? [[b.from, b.from + q - 1]] : [] }; })() : parseRanges($('.af-ur', tr).value, b.from, b.to);
        if (p.error) { toast(`${FORM_SHORT[b.form]} ${serialText(b)}: ${p.error}`, 'bad'); return; }
        const rec = { examId: exam.id, bookletId: b.id, seen: $('.af-seen', tr).checked, ranges: p.ranges };
        if (b.form === 'chk') {
          const no = int($('.af-lc-no', tr).value);
          if (no && (no < b.from || no > b.to)) { toast(`Check No. ${no} is outside the checkbook ${serialText(b)}.`, 'bad'); return; }
          rec.lastCheck = { no: no || '', date: $('.af-lc-date', tr).value, payee: $('.af-lc-payee', tr).value.trim(), amount: parseFloat(String($('.af-lc-amt', tr).value).replace(/[,₱\s]/g, '')) || 0 };
          // The checkbook's unused checks follow the Physical Check (no check register yet).
          if (rec.seen) await store.save('cer_booklets', b.id, { ...strip(b), unusedAtStart: p.ranges, lastCheck: rec.lastCheck }, by(refs), { quiet: true });
        }
        await store.save('cer_formcheck', id, rec, by(refs), { quiet: true });
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
    const key = b.noSerial ? b.form + '~ns' : b.form;
    const r = rows[key] = rows[key] || { form: b.form, key, ns: !!b.noSerial, beg: [], rec: [], end: [] };
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
  const cell = (rs, r) => `<td class="r">${countRanges(rs)}${FACE[r.form] && countRanges(rs) ? `<small>${peso(countRanges(rs) * FACE[r.form])}</small>` : ''}</td><td class="mono">${rs.length && !r.ns ? rs.map(([a]) => `<div>${a}</div>`).join('') : ''}</td><td class="mono">${rs.length && !r.ns ? rs.map(([, z]) => `<div>${z}</div>`).join('') : ''}</td>`;
  const sectionHtml = ([fund, list]) => `${list.sort((a, b) => a.key.localeCompare(b.key)).map((r) => {
      const t = typed(fund, r.key); const has = cols.some((c) => t[c] !== undefined && t[c] !== '' && t[c] !== null);
      const same = has && cols.every((c) => +(t[c] || 0) === countRanges(r[c]));
      return `<tr class="reg"><th scope="row" class="l">${esc(FORM_SHORT[r.form] || r.form)}${r.ns ? ' (no serial)' : ''}</th>${cols.map((c) => cell(r[c], r)).join('')}<td class="l res">${!has ? '' : same ? '<span class="pill p-done">Agrees</span>' : '<span class="pill p-flag">For checking</span>'}</td></tr>
        <tr class="af-typed"><td class="l dim">Per submitted RAAF</td>${cols.map((c) => `<td class="r"><label class="sr-only" for="t-${esc(fund)}-${r.key}-${c}">${esc(fund)} ${esc(FORM_SHORT[r.form])} ${c} per submitted RAAF</label><input class="input af-cell" id="t-${esc(fund)}-${r.key}-${c}" data-fund="${esc(fund)}" data-form="${r.key}" data-c="${c}" inputmode="numeric" value="${t[c] ?? ''}" ${enc ? '' : 'disabled'}></td><td colspan="2" class="dim">${has && +(t[c] || 0) !== countRanges(r[c]) ? `<span class="warn-t">difference ${(+(t[c] || 0)) - countRanges(r[c])}</span>` : ''}</td>`).join('')}<td></td></tr>`;
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
  const sr = (r, rs) => (r.ns ? '' : rangesText(rs));
  const exportRows = () => sections.flatMap(([fund, list]) => list.map((r) => ({ Form: (FORM_SHORT[r.form] || r.form) + (r.ns ? ' (no serial)' : ''),
    'Beginning Qty': countRanges(r.beg), 'Beginning Serials': sr(r, r.beg), 'Receipt Qty': countRanges(r.rec), 'Receipt Serials': sr(r, r.rec),
    'Issued Qty': countRanges(r.iss), 'Issued Serials': sr(r, r.iss), 'Ending Qty': countRanges(r.end), 'Ending Serials': sr(r, r.end),
    ...(FACE[r.form] ? { 'Ending Amount': countRanges(r.end) * FACE[r.form] } : {}) })));
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
      'Received From: Provincial Treasurer, National Printing Office, or any other source (a new one is added to the LGU\'s list).',
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
    // Any source is accepted: one already in the list keeps its spelling; a new one is added to the list on import.
    const src = [...srcList(f, lguId), ...RECEIVED_FROM].find((x) => x.toUpperCase() === srcIn.toUpperCase()) || srcIn.replace(/\s+/g, ' ');
    const rbyIn = String(get(row, 'rby') || '').trim();
    const bad = (why) => plan.problems.push({ line, text: `${a || '?'} – ${z || '?'}`, why });
    if (!a || !z) { bad('Series From or Series To is missing.'); continue; }
    if (z < a) { bad('Series From is after Series To.'); continue; }
    if (z - a + 1 > MAX_PCS) { bad(`${z - a + 1} pieces in one row. Check the series.`); continue; }
    if (!date) { bad(date === null ? 'Date Received is not a date.' : 'Date Received is missing.'); continue; }
    if (!src) { bad('Received From is missing.'); continue; }
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
        <div class="field"><label for="i-form">Form Type</label><select class="input" id="i-form">${AF_FORMS.map(([k, l]) => `<option value="${k}" ${k === LAST.form ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
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

// For Cash Count: the officer's booklets in hand on the count date, with the unused numbers per register and per the Physical Check.
export function unusedFormsOf(f, officerId, exam, countDate) {
  return f.booklets.filter((b) => b.officerId === officerId && b.status === 'issued' && b.issuedDate && b.issuedDate <= countDate && statusOf(b).key !== 'done')
    .sort((a, b) => a.form.localeCompare(b.form) || a.from - b.from).map((b) => {
      const c = exam ? f.checks.find((x) => x.id === exam.id + '|' + b.id) : null;
      const counted = c && Array.isArray(c.ranges) ? c.ranges : null;
      const un = c && c.seen && counted ? counted : unusedRanges(b);
      const st = !c ? ['p-stock', 'Not yet checked'] : !c.seen ? ['p-flag', 'Not seen'] : b.form === 'chk' ? ['p-done', 'Last check recorded'] : counted && sameRanges(counted, unusedRanges(b)) ? ['p-done', 'Agrees'] : ['p-flag', 'For checking'];
      const qty = countRanges(un), face = faceOf(b);
      return { id: b.id, form: b.form, name: FORM_SHORT[b.form] || b.form, from: b.noSerial ? '' : b.from, to: b.noSerial ? '' : b.to, ns: !!b.noSerial, ranges: un, qty, text: b.noSerial ? `${qty} pcs (no serial)` : rangesText(un),
        face, amount: face * qty, status: st, lastCheck: c?.lastCheck || b.lastCheck || null };
    });
}

// For Reports (SAAF, Annex B): each booklet of the officer within the scope of audit, as Beginning, Received, Issued,
// Ending (per the register) and per Count (Physical Check at this cash examination). Ranges are [[from, to], …].
export function saafRows(f, officerId, exam, from, to) {
  const out = [];
  f.booklets.filter((b) => b.officerId === officerId && b.status !== 'stock' && b.issuedDate && b.issuedDate <= to)
    .sort((a, b) => a.form.localeCompare(b.form) || a.from - b.from).forEach((b) => {
      const beg = from && b.issuedDate <= from ? (b.status === 'lost' && b.history?.some((h) => h.action === 'lost' && h.date <= from) ? [] : rawUnused(b, from)) : [];
      const rec = !from || b.issuedDate > from ? [[b.from, b.to]] : [];
      const end = b.status === 'lost' ? [] : rawUnused(b, to);
      if (!beg.length && !rec.length && !end.length) return;
      const issued = subtractRanges([...beg, ...rec], end);
      const c = exam ? f.checks.find((x) => x.id === exam.id + '|' + b.id) : null;
      const count = c && c.seen && Array.isArray(c.ranges) ? c.ranges : null;
      out.push({ id: b.id, form: b.form, name: FORM_SHORT[b.form] || b.form, booklet: [b.from, b.to], ns: !!b.noSerial, face: faceOf(b), beg, rec, issued, end, count,
        diff: count === null ? null : countRanges(end) - countRanges(count), fund: b.fund || '' });
    });
  return out;
}
export { countRanges };

/* ---------- Audit Setup · Beginning Inventory of Accountable Forms ---------- */
// The officer's forms on hand at the last cash exam (the SAAF beginning balance): booklets issued on or before that date,
// with the numbers still unused on that date. Same booklet records as the Forms Register and the officer's page.
const srcOf = (b) => (b.form === 'chk' && b.receivedFrom === 'Bank' && b.receivedDirect ? 'bank' : b.receivedDirect ? 'direct' : 'custodian');

export function beginningFormsOf(f, officerId, asOf) {
  if (!asOf) return [];
  return f.booklets.filter((b) => b.officerId === officerId && b.status !== 'stock' && b.issuedDate && b.issuedDate <= asOf
      && !(b.status === 'lost' && (b.history || []).some((h) => h.action === 'lost' && h.date <= asOf)))
    .map((b) => ({ b, unused: rawUnused(b, asOf), src: srcOf(b) })).filter((r) => r.unused.length)
    .sort((x, y) => x.b.form.localeCompare(y.b.form) || x.b.from - y.b.from);
}
// Booklets the officer received after the last cash exam, up to the count date (shown for information).
export const receivedDuringOf = (f, officerId, asOf, countDate) =>
  f.booklets.filter((b) => b.officerId === officerId && b.status !== 'stock' && b.issuedDate && (!asOf || b.issuedDate > asOf) && (!countDate || b.issuedDate <= countDate));
export function beginningTableHtml(f, rows, canEdit) {
  if (!rows.length) return '';
  const srcText = { custodian: 'From the custodian · in the Forms Register', bank: 'From the bank · this officer only', direct: 'Received directly · in the Forms Register' };
  const dirFrom = (b) => (b.receivedDirect && b.receivedFrom && b.receivedFrom !== 'Bank' ? ` (${esc(b.receivedFrom)})` : '');
  return `<div class="cer-tbl"><table class="af-reg cer-afbeg"><thead><tr><th scope="col">Form</th><th scope="col">Booklet</th><th scope="col">Date Issued</th><th scope="col">Unused at the Last Cash Exam</th><th scope="col" class="r">Qty</th><th scope="col">Source</th></tr></thead>
    <tbody>${rows.map(({ b, unused, src }) => `<tr ${canEdit ? `data-begbk="${esc(b.id)}" tabindex="0" class="click"` : ''}><td>${chkLabel(b)}</td><td class="mono">${serialText(b)}</td><td>${issuedText(b)}</td>
      <td class="mono">${b.noSerial ? '—' : rangesText(unused)}</td><td class="r">${countRanges(unused)}${faceOf(b) ? `<small>${peso(countRanges(unused) * faceOf(b))}</small>` : ''}</td><td><small class="dim">${srcText[src]}${dirFrom(b)}</small></td></tr>`).join('')}</tbody></table></div>`;
}
export function openBooklet(refs, f, id) {
  const b = f.booklets.find((x) => x.id === id); if (!b) return;
  return bookletModal({ refs }, f, b, officersOf(refs, f, b.lguId));
}
// Add the officer's forms on hand at the last cash exam. From the custodian: they go to the Forms Register as issuances
// still in the officer's hands. From the bank (checks): they stay on this officer's records only.
export async function addBeginningForms(refs, f, regId, o, asOf) {
  const lgu = refs.lgu[regId], cust = custOf(lgu);
  let plan = null;
  const CUST = '__cust';
  // custodian | direct | bank
  const srcNow = (bg) => ($('input[name="g-kind"]:checked', bg)?.value === 'bank' ? 'bank' : $('#g-srcsel', bg).value === CUST ? 'custodian' : 'direct');
  const read = (bg) => {
    const src = srcNow(bg), form = src === 'bank' ? 'chk' : $('#g-form', bg).value;
    const a = int($('#g-from', bg).value), z = int($('#g-to', bg).value), p = int($('#g-per', bg).value) || (src === 'bank' ? CHK_PER : PER_BOOKLET);
    if (src === 'direct' && (!$('#g-srcsel', bg).value || $('#g-srcsel', bg).value === ADD_SRC)) return { error: 'Choose where the officer received the forms from.' };
    if (form === 'cash' && $('#g-ns', bg).checked) {
      if (!z) return { error: 'Enter the quantity of cash tickets.' };
      if (z > NS_MAX) return { error: `One lot takes up to ${NS_MAX.toLocaleString('en-US')} pieces.` };
      const parts = [{ x: 1, y: z, unused: null }], pv = partVals('g', bg);
      if (pv.on) { const r = nsUnused(pv, 1, z); if (r.error) return { error: r.error }; parts[0].unused = r.unused; }
      return { src, form, parts, per: p, ns: true };
    }
    if (!a || !z || z < a) return { error: 'Enter the serial range (From must not be after To).' };
    if (z - a + 1 > MAX_PCS) return { error: `That range has ${(z - a + 1).toLocaleString('en-US')} pieces. Check the serial numbers.` };
    const [bs, be] = bookletOf(a, p);
    if (bs !== a) return { error: `${a} is in the middle of booklet ${rangeText(bs, be)}. Enter the complete series from ${bs}; tick Partly used for the numbers already used.` };
    const parts = splitRange(a, z, p).map(([x, y]) => ({ x, y, unused: null }));
    const pv = partVals('g', bg);
    if (pv.on) {
      if (!pv.text.trim()) return { error: `Type the ${pv.mode} numbers, or untick Partly used.` };
      const r = parseRanges(pv.text, a, z, 'the range entered'); if (r.error) return { error: r.error };
      parts.forEach((s) => { s.unused = unusedFromTyped(r.ranges, pv.mode, s.x, s.y); });
      if (parts.every((s) => !s.unused)) return { error: 'None of the numbers typed changed a booklet. Check the numbers.' };
    }
    for (const s of parts) { const hit = overlaps(f, form, s.x, s.y); if (hit.length) return { error: `${FORM_SHORT[form]} ${rangeText(s.x, s.y)} overlaps ${rangeText(hit[0].from, hit[0].to)} already encoded${hit[0].officerId ? ' with ' + (f.officers.find((x) => x.id === hit[0].officerId)?.name || 'another officer') : ' in the custodian\'s stock'}.` }; }
    return { src, form, parts, per: p };
  };
  let lastSrc = 'custodian';
  const show = (bg) => {
    const src = srcNow(bg);
    $('#g-formbox', bg).hidden = src === 'bank'; $('#g-acctbox', bg).hidden = src !== 'bank'; $('#g-srcbox', bg).hidden = src === 'bank';
    // Checkbooks come in books of 100; the other forms keep the last per-booklet used.
    if (src !== lastSrc) { const per = $('#g-per', bg); if (src === 'bank') per.value = LASTCHK.per; else if (lastSrc === 'bank') per.value = LAST.per; lastSrc = src; }
    $('#g-srcnote', bg).textContent = src === 'bank' ? 'Checkbooks from the bank: shown only on this officer\'s records, never in the custodian\'s register.'
      : src === 'custodian' ? `Issued by the custodian (${cust}): added to the Forms Register as forms already in the officer's hands.`
      : `Received by the officer directly from ${$('#g-srcsel', bg).value}, not through the ${cust}: shown in the Forms Register marked "Received directly", never in the custodian's stock or RAAF.`;
    const cash = src !== 'bank' && $('#g-form', bg).value === 'cash'; $('#g-nsbox', bg).hidden = !cash; if (!cash) $('#g-ns', bg).checked = false;
    const ns = $('#g-ns', bg).checked;
    $('#g-from', bg).closest('.field').hidden = ns; $('#g-per', bg).closest('.field').hidden = ns; $('label[for="g-to"]', bg).textContent = ns ? 'Quantity (pcs)' : 'Serial To';
    const box = $('#g-prev', bg);
    if ((!ns && !int($('#g-from', bg).value)) || !int($('#g-to', bg).value)) { box.innerHTML = ''; return; }
    const r = read(bg);
    box.innerHTML = r.error ? `<b class="warn-t">${esc(r.error)}</b>` : startPreview({ parts: r.parts, held: o.id, ns: r.ns }).replace('in the officer\'s hands', `in ${esc(o.name)}'s hands at the last cash exam`);
  };
  const forms = formsFor(f, regId);
  const v = await modal({ title: `Beginning Forms · ${o.name}`, wide: true,
    body: `<div class="af-pmode af-src" role="radiogroup" aria-label="Kind"><span>Entering:</span>
        <label class="cer-chip"><input type="radio" name="g-kind" value="forms" checked> Accountable Forms</label>
        <label class="cer-chip"><input type="radio" name="g-kind" value="bank"> Checkbook (Bank)</label></div>
      <p class="af-note" id="g-srcnote"></p>
      <div class="af-edit">
        <div class="field" id="g-formbox"><label for="g-form">Form Type</label><select class="input" id="g-form">${forms.map(([k, l]) => `<option value="${k}" ${sel(k, LAST.form)}>${esc(l)}</option>`).join('')}</select></div>
        <div class="field" id="g-srcbox"><label for="g-srcsel">Received From</label><select class="input" id="g-srcsel">${srcOptions(f, regId, { extra: [[CUST, `Custodian (${cust})`]], cur: CUST, direct: true })}</select></div>
        <div class="field" id="g-acctbox" hidden><label for="g-acct">Bank / Account (optional)</label><input class="input" id="g-acct" value="${esc(LASTCHK.acct)}" placeholder="e.g. LBP – General Fund"></div>
        <div class="field"><label for="g-from">Serial From</label><input class="input r mono" id="g-from" inputmode="numeric" autocomplete="off"></div>
        <div class="field"><label for="g-to">Serial To</label><input class="input r mono" id="g-to" inputmode="numeric" autocomplete="off"></div>
        <div class="field"><label for="g-per">Per Booklet</label><input class="input r" id="g-per" inputmode="numeric" value="${LAST.per}"></div>
        <label class="cer-chip af-span af-nschip" id="g-nsbox" hidden><input type="checkbox" id="g-ns"> Cash tickets without serial numbers (counted by quantity)</label>
        <div class="af-span">${partBox('g', { note: `Partly used (numbers used on or before the last cash exam, ${fmtDate(asOf)}); for cash tickets without serials, type the number of pieces` })}</div>
      </div>
      <p class="af-note">Enter complete series. Everything here is the officer's beginning <b>as of the last cash exam (${esc(fmtDate(asOf))})</b>; the real date received and date issued, if known, are added later with Edit in Accountable Forms. Receipts encoded in Collections &amp; Deposits are taken out on top of this.</p>
      <div class="af-note" id="g-prev"></div>`,
    onOpen: (bg) => {
      $$('input[name="g-kind"]', bg).forEach((r) => { r.onchange = () => show(bg); });
      wireSrcSelect($('#g-srcsel', bg), refs, f, regId, () => show(bg), true);
      $$('#g-from, #g-to, #g-per, #g-form, #g-ns', bg).forEach((el) => { el.oninput = () => show(bg); el.onchange = () => show(bg); });
      $('#g-from', bg).addEventListener('change', () => { const a = int($('#g-from', bg).value), t = $('#g-to', bg); if (a && !t.value) { t.value = bookletOf(a, int($('#g-per', bg).value) || (srcNow(bg) === 'bank' ? CHK_PER : PER_BOOKLET))[1]; show(bg); } });
      wirePart('g', bg, () => show(bg)); show(bg); },
    buttons: [{ label: 'Cancel', value: null }, { label: 'Save Beginning Forms', cls: 'primary', value: 'save', check: (bg) => {
      const r = read(bg); if (r.error) { toast(r.error, 'bad'); return false; }
      plan = { ...r, acct: $('#g-acct', bg).value.trim(), other: $('#g-srcsel', bg).value }; return true; } }] });
  if (v !== 'save' || !plan) return false;
  if (!plan.ns && !(await confirmBig(plan.form, plan.parts[0].x, plan.parts[plan.parts.length - 1].y, plan.parts.length))) return false;
  if (plan.ns) { const shift = nsBase() - 1; plan.parts = plan.parts.map((s) => ({ x: s.x + shift, y: s.y + shift, unused: s.unused ? s.unused.map(([a, z]) => [a + shift, z + shift]) : null })); }
  if (plan.src === 'bank') Object.assign(LASTCHK, { acct: plan.acct, per: plan.per }); else Object.assign(LAST, { form: plan.form, per: plan.per });
  const from = { custodian: '', bank: 'Bank', direct: plan.other }[plan.src];
  const direct = plan.src !== 'custodian';
  for (const s of plan.parts) {
    // The officer's beginning as of the last cash exam: dates not yet known (added with Edit when found).
    const rec = { lguId: regId, form: plan.form, from: s.x, to: s.y, qty: s.y - s.x + 1, reference: '', status: 'issued', officerId: o.id, ...(plan.ns ? { noSerial: true } : {}),
      issuedDate: asOf, issuedAsOf: true, beginAs: 'ao', beginDate: asOf, usedBefore: null, unusedAtStart: s.unused,
      receivedDate: '', receivedFrom: from, receivedDirect: direct, source: plan.src === 'bank' ? 'officer' : 'starting',
      ...(plan.src === 'bank' ? { bankAccount: plan.acct } : {}),
      history: [hist(refs, 'starting', asOf, { officerId: o.id, note: `In the officer's hands at the last cash exam${from ? ' · from ' + from : ' · from the custodian'}${s.unused ? `, partly used: ${countRanges(s.unused)} unused` : ''} · Audit Setup` })] };
    await store.save('cer_booklets', newId('cerb'), rec, by(refs), { quiet: true });
  }
  emitChange('local');
  toast(`${plan.parts.length} ${plan.src === 'bank' ? 'checkbook' : 'booklet'}${plan.parts.length > 1 ? 's' : ''} added to ${o.name}'s beginning forms.`, 'ok');
  return true;
}
