// Start-up and screen router: login → dashboard → Admin screens.
import { DEMO } from './config.js';
import { auth } from './auth.js';
import { store, loadRefs, onChange } from './store.js';
import { startSync, syncNow, syncState } from './sync.js';
import { $, toast, bottomBand } from './ui.js';
import { loginHtml } from './views/login.js';
import { dashboardHtml } from './views/dashboard.js';
import { setScopeRefs } from './scope.js';
import { MODULES } from './modules.js';
import { DEMO_JO } from './seed.js';
import { adminBar, notAdmin, roleLine, usersHtml, wireUsers, teamsHtml, wireTeams, lgusHtml, wireLgus } from './views/admin.js';

const app = document.getElementById('app');

// Small status shown on the Admin screens: whether changes have reached the AMS database.
export function syncPill(st = syncState) {
  if (DEMO) return '<span id="sync" class="sync demo">Demo Mode · saved in this browser only</span>';
  const n = st.pending || 0;
  const text = st.status === 'offline' ? (n ? `Offline · ${n} change${n > 1 ? 's' : ''} saved on this device` : 'Offline')
    : st.status === 'syncing' || st.status === 'retry' ? 'Saving to database…'
    : st.status === 'signin' ? 'Sign in again to send changes'
    : n ? `${n} change${n > 1 ? 's' : ''} waiting to send` : 'All changes saved';
  const kind = st.status === 'offline' || st.status === 'signin' || st.status === 'error' ? 'warn' : n || st.status === 'syncing' ? '' : 'ok';
  return `<span id="sync" class="sync ${kind}" title="${st.lastSync ? 'Last sync ' + new Date(st.lastSync).toLocaleString() : ''}">● ${text}</span>`;
}
let signedIn = false;
let popPending = false;   // the Urgent Reports pop-out appears once each time the app is opened or someone signs in

async function showLogin(error = '') {
  signedIn = false;
  app.innerHTML = loginHtml(error);
  if (DEMO) {
    $('#demo-signin').addEventListener('click', async () => { await auth.demoSignIn(); enter(); });
    // Demo Mode only: sign in as the sample JO account (added to Users & Roles the first time).
    $('#demo-jo').addEventListener('click', async () => {
      if (!(await store.list('users')).some((u) => u.id === DEMO_JO.id)) await store.save('users', DEMO_JO.id, DEMO_JO, 'setup');
      await auth.demoSignIn('jo'); enter();
    });
    return;
  }
  try { await auth.renderButton($('#gsi-btn')); }
  catch (e) { app.innerHTML = loginHtml(error || e.message); }
}

async function enter() {
  if (!DEMO) {
    // Connected: on a device's first sign-in, wait for the database before deciding who this is.
    const have = (await store.list('users')).length > 0;
    if (!have) app.innerHTML = loginHtml('', 'Connecting to the AMS database…');
    const problems = have ? (startSync(), []) : await startSync();
    if (!have && problems.length && !(await store.list('users')).length) {
      const m = problems[0];
      if (/not registered|not for this app|not verified/i.test(m)) { await auth.signOut(); return showLogin(m); }
      return showLogin(m === 'OFFLINE' || /fetch/i.test(m) ? 'No internet. The first sign-in on this device needs internet.' : m);
    }
  }
  const refs = await loadRefs(auth.session.email); setScopeRefs(refs);
  if (!DEMO && (!refs.me || refs.me.data.status === 'disabled')) {
    await auth.signOut(); await store.wipe();
    return showLogin('This Gmail is not registered in AMS. Ask the Admin to add it.');
  }
  signedIn = true;
  popPending = true;
  if (!location.hash || location.hash === '#') history.replaceState(null, '', '#/');
  render();
}

