// Source Documents · Liquidation Journal (design approved 5 Nov 2026).
// Each liquidation of a cash advance: Debit the expenses (account code, title, amount), Credit the Advances account of the
// check. A refund: Debit Cash Local Treasury (OR No.), Credit the Advances account. The same records as the liquidations in
// Cash Examination, Cash Advances (cer_liquid): entered in either place, shown in both, never typed twice.
//
//   cer_liquid  { lguId, officerId, date, ref (LR No.; refund: OR No.), particulars ('' = "Liquidation of cash advance under
//                 Check No. …"), amount (= the debits), advanceId, type: 'liq' | 'refund', lines: [{ code, name, amount }]
//                 (the debits of a liquidation), credit (the Advances account code), countAnyway }
// Shown under the bank account of the cash advance check (from the CkDJ, else its checkbook), for the month of the liquidation.
import { store, newId, emitChange } from '../../js/store.js';
import { esc, modal, toast, $, $$ } from '../../js/ui.js';
import { by, agencyName, fmtDate, money, num } from '../cer/cer.js';
import { loadXlsx, excelDate } from '../cer/forms.js';
import { caAcct } from '../cer/funds.js';
import { liqText } from '../cer/advances.js';
import { listAdvances, CA_CODES, chkNo } from './journal.js';
import { outButtons, wireOut } from './rciout.js';
import { focusAfter } from './focus.js';

const r2 = (n) => Math.round((+n || 0) * 100) / 100;
const flat = (r) => ({ id: r.id, ...r.data });
const strip = (x) => { const { id, ...rest } = x; return rest; };
const bad = (m) => { toast(m, 'bad'); return false; };
const CASH = '1-01-01-010';
const ADV_DEFAULT = '1-03-03-020';
const LQ = { key: '', id: '', d: null };   // the liquidation in the entry line (kept across redraws)
const blank = (type = 'liq', date = '') => ({ type, date, ref: '', advanceId: '', lines: [{ code: '', amount: '' }], credit: '' });
const lastDayOf = (m) => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate();
const dateIn = (m, v) => { const n = parseInt(String(v || '').trim(), 10); return n >= 1 && n <= lastDayOf(m) ? `${m}-${String(n).padStart(2, '0')}` : ''; };
export const debitsOf = (l) => (l.type === 'refund' ? [{ code: CASH, amount: r2(l.amount) }] : (l.lines || []));
const noEntryL = (l) => l.type !== 'refund' && !(l.lines || []).length;
// A liquidation loaded in the entry line; with no entry yet, the debit amount starts as the liquidation amount.
const loadL = (l, credit) => ({ type: l.type === 'refund' ? 'refund' : 'liq', date: l.date, ref: l.ref || '', advanceId: l.advanceId, credit,
  lines: l.type === 'refund' ? [{ code: CASH, amount: l.amount }] : (l.lines && l.lines.length ? l.lines.map((x) => ({ code: x.code, amount: x.amount })) : [{ code: '', amount: l.amount }]) });
const goM = (mm) => { const q = new URLSearchParams(location.hash.split('?')[1] || ''); q.set('m', mm); location.hash = '#/src?' + q.toString(); };
const sumOf = (ls) => r2(ls.reduce((n, x) => n + (+x.amount || 0), 0));

