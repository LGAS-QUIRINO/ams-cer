// Local storage on this device (IndexedDB). Falls back to memory if the browser blocks it.
// Each copy of the app (e.g. the live site and a practice copy) keeps its own data on the computer.
const SCOPE = (location.pathname.split('/')[1] || '').replace(/[^a-z0-9-]/gi, '');
const NAME = !SCOPE || SCOPE === 'audit-management-system' ? 'ams' : 'ams-' + SCOPE, VER = 1;
let dbp = null, mem = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(NAME, VER); } catch (e) { mem = new Map(); return resolve(null); }
    req.onupgradeneeded = () => {
      const db = req.result;
      const rec = db.createObjectStore('records', { keyPath: ['table', 'id'] });
      rec.createIndex('table', 'table');
      db.createObjectStore('outbox', { keyPath: ['table', 'id'] });
      db.createObjectStore('meta');
      db.createObjectStore('demo');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { mem = new Map(); resolve(null); };
  });
  return dbp;
}

const mk = (store, key) => store + '|' + JSON.stringify(key);
function memStore(store) { if (!mem.has(store)) mem.set(store, new Map()); return mem.get(store); }

async function tx(store, mode, fn) {
  const db = await open();
  if (!db) return fn(null);
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
  });
}
const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const db = {
  async get(store, key) {
    await open();
    if (mem) return structuredClone(memStore(store).get(mk(store, key)));
    return tx(store, 'readonly', (s) => wrap(s.get(key)));
  },
  async put(store, value, key) {
    await open();
    if (mem) {
      const k = key !== undefined ? key : [value.table, value.id];
      memStore(store).set(mk(store, k), structuredClone(value)); return;
    }
    return tx(store, 'readwrite', (s) => wrap(key !== undefined ? s.put(value, key) : s.put(value)));
  },
  async del(store, key) {
    await open();
    if (mem) { memStore(store).delete(mk(store, key)); return; }
    return tx(store, 'readwrite', (s) => wrap(s.delete(key)));
  },
  async all(store, table) {
    await open();
    if (mem) {
      const vals = [...memStore(store).values()].map((v) => structuredClone(v));
      return table ? vals.filter((v) => v.table === table) : vals;
    }
    return tx(store, 'readonly', (s) => wrap(table ? s.index('table').getAll(table) : s.getAll()));
  },
  async clear(store) {
    await open();
    if (mem) { memStore(store).clear(); return; }
    return tx(store, 'readwrite', (s) => wrap(s.clear()));
  },
  get persistent() { return !mem; }
};
