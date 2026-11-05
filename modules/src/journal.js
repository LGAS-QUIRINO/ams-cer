// Source Documents · Check Disbursements Journal: the data, shared with Cash Examination.
//
// Record:
//   src_ckdj  one check  { coa: 2 (revised chart codes), lguId, acctId (bank account: cer_settings banks|<lguId>), date, checkNo, ref (DV / payroll No.), payee, amount
//                          (check amount, from the Report of Checks Issued, encoded first),
//                          particulars, lines[{ code, name, gross }], tax: { taxable, vat (true / false; null when imported),
//                          main (5% or 3%, typed when rounded; empty = computed), one (1%, same) }, cancelled, officerId (for a
//                          cash advance), note (auditor's note) }
// Tax (Tax Register): VAT → base = gross ÷ 1.12, 5%; Non-VAT → base = gross, 3%; the 1% is on the same base.
// Check amount = gross − tax. A check charged to a cash advance account is a cash advance of officerId.
import { store } from '../../js/store.js';

const r2 = (n) => Math.round((+n || 0) * 100) / 100;
const flat = (r) => ({ id: r.id, ...r.data });

let COA = null;
export async function loadCoa() {
  if (!COA) COA = await (await fetch('lib/coa-barangay.json')).json();
  return COA;
}
// Revised Chart of Accounts for LGUs (Annex A). Cash advances: Petty Cash and the four Advances accounts.
export const CA_CODES = ['1-01-01-020', '1-03-05-010', '1-03-05-020', '1-03-05-030', '1-03-05-040'];
// Checks encoded before the revised chart (no coa: 2) have the old barangay codes: changed to the new code of the same
// account (coa.old: old code → [new code or null, old title]). An old account with no new one keeps its amount, with old
// (the old code) and no code, for the auditor to choose the new account.
export function upgrade(c, coa) {
  if (!c || c.coa === 2) return c;
  const lines = (c.lines || []).map((l) => {
    const m = l.code && coa.old[l.code]; if (!m) return l;
    return m[0] ? { ...l, code: m[0], name: '' } : { code: '', name: '', gross: l.gross, old: l.code, oldName: m[1] };
  });
  return { ...c, lines, coa: 2 };
}

export const grossOf = (c) => r2((c.lines || []).reduce((n, l) => n + (+l.gross || 0), 0));
export function taxOf(c) {
  const t = c.tax || {}, g = grossOf(c);
  const none = { base: 0, main: 0, one: 0, amount: 0, vat: null };
  if (c.cancelled) return none;
  if (t.taxable) {
    // Taxable: VAT → base = gross ÷ 1.12, 5%; Non-VAT → base = gross, 3%; plus 1% on the base. Amounts may be typed (rounding).
    if (t.vat !== true && t.vat !== false) return { ...none, main: r2(t.main || 0), amount: r2((t.main || 0) + (t.one || 0)), one: r2(t.one || 0) };   // imported, VAT not yet set
    const base = t.vat ? r2(g / 1.12) : g;
    const main = t.main === null || t.main === undefined || t.main === '' ? r2(base * (t.vat ? 5 : 3) / 100) : r2(t.main);
    const one = t.one === null || t.one === undefined || t.one === '' ? r2(base / 100) : r2(t.one);
    return { base, main, one, amount: r2(main + one), vat: t.vat };
  }
  if (t.rate) { const base = t.rate === 5 ? r2(g / 1.12) : g; const main = r2(base * t.rate / 100), one = t.one ? r2(base / 100) : 0; return { base, main, one, amount: r2(main + one), vat: t.rate === 5 }; }   // older entries
  return { ...none, amount: r2(t.amount || 0), main: r2(t.amount || 0) };
}
export const isTaxable = (c) => !c.cancelled && (!!(c.tax || {}).taxable || taxOf(c).amount > 0);
// The check amount: as typed in the Report of Checks Issued (amount); older entries without it: gross − tax.
export const hasAmount = (c) => c.amount !== undefined && c.amount !== null && c.amount !== '';
export const checkAmountOf = (c) => (c.cancelled ? 0 : hasAmount(c) ? r2(c.amount) : r2(grossOf(c) - taxOf(c).amount));
// The journal entry (accounts and gross amounts) is filled; it tallies when gross − tax = the check amount.
export const hasEntry = (c) => (c.lines || []).some((l) => (l.code || l.old) && +l.gross > 0);
export const tallies = (c) => !hasAmount(c) || Math.abs(r2(grossOf(c) - taxOf(c).amount) - r2(c.amount)) < 0.005;
export const caGrossOf = (c) => r2((c.lines || []).filter((l) => CA_CODES.includes(l.code)).reduce((n, l) => n + (+l.gross || 0), 0));
export const isCa = (c) => !c.cancelled && caGrossOf(c) > 0;
export const chkNo = (v) => +String(v ?? '').replace(/\D/g, '') || 0;

const listJournal = async () => { const [rs, coa] = await Promise.all([store.list('src_ckdj'), loadCoa()]); return rs.map((r) => ({ ...r, data: upgrade(r.data, coa) })); };
export async function loadJournal() { return (await listJournal()).map(flat); }

// For Cash Examination: the cash advances typed in Cash Advances plus those from the journal (a check charged to a cash
// advance account, with its officer). A journal check already typed in Cash Advances is not doubled: the typed one stays
// and is marked inJournal. Returns records shaped like store.list() ({ id, data }).
export async function listAdvances() {
  const [typed, jr] = await Promise.all([store.list('cer_cashadv'), loadJournal()]);
  const key = (lguId, no) => `${lguId}|${chkNo(no)}`;
  const jrCa = jr.filter((c) => isCa(c) && c.officerId);
  const jrKeys = new Set(jrCa.map((c) => key(c.lguId, c.checkNo)));
  const typedKeys = new Set(typed.filter((r) => !r.deleted).map((r) => key(r.data.lguId, r.data.checkNo)));
  const out = typed.map((r) => (jrKeys.has(key(r.data.lguId, r.data.checkNo)) ? { ...r, data: { ...r.data, inJournal: true } } : r));
  jrCa.filter((c) => !typedKeys.has(key(c.lguId, c.checkNo))).forEach((c) => out.push({ id: `ckdj|${c.id}`,
    data: { lguId: c.lguId, officerId: c.officerId, date: c.date, checkNo: c.checkNo, particulars: c.particulars || c.payee || '', amount: caGrossOf(c), fromJournal: c.id, acctId: c.acctId } }));
  return out;
}
// store.list, with the journal's cash advances added to cer_cashadv.
export const listT = (t) => (t === 'cer_cashadv' ? listAdvances() : t === 'src_ckdj' ? listJournal() : store.list(t));

// For Bank Statements: the journal's checks of a bank account that are not cash advances (those come with Cash Advances).
export const bankChecksOf = (jr, acctId) => jr.filter((c) => c.acctId === acctId && !c.cancelled && !(isCa(c) && c.officerId));