export async function liqView(c) {
  const { refs, lgu, acct, accounts, m, coa, names, jr, books, enc, monthLabel, acctLabel, rerender } = c;
  const [advs0, liqs0, officers0] = await Promise.all([listAdvances(), store.list('cer_liquid'), store.list('cer_officers')]);
  const officers = Object.fromEntries(officers0.map((r) => [r.id, r.data.name]));
  const ctxF = { booklets: books, accounts };
  const jrOf = (a) => (a.fromJournal ? jr.find((x) => x.id === a.fromJournal) : jr.find((x) => x.lguId === a.lguId && chkNo(x.checkNo) === chkNo(a.checkNo) && !x.cancelled)) || null;
  const liqsAll = liqs0.map(flat).filter((l) => l.lguId === lgu.id);
  // The cash advances of this office with the account of their check, the Advances account (from the CkDJ) and the balance.
  const advs = advs0.map(flat).filter((a) => a.lguId === lgu.id).map((a) => {
    const j = jrOf(a), caLine = j && (j.lines || []).find((l) => CA_CODES.includes(l.code));
    const ac = (j && accounts.find((x) => x.id === j.acctId)) || caAcct(a, ctxF);
    const liq = sumOf(liqsAll.filter((l) => l.advanceId === a.id));
    return { ...a, acctId: ac ? ac.id : '', credit: caLine ? caLine.code : '', inCkdj: !!j, bal: r2((+a.amount || 0) - liq), officer: officers[a.officerId] || '' };
  });
  const advOf = (id) => advs.find((a) => a.id === id) || null;
  // A liquidation's account: that of its check; the beginning balance (not itemized) and unknown checks: the first account.
  const acctOfLiq = (l) => { const a = advOf(l.advanceId); return (a && a.acctId) || accounts[0]?.id || ''; };
  const list = liqsAll.filter((l) => acctOfLiq(l) === acct.id && String(l.date || '').startsWith(m))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.ref).localeCompare(String(b.ref), undefined, { numeric: true }));
  const mine = advs.filter((a) => a.acctId === acct.id).sort((a, b) => String(a.date).localeCompare(String(b.date)) || chkNo(a.checkNo) - chkNo(b.checkNo));
  const creditOf = (l) => l.credit || advOf(l.advanceId)?.credit || '';
  const acctTxt = (code) => (code ? `${code} ${names[code] || ''}`.trim() : '');
  const forTxt = (l) => { const a = advOf(l.advanceId); return l.advanceId === '__beg' ? 'Beginning balance' : a ? a.checkNo : ''; };
  const flagsOf = (l) => {
    const a = advOf(l.advanceId), deb = debitsOf(l);
    return [l.type !== 'refund' && !deb.length ? 'No entry yet' : '', l.type !== 'refund' && deb.length && Math.abs(sumOf(deb) - r2(l.amount)) > 0.004 ? `Debits ₱${money(sumOf(deb))} ≠ amount` : '',
      a && a.bal < -0.004 ? `More than the cash advance (₱${money(-a.bal)} over)` : '', l.advanceId !== '__beg' && !a ? 'Check not found' : '',
      a && !a.inCkdj && !a.beg ? 'Check not in the CkDJ' : '', !creditOf(l) ? 'Credit account: choose' : ''].filter(Boolean);
  };
  const total = sumOf(list);

  // The entry line (one liquidation), like the CkDJ line.
  const key = `${lgu.id}|${acct.id}|${m}`;
  if (LQ.key !== key) Object.assign(LQ, { key, id: '', d: null });
  if (LQ.id && !list.some((l) => l.id === LQ.id)) Object.assign(LQ, { id: '', d: null });
  if (!LQ.d) LQ.d = blank();
  const d = LQ.d, editing = !!LQ.id, isRf = d.type === 'refund';
  const advLabel = (a) => `${a.checkNo} · ${a.officer || 'no officer'} · ₱${money(a.bal + (editing && a.id === d.advanceId ? r2(list.find((l) => l.id === LQ.id)?.amount) : 0))} left`;
  const open = mine.filter((a) => a.bal > 0.004 || a.id === d.advanceId), done = mine.filter((a) => !open.includes(a));
  const forOpts = `<option value="">— Check No. —</option>${open.map((a) => `<option value="${esc(a.id)}" ${a.id === d.advanceId ? 'selected' : ''}>${esc(advLabel(a))}</option>`).join('')}${done.length ? `<optgroup label="Fully liquidated">${done.map((a) => `<option value="${esc(a.id)}" ${a.id === d.advanceId ? 'selected' : ''}>${esc(advLabel(a))}</option>`).join('')}</optgroup>` : ''}${d.advanceId === '__beg' ? '<option value="__beg" selected>Beginning balance</option>' : ''}`;
  const ln = (l, i) => `<div class="sd-ln" data-ln="${i}"><input class="input mono sd-code" list="sd-coa" value="${esc(l.code)}" placeholder="Code or title" aria-label="Debit account" title="${esc(names[l.code] || '')}">
      <input class="input r sd-gross" inputmode="decimal" value="${l.amount === '' || l.amount === undefined ? '' : esc(money(l.amount))}" aria-label="Amount">${i ? '<button class="btn sm sd-xl" type="button" aria-label="Remove account">✕</button>' : ''}</div>`;
  const form = !enc ? '' : !mine.length && !editing ? `<div class="panel sd-pan"><div class="cd-info">No cash advance check from this bank account yet. Encode the cash advance check in the CkDJ (or in Cash Examination, Cash Advances) first.</div></div>`
    : `<div class="panel sd-pan" id="lq-form">${editing ? `<div class="cd-orhead"><h3 class="cer-h3">Edit ${isRf ? 'refund' : 'liquidation'} ${esc(d.ref)}</h3><button class="btn sm" type="button" id="lq-del">Delete</button><button class="btn sm" type="button" id="lq-new">Cancel</button></div>` : ''}
    <div class="sd-line">
      <div class="sd-f sd-w-typ"><label for="lq-type">Type</label><select class="input" id="lq-type"><option value="liq" ${isRf ? '' : 'selected'}>Liquidation</option><option value="refund" ${isRf ? 'selected' : ''}>Refund</option></select></div>
      <div class="sd-f sd-w-day"><label for="lq-day">Day</label><input class="input r" id="lq-day" inputmode="numeric" maxlength="2" value="${d.date ? +d.date.slice(8, 10) : ''}" title="${esc(monthLabel(m))}"></div>
      <div class="sd-f sd-w-ref"><label for="lq-ref">${isRf ? 'OR No.' : 'LR No. / JEV'}</label><input class="input mono" id="lq-ref" value="${esc(d.ref)}"></div>
      <div class="sd-f sd-w-for"><label for="lq-for">For Check No.</label><select class="input" id="lq-for">${forOpts}</select></div>
      <div class="sd-f sd-w-acct"><div class="sd-acch"><label>Debit</label><label class="r">Amount</label><span></span></div>
        <div class="sd-accts">${isRf ? `<div class="sd-ln"><div class="input cd-ro mono" title="Cash Local Treasury">${CASH} Cash Local Treasury</div><input class="input r sd-gross" id="lq-rfamt" inputmode="decimal" value="${d.lines[0] && d.lines[0].amount !== '' ? esc(money(d.lines[0].amount)) : ''}" aria-label="Refund amount"></div>`
          : `${d.lines.map(ln).join('')}<button type="button" class="sd-add" id="lq-addln">+ another account</button>`}</div></div>
      <div class="sd-f sd-w-cr"><label for="lq-cr">Credit</label><select class="input" id="lq-cr">${CA_CODES.map((k) => `<option value="${k}" ${k === (d.credit || ADV_DEFAULT) ? 'selected' : ''}>${k} ${esc(names[k] || '')}</option>`).join('')}</select></div>
      <div class="sd-f sd-w-amt"><label>Total</label><div class="input cd-ro r" id="lq-tot">0.00</div></div>
      <div class="sd-f sd-w-btn"><label>&nbsp;</label><button class="btn primary" type="button" id="lq-save">${editing ? 'Save' : 'Enter'}</button></div>
    </div><div class="sd-tally" id="lq-left" hidden></div></div>`;

  // The table on screen = the printout (DEBIT and CREDIT, one row per debit account); Flags and Edit at the right, screen only.
  const debTotal = sumOf(list.flatMap(debitsOf));
  const rows = list.map((l) => {
    const deb = debitsOf(l), fl = flagsOf(l), a = advOf(l.advanceId), cr = creditOf(l), n = Math.max(deb.length, 1), on = l.id === LQ.id ? ' class="cd-on"' : '';
    const rs = n > 1 ? ` rowspan="${n}"` : '';
    const dc = (x) => (x ? `<td class="lq-code">${esc(x.code)}</td><td>${esc(names[x.code] || x.name || '')}</td><td class="r">${money(x.amount)}</td>` : '<td></td><td></td><td></td>');
    const first = `<tr${on}><td${rs}>${esc(fmtDate(l.date))}</td><td${rs}>${l.type === 'refund' ? 'Refund' : 'Liquidation'}</td><td${rs}>${esc(l.ref || '')}</td><td${rs}>${esc(liqText(l, a))}</td>${dc(deb[0])}
      <td${rs} class="lq-code">${esc(cr)}</td><td${rs}>${esc(names[cr] || '')}</td><td${rs} class="r">${money(l.amount)}</td><td${rs}>${esc(forTxt(l))}${a && a.officer ? `<small class="dim lq-off">${esc(a.officer)}</small>` : ''}</td>
      <td${rs} class="af-noprint lq-flags">${fl.map((t) => `<span class="sd-flag">${esc(t)}</span>`).join('')}${enc ? `<button class="btn sm ${fl.includes('No entry yet') ? 'primary' : ''}" type="button" data-lqedit="${esc(l.id)}">${fl.includes('No entry yet') ? 'Fill entry' : 'Edit'}</button>` : ''}</td></tr>`;
    return first + deb.slice(1).map((x) => `<tr${on}>${dc(x)}</tr>`).join('');
  }).join('');
  // Fill next entry: the liquidations of the month with no entry yet; when none is left, the next month that has some.
  const blanks = list.filter(noEntryL);
  const nm = (() => { const by = new Map(); liqsAll.filter((l) => noEntryL(l) && acctOfLiq(l) === acct.id).forEach((l) => { const k = String(l.date || '').slice(0, 7); if (k && k !== m) by.set(k, (by.get(k) || 0) + 1); });
    const ks = [...by.keys()].sort(), k = ks.find((x) => x > m) || ks[0]; return k ? { m: k, n: by.get(k) } : null; })();
  const fillHead = blanks.length ? `<button class="btn sm primary" type="button" id="lq-fillnext" data-id="${esc((blanks.find((l) => l.id !== LQ.id) || blanks[0]).id)}">Fill next entry (${blanks.length} left)</button>`
    : list.length ? `<span class="sd-done">✓ All entries filled for ${esc(monthLabel(m))}${nm ? ` · <a href="#" id="lq-nextm" data-m="${nm.m}">Next: ${esc(monthLabel(nm.m))} (${nm.n} left) →</a>` : ''}</span>` : '';
  const inner = `${form}<div class="panel sd-pan"><div class="cd-orhead"><h3 class="cer-h3">Liquidation Journal · ${esc(monthLabel(m))}</h3><span class="pill">${list.length}</span>
      ${enc ? fillHead : ''}${enc ? '<a href="#" class="cd-link" id="lq-tpl">Template</a><button class="btn sm" type="button" id="lq-imp">Import from Excel</button>' : ''}${outButtons('lq')}</div>
    <div class="rp-doc"><div class="rp-page rp-wide lq-page"><h2 class="rp-title">LIQUIDATION JOURNAL</h2>
      <p class="c"><b>${esc(agencyName(refs, lgu))}</b><br>${esc(acctLabel(acct))}<br>${esc(monthLabel(m))}</p>
      <table class="rp-t lq-t"><colgroup>${[8, 7, 6.5, 12.5, 7.5, 11, 7.5, 7.5, 10, 7.5, 6.5, 8.5].map((w) => `<col style="width:${w}%">`).join('')}</colgroup><thead><tr><th rowspan="2">Date</th><th rowspan="2">Type</th><th rowspan="2">LR No. / OR No.</th><th rowspan="2">Particulars</th><th colspan="3" class="lq-g">DEBIT</th><th colspan="3" class="lq-g">CREDIT</th><th rowspan="2">For Check No.</th><th rowspan="2" class="af-noprint">Flags</th></tr>
        <tr><th>Account Code</th><th>Account Name</th><th>Amount</th><th>Account Code</th><th>Account Name</th><th>Amount</th></tr></thead>
      <tbody>${list.length ? rows : '<tr><td colspan="12" class="c">No liquidation this month.</td></tr>'}
        <tr class="tot"><td colspan="4">Total</td><td></td><td></td><td class="r">${money(debTotal)}</td><td></td><td></td><td class="r">${money(total)}</td><td></td><td class="af-noprint"></td></tr></tbody></table></div></div>
    <p class="af-note">The same liquidations as in Cash Examination, Cash Advances. Listed under the bank account of the cash advance check, by the date of the liquidation.</p></div>`;

  const spec = () => ({ title: 'Liquidation Journal', sheet: 'Liquidation Journal', office: agencyName(refs, lgu), acct: acctLabel(acct), month: monthLabel(m), empty: 'No liquidation this month.',
    landscape: true,
    cols: [{ h: 'Date', w: 0.85 }, { h: 'Type', w: 0.85 }, { h: 'LR No. / OR No.', w: 0.9 }, { h: 'Particulars', w: 1.9 },
      { h: 'Account Code', w: 0.95, g: 'DEBIT' }, { h: 'Account Name', w: 1.4, g: 'DEBIT' }, { h: 'Amount', w: 1.0, right: true, g: 'DEBIT' },
      { h: 'Account Code', w: 0.95, g: 'CREDIT' }, { h: 'Account Name', w: 1.3, g: 'CREDIT' }, { h: 'Amount', w: 1.0, right: true, g: 'CREDIT' }, { h: 'For Check No.', w: 0.8 }],
    // One row per debit account; the date, particulars, credit and check on the first.
    rows: list.flatMap((l) => { const deb = debitsOf(l), a = advOf(l.advanceId), cr = creditOf(l);
      return (deb.length ? deb : [null]).map((x, i) => [...(i ? ['', '', '', ''] : [fmtDate(l.date), l.type === 'refund' ? 'Refund' : 'Liquidation', l.ref || '', liqText(l, a)]),
        x ? x.code : '', x ? names[x.code] || x.name || '' : '', x ? r2(x.amount) : '',
        ...(i ? ['', '', '', ''] : [cr, names[cr] || '', r2(l.amount), forTxt(l)])]); }),
    total: [{ t: 'Total', span: 4 }, '', '', sumOf(list.flatMap(debitsOf)), '', '', total, ''] });

  const wire = () => {
    wireOut('lq', spec, `Liquidation Journal ${agencyName(refs, lgu)} ${acct.accountNo || ''} ${m}`, (msg) => toast(msg, 'bad'));
    const startL = (id) => { const l = list.find((x) => x.id === id); LQ.id = l.id; LQ.d = loadL(l, creditOf(l));
      focusAfter('#lq-form', l.type === 'refund' ? '#lq-rfamt' : '.sd-code', true); rerender(); };
    $$('[data-lqedit]').forEach((b) => { b.onclick = () => startL(b.dataset.lqedit); });
    if ($('#lq-fillnext')) $('#lq-fillnext').onclick = () => startL($('#lq-fillnext').dataset.id);
    if ($('#lq-nextm')) $('#lq-nextm').onclick = (e) => { e.preventDefault(); LQ.id = ''; LQ.d = null; goM($('#lq-nextm').dataset.m); };
    if ($('#lq-tpl')) $('#lq-tpl').onclick = async (e) => { e.preventDefault();
      try { const XLSX = await loadXlsx(); const ws = XLSX.utils.aoa_to_sheet([['Type', 'Date', 'LR No. / OR No.', 'For Check No.', 'Account Code', 'Amount'], ['Liquidation', '12/11/2025', 'LR 2025-12-001', '1894958', '5-02-01-010', 60000], ['', '', 'LR 2025-12-001', '1894958', '5-02-03-010', 42173], ['Refund', '12/12/2025', '3764120', '1894958', '', 500]]);
        ws['!cols'] = [12, 12, 18, 14, 14, 14].map((w) => ({ wch: w })); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Liquidations'); XLSX.writeFile(wb, 'Liquidation Journal Template.xlsx'); } catch (err) { toast(err.message || String(err), 'bad'); } };
    if ($('#lq-imp')) $('#lq-imp').onclick = () => importLiq({ refs, lgu, advs, liqsAll, names });
    if (!$('#lq-form')) return;
    if (!$('#sd-coa')) { const dl = document.createElement('datalist'); dl.id = 'sd-coa'; dl.innerHTML = coa.accounts.map(([k, t]) => `<option value="${esc(k)}">${esc(t)}</option>`).join(''); document.body.appendChild(dl); }
    const toCode = (v) => { const t = String(v || '').trim(); if (names[t]) return t; const hit = coa.accounts.find(([, n]) => n.toLowerCase() === t.toLowerCase()); return hit ? hit[0] : t; };
    const read = () => {
      d.date = dateIn(m, $('#lq-day').value); d.ref = $('#lq-ref').value.trim(); d.advanceId = $('#lq-for').value; d.credit = $('#lq-cr').value;
      d.lines = d.type === 'refund' ? [{ code: CASH, amount: num($('#lq-rfamt').value) ?? '' }] : $$('.sd-ln[data-ln]').map((el) => ({ code: toCode($('.sd-code', el).value), amount: num($('.sd-gross', el).value) ?? '' }));
    };
    const paint = () => {
      read();
      $$('.sd-ln[data-ln]').forEach((el, i) => { const l = d.lines[i]; $('.sd-code', el).title = names[l.code] || (l.code ? 'Not in the Chart of Accounts' : ''); $('.sd-code', el).classList.toggle('sd-bad', !!l.code && !names[l.code]); });
      $('#lq-tot').textContent = money(sumOf(d.lines));
      const a = advOf(d.advanceId), was = editing ? r2(list.find((l) => l.id === LQ.id)?.amount) : 0, left = a ? r2(a.bal + (a.id === list.find((l) => l.id === LQ.id)?.advanceId ? was : 0)) : null;
      const over = a && sumOf(d.lines) > left + 0.004, tl = $('#lq-left');
      tl.hidden = !over; tl.textContent = over ? `Check No. ${a.checkNo} has ₱${money(left)} left; this is ₱${money(sumOf(d.lines))}.` : '';
    };
    // Picking the check: its Advances account (from the CkDJ) becomes the credit.
    $('#lq-for').onchange = () => { const a = advOf($('#lq-for').value); if (a && a.credit) $('#lq-cr').value = a.credit; paint(); };
    $('#lq-type').onchange = () => { read(); d.type = $('#lq-type').value; d.lines = d.type === 'refund' ? [{ code: CASH, amount: sumOf(d.lines) || '' }] : [{ code: '', amount: sumOf(d.lines) || '' }]; rerender(); };
    $$('#lq-form input').forEach((el) => { el.oninput = paint; });
    $$('.sd-code').forEach((el) => { el.onchange = () => { el.value = toCode(el.value); paint(); }; });
    $$('#lq-form .sd-gross').forEach((el) => { el.onblur = () => { const v = num(el.value); if (v !== null) el.value = money(v); paint(); }; });
    $$('.sd-xl').forEach((b) => { b.onclick = () => { read(); d.lines.splice(+b.closest('.sd-ln').dataset.ln, 1); rerender(); }; });
    if ($('#lq-addln')) $('#lq-addln').onclick = () => { read(); d.lines.push({ code: '', amount: '' }); rerender(); setTimeout(() => { const all = $$('.sd-code'); if (all.length) all[all.length - 1].focus(); }, 0); };
    if ($('#lq-new')) $('#lq-new').onclick = () => { LQ.id = ''; LQ.d = null; rerender(); };
    if ($('#lq-del')) $('#lq-del').onclick = async () => {
      const ok = await modal({ title: 'Delete this liquidation?', body: `<p style="margin:0">Delete <b>${esc(d.ref)}</b>? It is removed here and from Cash Examination, Cash Advances.</p>`, buttons: [{ label: 'Cancel', value: false }, { label: 'Delete', cls: 'danger', value: true }] });
      if (!ok) return; const cur = list.find((x) => x.id === LQ.id);
      await store.save('cer_liquid', cur.id, strip(cur), by(refs), { deleted: true }); LQ.id = ''; LQ.d = null; toast('Liquidation deleted.', 'ok');
    };
    const save = async () => {
      read();
      if (!d.date) return bad(`Enter the day (1 to ${lastDayOf(m)}).`);
      if (!d.ref) return bad(d.type === 'refund' ? 'Enter the OR No. of the refund.' : 'Enter the LR No. (or JEV).');
      if (!d.advanceId) return bad('Choose the check (For Check No.).');
      const lines = d.lines.filter((l) => l.code || l.amount !== '');
      if (!lines.length) return bad('Enter the debit account and the amount.');
      if (lines.some((l) => !l.code)) return bad('Enter the account of each debit.');
      if (lines.some((l) => !names[l.code])) return bad(`${lines.find((l) => !names[l.code]).code} is not in the Chart of Accounts.`);
      if (lines.some((l) => !(+l.amount > 0))) return bad('Enter the amount of each debit.');
      const amount = sumOf(lines), a = advOf(d.advanceId), cur = LQ.id ? list.find((x) => x.id === LQ.id) : null;
      const left = a ? r2(a.bal + (cur && cur.advanceId === a.id ? r2(cur.amount) : 0)) : null;
      if (a && amount > left + 0.004) {
        const go = await modal({ title: 'More than what is left?', body: `<p style="margin:0">Check No. ${esc(a.checkNo)} has ₱${money(left)} left. This is ₱${money(amount)}. Save it anyway? It is flagged.</p>`, buttons: [{ label: 'Go back', value: false }, { label: 'Save', cls: 'primary', value: true }] });
        if (!go) return;
      }
      const rec = { ...(cur ? strip(cur) : { particulars: '' }), lguId: lgu.id, officerId: a ? a.officerId : (cur && cur.officerId) || '', type: d.type, date: d.date, ref: d.ref, advanceId: d.advanceId, amount,
        lines: d.type === 'refund' ? [] : lines.map((l) => ({ code: l.code, name: names[l.code], amount: r2(l.amount) })), credit: d.credit };
      const id = LQ.id || newId('cerlq'), was = !LQ.id;
      // Filling one that had no entry: the next one of the month with no entry opens.
      let next = null;
      if (cur && noEntryL(cur)) { const i = list.findIndex((x) => x.id === cur.id); next = [...list.slice(i + 1), ...list.slice(0, i)].find((x) => x.id !== cur.id && noEntryL(x)) || null; }
      LQ.id = next ? next.id : ''; LQ.d = next ? loadL(next, creditOf(next)) : was ? blank(d.type, d.date) : null;
      focusAfter('#lq-form', next ? '.sd-code' : '#lq-ref', !!next);
      await store.save('cer_liquid', id, rec, by(refs));
      toast(`${d.type === 'refund' ? 'Refund' : 'Liquidation'} ${d.ref} saved.${next ? ` Next: ${next.ref || ''}.` : ''}`, 'ok');
    };
    $('#lq-save').onclick = save;
    $('#lq-form').onkeydown = (e) => {
      if (e.key !== 'Enter' || e.target.tagName === 'BUTTON') return;
      e.preventDefault();
      // Enter in a debit box saves when every debit is complete and, for one already in, they add up to its amount.
      if (e.target.matches('.sd-code, .sd-gross')) { read(); const cur = LQ.id ? list.find((x) => x.id === LQ.id) : null;
        if (d.date && d.ref && d.advanceId && d.lines.length && d.lines.every((l) => l.code && names[l.code] && +l.amount > 0) && (!cur || Math.abs(sumOf(d.lines) - r2(cur.amount)) < 0.005)) { save(); return; } }
      const els = ['#lq-day', '#lq-ref', '#lq-for', ...$$('#lq-form .sd-code, #lq-form .sd-gross').map((el) => el), '#lq-cr'].map((k) => (typeof k === 'string' ? $(k) : k)).filter(Boolean);
      const i = els.indexOf(e.target); if (i < 0 || i === els.length - 1) { save(); return; } els[i + 1].focus();
    };
    paint();
  };
  return { inner, wire };
}

/* ---------- Import from Excel ---------- */
// Columns: Type, Date, LR No. / OR No., For Check No., Account Code, Amount (Particulars optional). Rows with the same
// LR No. and check become one liquidation with several debits. A liquidation already in (same LR No. and check): its
// debits are filled when it has none yet.
async function importLiq({ refs, lgu, advs, liqsAll, names }) {
  let plan = null;
  const read = async (file) => {
    const XLSX = await loadXlsx();
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const cols = [['type', /^\s*type\s*$/i], ['date', /^\s*date/i], ['ref', /lr|or\s*no|jev|reference/i], ['for', /for\s*check|check\s*no/i], ['code', /account\s*code|^\s*code\s*$/i], ['amt', /amount/i], ['part', /particular/i]];
    let sheet = null;
    for (const n of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' });
      for (let r = 0; r < Math.min(rows.length, 15) && !sheet; r++) {
        const map = {}; rows[r].forEach((cell, i) => { const t = String(cell || ''); cols.forEach(([k, re]) => { if (map[k] === undefined && Object.values(map).indexOf(i) < 0 && re.test(t)) map[k] = i; }); });
        if (map.ref !== undefined && map.for !== undefined && map.amt !== undefined) sheet = { rows, header: r, map };
      }
      if (sheet) break;
    }
    if (!sheet) return { error: 'No sheet with the columns LR No. / OR No., For Check No. and Amount was found. Use the template.' };
    const M = sheet.map, get = (row, k) => (M[k] === undefined ? '' : row[M[k]]);
    const groups = new Map(), problems = [];
    let last = { type: 'liq', date: '' };
    sheet.rows.slice(sheet.header + 1).forEach((row, i) => {
      const line = sheet.header + i + 2;
      if (Object.keys(M).every((k) => !String(get(row, k) ?? '').trim()) || /total/i.test(String(get(row, 'type')) + String(get(row, 'date')))) return;
      const ref = String(get(row, 'ref') ?? '').trim(), forTxt = String(get(row, 'for') ?? '').trim();
      const tTxt = String(get(row, 'type') ?? '').trim(), date = excelDate(XLSX, get(row, 'date'));
      const k = `${ref}|${chkNo(forTxt)}`, g = groups.get(k);
      const type = tTxt ? (/refund/i.test(tTxt) ? 'refund' : 'liq') : g ? g.type : last.type;
      const amt = typeof get(row, 'amt') === 'number' ? r2(get(row, 'amt')) : num(get(row, 'amt'));
      if (!ref) { problems.push({ line, why: 'LR No. / OR No. is missing.' }); return; }
      if (!(amt > 0)) { problems.push({ line, why: 'Amount is missing or not a number.' }); return; }
      const code = String(get(row, 'code') ?? '').trim();
      const x = g || { ref, forTxt, type, date: date || (tTxt ? '' : last.date), part: '', lines: [], rows: [] };
      if (date && !x.date) x.date = date;
      const p = String(get(row, 'part') ?? '').trim(); if (p && !x.part) x.part = p;
      x.lines.push({ code: type === 'refund' ? (code || '1-01-01-010') : code, amount: amt }); x.rows.push(line);
      groups.set(k, x); last = { type: x.type, date: x.date };
    });
    const add = [], upd = [];
    groups.forEach((g) => {
      const a = advs.find((y) => chkNo(y.checkNo) && chkNo(y.checkNo) === chkNo(g.forTxt));
      if (!a) { problems.push({ line: g.rows[0], why: `Check No. ${g.forTxt || '(blank)'} is not a cash advance of this office.` }); return; }
      if (!g.date) { problems.push({ line: g.rows[0], why: `${g.ref}: the date is missing.` }); return; }
      if (g.type !== 'refund') {
        const unk = g.lines.find((l) => !l.code || !names[l.code]);
        if (unk) { problems.push({ line: g.rows[0], why: `${g.ref}: account code "${unk.code || '(blank)'}" is not in the Chart of Accounts.` }); return; }
      }
      const amount = sumOf(g.lines), cur = liqsAll.find((l) => l.advanceId === a.id && String(l.ref || '').trim().toUpperCase() === g.ref.toUpperCase());
      if (cur) {
        if (g.type !== 'refund' && !(cur.lines || []).length) upd.push({ cur, lines: g.lines, credit: cur.credit || a.credit });
        else problems.push({ line: g.rows[0], why: `${g.ref} for Check No. ${a.checkNo} is already in.` });
        return;
      }
      add.push({ g, a, amount });
    });
    return { add, upd, problems };
  };
  const show = (bg, p) => {
    const box = $('#lj-res', bg);
    if (p.error) { box.innerHTML = `<div class="msg bad">${esc(p.error)}</div>`; return; }
    box.innerHTML = `<div class="oi-sum"><b>${p.add.length} liquidation${p.add.length === 1 ? '' : 's'} to add</b> · ₱ ${money(sumOf(p.add.map((x) => ({ amount: x.amount }))))}${p.upd.length ? `<span>${p.upd.length} already in: debits filled</span>` : ''}</div>
      ${p.add.length ? `<div class="af-tbl oi-prev"><table class="af-reg"><thead><tr><th>Date</th><th>Type</th><th>LR / OR No.</th><th>Check No.</th><th>Debits</th><th class="r">Amount</th></tr></thead><tbody>${p.add.slice(0, 200).map((x) => `<tr><td>${esc(fmtDate(x.g.date))}</td><td>${x.g.type === 'refund' ? 'Refund' : 'Liquidation'}</td><td class="mono">${esc(x.g.ref)}</td><td class="mono">${esc(x.a.checkNo)}</td><td class="mono">${esc(x.g.lines.map((l) => l.code).join(', '))}</td><td class="r">${money(x.amount)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${p.problems.length ? `<div class="af-probs"><b>Not imported (${p.problems.length})</b>${p.problems.slice(0, 60).map((q) => `<div>Row ${q.line} — ${esc(q.why)}</div>`).join('')}</div>` : ''}`;
  };
  const v = await modal({ title: `Import Liquidations · ${agencyName(refs, lgu)}`, wide: true,
    body: `<p class="af-note">Excel columns: <b>Type, Date, LR No. / OR No., For Check No., Account Code, Amount</b> (see the Template). Rows with the same LR No. and check become one liquidation with several debits. Type Refund: the OR No.; the debit is Cash Local Treasury.</p>
      <div class="field"><label for="lj-file">Excel file</label><input class="input" type="file" id="lj-file" accept=".xlsx,.xlsm,.xls,.csv"></div><div id="lj-res"></div>`,
    onOpen: (bg) => { $('#lj-file', bg).onchange = async (e) => { const fl = e.target.files[0]; if (!fl) return; $('#lj-res', bg).innerHTML = '<p class="af-note">Reading…</p>'; try { plan = await read(fl); show(bg, plan); } catch (err) { plan = null; $('#lj-res', bg).innerHTML = `<div class="msg bad">${esc(err.message || String(err))}</div>`; } }; },
    buttons: [{ label: 'Cancel', value: null }, { label: 'Import', cls: 'primary', value: 'go', check: () => { if (!plan || plan.error) { toast('Choose the Excel file first.', 'bad'); return false; } if (!plan.add.length && !plan.upd.length) { toast('Nothing to import.', 'bad'); return false; } return true; } }] });
  if (v !== 'go') return;
  for (const { g, a, amount } of plan.add) {
    await store.save('cer_liquid', newId('cerlq'), { lguId: lgu.id, officerId: a.officerId, type: g.type, date: g.date, ref: g.ref, particulars: g.part || '', amount, advanceId: a.id,
      lines: g.type === 'refund' ? [] : g.lines.map((l) => ({ code: l.code, name: names[l.code], amount: r2(l.amount) })), credit: a.credit || ADV_DEFAULT }, by(refs), { quiet: true });
  }
  for (const { cur, lines, credit } of plan.upd) await store.save('cer_liquid', cur.id, { ...strip(cur), lines: lines.map((l) => ({ code: l.code, name: names[l.code], amount: r2(l.amount) })), credit: credit || ADV_DEFAULT }, by(refs), { quiet: true });
  emitChange('local');
  toast(`${plan.add.length} liquidation${plan.add.length === 1 ? '' : 's'} imported${plan.upd.length ? `, ${plan.upd.length} filled` : ''}.`, 'ok');
}
