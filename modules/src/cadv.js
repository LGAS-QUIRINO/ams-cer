// Source Documents · the cash advances of an office, for the Liquidation Journal and Unliquidated Cash Advances.
// Each: the check (typed in Cash Advances, or from the CkDJ, of an AO or not), its bank account, its Advances account
// (the credit of a liquidation), the person (the AO, else the payee) and the liquidations under it.
import { store } from '../../js/store.js';
import { caAcct } from '../cer/funds.js';
import { listAdvances, CA_CODES, chkNo } from './journal.js';

const r2 = (n) => Math.round((+n || 0) * 100) / 100;
const flat = (r) => ({ id: r.id, ...r.data });

export async function cashAdvancesOf({ lgu, accounts, jr, books }) {
  const [advs0, liqs0, officers0] = await Promise.all([listAdvances(true), store.list('cer_liquid'), store.list('cer_officers')]);
  const officers = Object.fromEntries(officers0.map((r) => [r.id, r.data]));
  const ctxF = { booklets: books, accounts };
  const jrOf = (a) => (a.fromJournal ? jr.find((x) => x.id === a.fromJournal) : jr.find((x) => x.lguId === a.lguId && chkNo(x.checkNo) === chkNo(a.checkNo) && !x.cancelled)) || null;
  const liqs = liqs0.map(flat).filter((l) => l.lguId === lgu.id);
  const advs = advs0.map(flat).filter((a) => a.lguId === lgu.id).map((a) => {
    const j = jrOf(a), caLine = j && (j.lines || []).find((l) => CA_CODES.includes(l.code));
    const ac = (j && accounts.find((x) => x.id === j.acctId)) || caAcct(a, ctxF);
    const liq = r2(liqs.filter((l) => l.advanceId === a.id).reduce((n, l) => n + (+l.amount || 0), 0));
    const o = officers[a.officerId];
    return { ...a, acctId: ac ? ac.id : '', fund: ac ? ac.fund : '', credit: caLine ? caLine.code : '', inCkdj: !!j, bal: r2((+a.amount || 0) - liq),
      isAo: !!o, officer: o ? o.name : a.person || (j && j.payee) || '', designation: o ? o.designation || '' : '' };
  });
  return { advs, liqs };
}