async function render() {
  if (!signedIn) return;
  const refs = await loadRefs(auth.session.email); setScopeRefs(refs);
  const [path, qs] = (location.hash.replace(/^#/, '') || '/').split('?');
  const q = new URLSearchParams(qs || '');
  const part = path.split('/').filter(Boolean);

  if (part[0] === 'admin') {
    const key = part[1] || 'users';
    const body = !refs.isAdmin ? notAdmin()
      : key === 'teams' ? teamsHtml(refs)
      : key === 'lgus' ? lgusHtml(refs, q)
      : usersHtml(refs);
    const y = window.scrollY;
    app.innerHTML = adminBar(key, refs, auth.session, syncPill()) + `<main class="admin">${body}</main>` + bottomBand();
    if (refs.isAdmin) {
      if (key === 'teams') wireTeams(refs);
      else if (key === 'lgus') wireLgus(refs, q);
      else wireUsers(refs, render);
    }
    if (render.sameRoute === location.hash) window.scrollTo(0, y);
    render.sameRoute = location.hash;
    return;
  }
  // A finished module opens from its card: #/<module id>/...  (its code lives in modules/<id>/)
  const mod = MODULES.find((m) => m.id === part[0] && m.ready && m.entry);
  if (mod) {
    const y = window.scrollY, same = render.sameRoute === location.hash;
    render.sameRoute = location.hash;
    try {
      const m = await import('../' + mod.entry);
      await m.render({ app, refs, q, parts: part.slice(1), session: auth.session, rerender: render, syncHtml: syncPill() });
      if (same) window.scrollTo(0, y);
    } catch (e) { app.innerHTML = `<div class="page"><div class="msg bad">${e.message}</div><a class="btn" href="#/">← Back to Dashboard</a></div>`; }
    return;
  }
  render.sameRoute = '';
  showDashboard(refs);
}

function showDashboard(refs) {
  const name = refs.me ? (refs.me.data.nickname || refs.me.data.name) : '';
  app.innerHTML = dashboardHtml(auth.session, refs.me ? roleLine(refs) : (DEMO ? 'Admin · Demo Mode' : 'Signed in'), refs.isAdmin, name);

  const pop = $('#urgent');
  const hide = () => { pop.hidden = true; };
  $('#bell').addEventListener('click', () => { pop.hidden = !pop.hidden; });
  $('#u-close').addEventListener('click', hide);
  $('#u-ok').addEventListener('click', hide);
  $('#u-all').addEventListener('click', (e) => { e.preventDefault(); toast('The full Urgent Items list comes with the first module.'); });

  if (popPending) { popPending = false; pop.hidden = false; }

  app.querySelectorAll('.card').forEach((card) => card.addEventListener('click', (e) => {
    const m = MODULES.find((x) => x.id === card.dataset.mod);
    if (!m.ready) { e.preventDefault(); toast(`${m.title} is not built yet. It will open here once the module is ready.`); }
  }));

  $('#signout').addEventListener('click', async () => { await auth.signOut(); history.replaceState(null, '', '#/'); showLogin(); });
}

window.addEventListener('hashchange', () => render());
// Sign Out from inside a module (the module frame's top bar).
document.addEventListener('click', async (e) => {
  if (!e.target.closest || !e.target.closest('#m-signout')) return;
  await auth.signOut(); history.replaceState(null, '', '#/'); showLogin();
});
window.addEventListener('sync-status', (e) => {
  const el = document.getElementById('sync'); if (el) el.outerHTML = syncPill(e.detail);
  if (e.detail.status === 'error' && e.detail.message) toast(e.detail.message, 'bad');
});
window.addEventListener('access-revoked', async (e) => { await auth.signOut(); await store.wipe(); showLogin(e.detail); });
// A sync that brings in changes (another user's save) redraws the screen. What the person is typing must not be lost:
//  - while a window (modal) is open, the redraw waits until it is closed;
//  - while the person is typing, it waits until they stop for 3 seconds or leave the field (a small note says so);
//  - fields typed in but not yet saved are put back after the redraw, with the cursor and the scroll positions where they were.
// The person's own saves ('local') redraw as before (Enter / Save clear their fields on purpose).
let syncWaiting = false, lastKey = 0;
const IDLE_MS = 3000;
document.addEventListener('keydown', () => { lastKey = Date.now(); }, true);
document.addEventListener('input', () => { lastKey = Date.now(); }, true);
const isTextField = (el) => !!el && app.contains(el) && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'file'].includes(el.type)));
const busyTyping = () => isTextField(document.activeElement) && Date.now() - lastKey < IDLE_MS;
function waitNote(on) {
  let n = document.getElementById('sync-wait');
  if (!on) { if (n) n.remove(); return; }
  if (n) return;
  n = document.createElement('div'); n.id = 'sync-wait'; n.setAttribute('role', 'status');
  n.textContent = 'Updated by another user · refreshes when you stop typing';
  n.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:60;background:#fff7e0;color:#7a5200;border:1px solid #f0d48a;border-radius:999px;padding:7px 14px;font-size:12.5px;box-shadow:0 4px 14px rgba(0,0,0,.12)';
  document.body.appendChild(n);
}
function typedFields() {
  return [...app.querySelectorAll('input[id], select[id], textarea[id]')].filter((el) => {
    if (el.disabled || el.type === 'file' || el.type === 'hidden') return false;
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked !== el.defaultChecked;
    if (el.tagName === 'SELECT') return [...el.options].some((o) => o.selected !== o.defaultSelected);
    return el.value !== el.defaultValue;
  }).map((el) => ({ id: el.id, type: el.type, value: el.value, checked: el.checked }));
}
// Scroll positions of the page and of scrolling boxes (e.g. the OR list), keyed by id or class and order.
function scrollKey(el, i) { return el.id ? '#' + el.id : `${el.tagName}.${[...el.classList].join('.')}|${i}`; }
function scrolls() {
  const out = { page: (document.scrollingElement || document.documentElement).scrollTop, boxes: {} };
  const seen = {};
  app.querySelectorAll('*').forEach((el) => { if (el.scrollHeight > el.clientHeight + 1 || el.scrollTop) { const k0 = scrollKey(el, 0).split('|')[0]; const i = seen[k0] = (seen[k0] ?? -1) + 1; if (el.scrollTop) out.boxes[scrollKey(el, i)] = el.scrollTop; } });
  return out;
}
function putScrolls(s) {
  const seen = {};
  app.querySelectorAll('*').forEach((el) => { if (el.scrollHeight > el.clientHeight + 1 || el.scrollTop) { const k0 = scrollKey(el, 0).split('|')[0]; const i = seen[k0] = (seen[k0] ?? -1) + 1; const k = scrollKey(el, i); if (k in s.boxes) el.scrollTop = s.boxes[k]; } });
  (document.scrollingElement || document.documentElement).scrollTop = s.page;
}
async function syncRedraw() {
  if (document.querySelector('.modal-bg') || busyTyping()) {
    if (syncWaiting) return; syncWaiting = true;
    if (!document.querySelector('.modal-bg')) waitNote(true);
    const wait = setInterval(() => { if (!document.querySelector('.modal-bg') && !busyTyping()) { clearInterval(wait); syncWaiting = false; syncRedraw(); } }, 400);
    return;
  }
  waitNote(false);
  const kept = typedFields();
  const act = document.activeElement && app.contains(document.activeElement) && document.activeElement.id ? document.activeElement : null;
  const focus = act ? { id: act.id, start: act.selectionStart, end: act.selectionEnd } : null;
  const sc = scrolls();
  await render();
  kept.forEach((k) => {
    const el = document.getElementById(k.id); if (!el || el.disabled) return;
    if (k.type === 'checkbox' || k.type === 'radio') { if (el.checked === k.checked) return; el.checked = k.checked; }
    else { if (el.value === k.value) return; el.value = k.value; }
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  putScrolls(sc);
  if (focus) { const el = document.getElementById(focus.id); if (el) { el.focus({ preventScroll: true }); try { if (focus.start !== null && focus.start !== undefined) el.setSelectionRange(focus.start, focus.end); } catch (e) { /* not a text field */ } } }
}
onChange((src) => (src === 'sync' ? syncRedraw() : render()));
window.addEventListener('signed-in', () => enter());

async function start() {
  await store.ready();
  const s = await auth.restore();
  const check = auth.openCheck();
  if (!s) return showLogin();
  if (check === 'old') { await auth.signOut(); return showLogin('Please sign in again. It has been more than 7 days since your last sign-in.'); }
  if (check === 'again') return showLogin('Your sign-in has expired. Please sign in again.');
  enter();
}

start();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
