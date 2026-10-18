/**
 * AMS – Audit Management System · COA Quirino
 * Database script. It lives inside the "AMS Database" Google Sheet owned by the AMS Gmail.
 *
 * Fill in the two lines below, run setup() once, then Deploy → New deployment → Web app
 * (Execute as: Me · Who has access: Anyone). See SETUP.md.
 */
const CLIENT_ID = 'PASTE-THE-CLIENT-ID-HERE.apps.googleusercontent.com';   // from Google Cloud → Credentials
const FIRST_ADMIN_EMAIL = 'paste.the.admin.gmail@gmail.com';               // the Gmail that will be the first Admin

const TABLES = ['users', 'teams', 'lgus', 'cer_officers', 'cer_audits', 'cer_exams', 'cer_booklets', 'cer_formcheck', 'cer_raaf', 'cer_settings', 'cer_ors', 'cer_reports', 'cer_cashadv', 'cer_liquid', 'cer_bankrec', 'cer_cashcount', 'cer_verify'];
const ADMIN_TABLES = { users: true, teams: true, lgus: true };            // only the Admin may change these
// CER Audit Setup: auditors only (Team Member, ATL, SA, Admin). Team Staff (JO) and OSA Staff may view but not change it.
const AUDITOR_TABLES = { cer_officers: true, cer_audits: true, cer_exams: true, cer_formcheck: true, cer_verify: true };
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
function sheet_(table) { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(table); }

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

function pull_(since) {
  const out = {};
  TABLES.forEach(function (t) { out[t] = readAll_(t).filter(function (r) { return !since || r.updatedAt > since; }); });
  return out;
}

function push_(changes, email, isAdmin, isAuditor) {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const log = sheet_('log');
    return changes.map(function (c) {
      const res = { table: c.table, id: c.id };
      try {
        if (TABLES.indexOf(c.table) < 0) throw new Error('Unknown list: ' + c.table);
        if (ADMIN_TABLES[c.table] && !isAdmin) throw new Error('Only the Admin can change ' + c.table + '.');
        if (AUDITOR_TABLES[c.table] && !isAuditor) throw new Error('Only the auditors (Team Member, ATL, SA) can change this.');
        const row = findRow_(c.table, c.id), sh = sheet_(c.table);
        const cur = row ? rec_(sh.getRange(row, 1, 1, HEAD.length).getValues()[0]) : null;
        if ((cur ? cur.version : 0) !== Number(c.baseVersion || 0)) { res.status = 'conflict'; res.record = cur; return res; }
        if (c.table === 'users' && !c.deleted) checkUser_(c, email);
        const next = [c.id, (cur ? cur.version : 0) + 1, new Date().toISOString(), email, !!c.deleted, JSON.stringify(c.data)];
        if (row) sh.getRange(row, 1, 1, HEAD.length).setValues([next]); else sh.appendRow(next);
        log.appendRow([next[2], email, row ? (c.deleted ? 'deleted' : 'changed') : 'added', c.table, c.id]);
        res.status = 'ok'; res.record = rec_(next);
      } catch (err) { res.status = 'error'; res.error = String(err.message || err); }
      return res;
    });
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
