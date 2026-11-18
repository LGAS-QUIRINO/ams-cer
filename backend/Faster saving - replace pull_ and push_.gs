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
