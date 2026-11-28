// AMS · Source Documents · RCD (LGU) (design approved 20 Nov 2026).
// One RCD form may be split between Liquidating Officers (e.g. one has the barangay remittances, another the LGU's): each
// enters her part under her own name in Cash Examination › Collections & Deposits, with the same RCD No. This page lists the
// LGU's RCDs by number with each officer's part (the RCD's Collections, worked out there) and their sum, against the whole
// total per hard copy, typed here once per RCD No. An RCD can also be added here from the hard copy (+ RCD or Import from
// Excel: RCD No., date, whole total) before any officer's part is entered: the list is then a checklist of the RCDs.
// The date typed here decides the month the RCD is listed in; an officer's RCD of another date is flagged.
//   cer_settings 'rcdtotal|<lguId>|<RCD No. key>' { no, total, date, type }
// type: 'col' (default: collections, the officers' parts are their Collections) · 'dep' (deposits only: the parts are the
// deposits the officers recorded under this RCD No.) · 'bank' (directly transferred to the bank: no officer's part; checked
// against the imported bank statements for a credit of the whole total on or near its date).
import { store } from '../../js/store.js';
import { esc, toast, modal, $, $$ } from '../../js/ui.js';
import { hasRole, by, mayView, agencyName, fmtDate, money, num, getPick } from '../cer/cer.js';
import { loadForms, loadXlsx, excelDate, exportXlsx } from '../cer/forms.js';
import { figuresOf, fundsOf, tagSameDay } from '../cer/collections.js';

