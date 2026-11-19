// AMS · Source Documents · RCD (LGU) (design approved 20 Nov 2026).
// One RCD form may be split between Liquidating Officers (e.g. one has the barangay remittances, another the LGU's): each
// enters her part under her own name in Cash Examination › Collections & Deposits, with the same RCD No. This page lists the
// LGU's RCDs by number with each officer's part (the RCD's Collections, worked out there) and their sum, against the whole
// total per hard copy, typed here once per RCD No.
//   cer_settings 'rcdtotal|<lguId>|<RCD No. key>' { no, total }
import { store } from '../../js/store.js';
import { esc, toast, $, $$ } from '../../js/ui.js';
import { hasRole, by, mayView, agencyName, fmtDate, money, num, getPick } from '../cer/cer.js';
import { loadForms } from '../cer/forms.js';
import { figuresOf, fundsOf, tagSameDay } from '../cer/collections.js';

const r2 = (n) => Math.round((+n || 0) * 100) / 100;
const flat = (r) => ({ id: r.id, ...r.data });
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const rcdKey = (no) => String(no || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const totalId = (lguId, no) => `rcdtotal|${lguId}|${rcdKey(no)}`;

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
      grp.parts.push({ o, coll: r2(g.coll), id: g.id, fund: g.rec.fund || '' });
    }));
  });
  return [...groups.values()].map((g) => {
    const t = f.settings[totalId(lguId, g.no)], whole = t && t.total !== null && t.total !== undefined && t.total !== '' ? +t.total : null;
    const sum = r2(g.parts.reduce((n, p) => n + p.coll, 0));
    return { ...g, parts: g.parts.sort((a, b) => a.o.name.localeCompare(b.o.name)), sum, whole, diff: whole === null ? null : r2(whole - sum) };
  }).sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.no.localeCompare(b.no, undefined, { numeric: true }));
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
  const months = [...new Set(all.map((g) => String(g.date).slice(0, 7)).filter(Boolean))].sort().reverse();
  const m = q.get('m') === 'all' ? 'all' : months.includes(q.get('m')) ? q.get('m') : months[0] || 'all';
  const rows = m === 'all' ? all : all.filter((g) => String(g.date).startsWith(m));
  const mLabel = (v) => (v === 'all' ? 'All months' : `${MONTHS[+v.slice(5, 7) - 1]} ${v.slice(0, 4)}`);
  const check = (g) => (g.whole === null ? '<span class="pill">Whole total not typed</span>' : Math.abs(g.diff) < 0.005 ? '<span class="pill p-done">Agrees</span>'
    : `<span class="pill p-flag">${g.diff > 0 ? 'Short' : 'Over'} ₱${money(Math.abs(g.diff))}</span>`);
  const wholeCell = (g) => (enc ? `<input class="input mono r sd-rcdw" data-rcdno="${esc(g.no)}" inputmode="decimal" value="${g.whole === null ? '' : esc(money(g.whole))}" placeholder="0.00" aria-label="Whole total per hard copy of RCD No. ${esc(g.no)}">`
    : g.whole === null ? '<span class="dim">—</span>' : money(g.whole));
  const tip = 'Each part is the Collections of the RCD entered under that Liquidating Officer in Cash Examination › Collections & Deposits (it changes there). Only the whole total per hard copy is typed here, once per RCD No.';
  const body = `<div class="panel sd-top" style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end"><div class="field" style="min-width:240px"><label for="rc-lgu">Office</label><select class="input" id="rc-lgu">${offices.map((l) => `<option value="${esc(l.id)}" ${l.id === lgu.id ? 'selected' : ''}>${esc(agencyName(refs, l))}</option>`).join('')}</select></div>
      <div class="field"><label for="rc-m">Month</label><select class="input" id="rc-m">${[...months, 'all'].map((v) => `<option value="${esc(v)}" ${v === m ? 'selected' : ''}>${esc(mLabel(v))}</option>`).join('')}</select></div></div>
    <div class="panel" style="margin-top:14px;padding:16px 20px"><div class="cd-scdhead"><h3 class="cer-h3">RCD of ${esc(agencyName(refs, lgu))} · ${esc(mLabel(m))}</h3><span class="crumb-i" title="${esc(tip)}">ⓘ</span></div>
    ${rows.length ? `<div class="af-tbl cd-tblbox"><table class="af-reg sd-rcd"><thead><tr><th scope="col">RCD No.</th><th scope="col">Date</th><th scope="col">Liquidating Officers (their parts)</th><th scope="col" class="r">Sum of the Parts (₱)</th><th scope="col" class="r">Whole Total per Hard Copy (₱)</th><th scope="col">Check</th></tr></thead>
      <tbody>${rows.map((g) => `<tr><td><b>${esc(g.no)}</b></td><td>${esc(fmtDate(g.date))}</td><td>${g.parts.map((p) => `<div>${esc(p.o.name)} <span class="dim">· ₱ ${money(p.coll)}${g.parts.filter((x) => x.o.id === p.o.id).length > 1 && p.fund ? ' · ' + esc(p.fund) : ''}</span></div>`).join('')}</td>
        <td class="r"><b>${money(g.sum)}</b></td><td class="r">${wholeCell(g)}</td><td>${check(g)}</td></tr>`).join('')}</tbody></table></div>
      <p class="dim" style="margin:8px 0 0;font-size:12.5px">Each part comes from the RCD entered under that officer. Type the whole total once per RCD; it is the same for every officer of that RCD.</p>`
    : `<div class="empty"><b>No RCD of ${esc(agencyName(refs, lgu))} ${m === 'all' ? '' : 'in ' + esc(mLabel(m)) + ' '}yet.</b>The RCDs entered under the Liquidating Officers in Cash Examination › Collections &amp; Deposits are listed here.</div>`}</div>`;
  const go = (params) => { const p = new URLSearchParams(location.hash.split('?')[1] || ''); Object.entries(params).forEach(([k, v]) => (v ? p.set(k, v) : p.delete(k))); location.hash = '#/src/rcd?' + p.toString(); };
  const wire = () => {
    $('#rc-lgu').onchange = (e) => go({ l: e.target.value, m: '' });
    $('#rc-m').onchange = (e) => go({ m: e.target.value });
    $$('.sd-rcdw').forEach((inp) => {
      const was = inp.value;
      const save = async () => {
        const raw = inp.value.trim(), v = raw === '' ? null : num(raw);
        if (raw !== '' && (v === null || isNaN(v))) { toast('Type the amount, e.g. 633,409.79.', 'bad'); return; }
        if (raw === was) return;
        await store.save('cer_settings', totalId(lgu.id, inp.dataset.rcdno), { no: inp.dataset.rcdno, total: v }, by(refs));
        toast(v === null ? 'Whole total cleared.' : `Whole total of RCD No. ${inp.dataset.rcdno} saved.`, 'ok');
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      };
      inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } else if (e.key === 'Escape') { inp.value = was; inp.blur(); } };
      inp.onchange = save;
    });
  };
  return { body, wire };
}
