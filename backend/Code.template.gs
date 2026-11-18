/**
 * AMS – Audit Management System · COA Quirino
 * Database script. It lives inside the "AMS Database" Google Sheet owned by the AMS Gmail.
 *
 * Fill in the two lines below, run setup() once, then Deploy → New deployment → Web app
 * (Execute as: Me · Who has access: Anyone). See SETUP.md.
 */
const CLIENT_ID = 'PASTE-THE-CLIENT-ID-HERE.apps.googleusercontent.com';   // from Google Cloud → Credentials
const FIRST_ADMIN_EMAIL = 'paste.the.admin.gmail@gmail.com';               // the Gmail that will be the first Admin

const TABLES = ['users', 'teams', 'lgus', 'cer_officers', 'cer_audits', 'cer_exams', 'cer_booklets', 'cer_formcheck', 'cer_raaf', 'cer_settings', 'cer_ors', 'cer_reports', 'cer_cashadv', 'cer_liquid', 'cer_bankrec', 'cer_cashcount', 'cer_verify', 'cer_cutoff', 'src_ckdj'];
const ADMIN_TABLES = { users: true, teams: true, lgus: true };            // only the Admin may change these
// CER Audit Setup: auditors only (Team Member, ATL, SA, Admin). Team Staff (JO) and OSA Staff may view but not change it.
const AUDITOR_TABLES = { cer_officers: true, cer_audits: true, cer_exams: true, cer_formcheck: true, cer_verify: true, cer_cutoff: true };
const AUDITOR_ROLES = ['member', 'atl', 'sa', 'admin'];
const HEAD = ['id', 'version', 'updatedAt', 'updatedBy', 'deleted', 'data'];
const SEED = __SEED__;

/* ---------- one-time setup ---------- */
function setup() {
  if (CLIENT_ID.indexOf('PASTE') === 0 || FIRST_ADMIN_EMAIL.indexOf('paste') === 0) throw new Error('Fill in CLIENT_ID and FIRST_ADMIN_EMAIL at the top first.');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  TABLES.concat(['log']).forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(name === 'log' ? ['at', 'by', 'action', 'table', 'id'] : HEAD);
      sh.setFrozenRows(1);
    }
  });
  const first = ss.getSheetByName('Sheet1'); if (first && ss.getSheets().length > 1 && first.getLastRow() === 0) ss.deleteSheet(first);
  const now = new Date().toISOString();
  const add = function (table, id, rec) { if (!findRow_(table, id)) sheet_(table).appendRow([id, 1, now, 'setup', false, JSON.stringify(rec)]); };
  SEED.teams.forEach(function (t) { add('teams', t.id, t); });
  SEED.lgus.forEach(function (l) { add('lgus', l.id, l); });
  const email = FIRST_ADMIN_EMAIL.trim().toLowerCase();
  const users = readAll_('users');
  if (!users.some(function (u) { return String(u.data.email).toLowerCase() === email; })) {
    add('users', 'user-first-admin', { email: email, name: 'ADMIN', nickname: '', position: '', designation: '', roles: ['admin'], teamIds: [], munIds: [], status: 'active' });
  }
  SpreadsheetApp.flush();
  Logger.log('AMS setup done: ' + SEED.teams.length + ' teams, ' + SEED.lgus.length + ' LGUs, first Admin ' + email);
}

/* ---------- web app ---------- */
function doGet() { return json_({ ok: true, app: 'AMS', time: new Date().toISOString() }); }

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const email = verify_(req.idToken);
    const me = readAll_('users').filter(function (u) { return !u.deleted && String(u.data.email).toLowerCase() === email; })[0];
    if (!me || me.data.status === 'disabled') throw new Error('This Gmail (' + email + ') is not registered in AMS. Ask the Admin to add it.');
    if (me.data.status === 'invited') markActive_(me, email);
    const isAdmin = (me.data.roles || []).indexOf('admin') >= 0;
    if (req.action === 'pull') return json_({ ok: true, records: pull_(req.since), serverTime: new Date().toISOString() });
    const isAuditor = (me.data.roles || []).some(function (r) { return AUDITOR_ROLES.indexOf(r) >= 0; });
    if (req.action === 'push') return json_({ ok: true, results: push_(req.changes || [], email, isAdmin, isAuditor) });
    throw new Error('Unknown action');
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

/* ---------- sign-in check ---------- */
function verify_(token) {
  if (!token) throw new Error('SIGNIN_NEEDED');
  const cache = CacheService.getScriptCache();
  const key = 't' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token)).slice(0, 40);
  const hit = cache.get(key); if (hit) return hit;
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('SIGNIN_NEEDED');
  const info = JSON.parse(res.getContentText());
  if (info.aud !== CLIENT_ID) throw new Error('This sign-in is not for this app.');
  if (String(info.email_verified) !== 'true') throw new Error('This Gmail is not verified by Google.');
  const email = String(info.email).toLowerCase();
  const left = Math.min(3000, Math.max(60, Number(info.exp) - Math.floor(Date.now() / 1000) - 60));
  cache.put(key, email, left);
  return email;
}

/* ---------- read and write ---------- */
function sheet_(table) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(table);
  if (!sh) { sh = ss.insertSheet(table); sh.appendRow(table === 'log' ? ['at', 'by', 'action', 'table', 'id'] : HEAD); sh.setFrozenRows(1); }   // a new list adds its own sheet
  return sh;
}

