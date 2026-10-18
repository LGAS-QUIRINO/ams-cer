// Talks to the AMS database (Apps Script web app under the AMS Gmail).
import { CONFIG } from './config.js';
import { auth } from './auth.js';

// Google sometimes drops a reply when it is busy. Such a call is tried again after 2 and then 5 seconds.
const AGAIN = [2000, 5000];
const busyStatus = (n) => n === 404 || n === 408 || n === 429 || n >= 500;
const busyError = (m) => /Lock timeout|too many times|timed out|Service unavailable|try again later/i.test(m);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function call(action, payload = {}) {
  const idToken = await auth.getToken();
  const body = JSON.stringify({ action, idToken, ...payload });
  for (let i = 0; ; i++) {
    const last = i >= AGAIN.length;
    let res;
    try {
      res = await fetch(CONFIG.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body });
    } catch (e) {
      if (last || !navigator.onLine) throw e;
      await wait(AGAIN[i]); continue;
    }
    if (!res.ok) {
      if (!last && busyStatus(res.status)) { await wait(AGAIN[i]); continue; }
      throw new Error('Server error ' + res.status);
    }
    let out;
    try { out = await res.json(); } catch (e) {
      if (!last) { await wait(AGAIN[i]); continue; }
      throw new Error('The server answer was not valid JSON');
    }
    if (!out.ok) {
      const m = out.error || 'Server error';
      if (!last && busyError(m)) { await wait(AGAIN[i]); continue; }
      throw new Error(m);
    }
    return out;
  }
}
