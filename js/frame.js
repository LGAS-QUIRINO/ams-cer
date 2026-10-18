// The standard frame every AMS module uses (design approved 17 Oct 2026):
// navy sidebar (module name, back to AMS, the module's parts, a Setup section, sync box) and a top bar (page name, user, Sign Out).
import { DEMO } from './config.js';
import { syncState } from './sync.js';
import { esc, bottomBand } from './ui.js';

const ICONS = {
  overview: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
  grid: '<path d="M3 3h18v18H3z"/><path d="M3 9h18M9 3v18"/>',
  inbox: '<path d="M4 4h16v12H4z"/><path d="M8 20h8M12 16v4"/><path d="M9 9l2 2 4-4"/>',
  book: '<path d="M4 4h12l4 4v12H4z"/><path d="M8 12h8M8 16h5"/>',
  box: '<path d="M3 7h18v13H3z"/><path d="M8 7V4h8v3"/>',
  swap: '<path d="M7 7h10v10H7z"/><path d="M17 12h4M3 12h4"/>',
  library: '<path d="M4 19V5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2z"/>',
  building: '<path d="M3 21h18M5 21V8l7-5 7 5v13"/><path d="M9 21v-6h6v6"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/>'
};
const icon = (k) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${ICONS[k] || ICONS.grid}</svg>`;

export function syncBox(st = syncState) {
  if (DEMO) return '<div class="syncbox" id="syncbox"><b><i class="warn"></i>Demo Mode</b><br>Saved in this browser only.</div>';
  const n = st.pending || 0;
  const head = st.status === 'offline' ? 'Offline' : st.status === 'syncing' || st.status === 'retry' ? 'Saving…' : st.status === 'signin' ? 'Sign in again' : n ? `${n} change${n > 1 ? 's' : ''} waiting` : 'All changes saved';
  const dot = st.status === 'offline' || st.status === 'signin' || st.status === 'error' ? 'warn' : '';
  const last = st.lastSync ? 'Last sync ' + new Date(st.lastSync).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '. ' : '';
  return `<div class="syncbox" id="syncbox"><b><i class="${dot}"></i>${head}</b><br>${last}Work saves on this device even without internet.</div>`;
}
window.addEventListener('sync-status', (e) => { const el = document.getElementById('syncbox'); if (el) el.outerHTML = syncBox(e.detail); });

// items: [{ key, label, icon, href, soon?, count?, section? }]  (section: true → a heading row)
export function moduleFrame({ title, items, active, crumb, me, roleText, body }) {
  const name = me ? me.name : '';
  const ini = String(name).split(/\s+/).filter((w) => /^[A-Z]/i.test(w)).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return `<div class="mshell">
    <aside class="mside">
      <div class="mbrand"><img src="img/coa-logo.png" alt="COA seal"><div><b>${title}</b><small>AMS · COA Quirino</small></div></div>
      <a class="mhome" href="#/">← AMS Dashboard</a>
      <nav class="mnav">${items.map((it) => it.section ? `<div class="msec">${esc(it.label)}</div>`
        : `<a href="${it.soon ? '#' : it.href}" class="${active === it.key ? 'on' : ''} ${it.soon ? 'soon' : ''}" ${it.soon ? `data-soon="${esc(it.label)}"` : ''}>${icon(it.icon)}<span>${esc(it.label)}</span>${it.count ? `<span class="cnt">${it.count}</span>` : ''}</a>`).join('')}</nav>
      ${syncBox()}
    </aside>
    <div class="mmain">
      <header class="mtop"><span class="crumb">${esc(crumb)}</span>
        <div class="mwho"><div class="av">${esc(ini)}</div><div><b>${esc(name)}</b><small>${esc(roleText)}</small></div>
          <button class="btn" type="button" id="m-signout">Sign Out</button></div></header>
      <div class="mcontent">${body}</div>
    </div>
  </div>`;
}
