// Admin screens (designs approved 17 Oct 2026): Users & Roles, Teams, LGU Master List.
import { store, newId } from '../store.js';
import { ROLE_NAMES, POSITIONS } from '../seed.js';
import { esc, pill, modal, toast, today, $, $$ } from '../ui.js';

const ONLY_STAFF = (roles) => roles.length > 0 && roles.every((r) => r === 'staff' || r === 'osa');
const byName = (a, b) => a.data.name.localeCompare(b.data.name);

export function roleLine(refs) {
  if (!refs.me) return 'Signed in';
  const d = refs.me.data;
  const roles = (d.roles || []).map((r) => ROLE_NAMES[r]).join(' · ');
  const teams = (d.teamIds || []).map((t) => refs.team[t]?.data.name).filter(Boolean).join(', ');
  return [roles, teams].filter(Boolean).join(' · ');
}

// Top bar on every Admin screen.
export function adminBar(active, refs, session, syncHtml = '') {
  const name = refs.me ? refs.me.data.name : (session.name || session.email);
  const ini = String(name).split(/\s+/).filter((w) => /^[A-Z]/i.test(w)).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const link = (href, label, key) => `<a href="${href}" class="${active === key ? 'on' : ''}">${label}</a>`;
  return `<div class="topbar">
    <img src="img/coa-logo.png" alt="COA seal">
    <div class="t">AUDIT MANAGEMENT SYSTEM<small>COA QUIRINO</small></div>
    <nav>${link('#/', '← Dashboard', '')}${link('#/admin/users', 'Users &amp; Roles', 'users')}${link('#/admin/teams', 'Teams', 'teams')}${link('#/admin/lgus', 'LGU Master List', 'lgus')}</nav>
    ${syncHtml}<div class="me"><div class="av">${esc(ini)}</div><span>${esc(name)}<br><small>${esc(roleLine(refs))}</small></span></div>
  </div><div class="tri-bar"></div>`;
}

export const notAdmin = () => `<div class="page"><div class="msg bad">Only the Admin can open this page.</div><a class="btn" href="#/">← Back to Dashboard</a></div>`;

/* ---------------- Users & Roles ---------------- */
export function usersHtml(refs) {
  const showRemoved = !!usersHtml.showRemoved;
  const list = [...refs.users].sort(byName);
  const removedN = list.filter((u) => u.data.status === 'disabled').length;
  const cols = 'grid-template-columns:minmax(170px,1.5fr) minmax(130px,1.1fr) minmax(140px,1.1fr) 84px 56px';
  const munName = (id) => refs.lgu[id]?.data.name || '';
  return `<div class="page">
    <div class="page-head"><div><h1>Users &amp; Roles</h1><p>Each person signs in with their own Gmail. Position and designation print on documents exactly as entered here. One list for all modules.</p></div>
      <button class="btn primary" id="add-user">+ Add User</button></div>
    <div class="grid2">
      <section class="panel">
        <div class="panel-head"><h2>Users · ${list.length - removedN}</h2>
          ${removedN ? `<label class="switch"><input type="checkbox" id="show-rm" ${showRemoved ? 'checked' : ''}> Show Removed Users (${removedN})</label>` : ''}</div>
        <div class="t-head" style="${cols}"><span>Name and Gmail</span><span>Position · Designation</span><span>Role · Team</span><span>Status</span><span></span></div>
        ${list.map((u) => { const d = u.data; const rm = d.status === 'disabled'; if (rm && !showRemoved) return '';
          const scope = (d.teamIds || []).map((t) => refs.team[t]?.data.name).filter(Boolean).join(', ') + ((d.munIds || []).length ? ' · ' + d.munIds.map(munName).join(', ') : '');
          return `<div class="t-row ${rm ? 'removed' : ''}" style="${cols}">
          <span><b>${esc(d.name)}</b><br><small class="mono">${esc(d.email)}</small></span>
          <span>${esc(d.position)}${d.designation ? `<br><small>${esc(d.designation)}</small>` : ''}</span>
          <span class="pills">${(d.roles || []).map((r) => pill(ROLE_NAMES[r] || r, r === 'admin' ? 'vio' : '')).join('')}<small>${esc(scope)}</small></span>
          <span>${d.status === 'active' ? pill('● Active', 'ok') : rm ? pill('Removed', 'bad') : pill('● Invited', 'warn')}</span>
          <span><button class="btn sm" data-edit="${u.id}">Edit</button></span></div>`; }).join('')}
      </section>
      <div class="stack">
        <section class="panel"><div class="panel-head"><h2>The Six Roles</h2></div><div class="note">
          <p><b>Admin</b> – manages users, teams and the LGU list.</p>
          <p><b>Supervising Auditor</b> – sees all teams; final approvals.</p>
          <p><b>OSA Staff</b> – staff of the SA; sees all teams.</p>
          <p><b>Audit Team Leader</b> – reviews and approves the team's work.</p>
          <p><b>Team Member</b> – auditor of the team.</p>
          <p class="last"><b>Team Staff (JO)</b> – encoding work for the team.</p></div></section>
        <section class="panel"><div class="panel-head"><h2>Good to Know</h2></div><div class="note">
          <p>• One person can hold two roles, e.g. Team Member and Admin.</p>
          <p>• What each role can do inside each card is set when that module is built.</p>
          <p>• Team Members and Team Staff can be limited to ticked municipalities of their team.</p>
          <p class="last">• Removing a user keeps everything they did in the history.</p></div></section>
      </div>
    </div></div>`;
}

