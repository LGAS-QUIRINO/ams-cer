// CER · Cash Count (design approved 18 Oct 2026), following the GF 74-A.
// Per accountable officer of a cash examination, at the cut-off:
//   1. Cash on Hand            bills by number of pieces; coins as one amount.
//   2. Cash Items              checks, paid vouchers / payrolls not yet liquidated, etc.: presented, allowed (auditor), disallowed.
//   3. Unused Accountable Forms read from Accountable Forms (Physical Check), checkbooks included.
//   4. Split by Accountability counted together, then split: Collections | Cash Advance, against the balance per books.
//
// Records:
//   cer_cashcount  id = examId  { examId, bills{ '1000': pcs, … }, coins, items[{ particulars, appliesTo: 'col'|'ca', presented, allowed }], split{ col, ca } (typed; blank = automatic) }
import { store } from '../../js/store.js';
import { esc, toast, $, $$ } from '../../js/ui.js';
import { hasRole, by, mayView, agencyName, fmtDate, money, num } from './cer.js';
import { loadForms, unusedFormsOf, exportXlsx, registerOf } from './forms.js';
import { figuresOf, fundsOf, kindOfForm } from './collections.js';

const canCount = (refs) => hasRole(refs, 'staff', 'member', 'atl', 'sa', 'admin');
const BILLS = [1000, 500, 200, 100, 50, 20];
const r2 = (n) => Math.round(n * 100) / 100;
const flat = (r) => ({ id: r.id, ...r.data });
const bad = (m) => { toast(m, 'bad'); return false; };
const go = (params) => { const q = new URLSearchParams(location.hash.split('?')[1] || ''); Object.entries(params).forEach(([k, v]) => (v ? q.set(k, v) : q.delete(k))); location.hash = location.hash.split('?')[0] + '?' + q.toString(); };
const BEG_CA = ['ca', 'sdo', 'pcf'];
const DRAFT = { key: '', data: null };   // unsaved count survives a screen refresh

// Balance per books of each accountability, as of the cash count.
export function booksOf(refs, f, o, exam, audit, advs, liqs) {
  const out = [];
  const fns = exam.functions || [];
  if (fns.includes('collecting') || fns.includes('liquidating') || f.ors.some((x) => x.officerId === o.id)) {
    const lgu = refs.lgu[audit.lguId];
    const fig = figuresOf(f, o, fundsOf(f, audit.lguId), audit.countDate, lgu);
    const forms = exam.forms || [];
    // One column per report type: barangays AF 51 (SCD) and CTC (SCR); LGU and PLGU one Collections (RCD).
    fig.kinds.forEach((kind) => {
      const chains = Object.values(fig.chains).filter((c) => c.kind === kind);
      const used = forms.some((x) => kindOfForm(lgu, x) === kind) || chains.some((c) => c.figs.length || c.pend.nOrs || c.pend.dep || c.pend.beg);
      if (!used && fig.kinds.length > 1) return;
      const bal = r2(chains.reduce((n, c) => n + c.pend.end, 0));
      const label = kind === 'SCD' ? 'AF 51 (SCD)' : kind === 'SCR' ? 'CTC (SCR)' : fns.includes('liquidating') && !fns.includes('collecting') ? 'Collections (Liquidating)' : 'Collections (RCD)';
      out.push({ key: 'col-' + kind, kind, label, books: bal, note: kind === 'SCR' ? 'Unremitted CTC, from Collections & Deposits' : 'Undeposited collections, from Collections & Deposits' });
    });
  }
  const mine = advs.filter((a) => a.officerId === o.id && !a.beg);   // beginning checks are inside the beginning balance
  if (fns.some((k) => ['disbursing', 'special', 'pettycash'].includes(k)) || mine.length) {
    const beg = BEG_CA.reduce((n, k) => n + (+(exam.balances?.[k]?.amount) || 0), 0);
    const bal = r2(beg + mine.reduce((n, a) => n + (+a.amount || 0), 0) - liqs.filter((l) => l.officerId === o.id).reduce((n, l) => n + (+l.amount || 0), 0));
    out.push({ key: 'ca', label: fns.includes('pettycash') && !fns.includes('disbursing') ? 'Petty Cash Fund' : 'Cash Advance', books: bal, note: 'Unliquidated, from Cash Advances' });
  }
  return out;
}

