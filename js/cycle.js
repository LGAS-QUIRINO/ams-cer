// Cash examination cycles: each round of cash counts is one group, whatever the count dates and offices
// (e.g. "May – June 2026"). The cycle shown is kept on this device only: Current (the default), one cycle, or All.
// The list of cycles is cached here by the CER module (loadCer) so the header select can show it at once.
const KEY = 'ams.cycle', CACHE = 'ams.cycles';
const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const put = (k, v) => { try { if (v === null || v === undefined || v === '') localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private window */ } };
export const getCycle = () => get(KEY) || 'cur';          // 'cur' | 'all' | a cycle id
export const setCycle = (v) => put(KEY, v && v !== 'cur' ? v : '');
export const cachedCycles = () => { try { return JSON.parse(get(CACHE) || 'null') || { list: [], current: '' }; } catch { return { list: [], current: '' }; } };
export const cacheCycles = (c) => put(CACHE, JSON.stringify(c));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// The "Cycle" select in the module header (cash examination screens only).
export function cycleSelect(id, cls = '') {
  const c = cachedCycles(); if (!c.list.length) return '';
  const s = getCycle(), cur = c.list.find((x) => x.id === c.current);
  const opts = [`<option value="cur" ${s === 'cur' ? 'selected' : ''}>Current${cur ? ` · ${esc(cur.name)}` : ''}</option>`,
    ...c.list.filter((x) => x.id !== c.current).map((x) => `<option value="${esc(x.id)}" ${s === x.id ? 'selected' : ''}>${esc(x.name)}</option>`),
    `<option value="all" ${s === 'all' ? 'selected' : ''}>All cycles</option>`];
  return `<label class="scope-pick ${cls}"><span>Cycle</span><select class="input" id="${id}" aria-label="Cash examination cycle">${opts.join('')}</select></label>`;
}
// The cash examination being worked on (set by the CER screens): shown in the header with a link to change it.
export function pickChip() {
  let p = {}; try { p = JSON.parse(localStorage.getItem('ams.cerpick') || '{}') || {}; } catch { /* none */ }
  if (!p.a || !p.label) return '';
  return `<span class="cer-pick" title="Every screen opens on this cash examination until you pick another"><span>Working on</span><b>${esc(p.label)}</b><a href="#/cer/setup">Change</a></span>`;
}
document.addEventListener('change', (e) => {
  const el = e.target; if (!el || el.id !== 'm-cycle') return;
  setCycle(el.value); window.dispatchEvent(new HashChangeEvent('hashchange'));
});