export function wireUsers(refs, rerender) {
  $('#add-user').onclick = () => editUser(refs, null);
  $$('[data-edit]').forEach((b) => { b.onclick = () => editUser(refs, b.dataset.edit); });
  const sr = $('#show-rm'); if (sr) sr.onchange = () => { usersHtml.showRemoved = sr.checked; rerender(); };
}

async function editUser(refs, id) {
  const u = id ? refs.user[id] : null;
  const d = u ? u.data : { email: '', name: '', nickname: '', position: 'State Auditor I', designation: '', roles: ['member'], teamIds: [], munIds: [], status: 'invited' };
  let out = null;
  const muns = (tid) => refs.lgus.filter((l) => l.data.kind === 'municipality' && l.data.teamId === tid).sort(byName);
  const res = await modal({
    title: u ? 'Edit User' : 'Add User',
    body: `<div class="field"><label for="u-email">Gmail</label><input class="input mono" id="u-email" type="email" value="${esc(d.email)}" placeholder="name@gmail.com"><span class="hint">The Google account this person signs in with.</span></div>
      <div class="field"><label for="u-name">Full Name (as printed)</label><input class="input upper" id="u-name" value="${esc(d.name)}" placeholder="ATTY. JUAN A. DELA CRUZ"></div>
      <div class="field"><label for="u-nick">Name to Greet (optional)</label><input class="input" id="u-nick" value="${esc(d.nickname || '')}" placeholder="e.g. Cess"><span class="hint">Shown only on the Dashboard greeting.</span></div>
      <div class="two"><div class="field"><label for="u-pos">Position</label><input class="input" id="u-pos" list="pos-list" value="${esc(d.position)}"><datalist id="pos-list">${POSITIONS.map((p) => `<option>${p}</option>`).join('')}</datalist></div>
        <div class="field"><label for="u-des">Designation</label><input class="input" id="u-des" value="${esc(d.designation)}" placeholder="e.g. OIC-Audit Team Leader"></div></div>
      <fieldset class="field"><legend>Roles</legend><div class="checks">${Object.entries(ROLE_NAMES).map(([k, v]) => `<label><input type="checkbox" name="role" value="${k}" ${(d.roles || []).includes(k) ? 'checked' : ''}> ${v}</label>`).join('')}</div></fieldset>
      <fieldset class="field"><legend>Teams</legend><div class="checks">${[...refs.teams].sort(byName).map((t) => `<label><input type="checkbox" name="team" value="${t.id}" ${(d.teamIds || []).includes(t.id) ? 'checked' : ''}> ${esc(t.data.name)}${t.data.officeCode ? ' (' + esc(t.data.officeCode) + ')' : ''}</label>`).join('')}</div></fieldset>
      <fieldset class="field" id="u-munbox"><legend>Municipalities</legend><div id="u-muns"></div>
        <span class="hint">Leave all unticked to give access to every municipality of the team. For Team Members and Team Staff only.</span></fieldset>
      ${u ? `<div class="field"><label for="u-status">Status</label><select class="input" id="u-status">${[['invited', 'Invited (not signed in yet)'], ['active', 'Active'], ['disabled', 'Removed (history kept)']].map(([v, l]) => `<option value="${v}" ${d.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>` : ''}`,
    onOpen: (bg) => {
      const picked = new Set(d.munIds || []);
      const drawMuns = () => {
        $$('input[name=mun]', bg).forEach((x) => { if (x.checked) picked.add(x.value); else picked.delete(x.value); });
        const teams = $$('input[name=team]:checked', bg).map((x) => x.value);
        $('#u-muns', bg).innerHTML = teams.length ? teams.map((tid) => `<span class="hint">${esc(refs.team[tid]?.data.name || '')}</span><div class="checks">${muns(tid).map((m) => `<label><input type="checkbox" name="mun" value="${m.id}" ${picked.has(m.id) ? 'checked' : ''}> ${esc(m.data.name)}</label>`).join('')}</div>`).join('') : '<span class="hint">Tick a team first.</span>';
      };
      const roleState = () => {
        const roles = $$('input[name=role]:checked', bg).map((x) => x.value);
        const des = $('#u-des', bg);
        if (ONLY_STAFF(roles)) { if (!des.disabled) des.dataset.was = des.value; des.value = ''; des.placeholder = 'None'; des.disabled = true; }
        else if (des.disabled) { des.disabled = false; des.value = des.dataset.was || ''; des.placeholder = 'e.g. OIC-Audit Team Leader'; }
        $('#u-munbox', bg).hidden = !(roles.includes('member') || roles.includes('staff')) || roles.some((r) => ['atl', 'sa', 'osa', 'admin'].includes(r));
      };
      $$('input[name=team]', bg).forEach((x) => { x.onchange = drawMuns; });
      $$('input[name=role]', bg).forEach((x) => { x.addEventListener('change', roleState); });
      drawMuns(); roleState();
    },
    buttons: [{ label: 'Cancel', value: null }, { label: 'Save', cls: 'primary', value: 'save', check: (bg) => {
      const email = $('#u-email', bg).value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('Enter a valid Gmail address.', 'bad'); return false; }
      if (refs.users.some((x) => x.id !== id && String(x.data.email).toLowerCase() === email)) { toast('That Gmail is already registered.', 'bad'); return false; }
      const name = $('#u-name', bg).value.trim().toUpperCase();
      if (!name) { toast('Enter the full name.', 'bad'); return false; }
      const roles = $$('input[name=role]:checked', bg).map((x) => x.value);
      if (!roles.length) { toast('Choose at least one role.', 'bad'); return false; }
      const teamIds = $$('input[name=team]:checked', bg).map((x) => x.value);
      if (!teamIds.length && !roles.some((r) => ['sa', 'osa', 'admin'].includes(r))) { toast('Choose the team of this user.', 'bad'); return false; }
      const status = u ? $('#u-status', bg).value : 'invited';
      if (u && id === refs.me?.id && (!roles.includes('admin') || status === 'disabled')) { toast('You cannot remove your own Admin access.', 'bad'); return false; }
      const des = $('#u-des', bg).value.trim().replace(/\s*-\s*/g, '-');
      out = { email, name, nickname: $('#u-nick', bg).value.trim(), position: $('#u-pos', bg).value.trim(), designation: ONLY_STAFF(roles) ? '' : des, roles, teamIds,
        munIds: $('#u-munbox', bg).hidden ? [] : $$('input[name=mun]:checked', bg).map((x) => x.value).filter((m) => teamIds.includes(refs.lgu[m]?.data.teamId)), status };
      return true;
    } }]
  });
  if (res !== 'save') return;
  await store.save('users', id || newId('user'), out, refs.me?.data.email);
  toast(id ? 'User saved.' : 'User added. They can sign in with that Gmail once the database is connected.', 'ok');
}

/* ---------------- Teams ---------------- */
export function teamsHtml(refs) {
  const cols = 'grid-template-columns:minmax(200px,1fr) minmax(240px,1.3fr) auto';
  const nm = (id) => refs.user[id]?.data.name || '';
  const lgusOf = (tid) => refs.lgus.filter((l) => l.data.kind !== 'barangay' && l.data.teamId === tid)
    .sort((a, b) => (a.data.kind === 'province' ? -1 : b.data.kind === 'province' ? 1 : byName(a, b)))
    .map((l) => l.data.kind === 'province' ? 'Province of Quirino' : l.data.name).join(', ');
  return `<div class="page">
    <div class="page-head"><div><h1>Teams</h1><p>Which LGUs each team audits, and who leads and supervises it. Each change takes an effective date; documents already issued keep the names of whoever signed them.</p></div></div>
    <section class="panel">
      <div class="t-head" style="${cols}"><span>Team · LGUs</span><span>Audit Team Leader · Supervising Auditor</span><span></span></div>
      ${[...refs.teams].sort(byName).map((t) => { const d = t.data; const same = d.atlUserId && d.atlUserId === d.saUserId; return `<div class="t-row" style="${cols}">
        <span><b>${esc(d.name)}</b>${d.officeCode ? ' · ' + esc(d.officeCode) : ''}<br><small>${esc(lgusOf(t.id))}</small></span>
        <span>Audit Team Leader: <b>${esc(nm(d.atlUserId) || 'Not assigned')}</b><br>Supervising Auditor: <b>${same ? 'Same Person' : esc(nm(d.saUserId) || 'Not assigned')}</b>
          ${(d.history || []).length ? `<br><small>Last change effective ${esc(d.history[d.history.length - 1].effective)}</small>` : ''}</span>
        <span><button class="btn sm" data-team="${t.id}">Change Assignment</button></span></div>`; }).join('')}
    </section></div>`;
}

export function wireTeams(refs) {
  $$('[data-team]').forEach((b) => { b.onclick = () => changeTeam(refs, b.dataset.team); });
}

async function changeTeam(refs, tid) {
  const t = refs.team[tid], d = t.data;
  const active = refs.users.filter((u) => u.data.status !== 'disabled').sort(byName);
  const opts = (role, cur) => `<option value="">Not assigned</option>` + active.filter((u) => (u.data.roles || []).includes(role) || u.id === cur)
    .map((u) => `<option value="${u.id}" ${u.id === cur ? 'selected' : ''}>${esc(u.data.name)}</option>`).join('');
  let out = null;
  const res = await modal({
    title: 'Change Assignment · ' + d.name,
    body: `<div class="field"><label for="t-atl">Audit Team Leader</label><select class="input" id="t-atl">${opts('atl', d.atlUserId)}</select><span class="hint">Only users with the Audit Team Leader role are listed.</span></div>
      <div class="field"><label for="t-sa">Supervising Auditor</label><select class="input" id="t-sa">${opts('sa', d.saUserId)}</select><span class="hint">Only users with the Supervising Auditor role are listed.</span></div>
      <div class="field"><label for="t-eff">Effective Date</label><input class="input" id="t-eff" type="date" value="${today()}"><span class="hint">Based on the office order or assumption of duty.</span></div>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Save', cls: 'primary', value: 'save', check: (bg) => {
      const eff = $('#t-eff', bg).value;
      if (!eff) { toast('Enter the effective date.', 'bad'); return false; }
      out = { atl: $('#t-atl', bg).value, sa: $('#t-sa', bg).value, eff };
      return true;
    } }]
  });
  if (res !== 'save') return;
  if (out.atl === d.atlUserId && out.sa === d.saUserId) return toast('No change made.');
  const history = [...(d.history || []), { effective: out.eff, atlUserId: out.atl, saUserId: out.sa, prevAtlUserId: d.atlUserId, prevSaUserId: d.saUserId, by: refs.me?.data.email || '', at: new Date().toISOString() }];
  await store.save('teams', tid, { ...d, atlUserId: out.atl, saUserId: out.sa, history }, refs.me?.data.email);
  toast('Assignment saved.', 'ok');
}

