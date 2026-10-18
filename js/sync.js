// Sync with the AMS database: send what was saved on this device, then fetch what changed.
// The first save to reach the database wins; a later save based on an older copy is reported, and the newer copy is shown.
import { CONFIG } from './config.js';
import { db } from './db.js';
import { call } from './api.js';
import { emitChange } from './store.js';
import { auth } from './auth.js';

export const syncState = { status: 'idle', pending: 0, message: '', lastSync: null };
let running = null, timer = null, fails = 0;

function publish(patch) {
  Object.assign(syncState, patch);
  window.dispatchEvent(new CustomEvent('sync-status', { detail: { ...syncState } }));
}
async function refreshPending() { publish({ pending: (await db.all('outbox')).length }); }

async function doSync() {
  await refreshPending();
  if (!navigator.onLine) { publish({ status: 'offline', message: '' }); return []; }
  publish({ status: 'syncing', message: '' });
  let changed = false;
  const problems = [];

  const outbox = await db.all('outbox');
  if (outbox.length) {
    const res = await call('push', { changes: outbox.map(({ table, id, baseVersion, data, deleted }) => ({ table, id, baseVersion, data, deleted })) });
    for (const r of res.results) {
      const sent = outbox.find((o) => o.table === r.table && o.id === r.id);
      const still = await db.get('outbox', [r.table, r.id]);
      const untouched = still && sent && still.queuedAt === sent.queuedAt;
      if (r.status === 'ok') {
        if (untouched) { await db.del('outbox', [r.table, r.id]); await db.put('records', { table: r.table, ...r.record, pending: false }); }
        else if (still) { still.baseVersion = r.record.version; await db.put('outbox', still); }
        changed = true;
        continue;
      }
      // Not saved: show the database copy again and say why.
      if (untouched || r.status === 'conflict') await db.del('outbox', [r.table, r.id]);
      if (r.record) await db.put('records', { table: r.table, ...r.record, pending: false });
      else { const local = await db.get('records', [r.table, r.id]); if (local && local.version === 0) await db.del('records', [r.table, r.id]); }
      problems.push(r.status === 'conflict' ? `${r.record && r.record.updatedBy ? r.record.updatedBy : 'Someone else'} saved this first, so your change was not saved. The latest copy is now shown.` : r.error);
      changed = true;
    }
  }

  const last = await db.get('meta', 'lastSync');
  const res = await call('pull', { since: last || '' });
  const queued = new Set((await db.all('outbox')).map((o) => o.table + '|' + o.id));
  for (const [table, recs] of Object.entries(res.records)) {
    for (const rec of recs) {
      if (queued.has(table + '|' + rec.id)) continue;           // this device's unsent change wins until it is sent
      const local = await db.get('records', [table, rec.id]);
      if (local && !local.pending && local.version === rec.version) continue;
      await db.put('records', { table, ...rec, pending: false });
      changed = true;
    }
  }
  await db.put('meta', new Date(new Date(res.serverTime).getTime() - 5000).toISOString(), 'lastSync');
  if (changed) emitChange('sync');
  await refreshPending();
  fails = 0;

  // This person's own user record removed or disabled: no more access.
  const me = String((auth.session && auth.session.email) || '').toLowerCase();
  const users = await db.all('records', 'users');
  if (me && users.length && !users.some((u) => !u.deleted && String((u.data || {}).email || '').toLowerCase() === me && (u.data || {}).status !== 'disabled')) {
    window.dispatchEvent(new CustomEvent('access-revoked', { detail: `This Gmail (${me}) is no longer registered in AMS.` }));
    return problems;
  }
  publish({ status: problems.length ? 'error' : 'synced', lastSync: new Date().toISOString(), message: problems[0] || '' });
  return problems;
}

export function syncNow() {
  if (!running) {
    running = doSync().catch((e) => {
      const m = String(e.message || e);
      if (/is not registered|not for this app|is not verified/i.test(m)) { publish({ status: 'signin', message: m }); window.dispatchEvent(new CustomEvent('access-revoked', { detail: m })); }
      else if (m === 'SIGNIN_NEEDED') publish({ status: 'signin', message: 'Sign in again to send your changes. Your work is safe on this device.' });
      else if (m === 'OFFLINE' || !navigator.onLine || /Failed to fetch|NetworkError/i.test(m)) publish({ status: 'offline', message: '' });
      else { fails++; publish(fails < 3 ? { status: 'retry', message: '' } : { status: 'error', message: 'The database did not answer. Your work is saved on this device and will be sent automatically.' }); }
      return [m];
    }).finally(() => { running = null; });
  }
  return running;
}

let started = false;
export function startSync() {
  if (started) return syncNow();
  started = true;
  window.addEventListener('online', () => syncNow());
  window.addEventListener('offline', () => publish({ status: 'offline' }));
  window.addEventListener('outbox-changed', () => { refreshPending(); clearTimeout(timer); timer = setTimeout(syncNow, 800); });
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, CONFIG.SYNC_EVERY_MS || 60000);
  return syncNow();
}