export async function countView(ctx) {
  const { refs, q } = ctx;
  const f = await loadForms();
  const [reports, advs0, liqs0, counts0] = await Promise.all(['cer_reports', 'cer_cashadv', 'cer_liquid', 'cer_cashcount'].map((t) => store.list(t)));
  f.reports = reports.map(flat);
  const advs = advs0.map(flat), liqs = liqs0.map(flat);
  const crumb = 'Cash Count';
  const hello = `<div class="hello"><div><h1>Cash Count</h1><p>Count everything the officer produces at the cut-off: cash on hand and cash items. The count is split by accountability and carried to the Report of Cash Examination (GF 74-A).</p></div></div>`;
  const audits = f.audits.filter((a) => mayView(refs, refs.lgu[a.lguId])).sort((a, b) => String(b.countDate).localeCompare(String(a.countDate)));
  if (!audits.length) return { crumb, body: hello + '<div class="panel"><div class="empty"><b>No cash examination yet.</b>The auditors set one up in Audit Setup.</div></div>' };
  const audit = audits.find((a) => a.id === q.get('a')) || audits[0];
  const exams = f.exams.filter((e) => e.auditId === audit.id).map((e) => ({ ...e, o: f.officers.find((x) => x.id === e.officerId) })).filter((e) => e.o);
  const exam = exams.find((e) => e.id === q.get('e')) || exams[0] || null;
  const top = `<div class="panel cd-bar cc-bar">
      <div class="field"><label for="cc-audit">Cash Examination</label><select class="input" id="cc-audit">${audits.map((a) => `<option value="${esc(a.id)}" ${a.id === audit.id ? 'selected' : ''}>${esc(agencyName(refs, refs.lgu[a.lguId]))} · ${esc(fmtDate(a.countDate))}</option>`).join('')}</select></div>
      <div class="field"><label for="cc-exam">Accountable Officer</label><select class="input" id="cc-exam">${exams.length ? exams.map((e) => `<option value="${esc(e.id)}" ${exam && e.id === exam.id ? 'selected' : ''}>${esc(e.o.name)}${e.o.designation ? ' · ' + esc(e.o.designation) : ''}</option>`).join('') : '<option value="">No officer in this examination</option>'}</select></div>
      <div class="field"><span class="cd-lbl">Cash Production Notice</span><div class="cc-cpn"><span class="pill p-done">Served ${esc(fmtDate(audit.countDate))}</span><span class="dim">count date</span></div></div></div>`;
  const wireTop = () => {
    $('#cc-audit').onchange = (e) => { DRAFT.key = ''; go({ a: e.target.value, e: '' }); };
    $('#cc-exam').onchange = (e) => { DRAFT.key = ''; go({ e: e.target.value }); };
  };
  if (!exam) return { crumb, body: hello + top + '<div class="panel"><div class="empty"><b>No accountable officer in this cash examination.</b>Add the officers in Audit Setup.</div></div>', wire: wireTop };

  const o = exam.o;
  const saved = counts0.map(flat).find((c) => c.id === exam.id) || null;
  if (DRAFT.key !== exam.id) DRAFT.key = exam.id, DRAFT.data = JSON.parse(JSON.stringify({ bills: {}, coins: '', items: [], split: {}, ...(saved || {}) }));
  const d = DRAFT.data;
  const books = booksOf(refs, f, o, exam, audit, advs, liqs);
  const forms = unusedFormsOf(f, o.id, exam, audit.countDate);
  const enc = canCount(refs);
  const dis = enc ? '' : 'disabled';
  const caChecks = advs.filter((a) => a.officerId === o.id).map((a) => a.checkNo);

  const billRows = BILLS.map((v) => `<tr><td>₱ ${v.toLocaleString('en-US')}</td><td class="r"><label class="sr-only" for="b${v}">₱${v} pieces</label><input class="input af-sm r cc-pc" id="b${v}" data-bill="${v}" inputmode="numeric" value="${esc(d.bills[v] || '')}" placeholder="0" ${dis}></td><td class="r" data-amt="${v}"></td></tr>`).join('');
  const itemRow = (it, i) => `<tr data-it="${i}"><td>${esc(it.particulars)}</td><td>${esc(books.find((b) => b.key === it.appliesTo)?.label || (it.appliesTo === 'ca' ? 'Cash advance' : 'Collections'))}</td><td class="r">${money(it.presented)}</td>
      <td class="r"><label class="sr-only" for="al${i}">Allowed: ${esc(it.particulars)}</label><input class="input af-sm r cc-al" id="al${i}" inputmode="decimal" value="${esc(money(it.allowed ?? it.presented))}" ${dis}></td><td class="r cc-dis"></td>
      <td class="r">${enc ? `<button class="btn sm" type="button" data-rmit="${i}" aria-label="Remove ${esc(it.particulars)}">Remove</button>` : ''}</td></tr>`;
  const body = `${hello}${top}
    <div class="stats">
      <div class="stat"><span>Cash on Hand</span><b id="cc-s-cash">₱ 0.00</b><small>bills and coins counted</small></div>
      <div class="stat"><span>Cash Items Allowed</span><b id="cc-s-items" style="color:#1d4fb8">₱ 0.00</b><small id="cc-s-items2"></small></div>
      <div class="stat"><span>Total Inventory</span><b id="cc-s-inv">₱ 0.00</b><small>cash + allowed cash items</small></div>
      <div class="stat"><span>Unused Forms</span><b>${forms.reduce((n, x) => n + x.qty, 0)} pcs</b><small>from the Physical Check</small></div>
    </div>
    <div class="cc-grid">
      <section class="panel" aria-labelledby="cc-h1"><div class="cc-head"><span class="cd-num">1</span><h2 id="cc-h1">Cash on Hand</h2></div>
        <table class="af-reg cc-tbl"><thead><tr><th scope="col">Denomination</th><th scope="col" class="r">No. of Pcs.</th><th scope="col" class="r">Amount (₱)</th></tr></thead>
        <tbody><tr class="cc-sec"><td colspan="3">Bills</td></tr>${billRows}
          <tr class="cc-sec"><td colspan="3">Coins</td></tr>
          <tr><td>Coins (total amount)</td><td class="r dim">type the amount</td><td class="r"><label class="sr-only" for="cc-coins">Coins amount</label><input class="input af-sm r" id="cc-coins" inputmode="decimal" value="${esc(d.coins === '' || d.coins === undefined || d.coins === null ? '' : money(d.coins))}" placeholder="0.00" ${dis}></td></tr>
          <tr class="cc-tot"><td colspan="2">Total cash on hand</td><td class="r" id="cc-cash"></td></tr></tbody></table>
      </section>
      <section class="panel" aria-labelledby="cc-h2"><div class="cc-head"><span class="cd-num">2</span><h2 id="cc-h2">Cash Items</h2><span class="cd-sub">checks, paid vouchers / payrolls not yet liquidated, etc.</span></div>
        <div class="cd-body">
          ${enc ? `<div class="cd-entry cc-entry">
            <div class="field"><label for="ci-part">Particulars</label><input class="input" id="ci-part" list="ci-list" autocomplete="off"><datalist id="ci-list">${caChecks.map((c) => `<option value="Paid vouchers / payroll, Check No. ${esc(c)}">`).join('')}</datalist></div>
            <div class="field"><label for="ci-to">Applies to</label><select class="input" id="ci-to">${books.map((b) => `<option value="${b.key}" ${b.key === 'ca' ? 'selected' : ''}>${esc(b.label)}</option>`).join('') || '<option value="col">Collections</option>'}</select></div>
            <div class="field"><label for="ci-amt">Amount Presented (₱)</label><input class="input r" id="ci-amt" inputmode="decimal" autocomplete="off"></div>
            <button class="btn primary" type="button" id="ci-enter">Enter</button></div>` : ''}
          ${d.items.length ? `<div class="af-tbl"><table class="af-reg"><thead><tr><th scope="col">Particulars</th><th scope="col">Applies to</th><th scope="col" class="r">Presented (₱)</th><th scope="col" class="r">Allowed (₱)</th><th scope="col" class="r">Disallowed (₱)</th><th scope="col"></th></tr></thead>
            <tbody>${d.items.map(itemRow).join('')}<tr class="cc-tot"><td colspan="2">Total cash items</td><td class="r">${money(d.items.reduce((n, x) => n + (+x.presented || 0), 0))}</td><td class="r" id="cc-alt"></td><td class="r" id="cc-dist"></td><td></td></tr></tbody></table></div>`
            : '<p class="af-note">No cash item yet.</p>'}
          <p class="af-note">The auditor decides what is allowed; disallowed = presented − allowed. Only allowed items count as inventory.</p>
        </div>
      </section>
    </div>
    <section class="panel" aria-labelledby="cc-h3"><div class="cc-head"><span class="cd-num">3</span><h2 id="cc-h3">Unused Accountable Forms</h2><span class="cd-sub">from Accountable Forms · Physical Check</span>
        <a class="btn" style="margin-left:auto" href="#/cer/forms/officer?lgu=${esc(registerOf(refs, o.lguId))}&o=${esc(o.id)}&exam=${esc(exam.id)}&tab=check">Open Physical Check</a></div>
      ${forms.length ? `<div class="af-tbl"><table class="af-reg"><thead><tr><th scope="col">Form</th><th scope="col">Booklet</th><th scope="col" class="r">Unused Qty</th><th scope="col">Unused Serial No.</th><th scope="col">Physical Check</th></tr></thead>
        <tbody>${forms.map((x) => `<tr><td><b>${esc(x.name)}</b>${x.lastCheck && x.lastCheck.no ? `<small>Last check ${esc(x.lastCheck.no)}${x.lastCheck.date ? ' · ' + esc(fmtDate(x.lastCheck.date)) : ''}${x.lastCheck.payee ? ' · ' + esc(x.lastCheck.payee) : ''}${x.lastCheck.amount ? ' · ₱' + money(x.lastCheck.amount) : ''}</small>` : ''}</td>
          <td class="mono">${x.ns ? 'No serial' : `${x.from} – ${x.to}`}</td><td class="r">${x.qty}${x.face && x.qty ? `<small>₱${money(x.amount)}</small>` : ''}</td><td class="mono">${esc(x.text) || '<span class="dim">None</span>'}</td><td><span class="pill ${x.status[0]}">${x.status[1]}</span></td></tr>`).join('')}
          ${forms.some((x) => x.face) ? `<tr class="cc-tot"><td colspan="2">Total unused forms with money value</td><td class="r">₱${money(forms.reduce((n, x) => n + (x.face ? x.amount : 0), 0))}</td><td colspan="2" class="dim">${forms.filter((x) => x.face).reduce((n, x) => n + x.qty, 0)} pcs at face value</td></tr>` : ''}
          <tr class="cc-tot"><td colspan="2">Total unused forms without money value</td><td class="r">${forms.reduce((n, x) => n + (x.face ? 0 : x.qty), 0)}</td><td colspan="2"></td></tr></tbody></table></div>
        <p class="af-note cc-pad">One row per booklet in the officer's hands on the count date. Checkbooks: unused checks follow the last check issued, entered in the Physical Check.</p>`
      : '<div class="empty"><b>No accountable forms in this officer\'s hands on the count date.</b>Booklets and checkbooks come from Accountable Forms.</div>'}
    </section>
    <section class="panel" aria-labelledby="cc-h4"><div class="cc-head"><span class="cd-num">4</span><h2 id="cc-h4">Split of the Count by Accountability</h2><span class="cd-sub">counted together, then split</span><span id="cc-pill" style="margin-left:auto"></span></div>
      <div class="cd-body">
        ${books.length ? `<div class="af-tbl"><table class="af-reg cc-split"><thead><tr><th scope="col">Nature of Funds</th>${books.map((b) => `<th scope="col" class="r">${esc(b.label)}</th>`).join('')}<th scope="col" class="r">Totals</th></tr></thead>
          <tbody>
            <tr><td>Balance per books<small>${books.map((b) => esc(b.note)).join(' · ')}</small></td>${books.map((b) => `<td class="r">${money(b.books)}</td>`).join('')}<td class="r">${money(r2(books.reduce((n, b) => n + b.books, 0)))}</td></tr>
            <tr><td>Cash on hand, split<small>automatic unless typed</small></td>${books.map((b) => `<td class="r"><label class="sr-only" for="sp-${b.key}">Cash on hand for ${esc(b.label)}</label><input class="input af-sm r cc-sp" id="sp-${b.key}" data-sp="${b.key}" inputmode="decimal" value="${d.split[b.key] !== undefined && d.split[b.key] !== null && d.split[b.key] !== '' ? esc(money(d.split[b.key])) : ''}" ${dis}></td>`).join('')}<td class="r" id="sp-tot"></td></tr>
            <tr><td>Allowed cash items</td>${books.map((b) => `<td class="r" data-ai="${b.key}"></td>`).join('')}<td class="r" id="ai-tot"></td></tr>
            <tr class="cc-tot"><td>Inventory of cash and allowed cash items</td>${books.map((b) => `<td class="r" data-inv="${b.key}"></td>`).join('')}<td class="r" id="inv-tot"></td></tr>
            <tr><td><b>Shortage / (Overage)</b></td>${books.map((b) => `<td class="r" data-sh="${b.key}"></td>`).join('')}<td class="r" id="sh-tot"></td></tr>
          </tbody></table></div>
          <p class="af-note">Cash on hand is split automatically: collections first, up to what they should have, the rest to the cash advance. Type an amount when the officer kept them apart. Balances per books use what is encoded up to now in Collections &amp; Deposits and Cash Advances.</p>`
          : '<div class="cd-info">This officer has no collecting or cash advance accountability in Audit Setup.</div>'}
        <div class="cd-actions"><button class="btn" type="button" id="cc-xls">Export to Excel</button><button class="btn" type="button" id="cc-print">Print Cash Count Sheet</button>${enc ? '<button class="btn primary" type="button" id="cc-save">Save Cash Count</button>' : ''}</div>
      </div>
    </section>
    <div id="cer-print" class="af-print" hidden></div>`;

  return { crumb, body, wire: () => { wireTop(); wireCount({ rerender: ctx.rerender, refs, audit, exam, o, d, books, forms, saved, enc, lgu: refs.lgu[audit.lguId] }); } };
}

export function compute(d, books) {
  const cash = r2(BILLS.reduce((n, v) => n + v * (parseInt(d.bills[v], 10) || 0), 0) + (num(d.coins) || 0));
  const allowed = (it) => { const a = num(it.allowed ?? it.presented); return a === null ? 0 : a; };
  const ai = {}; books.forEach((b) => { ai[b.key] = r2(d.items.filter((it) => (it.appliesTo === b.key) || (!books.some((x) => x.key === it.appliesTo) && b === (it.appliesTo === 'ca' ? books[books.length - 1] : books[0]))).reduce((n, it) => n + allowed(it), 0)); });
  const typed = (k) => d.split[k] !== undefined && d.split[k] !== null && d.split[k] !== '';
  const sp = {}; let left = cash;
  books.filter((b) => typed(b.key)).forEach((b) => { sp[b.key] = num(d.split[b.key]) || 0; left = r2(left - sp[b.key]); });
  const auto = books.filter((b) => !typed(b.key));
  auto.forEach((b, i) => {
    if (i === auto.length - 1) { sp[b.key] = r2(Math.max(0, left)); left = r2(left - sp[b.key]); return; }
    const want = Math.max(0, r2(b.books - ai[b.key]));
    sp[b.key] = r2(Math.min(Math.max(0, left), want)); left = r2(left - sp[b.key]);
  });
  const inv = {}, sh = {}; books.forEach((b) => { inv[b.key] = r2(sp[b.key] + ai[b.key]); sh[b.key] = r2(b.books - inv[b.key]); });
  const itemsAllowed = r2(d.items.reduce((n, it) => n + allowed(it), 0));
  const itemsPresented = r2(d.items.reduce((n, it) => n + (+it.presented || 0), 0));
  return { cash, ai, sp, inv, sh, itemsAllowed, itemsPresented, unsplit: left };
}

function wireCount(c) {
  const { refs, audit, exam, o, d, books, enc } = c;
  const paint = () => {
    const k = compute(d, books);
    BILLS.forEach((v) => { const el = $(`[data-amt="${v}"]`); if (el) el.textContent = money(v * (parseInt(d.bills[v], 10) || 0)); });
    $('#cc-cash').textContent = money(k.cash);
    $('#cc-s-cash').textContent = '₱ ' + money(k.cash);
    $('#cc-s-items').textContent = '₱ ' + money(k.itemsAllowed);
    $('#cc-s-items2').textContent = `${d.items.length} item${d.items.length === 1 ? '' : 's'} · ₱${money(r2(k.itemsPresented - k.itemsAllowed))} disallowed`;
    $('#cc-s-inv').textContent = '₱ ' + money(r2(k.cash + k.itemsAllowed));
    $$('tr[data-it]').forEach((tr) => { const it = d.items[+tr.dataset.it]; $('.cc-dis', tr).textContent = money(r2((+it.presented || 0) - (num(it.allowed ?? it.presented) || 0))); });
    if ($('#cc-alt')) { $('#cc-alt').textContent = money(k.itemsAllowed); $('#cc-dist').textContent = money(r2(k.itemsPresented - k.itemsAllowed)); }
    books.forEach((b) => {
      const sp = $(`#sp-${b.key}`); if (sp && document.activeElement !== sp && (d.split[b.key] === undefined || d.split[b.key] === '' || d.split[b.key] === null)) sp.placeholder = money(k.sp[b.key]);
      $(`[data-ai="${b.key}"]`).textContent = money(k.ai[b.key]);
      $(`[data-inv="${b.key}"]`).textContent = money(k.inv[b.key]);
      const s = k.sh[b.key]; $(`[data-sh="${b.key}"]`).innerHTML = `<b class="${Math.abs(s) > 0.004 ? 'warn-t' : ''}">${s < -0.004 ? `(${money(-s)})` : money(s)}</b>`;
    });
    if (!books.length) return;
    const tot = (o2) => r2(books.reduce((n, b) => n + o2[b.key], 0));
    $('#sp-tot').textContent = money(tot(k.sp)); $('#ai-tot').textContent = money(tot(k.ai)); $('#inv-tot').textContent = money(tot(k.inv));
    const st = tot(k.sh); $('#sh-tot').innerHTML = `<b class="${Math.abs(st) > 0.004 ? 'warn-t' : ''}">${st < -0.004 ? `(${money(-st)})` : money(st)}</b>`;
    $('#cc-pill').innerHTML = Math.abs(k.unsplit) > 0.004 ? `<span class="pill p-flag">₱${money(k.unsplit)} of the cash is not split</span>`
      : Math.abs(st) <= 0.004 ? '<span class="pill p-done">No shortage or overage</span>' : st > 0 ? `<span class="pill p-flag">Shortage ₱${money(st)}</span>` : `<span class="pill p-flag">Overage ₱${money(-st)}</span>`;
  };
  const refresh = () => c.rerender();
  paint();
  $$('[data-bill]').forEach((i) => { i.oninput = () => { d.bills[i.dataset.bill] = i.value.replace(/[^\d]/g, ''); paint(); }; });
  const coins = $('#cc-coins');
  if (coins) { coins.oninput = () => { d.coins = coins.value; paint(); }; coins.onblur = () => { const v = num(coins.value); if (v !== null) coins.value = money(v); }; }
  $$('.cc-al').forEach((i) => { i.oninput = () => { d.items[+i.closest('tr').dataset.it].allowed = i.value; paint(); }; i.onblur = () => { const v = num(i.value); if (v !== null) i.value = money(v); }; });
  $$('.cc-sp').forEach((i) => { i.oninput = () => { d.split[i.dataset.sp] = i.value.trim(); paint(); }; i.onblur = () => { const v = num(i.value); if (v !== null) i.value = money(v); }; });
  $$('[data-rmit]').forEach((b) => { b.onclick = () => { d.items.splice(+b.dataset.rmit, 1); refresh(); }; });
  const ce = $('#ci-enter');
  if (ce) {
    const add = () => {
      const p = $('#ci-part').value.trim(), a = num($('#ci-amt').value);
      if (!p) return bad('Type the particulars of the cash item.');
      if (!a || a <= 0) return bad('Enter the amount presented.');
      d.items.push({ particulars: p, appliesTo: $('#ci-to').value, presented: a, allowed: a });
      refresh();
    };
    ce.onclick = add; $('#ci-amt').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
  }
  const data = () => ({ examId: exam.id, bills: Object.fromEntries(Object.entries(d.bills).filter(([, v]) => v !== '' && v !== '0').map(([k, v]) => [k, parseInt(v, 10) || 0])),
    coins: num(d.coins) || 0, items: d.items.map((it) => ({ particulars: it.particulars, appliesTo: it.appliesTo, presented: +it.presented || 0, allowed: num(it.allowed ?? it.presented) ?? 0 })),
    split: Object.fromEntries(Object.entries(d.split).filter(([, v]) => v !== '' && v !== null && v !== undefined).map(([k, v]) => [k, num(v) || 0])) });
  const save = $('#cc-save');
  if (save) save.onclick = async () => {
    const k = compute(d, books);
    if (Math.abs(k.unsplit) > 0.004) return bad(`₱${money(k.unsplit)} of the cash on hand is not split. Check the typed amounts.`);
    if (d.items.some((it) => (num(it.allowed ?? it.presented) ?? 0) > (+it.presented || 0) + 0.004)) return bad('An allowed amount is more than what was presented.');
    save.disabled = true;
    try { DRAFT.key = ''; await store.save('cer_cashcount', exam.id, data(), by(refs)); toast('Cash Count saved.', 'ok'); } finally { save.disabled = false; }
  };
  $('#cc-xls').onclick = () => {
    const k = compute(d, books);
    exportXlsx(`Cash Count ${o.name} ${audit.countDate}.xlsx`, 'Cash Count', [
      ...BILLS.map((v) => ({ Part: 'Cash on hand', Item: `₱${v}`, Pieces: parseInt(d.bills[v], 10) || 0, Amount: v * (parseInt(d.bills[v], 10) || 0) })),
      { Part: 'Cash on hand', Item: 'Coins', Pieces: '', Amount: num(d.coins) || 0 }, { Part: 'Cash on hand', Item: 'Total', Pieces: '', Amount: k.cash },
      ...d.items.map((it) => ({ Part: 'Cash item', Item: it.particulars, Pieces: '', Amount: +it.presented || 0, Allowed: num(it.allowed ?? it.presented) ?? 0, 'Applies to': books.find((b) => b.key === it.appliesTo)?.label || it.appliesTo })),
      ...c.forms.map((x) => ({ Part: 'Unused forms', Item: `${x.name} ${x.from}–${x.to}`, Pieces: x.qty, Amount: x.face ? x.amount : '', Allowed: '', 'Applies to': x.text })),
      ...books.map((b) => ({ Part: 'Split', Item: b.label, Pieces: '', Amount: b.books, Allowed: k.inv[b.key], 'Applies to': `Shortage/(Overage) ${money(k.sh[b.key])}` }))]);
  };
  $('#cc-print').onclick = () => {
    const k = compute(d, books);
    const p = $('#cer-print');
    p.innerHTML = `<h2>Cash Count Sheet</h2>
      <p><b>${esc(o.name)}</b>, ${esc(o.designation || '')} · ${esc(agencyName(refs, c.lgu))} · cash count of ${esc(fmtDate(audit.countDate))}</p>
      <table><thead><tr><th>Denomination</th><th>No. of Pcs.</th><th>Amount</th></tr></thead><tbody>
      ${BILLS.map((v) => `<tr><td>₱${v.toLocaleString('en-US')}</td><td>${parseInt(d.bills[v], 10) || 0}</td><td>${money(v * (parseInt(d.bills[v], 10) || 0))}</td></tr>`).join('')}
      <tr><td>Coins</td><td></td><td>${money(num(d.coins) || 0)}</td></tr><tr><td><b>Total cash on hand</b></td><td></td><td><b>${money(k.cash)}</b></td></tr></tbody></table>
      <table><thead><tr><th>Cash items</th><th>Presented</th><th>Allowed</th><th>Disallowed</th></tr></thead><tbody>
      ${d.items.length ? d.items.map((it) => { const a = num(it.allowed ?? it.presented) ?? 0; return `<tr><td>${esc(it.particulars)}</td><td>${money(it.presented)}</td><td>${money(a)}</td><td>${money(r2((+it.presented || 0) - a))}</td></tr>`; }).join('') : '<tr><td colspan="4">None</td></tr>'}</tbody></table>
      <table><thead><tr><th>Unused accountable forms</th><th>Qty</th><th>Inclusive serial No.</th></tr></thead><tbody>
      ${c.forms.length ? c.forms.map((x) => `<tr><td>${esc(x.name)}${x.face ? ` (₱${money(x.amount)})` : ''}</td><td>${x.qty}</td><td>${esc(x.text)}</td></tr>`).join('') : '<tr><td colspan="3">None</td></tr>'}</tbody></table>
      <table><thead><tr><th></th>${books.map((b) => `<th>${esc(b.label)}</th>`).join('')}</tr></thead><tbody>
      <tr><td>Balance per books</td>${books.map((b) => `<td>${money(b.books)}</td>`).join('')}</tr>
      <tr><td>Inventory of cash and allowed cash items</td>${books.map((b) => `<td>${money(k.inv[b.key])}</td>`).join('')}</tr>
      <tr><td><b>Shortage / (Overage)</b></td>${books.map((b) => `<td><b>${money(k.sh[b.key])}</b></td>`).join('')}</tr></tbody></table>
      <p>Counted in the presence of the accountable officer. Prepared by ${esc(refs.me?.data.name || '')}.</p>`;
    document.body.classList.add('af-printing'); p.hidden = false; window.print(); p.hidden = true; document.body.classList.remove('af-printing');
  };
}
