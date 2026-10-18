// Sign-in. Real mode uses Google Sign-In (Gmail). Demo Mode signs in a demo user without Google.
import { CONFIG, DEMO } from './config.js';
import { db } from './db.js';

let session = null;          // { email, name, token, exp, signedAt }
let waiting = [];
const STALE_DAYS = 7;       // a sign-in older than this is asked again, even without internet

function decode(jwt) {
  const p = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(escape(atob(p))));
}

function onCredential(resp) {
  const info = decode(resp.credential);
  session = { email: String(info.email).toLowerCase(), name: info.name || '', token: resp.credential, exp: info.exp * 1000, signedAt: Date.now() };
  db.put('meta', session, 'session');
  waiting.forEach((w) => w.resolve(session.token)); waiting = [];
  window.dispatchEvent(new CustomEvent('signed-in', { detail: session }));
}

let gisReady = null;
function loadGis() {
  if (gisReady) return gisReady;
  gisReady = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = () => {
      window.google.accounts.id.initialize({ client_id: CONFIG.CLIENT_ID, callback: onCredential, auto_select: false, cancel_on_tap_outside: false, use_fedcm_for_prompt: true });
      resolve(window.google);
    };
    s.onerror = () => { gisReady = null; reject(new Error('Google Sign-In could not load. Check the internet connection.')); };
    document.head.appendChild(s);
  });
  return gisReady;
}

export const auth = {
  async restore() { session = (await db.get('meta', 'session')) || null; return session; },
  get session() { return session; },
  // 'ok' = open the app; 'again' = Google must confirm the account again (online, sign-in expired);
  // 'old' = no sign-in for more than STALE_DAYS (asked again even offline).
  openCheck() {
    if (DEMO || !session) return 'ok';
    if (!session.signedAt || Date.now() - session.signedAt > STALE_DAYS * 864e5) return 'old';
    if (navigator.onLine && !(session.exp > Date.now() + 60000)) return 'again';
    return 'ok';
  },
  async renderButton(el) {
    const g = await loadGis();
    g.accounts.id.renderButton(el, { theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular', width: 300 });
    g.accounts.id.prompt();
  },
  // Demo Mode: the Demo Admin, or the sample JO account (who = 'jo').
  async demoSignIn(who = 'admin') {
    session = who === 'jo' ? { email: 'jo@demo.ams', name: 'MARIA B. SANTOS', token: 'demo', exp: Date.now() + 3650 * 864e5, signedAt: Date.now() }
      : { email: 'admin@demo.ams', name: 'Demo Admin', token: 'demo', exp: Date.now() + 3650 * 864e5, signedAt: Date.now() };
    await db.put('meta', session, 'session');
  },
  // A fresh token for the server. Throws SIGNIN_NEEDED when Google needs the user to click again.
  async getToken() {
    if (DEMO) return 'demo';
    if (session && session.token && session.exp > Date.now() + 60000) return session.token;
    if (!navigator.onLine) throw new Error('OFFLINE');
    const g = await loadGis();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { waiting = waiting.filter((w) => w.resolve !== resolve); reject(new Error('SIGNIN_NEEDED')); }, 10000);
      waiting.push({ resolve: (v) => { clearTimeout(t); resolve(v); } });
      g.accounts.id.prompt();
    });
  },
  async signOut() {
    session = null;
    await db.del('meta', 'session');
    if (!DEMO && window.google) window.google.accounts.id.disableAutoSelect();
  }
};