/* ---------------- LGU Master List ---------------- */
export function lgusHtml(refs, q) {
  const muns = refs.lgus.filter((l) => l.data.kind === 'municipality').sort(byName);
  const prov = refs.lgus.find((l) => l.data.kind === 'province');
  const munId = q.get('m') || 'lgu-maddela';
  const mun = refs.lgu[munId];
  const brgys = refs.lgus.filter((l) => l.data.kind === 'barangay' && l.data.parentId === munId).sort((a, b) => String(a.data.code).localeCompare(String(b.data.code)));
  const selId = q.get('b') || brgys[0]?.id;
  const sel = refs.lgu[selId];
  const go = (m, b) => `#/admin/lgus?m=${encodeURIComponent(m)}${b ? '&b=' + encodeURIComponent(b) : ''}`;
  const tname = (tid) => refs.team[tid]?.data.name || '';
  const cols = 'grid-template-columns:84px 1fr 96px';
  return `<div class="page">
    <div class="page-head"><div><h1>LGU Master List</h1><p>Province of Quirino. Names follow the PSA list and are used on every document in every module, so they are only edited here.</p></div>
      <button class="btn primary" id="add-brgy">+ Add Barangay</button></div>
    <div class="grid3">
      <section class="panel"><div class="panel-head"><h2>Province of Quirino</h2></div>
        ${prov ? `<div class="t-row" style="grid-template-columns:1fr auto"><span><b>Province of Quirino</b><br><small>${esc(tname(prov.data.teamId))}</small></span>${pill('Province')}</div>` : ''}
        ${muns.map((m) => { const n = refs.lgus.filter((l) => l.data.parentId === m.id && l.data.kind === 'barangay' && l.data.active !== false).length;
          return `<a class="t-row click ${m.id === munId ? 'sel' : ''}" href="${go(m.id)}" style="grid-template-columns:1fr auto"><span><b>${esc(m.data.name)}</b><br><small>${esc(tname(m.data.teamId))}</small></span>${pill(n + ' Barangays', 'ok')}</a>`; }).join('')}
      </section>
      <section class="panel"><div class="panel-head"><h2>Municipality of ${esc(mun?.data.name || '')} · ${brgys.filter((b) => b.data.active !== false).length} Barangays</h2></div>
        <div class="search"><label class="sr-only" for="find">Search Barangays</label><input class="input" id="find" placeholder="Search Barangays"></div>
        <div class="t-head" style="${cols}"><span>ID</span><span>Barangay</span><span>SK</span></div>
        <div id="blist">${brgys.map((b) => `<a class="t-row click ${b.id === selId ? 'sel' : ''}" data-name="${esc(b.data.name.toLowerCase())} ${esc(String(b.data.formerName || '').toLowerCase())}" href="${go(munId, b.id)}" style="${cols}">
          <span class="mono">${esc(b.data.code || '')}</span><span><b>${esc(b.data.name)}</b>${b.data.formerName ? ` <small>(formerly ${esc(b.data.formerName)})</small>` : ''} ${b.data.active === false ? pill('Inactive') : ''}</span>
          <span>${b.data.hasSk === false ? pill('No SK') : pill('With SK', 'ok')}</span></a>`).join('') || '<div class="empty">No barangays yet.</div>'}</div>
      </section>
      ${sel ? `<section class="panel"><div class="panel-head"><h2>Barangay ${esc(sel.data.name)}</h2></div><div class="note">
        <div class="field"><label for="b-name">Barangay Name</label><input class="input" id="b-name" value="${esc(sel.data.name)}"></div>
        <div class="field"><label for="b-former">Former Name (PSA, for matching only)</label><input class="input" id="b-former" value="${esc(sel.data.formerName || '')}" placeholder="None"></div>
        <div class="field"><label for="b-sk">Sangguniang Kabataan</label><select class="input" id="b-sk"><option value="yes" ${sel.data.hasSk !== false ? 'selected' : ''}>With SK</option><option value="no" ${sel.data.hasSk === false ? 'selected' : ''}>No SK</option></select></div>
        <div class="field"><label for="b-active">Status</label><select class="input" id="b-active"><option value="yes" ${sel.data.active !== false ? 'selected' : ''}>Active</option><option value="no" ${sel.data.active === false ? 'selected' : ''}>Inactive</option></select></div>
        <p class="hint">A renamed barangay keeps the same ID, so the barangay count stays the same. Officials, funds and other details are kept by each module.</p>
        <button class="btn primary" id="b-save" data-id="${sel.id}">Save</button>
      </div></section>` : '<div></div>'}
    </div></div>`;
}

