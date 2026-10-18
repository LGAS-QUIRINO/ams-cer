// Small helpers shared by every screen and module.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const pill = (text, kind = '') => `<span class="pill ${kind}">${esc(text)}</span>`;

// Blue/red/gold wave and footer at the bottom of the page.
export function bottomBand() {
  return `<div class="bottom">
    <svg class="wave" viewBox="0 0 1440 120" preserveAspectRatio="none" aria-hidden="true">
      <path d="M0,70 C360,20 760,120 1440,40 L1440,120 L0,120 Z" fill="#0b2a6b"/>
      <path d="M0,62 C380,14 780,112 1440,32 L1440,40 C760,120 360,20 0,70 Z" fill="#d62839"/>
      <path d="M0,54 C400,6 800,102 1440,22 L1440,32 C780,112 380,14 0,62 Z" fill="#f2b705"/>
    </svg>
    <footer>
      <span>Audit Management System &nbsp;|&nbsp; COA Quirino</span>
      <span class="motto">GOOD GOVERNANCE FOR A BETTER PHILIPPINES</span>
    </footer>
  </div>`;
}

// Small message at the bottom of the screen. kind: '' | 'ok' | 'bad'
let toastTimer = null;
export function toast(msg, kind = '') {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.className = 'toast ' + kind; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

// Pop-up window. buttons: [{ label, cls, value, check(bg) → true to close }]. Resolves with the value of the button pressed (null if closed).
export function modal({ title, body, buttons = [{ label: 'Close', cls: 'primary', value: null }], onOpen, wide = false }) {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="mh"><h3>${esc(title)}</h3><button class="x" type="button" aria-label="Close">×</button></div>
      <div class="mb">${body}</div>
      <div class="mf">${buttons.map((b, i) => `<button class="btn ${b.cls || ''}" type="button" data-i="${i}">${esc(b.label)}</button>`).join('')}</div></div>`;
    const close = (v) => { bg.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    $('.x', bg).onclick = () => close(null);
    $$('.mf .btn', bg).forEach((el) => { el.onclick = () => { const b = buttons[+el.dataset.i]; if (b.check && !b.check(bg)) return; close(b.value); }; });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(bg);
    if (onOpen) onOpen(bg);
    const first = $('input, select', bg); if (first) first.focus();
  });
}

export const nice = (s) => String(s || '');
export const today = () => new Date().toISOString().slice(0, 10);
