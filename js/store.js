// Records kept on this device (users, teams, lgus).
// Connected: every save waits in the outbox and is sent to the AMS database by sync.js.
// Demo Mode: saves stay in this browser only.
import { db } from './db.js';
import { DEMO } from './config.js';
import { seedData, DEMO_ADMIN } from './seed.js';

const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const emitChange = (src) => listeners.forEach((fn) => fn(src));

export const newId = (prefix) => prefix + '-' + (crypto.randomUUID ? crypto.randomUUID().slice(0, 13) : Date.now().toString(36) + Math.random().toString(36).slice(2, 6));

const put = (table, id, data, by = '') => db.put('records', { table, id, version: 1, updatedAt: new Date().toISOString(), updatedBy: by, deleted: false, data, pending: false });

export const store = {
  // Demo Mode, first run on this device: load the teams, the LGU Master List and the demo Admin.
  // Connected: everything comes from the AMS database on the first sync.
  async ready() {
    if (!DEMO || await db.get('meta', 'seeded')) return;
    const { teams, lgus } = seedData();
    for (const t of teams) await put('teams', t.id, t, 'setup');
    for (const l of lgus) await put('lgus', l.id, l, 'setup');
    await put('users', DEMO_ADMIN.id, DEMO_ADMIN, 'setup');
    await db.put('meta', true, 'seeded');
  },
  async list(table) { return (await db.all('records', table)).filter((r) => !r.deleted); },
  async get(table, id) { return db.get('records', [table, id]); },
  async save(table, id, data, by = '', { deleted = false } = {}) {
    const cur = await db.get('records', [table, id]);
    const now = new Date().toISOString();
    if (DEMO) {
      const rec = { table, id, version: (cur ? cur.version : 0) + 1, updatedAt: now, updatedBy: by, deleted, data, pending: false };
      await db.put('records', rec); emitChange('local'); return rec;
    }
    const queued = await db.get('outbox', [table, id]);
    const baseVersion = queued ? queued.baseVersion : cur ? cur.version : 0;
    await db.put('outbox', { table, id, baseVersion, data, deleted, queuedAt: now });
    const rec = { table, id, version: cur ? cur.version : 0, updatedAt: now, updatedBy: cur ? cur.updatedBy : '', deleted, data, pending: true };
    await db.put('records', rec);
    emitChange('local');
    window.dispatchEvent(new Event('outbox-changed'));
    return rec;
  },
  async wipe() { await db.clear('records'); await db.clear('outbox'); await db.del('meta', 'lastSync'); }
};

// Everything the screens need at once, with quick look-ups by ID.
export async function loadRefs(email) {
  const [users, teams, lgus] = await Promise.all([store.list('users'), store.list('teams'), store.list('lgus')]);
  const byId = (arr) => Object.fromEntries(arr.map((r) => [r.id, r]));
  const me = users.find((u) => String(u.data.email).toLowerCase() === String(email || '').toLowerCase()) || null;
  return { users, teams, lgus, user: byId(users), team: byId(teams), lgu: byId(lgus), me,
    isAdmin: !!(me && me.data.status !== 'disabled' && (me.data.roles || []).includes('admin')) };
}
