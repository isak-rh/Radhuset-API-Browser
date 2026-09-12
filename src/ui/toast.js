import { h, icon } from '../lib/dom.js';
import { t } from '../i18n/index.js';

let region = null;

function getRegion() {
  if (!region) {
    region = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(region);
  }
  return region;
}

/** A transient notice. *kind*: info | success | warning | error. */
export function toast(message, { kind = 'info', timeout = kind === 'error' ? 9000 : 5000, action = null } = {}) {
  const iconName = { success: 'check', warning: 'alert', error: 'alert' }[kind] || 'info';
  const el = h(
    'div',
    { class: ['toast', `toast-${kind}`] },
    icon(iconName, { size: 18 }),
    h('div', { class: 'toast-text', text: message }),
    action ? h('button', { type: 'button', class: 'toast-action', text: action.label, onclick: () => { action.onClick(); dismiss(); } }) : null,
    h('button', { type: 'button', class: 'toast-close', 'aria-label': t('toast.dismiss'), onclick: () => dismiss() }, icon('x', { size: 16 })),
  );
  getRegion().append(el);
  let timer = timeout ? setTimeout(dismiss, timeout) : null;
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => { if (timeout) timer = setTimeout(dismiss, timeout); });
  function dismiss() {
    clearTimeout(timer);
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 200);
  }
  return { dismiss };
}
