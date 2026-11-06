// The working scope (AMS Dashboard, "Working on"): one PLGU, or one municipality with its barangays, or All. Kept on this
// device only (each person picks their own). Every module lists only the offices in the scope (mayView in modules/cer/cer.js).
const KEY = 'ams.scope';
let REFS = null;
export const getScope = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
export const setScope = (id) => { try { if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY); } catch { /* private window: not kept */ } };
// The offices a person may see at all (their teams and municipalities), before the scope.
export function baseVisible(refs, lgu) {
  if (!lgu) return false;
  const d = refs.me?.data, roles = d?.roles || [];
  if (refs.isAdmin || roles.some((r) => ['admin', 'sa', 'osa'].includes(r))) return true;
  if (!d || !(d.teamIds || []).includes(lgu.data.teamId)) return false;
  if (roles.includes('atl')) return true;
  const mun = lgu.data.kind === 'barangay' ? lgu.data.parentId : lgu.data.kind === 'municipality' ? lgu.id : '';
  return !(d.munIds || []).length || !mun || d.munIds.includes(mun);
}
// In the scope: the PLGU alone; a municipality with its barangays.
export function inScope(refs, lgu) {
  const s = getScope(); if (!s || !lgu) return true;
  if (!refs.lgu[s]) return true;   // a scope no longer in the list: all
  return lgu.id === s || (lgu.data.kind === 'barangay' && lgu.data.parentId === s);
}
export const scopeOptions = (refs) => (refs ? refs.lgus.filter((l) => (l.data.kind === 'province' || l.data.kind === 'municipality') && baseVisible(refs, l))
  .sort((a, b) => (a.data.kind === 'province' ? -1 : b.data.kind === 'province' ? 1 : a.data.name.localeCompare(b.data.name))) : []);
export const setScopeRefs = (refs) => { REFS = refs; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const scopeName = (l) => (l.data.kind === 'province' ? `PLGU – ${l.data.name}` : `LGU – ${l.data.name} (with its barangays)`);
// The "Working on" select (dashboard and module headers).
export function scopeSelect(id, cls = '') {
  const opts = scopeOptions(REFS); if (!opts.length) return '';
  const s = REFS.lgu[getScope()] ? getScope() : '';
  return `<label class="scope-pick ${cls}"><span>Working on</span><select class="input" id="${id}" aria-label="Working on">${[`<option value="" ${s ? '' : 'selected'}>All</option>`, ...opts.map((l) => `<option value="${esc(l.id)}" ${l.id === s ? 'selected' : ''}>${esc(scopeName(l))}</option>`)].join('')}</select></label>`;
}
// Changing it anywhere redraws the screen in the new scope.
document.addEventListener('change', (e) => {
  const el = e.target; if (!el || (el.id !== 'm-scope' && el.id !== 'd-scope')) return;
  setScope(el.value); window.dispatchEvent(new HashChangeEvent('hashchange'));
});
