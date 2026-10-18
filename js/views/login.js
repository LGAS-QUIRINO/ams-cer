// Login screen (design approved 17 Oct 2026).
import { CONFIG, DEMO } from '../config.js';
import { esc, bottomBand } from '../ui.js';

const G_ICON = `<svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.7 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.7z"/><path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.7-6c-2.2 1.5-5 2.3-8.2 2.3-6.2 0-11.5-4.2-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>`;

export function loginHtml(error = '', busy = '') {
  return `<main class="login-wrap"><div class="login-card">
    ${DEMO ? `<p class="demo-tag"><span class="pill warn">Demo Mode — not yet connected to the database</span></p>` : ''}
    ${CONFIG.LABEL ? `<p class="demo-tag"><span class="pill warn">${esc(CONFIG.LABEL)}</span></p>` : ''}
    <img class="seal" src="img/coa-logo.png" alt="Commission on Audit seal">
    <p class="agency">COMMISSION ON AUDIT</p>
    <p class="rep">REPUBLIC OF THE PHILIPPINES</p>
    <h1>AUDIT MANAGEMENT SYSTEM</h1>
    <div class="tri"></div>
    <p class="office">COA QUIRINO</p>
    ${error ? `<div class="msg bad" role="alert">${esc(error)}</div>` : ''}
    ${busy ? `<p class="note"><b>${esc(busy)}</b></p>` : DEMO
      ? `<button class="gbtn" type="button" id="demo-signin">${G_ICON} Sign in with Google</button>
         <button class="btn demo-jo" type="button" id="demo-jo">Sign in as Demo JO</button>
         <p class="note">Demo only: the Google button opens the Demo Admin. Demo JO shows what a Job Order sees.</p>`
      : `<div id="gsi-btn"></div>`}
    <p class="note">Use the Gmail account registered for you by the Admin.<br>Only registered users can enter the system.</p>
    <div class="divider"></div>
    <p class="help">No access yet? Ask the Admin to add your Gmail account.</p>
    <span class="pill ok"><i></i>Works offline after your first sign-in</span>
  </div></main>${bottomBand()}`;
}
