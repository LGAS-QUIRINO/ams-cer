// Source Documents · Focus a box once the screen is drawn again (the form is replaced): waits up to 2 s.
export function focusAfter(formSel, sel, scroll) {
  const old = document.querySelector(formSel); let n = 0;
  const t = setInterval(() => { const f = document.querySelector(formSel); if ((f && f !== old) || ++n > 40) { clearInterval(t); const el = f && f.querySelector(sel); if (el) { if (scroll) f.scrollIntoView({ block: 'nearest' }); el.focus(); } } }, 50);
}
