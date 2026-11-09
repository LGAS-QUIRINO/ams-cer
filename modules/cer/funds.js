// CER · the fund of a cash advance: the fund of the checkbook of its check (or of the journal's bank account).
// Bank accounts: cer_settings banks|<lguId> { list[{ id, bank, accountNo, fund }] }. A checkbook names its fund in fund and/or
// bankAccount (free text, e.g. "LBP - 5% BDRRM"); it belongs to the account whose No. or fund it names.
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9%]/g, '');
const core = (s) => norm(s).replace(/landbankofthephilippines|landbank|lbp|dbp|fund$/g, '');
const chkNo = (v) => +String(v ?? '').replace(/\D/g, '') || 0;

// Two fund names for the same fund ("General Fund" = "LBP - General Fund"; "5% BDRRM" = "5% BDRRM Fund").
export const sameFund = (a, b) => { const x = core(a), y = core(b); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };
// The fund of the collections (ORs with no fund): the General Fund account's, else the first account's.
export const colFundOf = (accounts) => (accounts.find((a) => sameFund(a.fund, 'General Fund')) || accounts[0])?.fund || 'General Fund';
export const accountsOf = (settings, lguId) => (settings && settings['banks|' + lguId]?.list) || [];
export function bookOfCheck(no, booklets) { const n = chkNo(no); return n ? booklets.find((b) => b.form === 'chk' && b.from <= n && n <= b.to) || null : null; }
export function acctOfBook(b, accounts) {
  if (!b) return null;
  const txt = norm([b.fund, b.bankAccount].join(' '));
  const byNo = accounts.find((a) => chkNo(a.accountNo) && txt.includes(String(chkNo(a.accountNo))));
  if (byNo) return byNo;
  const t = core(b.fund) || core(b.bankAccount);
  return t ? accounts.find((a) => { const k = core(a.fund); return k && (k === t || k.includes(t) || t.includes(k)); }) || null : null;
}
// ctx: { booklets, accounts }. a: a cash advance ({ checkNo, acctId? }).
// ctx.jr (optional): the Check Disbursements Journal (RCI): a check written there carries its bank account.
export function caAcct(a, ctx) {
  if (a.acctId) return ctx.accounts.find((x) => x.id === a.acctId) || null;
  const n = chkNo(a.checkNo);
  const j = n && (ctx.jr || []).find((x) => !x.cancelled && x.acctId && chkNo(x.checkNo) === n && (!a.lguId || !x.lguId || x.lguId === a.lguId));
  const ja = j && ctx.accounts.find((x) => x.id === j.acctId);
  return ja || acctOfBook(bookOfCheck(a.checkNo, ctx.booklets), ctx.accounts);
}
export function caFund(a, ctx) {
  const ac = caAcct(a, ctx); if (ac) return ac.fund;
  const b = bookOfCheck(a.checkNo, ctx.booklets);
  return b ? b.fund || b.bankAccount || 'Fund not identified' : 'Fund not identified';
}
// The fund of the beginning balance not itemized by check (Audit Setup), else the first account's fund.
export const restFund = (exam, ctx) => exam.caRestFund || ctx.accounts[0]?.fund || 'General Fund';
// The beginning cash advance balance by fund: the beginning checks by their fund, the rest in restFund.
// A beginning carried from the officer's previous cash exam in the app: the checks of before that count still unliquidated
// then make it up (each at its amount unliquidated at that count). Checks typed as beginning checks are not repeated.
export function carriedOpen(exam, advs, liqs) {
  const bal = exam.balances || {};
  if (!['ca', 'sdo', 'pcf'].some((k) => bal[k]?.source === 'carried') || !exam.lastExamDate) return [];
  const from = exam.lastExamDate;
  const typed = new Set(advs.filter((a) => a.officerId === exam.officerId && a.beg).map((a) => chkNo(a.checkNo)).filter(Boolean));
  return advs.filter((a) => a.officerId === exam.officerId && !a.beg && a.date && a.date < from && !typed.has(chkNo(a.checkNo))).map((a) => {
    const before = (liqs || []).filter((l) => l.advanceId === a.id && l.date && l.date < from).reduce((n, l) => n + (+l.amount || 0), 0);
    const u0 = Math.round(((+a.amount || 0) - before) * 100) / 100;
    return u0 > 0.004 ? { ...a, amount: u0, carried: true } : null;
  }).filter(Boolean);
}
export function begByFund(exam, advs, ctx, total, liqs) {
  const out = new Map();
  const add = (k, v) => out.set(k, Math.round(((out.get(k) || 0) + v) * 100) / 100);
  let s = 0;
  [...advs.filter((a) => a.officerId === exam.officerId && a.beg && !a.rest), ...carriedOpen(exam, advs, liqs)].forEach((a) => { const v = +a.amount || 0; s += v; add(caFund(a, ctx), v); });
  const rest = Math.round((total - s) * 100) / 100;
  if (Math.abs(rest) > 0.004) add(restFund(exam, ctx), rest);
  return out;
}
// The order of funds: the bank accounts' order, then the rest by name.
export const fundOrder = (ctx) => (a, b) => { const ia = ctx.accounts.findIndex((x) => x.fund === a), ib = ctx.accounts.findIndex((x) => x.fund === b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || String(a).localeCompare(String(b)); };