const r2 = (n) => Math.round((+n || 0) * 100) / 100;
const flat = (r) => ({ id: r.id, ...r.data });
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const rcdKey = (no) => String(no || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const totalId = (lguId, no) => `rcdtotal|${lguId}|${rcdKey(no)}`;
// Bank transfer RCDs: the collectors' RCDs marked "Credited to bank" (Collections & Deposits) ticked into it (bankReps: their ids).
// Each one's amount is its ORs; each is looked for in the bank statements (a credit of that amount within 15 days).
const repAmt = (f, r) => r2((f.ors || []).filter((x) => x.reportId === r.id && x.status !== 'cancelled').reduce((n, x) => n + r2((x.items || []).reduce((t, i) => t + (+i.amt || 0), 0)), 0));
const bankRepsOf = (f, lguId) => (f.reports || []).filter((r) => !r.pending && r.bankCredit && r.bankCredit.on && (f.officers || []).some((o) => o.id === r.officerId && o.lguId === lguId));
const tickedIn = (f, lguId) => { const m = new Map(); Object.entries(f.settings || {}).forEach(([id, t]) => { if (id.startsWith(`rcdtotal|${lguId}|`) && t && t.no) (t.bankReps || []).forEach((rid) => m.set(rid, t.no)); }); return m; };

// The RCDs of an LGU's Liquidating Officers grouped by RCD No.: [{ key, no, date, parts[{ o, coll, id }], sum, whole, diff }].
export function rcdGroups(refs, f, lguId) {
  const lgu = refs.lgu[lguId]; if (!lgu || lgu.data.kind === 'barangay') return [];
  const isLO = (o) => (f.exams || []).some((e) => e.officerId === o.id && (e.functions || []).includes('liquidating'));
  const offs = (f.officers || []).filter((o) => o.lguId === lguId);
  const los = offs.filter(isLO);
  const funds = fundsOf(f, lguId), groups = new Map();
  (los.length ? los : offs).forEach((o) => {
    if (!f.reports.some((r) => r.officerId === o.id && !r.pending && String(r.no || '').trim())) return;
    const fig = figuresOf(f, o, funds, '9999-12-31', lgu, null);
    Object.values(fig.chains).forEach((ch) => ch.figs.forEach((g) => {
      const no = String(g.rec.no || '').trim(); if (!no) return;
      const k = rcdKey(no), grp = groups.get(k) || { key: k, no, date: g.rec.date || '', parts: [] };
      groups.set(k, grp);
      if (g.rec.date && (!grp.date || g.rec.date < grp.date)) grp.date = g.rec.date;
      grp.parts.push({ o, coll: r2(g.coll), dep: r2(g.dep), id: g.id, fund: g.rec.fund || '', date: g.rec.date || '' });
    }));
  });
  // RCDs added here from the hard copy (with or without officers' parts yet).
  Object.entries(f.settings || {}).filter(([id, t]) => id.startsWith(`rcdtotal|${lguId}|`) && t && t.no).forEach(([, t]) => {
    const k = rcdKey(t.no); if (!groups.has(k)) groups.set(k, { key: k, no: t.no, date: '', parts: [] }); });
  return [...groups.values()].map((g) => {
    const t = f.settings[totalId(lguId, g.no)] || null, whole = t && t.total !== null && t.total !== undefined && t.total !== '' ? +t.total : null;
    const type = (t && t.type) || 'col';
    g.parts.forEach((p) => { p.amt = type === 'dep' ? p.dep : p.coll; });
    // Bank transfer: its parts are the collectors' RCDs credited to bank ticked into it.
    const bparts = type === 'bank' ? ((t && t.bankReps) || []).map((rid) => f.reports.find((r) => r.id === rid)).filter(Boolean).map((r) => ({ r, o: (f.officers || []).find((x) => x.id === r.officerId) || { name: '—' }, amt: repAmt(f, r) })) : [];
    const sum = type === 'bank' ? (bparts.length ? r2(bparts.reduce((n, p) => n + p.amt, 0)) : null) : r2(g.parts.reduce((n, p) => n + p.amt, 0));
    const date = (t && t.date) || g.date;
    // An officer's RCD dated differently from the hard copy (the date typed here).
    const offDate = t && t.date ? g.parts.filter((p) => p.date && p.date !== t.date) : [];
    // Its fund: typed here (+ RCD / Edit), else that of the officers' RCDs (or of the collectors' RCDs ticked into a bank transfer).
    const fund = (t && t.fund) || g.parts.find((p) => p.fund)?.fund || bparts.find((p) => p.r.fund)?.r.fund || '';
    return { ...g, date, fund, reg: !!t, regDate: (t && t.date) || '', offDate, parts: g.parts.sort((a, b) => a.o.name.localeCompare(b.o.name)), bparts, type, sum, whole, diff: whole === null || sum === null ? null : r2(whole - sum) };
  }).sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.no.localeCompare(b.no, undefined, { numeric: true }));
}

