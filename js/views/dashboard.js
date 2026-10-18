// Dashboard (design approved 17 Oct 2026): seven module cards, centered; Urgent Reports pops out at the lower-right corner.
import { esc, bottomBand } from '../ui.js';
import { MODULES, iconSvg } from '../modules.js';

const BELL = '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>';
const OUT = '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>';
const CHECK = '<path d="M5 12l5 5 9-10"/>';
const GEAR = '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>';

function initials(name, email) {
  const src = (name || email || '').replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  return ((src[0] || '?')[0] + (src[1] ? src[1][0] : '')).toUpperCase();
}

// Urgent items come from the modules once they are built. For now there are none.
export function urgentItems() { return []; }

function urgentHtml(items) {
  const body = items.length
    ? items.map((it) => `<div class="u-item"><b>${esc(it.title)}</b><span>${esc(it.detail || '')}</span></div>`).join('')
    : `<div class="u-empty"><div class="u-ok">${iconSvg(CHECK, 22)}</div>No urgent items right now.<br>Urgent reports will appear here and pop up when you sign in.</div>`;
  return `<div class="u-pop" id="urgent" hidden>
    <aside class="urgent" role="dialog" aria-label="Urgent reports">
      <p class="u-h"><svg width="20" height="20" viewBox="0 0 24 24" fill="#d62839" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0" stroke="#d62839" stroke-width="2" fill="none"/></svg>
        <b>URGENT REPORTS</b><span class="u-count">${items.length}</span><button class="u-x" id="u-close" aria-label="Close">×</button></p>
      <p class="u-sub">Items that need immediate attention</p>
      ${body}
      <a class="u-all" href="#" id="u-all">VIEW ALL URGENT ITEMS →</a>
      <div class="u-btns"><button class="btn primary" type="button" id="u-ok">OK, got it</button></div>
    </aside></div>`;
}

export function dashboardHtml(session, roleLine, isAdmin = false, displayName = '') {
  const items = urgentItems();
  return `<div class="dash">
    <header class="d-head">
      <div class="d-brand"><img src="img/coa-logo.png" alt="Commission on Audit seal">
        <div><p class="a">COMMISSION ON AUDIT</p><p class="r">REPUBLIC OF THE PHILIPPINES</p></div></div>
      <div class="d-user">
        <div class="who"><div class="avatar">${esc(initials(displayName || session.name, session.email))}</div>
          <div><p class="n">${esc((displayName || session.name || session.email).toUpperCase())}</p><p class="o">${esc(roleLine)}</p></div></div>
        <span class="sep"></span>
        ${isAdmin ? `<a class="icon-btn" id="admin" href="#/admin/users" title="Admin" aria-label="Admin">${iconSvg(GEAR, 22)}</a>` : ''}
        <button class="icon-btn" id="bell" title="Urgent reports" aria-label="Urgent reports">${iconSvg(BELL, 22)}${items.length ? '<span class="dot"></span>' : ''}</button>
        <button class="icon-btn" id="signout" title="Sign out" aria-label="Sign out">${iconSvg(OUT, 22)}</button>
      </div>
    </header>
    <div class="d-title">
      <h1>AUDIT MANAGEMENT SYSTEM</h1><div class="tri wide"></div>
      <p class="office">COA QUIRINO</p>
      <p class="motto">INTEGRATED AUDIT OPERATIONS FOR GREATER ACCOUNTABILITY</p>
    </div>
    <div class="cards">
      ${MODULES.map((m) => `<a class="card" href="${m.ready ? esc(m.path) : '#'}" data-mod="${m.id}" style="--k:${m.color}">
        <span class="ic">${iconSvg(m.icon)}</span>
        <h3>${esc(m.title)}</h3><p>${esc(m.text)}</p>
        <span class="go" aria-hidden="true">→</span></a>`).join('')}
    </div>
  </div>
  ${urgentHtml(items)}
  <div class="toast" id="toast" role="status" hidden></div>
  ${bottomBand()}`;
}