function readAll_(table) {
  const sh = sheet_(table); const n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, HEAD.length).getValues().filter(function (r) { return r[0]; }).map(rec_);
}
function rec_(r) {
  let data = null; try { data = JSON.parse(r[5]); } catch (e) { data = null; }
  const at = r[2] instanceof Date ? r[2].toISOString() : String(r[2]);
  return { id: String(r[0]), version: Number(r[1]) || 0, updatedAt: at, updatedBy: String(r[3]), deleted: r[4] === true || r[4] === 'TRUE', data: data };
}
function findRow_(table, id) {
  const sh = sheet_(table); const n = sh.getLastRow();
  if (n < 2) return 0;
  const ids = sh.getRange(2, 1, n - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === id) return i + 2;
  return 0;
}

/* ---------- read and write ---------- */
// Pull: the rows changed since the device's last sync. Only the first three columns are read to find them; the big data
// column is read just for the rows that changed.
function pull_(since) {
  const out = {};
  TABLES.forEach(function (t) {
    out[t] = [];
    if (!since) { out[t] = readAll_(t); return; }
    const sh = sheet_(t), n = sh.getLastRow();
    if (n < 2) return;
    const rows = [];
    sh.getRange(2, 1, n - 1, 3).getValues().forEach(function (r, i) {
      if (!r[0]) return;
      const at = r[2] instanceof Date ? r[2].toISOString() : String(r[2]);
      if (at > since) rows.push(i + 2);
    });
    if (!rows.length) return;
    const a = rows[0], z = rows[rows.length - 1];
    const vals = sh.getRange(a, 1, z - a + 1, HEAD.length).getValues();
    rows.forEach(function (r) { out[t].push(rec_(vals[r - a])); });
  });
  return out;
}

// Push: a batch of changes. Each list is looked up once per batch (ids and versions), new rows and log lines are written
// together at the end, so a batch of 50 takes seconds instead of half a minute.
function push_(changes, email, isAdmin, isAuditor) {
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const now = new Date().toISOString(), logRows = [], lists = {};
    const list = function (t) {
      if (lists[t]) return lists[t];
      const sh = sheet_(t), n = sh.getLastRow(), at = {}, ver = {};
      if (n >= 2) sh.getRange(2, 1, n - 1, 2).getValues().forEach(function (r, i) { if (r[0]) { at[String(r[0])] = i + 2; ver[String(r[0])] = Number(r[1]) || 0; } });
      lists[t] = { sh: sh, at: at, ver: ver, add: [], last: Math.max(n, 1) };
      return lists[t];
    };
    const results = changes.map(function (c) {
      const res = { table: c.table, id: c.id };
      try {
        if (TABLES.indexOf(c.table) < 0) throw new Error('Unknown list: ' + c.table);
        if (ADMIN_TABLES[c.table] && !isAdmin) throw new Error('Only the Admin can change ' + c.table + '.');
        if (AUDITOR_TABLES[c.table] && !isAuditor) throw new Error('Only the auditors (Team Member, ATL, SA) can change this.');
        const L = list(c.table), row = L.at[c.id] || 0, curV = row ? L.ver[c.id] : 0;
        if (curV !== Number(c.baseVersion || 0)) { res.status = 'conflict'; res.record = row ? rec_(L.sh.getRange(row, 1, 1, HEAD.length).getValues()[0]) : null; return res; }
        if (c.table === 'users' && !c.deleted) checkUser_(c, email);
        const json = JSON.stringify(c.data);
        if (json.length > 49000) throw new Error('This record is too big for one cell of the Sheet (' + json.length + ' characters).');
        const next = [c.id, curV + 1, now, email, !!c.deleted, json];
        if (row) L.sh.getRange(row, 1, 1, HEAD.length).setValues([next]);
        else { L.add.push({ next: next, res: res }); L.at[c.id] = L.last + L.add.length; }
        L.ver[c.id] = curV + 1;
        logRows.push([now, email, row ? (c.deleted ? 'deleted' : 'changed') : 'added', c.table, c.id]);
        res.status = 'ok'; res.record = rec_(next);
      } catch (err) { res.status = 'error'; res.error = String(err.message || err); }
      return res;
    });
    // New rows of each list in one write; if that fails, one by one, and a row that still fails is reported as not saved.
    Object.keys(lists).forEach(function (t) {
      const L = lists[t]; if (!L.add.length) return;
      try { L.sh.getRange(L.last + 1, 1, L.add.length, HEAD.length).setValues(L.add.map(function (x) { return x.next; })); }
      catch (e) { L.add.forEach(function (x) { try { L.sh.appendRow(x.next); } catch (e2) { x.res.status = 'error'; x.res.error = String(e2.message || e2); delete x.res.record; } }); }
    });
    if (logRows.length) { const log = sheet_('log'); log.getRange(log.getLastRow() + 1, 1, logRows.length, 5).setValues(logRows); }
    return results;
  } finally { lock.releaseLock(); }
}

// Same Gmail twice is not allowed; the Admin cannot remove their own Admin access.
function checkUser_(c, email) {
  const mail = String(c.data.email || '').toLowerCase();
  const dup = readAll_('users').some(function (u) { return u.id !== c.id && !u.deleted && String(u.data.email).toLowerCase() === mail; });
  if (dup) throw new Error('That Gmail is already registered.');
  if (mail === email && ((c.data.roles || []).indexOf('admin') < 0 || c.data.status === 'disabled')) throw new Error('You cannot remove your own Admin access.');
}

// First sign-in: Invited becomes Active.
function markActive_(me, email) {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const row = findRow_('users', me.id); if (!row) return;
    const data = Object.assign({}, me.data, { status: 'active' });
    sheet_('users').getRange(row, 1, 1, HEAD.length).setValues([[me.id, me.version + 1, new Date().toISOString(), email, false, JSON.stringify(data)]]);
  } finally { lock.releaseLock(); }
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
