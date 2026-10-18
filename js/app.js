// Start-up and screen router: login → dashboard → Admin screens.
import { DEMO } from './config.js';
import { auth } from './auth.js';
import { store, loadRefs, onChange } from './store.js';
import { startSync, syncNow, syncState } from './sync.js';
import { $, toast, bottomBand } from './ui.js';
import { loginHtml } from './views/login.js';
import { dashboardHtml } from './views/dashboard.js';
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
  const refs = await loadRefs(auth.session.email);
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
  const refs = await loadRefs(auth.session.email);
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
onChange(() => render());
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