export function wireLgus(refs, q) {
  const munId = q.get('m') || 'lgu-maddela';
  const find = $('#find');
  if (find) find.oninput = () => { const v = find.value.trim().toLowerCase(); $$('#blist .t-row').forEach((r) => { r.hidden = v && !r.dataset.name.includes(v); }); };
  const save = $('#b-save');
  if (save) save.onclick = async () => {
    const id = save.dataset.id, d = refs.lgu[id].data;
    const name = $('#b-name').value.trim();
    if (!name) return toast('Enter the barangay name.', 'bad');
    const dup = refs.lgus.some((l) => l.id !== id && l.data.parentId === d.parentId && l.data.kind === 'barangay' && l.data.name.toLowerCase() === name.toLowerCase());
    if (dup) return toast('That barangay name is already in this municipality.', 'bad');
    await store.save('lgus', id, { ...d, name, formerName: $('#b-former').value.trim(), hasSk: $('#b-sk').value === 'yes', active: $('#b-active').value === 'yes' }, refs.me?.data.email);
    toast('Barangay saved.', 'ok');
  };
  $('#add-brgy').onclick = async () => {
    const mun = refs.lgu[munId];
    let name = '';
    const res = await modal({
      title: 'Add Barangay · ' + mun.data.name,
      body: `<div class="field"><label for="nb-name">Barangay Name</label><input class="input" id="nb-name" placeholder="As written in the PSA list"><span class="hint">It gets the next ID in ${esc(mun.data.name)} and is listed with its SK.</span></div>`,
      buttons: [{ label: 'Cancel', value: null }, { label: 'Add', cls: 'primary', value: 'add', check: (bg) => {
        name = $('#nb-name', bg).value.trim();
        if (!name) { toast('Enter the barangay name.', 'bad'); return false; }
        if (refs.lgus.some((l) => l.data.parentId === munId && l.data.kind === 'barangay' && l.data.name.toLowerCase() === name.toLowerCase())) { toast('That barangay is already listed.', 'bad'); return false; }
        return true;
      } }]
    });
    if (res !== 'add') return;
    const nums = refs.lgus.filter((l) => l.data.parentId === munId && l.data.kind === 'barangay').map((l) => parseInt(String(l.data.code).replace(/\D/g, ''), 10) || 0);
    const code = 'BRGY-' + String(Math.max(0, ...nums) + 1).padStart(3, '0');
    const id = 'brgy-' + munId.replace(/^lgu-/, '') + '-' + newId('n').slice(2);
    await store.save('lgus', id, { id, kind: 'barangay', name, formerName: '', parentId: munId, teamId: mun.data.teamId, code, hasSk: true, active: true }, refs.me?.data.email);
    location.hash = `#/admin/lgus?m=${encodeURIComponent(munId)}&b=${encodeURIComponent(id)}`;
    toast('Barangay added.', 'ok');
  };
}
