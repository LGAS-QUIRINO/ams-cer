// Source Documents · Check Disbursements Journal: the data, shared with Cash Examination.
//
// Record:
//   src_ckdj  one check  { coa: 3, lguId, acctId (bank account: cer_settings banks|<lguId>), date, checkNo, ref (DV / payroll No.), payee, amount
//                          (check amount, from the Report of Checks Issued, encoded first),
//                          particulars, lines[{ code, name, gross }], tax: { taxable, vat (true / false; null when imported),
//                          main (5% or 3%, typed when rounded; empty = computed), one (1%, same) }, cancelled, officerId (for a
//                          cash advance), note (auditor's note) }
// Tax (Tax Register): VAT → base = gross ÷ 1.12, 5% creditable VAT; Non-VAT → base = gross, 3% percentage tax; plus the EWT
// on the same base: goods 1%, services 2% (tax.svc). Amounts may be typed (rounding).
// Check amount = gross − tax. A check charged to a cash advance account is a cash advance of officerId.
import { store } from '../../js/store.js';

const r2 = (n) => Math.round((+n || 0) * 100) / 100;
const flat = (r) => ({ id: r.id, ...r.data });

let COA = null;
export async function loadCoa() {
  if (!COA) COA = await (await fetch('lib/coa-barangay.json')).json();
  return COA;
}
// Chart of Accounts: the Barangay Manual first; accounts not in the Manual from the Revised Chart of Accounts for LGUs
// (COA Circular, Annex A). Cash advances: Petty Cash, the Manual's two Advances accounts and the Circular's 1-03-05 accounts.
export const CA_CODES = ['1-01-01-020', '1-03-03-010', '1-03-03-020', '1-03-05-010', '1-03-05-020', '1-03-05-030', '1-03-05-040'];
// Checks saved with coa: 2 (5 Nov 2026, when Manual codes were briefly changed to the Circular's) get their Manual codes back
// (coa.rev: Circular code → Manual code). Saved from now on with coa: 3. Checks without coa keep their codes as typed.
export function upgrade(c, coa) {
  if (!c || c.coa !== 2) return c;
  const lines = (c.lines || []).map((l) => (l.code && coa.rev[l.code] ? { ...l, code: coa.rev[l.code], name: '' } : l));
  return { ...c, lines, coa: 3 };
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
    const pct = t.svc ? 2 : 1;   // EWT (creditable income tax): goods 1%, services 2%
    const one = t.one === null || t.one === undefined || t.one === '' ? r2(base * pct / 100) : r2(t.one);
    return { base, main, one, amount: r2(main + one), vat: t.vat, svc: !!t.svc };
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

// The person of a cash advance is the payee. An accountable officer (cer_officers of the office) is matched by name,
// ignoring capitals, dots, commas and middle initials (Victorino D. Amador = VICTORINO AMADOR); only a single match counts.
// A check's officer picked by hand (officerId) stays. aoId: the AO of a cash advance check, or ''.
const nameKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-zñ\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !/^(jr|sr|ii|iii|iv)$/.test(w)).sort().join(' ');
export function matchAo(payee, officers, lguId) {
  const k = nameKey(payee); if (!k) return null;
  const hits = officers.filter((o) => o.lguId === lguId && nameKey(o.name) === k);
  return hits.length === 1 ? hits[0] : null;
}
const flatOfficers = async () => (await store.list('cer_officers')).map(flat);
const withAo = (c, officers) => (isCa(c) ? { ...c, aoId: c.officerId || matchAo(c.payee, officers, c.lguId)?.id || '' } : { ...c, aoId: '' });
const listJournal = async () => { const [rs, coa, officers] = await Promise.all([store.list('src_ckdj'), loadCoa(), flatOfficers()]);
  return rs.map((r) => ({ ...r, data: withAo(upgrade(r.data, coa), officers) })); };
export async function loadJournal() { return (await listJournal()).map(flat); }

// For Cash Examination: the cash advances typed in Cash Advances plus those from the journal of an AO (matched or picked).
// A journal check already typed in Cash Advances is not doubled: the typed one stays and is marked inJournal.
// all: true also gives the journal's cash advances of persons who are not AOs (the Punong Barangay, a Kagawad…), with
// person (the payee) and officerId ''. Returns records shaped like store.list() ({ id, data }).
export async function listAdvances(all = false) {
  const [typed, jr] = await Promise.all([store.list('cer_cashadv'), loadJournal()]);
  const key = (lguId, no) => `${lguId}|${chkNo(no)}`;
  const jrCa = jr.filter((c) => isCa(c) && (all || c.aoId));
  const jrKeys = new Set(jrCa.map((c) => key(c.lguId, c.checkNo)));
  const typedKeys = new Set(typed.filter((r) => !r.deleted).map((r) => key(r.data.lguId, r.data.checkNo)));
  const out = typed.map((r) => (jrKeys.has(key(r.data.lguId, r.data.checkNo)) ? { ...r, data: { ...r.data, inJournal: true } } : r));
  jrCa.filter((c) => !typedKeys.has(key(c.lguId, c.checkNo))).forEach((c) => out.push({ id: `ckdj|${c.id}`,
    data: { lguId: c.lguId, officerId: c.aoId, person: c.payee || '', date: c.date, checkNo: c.checkNo, particulars: c.particulars || c.payee || '', amount: caGrossOf(c), fromJournal: c.id, acctId: c.acctId } }));
  return out;
}
// store.list, with the journal's cash advances added to cer_cashadv.
export const listT = (t) => (t === 'cer_cashadv' ? listAdvances() : t === 'src_ckdj' ? listJournal() : store.list(t));

// For Bank Statements: the journal's checks of a bank account that are not AO cash advances (those come with Cash Advances).
export const bankChecksOf = (jr, acctId) => jr.filter((c) => c.acctId === acctId && !c.cancelled && !(isCa(c) && (c.aoId ?? c.officerId)));

// A transfer into a bank account: a check of another account of the office paid to this account's fund (the payee names it,
// e.g. "Brgy. Sta. Maria 5% BDRRM Fund", or the particulars say transfer … 5% BDRRM). For the Cashbook and the bank reconciliation.
const fcore = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9%]/g, '').replace(/landbankofthephilippines|landbank|lbp|dbp|fund$/g, '');
export function transfersInto(jr, acct, lguId) {
  const k = fcore(acct.fund); if (k.length < 3 || k === 'general') return [];
  const has = (t) => fcore(t).includes(k);
  return jr.filter((c) => c.lguId === lguId && c.acctId && c.acctId !== acct.id && !c.cancelled && (has(c.payee) || (/transfer/i.test(c.particulars || '') && has(c.particulars))));
}
// A transfer already typed as a bank credit (Cashbook "Other entry"): same amount, and its text names the check No. or its
// date is within 15 days of the check (the bank credits it a day or more later). Not counted twice.
export const typedTransfer = (c, x) => Math.abs((+x.amount || 0) - checkAmountOf(c)) < 0.005
  && (String(x.text || '').match(/\d+/g) || []).map(Number).includes(chkNo(c.checkNo)) || (Math.abs((+x.amount || 0) - checkAmountOf(c)) < 0.005 && Math.abs(Date.parse(x.date) - Date.parse(c.date)) <= 15 * 86400000);