// The credits of the bank statements imported for this LGU's cash exams (Bank Statements): [{ date, credit, desc }].
async function bankCreditsOf(f, lguId) {
  const auds = new Set((f.audits || []).filter((a) => a.lguId === lguId).map((a) => a.id));
  const recs = (await store.list('cer_bankrec')).map(flat);
  const mine = (id) => auds.has(String(id || '').split('|')[0]);
  const out = [];
  recs.forEach((r) => { if (r.part ? mine(r.recId) : mine(String(r.id).split('#')[0])) (r.lines || []).forEach((l) => { if (+l.credit > 0) out.push(l); }); });
  return out;
}
export async function rcdView(ctx) {
  const { refs, q } = ctx;
  const enc = hasRole(refs, 'staff', 'member', 'atl', 'sa', 'admin');
  const f = await loadForms();
  f.reports = tagSameDay((await store.list('cer_reports')).map(flat));
  const offices = Object.values(refs.lgu).filter((l) => (l.data.kind === 'municipality' || l.data.kind === 'province') && mayView(refs, l))
    .sort((a, b) => (a.data.kind === 'province' ? -1 : b.data.kind === 'province' ? 1 : a.data.name.localeCompare(b.data.name)));
  if (!offices.length) return { body: '<div class="panel"><div class="empty"><b>No LGU assigned to you.</b></div></div>' };
  // Opens on the LGU of the cash examination being worked on, else the first one.
  const pa = (f.audits || []).find((a) => a.id === getPick().a), pl = pa && refs.lgu[pa.lguId];
  const pm = pl ? (pl.data.kind === 'barangay' ? pl.data.parentId : pl.id) : '';
  const lgu = offices.find((l) => l.id === q.get('l')) || offices.find((l) => l.id === pm) || offices[0];
  const all = rcdGroups(refs, f, lgu.id);
  // Bank transfer RCDs: a credit of the whole total in the imported bank statements of this LGU's cash exams, on or near its date.
  const bankLines = await bankCreditsOf(f, lgu.id);
  const bankHit = (g) => { if (g.whole === null || !g.date) return null; const c = bankLines.filter((l) => Math.abs((+l.credit || 0) - g.whole) < 0.005 && l.date && Math.abs(Date.parse(l.date) - Date.parse(g.date)) <= 15 * 864e5);
    return c.sort((a, b) => Math.abs(Date.parse(a.date) - Date.parse(g.date)) - Math.abs(Date.parse(b.date) - Date.parse(g.date)))[0] || false; };
  const months = [...new Set(all.map((g) => String(g.date).slice(0, 7)).filter(Boolean))].sort().reverse();
  const m = q.get('m') === 'all' ? 'all' : months.includes(q.get('m')) ? q.get('m') : months[0] || 'all';
  // Fund: one fund, or all of them in sections (General Fund first, then in the order of the bank accounts).
  const fundList = (() => { const fl = fundsOf(f, lgu.id), extra = [...new Set(all.map((g) => g.fund).filter((x) => x && !fl.includes(x)))]; return [...fl, ...extra]; })();
  const fd = fundList.includes(q.get('fd')) ? q.get('fd') : 'all';
  const rows0 = m === 'all' ? all : all.filter((g) => String(g.date).startsWith(m));
  const rows = fd === 'all' ? rows0 : rows0.filter((g) => g.fund === fd);
  const mLabel = (v) => (v === 'all' ? 'All months' : `${MONTHS[+v.slice(5, 7) - 1]} ${v.slice(0, 4)}`);
  const hitOf = (amt, d) => bankLines.filter((l) => Math.abs((+l.credit || 0) - amt) < 0.005 && l.date && Math.abs(Date.parse(l.date) - Date.parse(d)) <= 15 * 864e5).sort((a, b) => Math.abs(Date.parse(a.date) - Date.parse(d)) - Math.abs(Date.parse(b.date) - Date.parse(d)))[0] || false;
  // The bank credits typed on the collector's RCD: each looked for; none typed: one credit of the whole.
  const partBank = (p) => { const cr = (p.r.bankCredit?.credits || []).filter((c) => c.date && +c.amount > 0);
    if (!cr.length) { const h = partHit(p); return h ? `<span class="pill p-done" title="${esc(h.desc || '')}">Bank ${esc(fmtDate(h.date))}</span>` : '<span class="pill p-flag">Not in the bank statement</span>'; }
    const miss = cr.filter((c) => !hitOf(+c.amount, c.date));
    return miss.length ? `<span class="pill p-flag" title="${esc('Not found: ' + miss.map((c) => `${fmtDate(c.date)} ₱${money(c.amount)}`).join('; '))}">Bank: ${cr.length - miss.length} of ${cr.length} credits found</span>` : `<span class="pill p-done">Bank: ${cr.length} of ${cr.length} credits found</span>`; };
  const partHit = (p) => { const d = p.r.date; if (!d) return null; const c = bankLines.filter((l) => Math.abs((+l.credit || 0) - p.amt) < 0.005 && l.date && Math.abs(Date.parse(l.date) - Date.parse(d)) <= 15 * 864e5);
    return c.sort((a, b) => Math.abs(Date.parse(a.date) - Date.parse(d)) - Math.abs(Date.parse(b.date) - Date.parse(d)))[0] || false; };
  const waiting = (() => { const tk = tickedIn(f, lgu.id); return bankRepsOf(f, lgu.id).filter((r) => !tk.has(r.id)); })();
  const bankCell = (g) => `${g.bparts.length ? g.bparts.map((p) => { return `<div>${esc(p.o.name)} <span class="dim">· RCD No. ${esc(p.r.no || '—')} · ₱ ${money(p.amt)}</span> ${partBank(p)}</div>`; }).join('') : '<span class="dim">Directly transferred to the bank</span>'}
    ${enc ? `<div style="margin-top:4px"><button class="btn sm" type="button" data-rcbank="${esc(g.no)}">Tick from the app · ${waiting.length} waiting</button></div>` : ''}`;
  const check = (g) => g.type === 'bank' && g.bparts.length ? (g.whole === null ? '<span class="pill">Whole total not typed</span>' : Math.abs(g.diff) < 0.005 ? '<span class="pill p-done">Agrees</span>' : `<span class="pill p-flag">${g.diff > 0 ? 'Short' : 'Over'} ₱${money(Math.abs(g.diff))}</span>`)
    : g.type === 'bank' ? (g.whole === null ? '<span class="pill">Whole total not typed</span>' : (() => { const h = bankHit(g); return h ? `<span class="pill p-done" title="${esc(h.desc || '')}">Found in the bank statement · ${esc(fmtDate(h.date))}</span>` : '<span class="pill p-flag">Not found in the bank statement</span>'; })()) : `${g.type === 'dep' ? '<span class="pill">Deposits only</span> ' : ''}${!g.parts.length ? '<span class="pill p-flag">No officer\'s part yet</span> ' : ''}${g.whole === null ? '<span class="pill">Whole total not typed</span>' : Math.abs(g.diff) < 0.005 ? '<span class="pill p-done">Agrees</span>'
    : `<span class="pill p-flag">${g.diff > 0 ? 'Short' : 'Over'} ₱${money(Math.abs(g.diff))}</span>`}${g.offDate.length ? ` <span class="pill p-flag" title="${esc(`Hard copy: ${fmtDate(g.regDate)}\n` + g.offDate.map((p) => `${p.o.name}: ${fmtDate(p.date)}`).join('\n'))}">Date differs ⓘ</span>` : ''}`;
  const wholeCell = (g) => (enc ? `<input class="input mono r sd-rcdw" data-rcdno="${esc(g.no)}" inputmode="decimal" value="${g.whole === null ? '' : esc(money(g.whole))}" placeholder="0.00" aria-label="Whole total per hard copy of RCD No. ${esc(g.no)}">`
    : g.whole === null ? '<span class="dim">—</span>' : money(g.whole));
  // All funds: one section per fund (heading, its RCDs, subtotal); one fund shown, or only one in the month: as a plain list.
  const secs = (rowFn) => {
    const fs = [...new Set(rows.map((g) => g.fund))], ord = [...fundList.filter((x) => fs.includes(x)), ...fs.filter((x) => !fundList.includes(x))];
    if (fd !== 'all' || ord.length < 2) return rows.map(rowFn).join('');
    const n = enc ? 7 : 6;
    return ord.map((fu) => { const gs = rows.filter((g) => g.fund === fu), sum = r2(gs.reduce((t, g) => t + (g.sum || 0), 0)), wh = r2(gs.reduce((t, g) => t + (g.whole || 0), 0));
      return `<tr class="rc-fundh"><td colspan="${n}"><b>${esc((fu || 'No fund').toUpperCase())}</b></td></tr>${gs.map(rowFn).join('')}
        <tr class="rc-fundt"><td colspan="3">Subtotal, ${esc(fu || 'No fund')}</td><td class="r">${money(sum)}</td><td class="r">${money(wh)}</td><td colspan="${n - 5}"></td></tr>`; }).join('');
  };
  const tip = 'Each part is the Collections of the RCD entered under that Liquidating Officer in Cash Examination › Collections & Deposits (it changes there). Typed here, from the hard copy: the RCD No., its date and the whole total (+ RCD or Import from Excel), once per RCD No.';
  const body = `<div class="panel sd-top" style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end"><div class="field" style="min-width:240px"><label for="rc-lgu">Office</label><select class="input" id="rc-lgu">${offices.map((l) => `<option value="${esc(l.id)}" ${l.id === lgu.id ? 'selected' : ''}>${esc(agencyName(refs, l))}</option>`).join('')}</select></div>
      <div class="field"><label for="rc-fd">Fund</label><select class="input" id="rc-fd"><option value="all" ${fd === 'all' ? 'selected' : ''}>All funds</option>${fundList.map((x) => `<option value="${esc(x)}" ${x === fd ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
      <div class="field"><label for="rc-m">Month</label><select class="input" id="rc-m">${[...months, 'all'].map((v) => `<option value="${esc(v)}" ${v === m ? 'selected' : ''}>${esc(mLabel(v))}</option>`).join('')}</select></div></div>
    <div class="panel" style="margin-top:14px;padding:16px 20px"><div class="cd-scdhead"><h3 class="cer-h3">RCD of ${esc(agencyName(refs, lgu))} · ${esc(mLabel(m))}</h3><span class="crumb-i" title="${esc(tip)}">ⓘ</span>
      ${enc ? '<div class="btn-row" style="margin-left:auto"><button class="btn primary" type="button" id="rc-add">+ RCD</button><button class="btn" type="button" id="rc-imp">Import from Excel</button><a href="#" class="cd-link" id="rc-tpl" style="align-self:center;margin-left:6px">Template</a></div>' : ''}</div>
    ${rows.length ? `<div class="af-tbl cd-tblbox"><table class="af-reg sd-rcd"><thead><tr><th scope="col">RCD No.</th><th scope="col">Date</th><th scope="col">Liquidating Officers (their parts)</th><th scope="col" class="r">Sum of the Parts (₱)</th><th scope="col" class="r">Whole Total per Hard Copy (₱)</th><th scope="col">Check</th>${enc ? '<th scope="col"></th>' : ''}</tr></thead>
      <tbody>${secs((g) => `<tr><td><b>${esc(g.no)}</b></td><td>${esc(fmtDate(g.date))}</td><td>${g.type === 'bank' ? bankCell(g) : g.parts.length ? g.parts.map((p) => `<div>${esc(p.o.name)} <span class="dim">· ₱ ${money(p.amt)}${g.type === 'dep' ? ' deposited' : ''}${g.parts.filter((x) => x.o.id === p.o.id).length > 1 && p.fund ? ' · ' + esc(p.fund) : ''}</span></div>`).join('') : '<span class="dim">Not yet entered under an officer</span>'}</td>
        <td class="r"><b>${g.sum === null ? '<span class="dim">—</span>' : money(g.sum)}</b></td><td class="r">${wholeCell(g)}</td><td>${check(g)}</td>${enc ? `<td><button class="btn sm" type="button" data-rcded="${esc(g.no)}">Edit</button></td>` : ''}</tr>`)}</tbody></table></div>
      <p class="dim" style="margin:8px 0 0;font-size:12.5px">Each part comes from the RCD entered under that officer. Type the whole total once per RCD; it is the same for every officer of that RCD.</p>`
    : `<div class="empty"><b>No RCD of ${esc(agencyName(refs, lgu))} ${m === 'all' ? '' : 'in ' + esc(mLabel(m)) + ' '}yet.</b>The RCDs entered under the Liquidating Officers in Cash Examination › Collections &amp; Deposits are listed here.</div>`}</div>`;
  const go = (params) => { const p = new URLSearchParams(location.hash.split('?')[1] || ''); Object.entries(params).forEach(([k, v]) => (v ? p.set(k, v) : p.delete(k))); location.hash = '#/src/rcd?' + p.toString(); };
  const wire = () => {
    $('#rc-lgu').onchange = (e) => go({ l: e.target.value, m: '' });
    $('#rc-m').onchange = (e) => go({ m: e.target.value });
    $('#rc-fd').onchange = (e) => go({ fd: e.target.value === 'all' ? '' : e.target.value });
    $$('.sd-rcdw').forEach((inp) => {
      const was = inp.value;
      const save = async () => {
        const raw = inp.value.trim(), v = raw === '' ? null : num(raw);
        if (raw !== '' && (v === null || isNaN(v))) { toast('Type the amount, e.g. 633,409.79.', 'bad'); return; }
        if (raw === was) return;
        const old = f.settings[totalId(lgu.id, inp.dataset.rcdno)] || {};
        await store.save('cer_settings', totalId(lgu.id, inp.dataset.rcdno), { ...old, no: old.no || inp.dataset.rcdno, total: v }, by(refs));
        toast(v === null ? 'Whole total cleared.' : `Whole total of RCD No. ${inp.dataset.rcdno} saved.`, 'ok');
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      };
      inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } else if (e.key === 'Escape') { inp.value = was; inp.blur(); } };
      inp.onchange = save;
    });
  };
  const wire2 = () => {
    wire();
    const a = $('#rc-add'); if (a) a.onclick = () => rcdModal(refs, f, lgu, all, null);
    $$('[data-rcded]').forEach((b) => { b.onclick = () => rcdModal(refs, f, lgu, all, all.find((g) => g.no === b.dataset.rcded)); });
    const im = $('#rc-imp'); if (im) im.onclick = () => importRcd(refs, f, lgu, all);
    $$('[data-rcbank]').forEach((b) => { b.onclick = () => bankTick(refs, f, lgu, all.find((g) => g.no === b.dataset.rcbank)); });
    const tp = $('#rc-tpl'); if (tp) tp.onclick = (e) => { e.preventDefault(); exportXlsx('RCD template.xlsx', 'RCD', [{ 'RCD No.': '2026-101-02-0018', Date: '02/27/2026', Total: 483743.09 }]); };
  };
  return { body, wire: wire2 };
}

// Tick from the app: the collectors' RCDs credited to bank, not yet in another RCD; those ticked are this RCD's parts.
async function bankTick(refs, f, lgu, g) {
  const id = totalId(lgu.id, g.no), t = f.settings[id] || { no: g.no, type: 'bank' }, mine = new Set(t.bankReps || []), tk = tickedIn(f, lgu.id);
  const list = bankRepsOf(f, lgu.id).filter((r) => mine.has(r.id) || !tk.has(r.id)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const name = (r) => (f.officers || []).find((o) => o.id === r.officerId)?.name || '—';
  const v = await modal({ title: `RCD No. ${g.no} · Collectors' RCDs credited to bank`, wide: true,
    body: list.length ? `<div class="af-tbl"><table class="af-reg"><thead><tr><th></th><th>Date</th><th>Collector</th><th>Their RCD</th><th>Reference</th><th class="r">Amount (₱)</th></tr></thead><tbody>${list.map((r) => `<tr><td><input type="checkbox" class="rb-k" value="${esc(r.id)}" ${mine.has(r.id) ? 'checked' : ''}></td><td>${esc(fmtDate(r.date))}</td><td>${esc(name(r))}</td><td class="mono">${esc(r.no || '—')}</td><td class="mono">${esc(r.bankCredit.ref || '')}</td><td class="r">${money(repAmt(f, r))}</td></tr>`).join('')}</tbody></table></div>
      <p class="af-note">Tick those listed on the hard copy of this RCD. A collector's RCD is marked "Credited to bank" in Collections &amp; Deposits (Edit the RCD).</p>`
      : '<p style="margin:0">No collector\'s RCD marked "Credited to bank" is waiting. Mark it in Collections &amp; Deposits: open the collector\'s RCD, Edit, Collections are: Credited to bank.</p>',
    buttons: [{ label: 'Cancel', value: null }, ...(list.length ? [{ label: 'Save', cls: 'primary', value: 'ok', check: (bg) => { t.bankReps = $$('.rb-k', bg).filter((x) => x.checked).map((x) => x.value); return true; } }] : [])] });
  if (v !== 'ok') return;
  await store.save('cer_settings', id, { ...t, no: t.no || g.no, type: 'bank' }, by(refs));
  toast(`RCD No. ${g.no}: ${t.bankReps.length} collector RCD${t.bankReps.length === 1 ? '' : 's'} ticked.`, 'ok');
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}
// + RCD / Edit: the RCD No., date and whole total per hard copy.
async function rcdModal(refs, f, lgu, all, g) {
  const t = g ? f.settings[totalId(lgu.id, g.no)] || {} : {};
  const bad = (m) => { toast(m, 'bad'); return false; };
  let out = null;
  const v = await modal({ title: g ? `RCD No. ${g.no}` : '+ RCD · from the hard copy',
    body: `<div class="cd-g2"><div class="field"><label for="rq-no">RCD No.</label><input class="input mono" id="rq-no" autocomplete="off" value="${esc(g ? g.no : '')}" ${g && g.parts.length ? 'readonly title="Entered under the officers with this number"' : ''}></div>
      <div class="field"><label for="rq-date">Date</label><input class="input" type="date" id="rq-date" value="${esc(t.date || (g ? g.date : ''))}"></div>
      <div class="field"><label for="rq-fund">Fund</label><select class="input" id="rq-fund">${[...new Set([...fundsOf(f, lgu.id), ...(t.fund || (g && g.fund) ? [t.fund || g.fund] : [])])].map((x) => `<option value="${esc(x)}" ${(t.fund || (g && g.fund) || '') === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
      <div class="field"><label for="rq-type">Type</label><select class="input" id="rq-type">${[['col', 'Collections'], ['dep', 'Deposits only'], ['bank', 'Bank transfer']].map(([k, l]) => `<option value="${k}" ${(t.type || 'col') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label for="rq-tot">Whole Total per Hard Copy (₱)</label><input class="input r" id="rq-tot" inputmode="decimal" value="${t.total !== undefined && t.total !== null && t.total !== '' ? esc(money(t.total)) : ''}" placeholder="0.00"></div></div>
      <p class="af-note">${g && g.parts.length ? 'The RCD No. is the one the officers entered; change it in their Collections &amp; Deposits.' : 'The officers\' parts join this line when they enter this RCD No. in Collections &amp; Deposits.'}</p>`,
    buttons: [...(g && g.reg ? [{ label: 'Delete', value: 'del' }] : []), { label: 'Cancel', value: null }, { label: 'Save', cls: 'primary', value: 'ok', check: (bg) => {
      const no = $('#rq-no', bg).value.trim(), date = $('#rq-date', bg).value, raw = $('#rq-tot', bg).value.trim(), tot = raw === '' ? null : num(raw);
      if (!no) return bad('Type the RCD No.');
      if (!date) return bad('Enter the date of the RCD.');
      if (raw !== '' && (tot === null || isNaN(tot))) return bad('Type the whole total, e.g. 483,743.09.');
      if ((!g || rcdKey(no) !== g.key) && all.some((x) => x.key === rcdKey(no))) return bad(`RCD No. ${no} is already listed. Edit that line.`);
      out = { no, date, total: tot, type: $('#rq-type', bg).value, fund: $('#rq-fund', bg).value }; return true; } }] });
  if (v === 'del') {
    if (!(await modal({ title: 'Delete this RCD?', body: `<p style="margin:0">Remove RCD No. ${esc(g.no)} typed here (its date and whole total)? The officers' RCDs stay in Collections &amp; Deposits.</p>`,
      buttons: [{ label: 'Cancel', value: false }, { label: 'Delete', cls: 'primary', value: true }] }))) return;
    await store.save('cer_settings', totalId(lgu.id, g.no), t, by(refs), { deleted: true });
    toast(`RCD No. ${g.no} removed.`, 'ok'); window.dispatchEvent(new HashChangeEvent('hashchange')); return;
  }
  if (!out) return;
  if (g && g.reg && rcdKey(out.no) !== g.key) await store.save('cer_settings', totalId(lgu.id, g.no), t, by(refs), { deleted: true });
  { const keep = t.bankReps && out.type === 'bank' ? { bankReps: t.bankReps } : {};
    await store.save('cer_settings', totalId(lgu.id, out.no), { no: out.no, date: out.date, total: out.total, ...(out.type && out.type !== 'col' ? { type: out.type } : {}), ...(out.fund ? { fund: out.fund } : {}), ...keep }, by(refs)); }
  toast(`RCD No. ${out.no} saved.`, 'ok');
  location.hash = `#/src/rcd?l=${lgu.id}&m=${out.date.slice(0, 7)}`;
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

// Import from Excel: columns RCD No., Date, Total (any order; the first row with them is the header). Adds new RCDs and
// updates the date and total of those already listed.
async function importRcd(refs, f, lgu, all) {
  const pick = document.createElement('input'); pick.type = 'file'; pick.accept = '.xlsx,.xls,.csv';
  pick.onchange = async () => {
    const file = pick.files[0]; if (!file) return;
    try {
      const XLSX = await loadXlsx(), wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
      const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z]/g, '');
      const hi = rows.findIndex((r) => r.some((c) => norm(c).startsWith('rcd')) && r.some((c) => norm(c).includes('total') || norm(c).includes('amount')));
      if (hi < 0) { toast('No header row with RCD No. and Total found. Use the Template.', 'bad'); return; }
      const h = rows[hi].map(norm), cNo = h.findIndex((c) => c.startsWith('rcd')), cD = h.findIndex((c) => c.includes('date')), cT = h.findIndex((c) => c.includes('total') || c.includes('amount'));
      const list = [], errs = [];
      rows.slice(hi + 1).forEach((r, i) => {
        const no = String(r[cNo] ?? '').trim(); if (!no) return;
        const date = cD >= 0 ? excelDate(XLSX, r[cD]) : '', tot = typeof r[cT] === 'number' ? r[cT] : num(r[cT]);
        if (!date) errs.push(`Row ${hi + i + 2}: no date for RCD No. ${no}`);
        else if (tot === null || isNaN(tot)) errs.push(`Row ${hi + i + 2}: no total for RCD No. ${no}`);
        else list.push({ no, date, total: r2(tot) });
      });
      if (!list.length) { toast(errs[0] || 'No RCD rows found.', 'bad'); return; }
      const isNew = (x) => !all.some((g) => g.key === rcdKey(x.no) && g.reg);
      const nNew = list.filter(isNew).length;
      const ok = await modal({ title: 'Import RCDs', body: `<p style="margin:0 0 8px">${list.length} RCD${list.length > 1 ? 's' : ''} read: <b>${nNew} new</b>, ${list.length - nNew} already listed (date and total updated).</p>
          ${errs.length ? `<p class="af-note" style="color:#a15c00">${errs.length} row${errs.length > 1 ? 's' : ''} skipped: ${esc(errs.slice(0, 5).join('; '))}${errs.length > 5 ? '…' : ''}</p>` : ''}`,
        buttons: [{ label: 'Cancel', value: false }, { label: 'Import', cls: 'primary', value: true }] });
      if (!ok) return;
      for (const x of list) { const old = f.settings[totalId(lgu.id, x.no)] || {}; await store.save('cer_settings', totalId(lgu.id, x.no), { ...old, no: x.no, date: x.date, total: x.total }, by(refs), { quiet: true }); }
      toast(`${list.length} RCD${list.length > 1 ? 's' : ''} imported.`, 'ok');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (e) { toast(e.message || String(e), 'bad'); }
  };
  pick.click();
}
