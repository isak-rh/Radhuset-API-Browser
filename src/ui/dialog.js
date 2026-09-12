// Modal dialogs on the native <dialog> element: focus trapping, Esc and the
// backdrop come from the browser.

import { button, h, icon } from '../lib/dom.js';
import { t } from '../i18n/index.js';

/**
 * Open a modal. *canClose()* may return false (or a promise of false) to keep
 * it open — used to guard unsaved edits. Returns { el, body, close, setBusy }.
 */
export function openDialog({
  title,
  body = null,
  footer = null,
  size = 'md',
  dismissible = true,
  className = null,
  canClose = null,
  onClose = null,
}) {
  const el = h('dialog', { class: ['dialog', `dialog-${size}`, className], 'aria-label': title });
  const titleEl = h('h2', { class: 'dialog-title', text: title });
  const closeButton = dismissible
    ? button('', { icon: 'x', variant: 'ghost', title: t('common.close'), onClick: () => requestClose() })
    : null;
  const bodyEl = h('div', { class: 'dialog-body' }, body);
  const footerEl = h('footer', { class: 'dialog-footer' }, footer);
  el.append(h('div', { class: 'dialog-frame' }, h('header', { class: 'dialog-header' }, titleEl, closeButton), bodyEl, footer ? footerEl : null));

  let closed = false;
  function close(result) {
    if (closed) return;
    closed = true;
    el.close();
    el.remove();
    onClose?.(result);
  }
  async function requestClose(result) {
    if (!dismissible || closed) return;
    if (canClose && (await canClose()) === false) return;
    close(result);
  }

  el.addEventListener('cancel', (event) => {
    event.preventDefault();
    requestClose();
  });
  // The frame fills the dialog, so a click whose target is the dialog itself
  // landed on the backdrop.
  el.addEventListener('mousedown', (event) => {
    if (event.target === el) el.dataset.backdropDown = '1';
  });
  el.addEventListener('click', (event) => {
    if (event.target === el && el.dataset.backdropDown) requestClose();
    delete el.dataset.backdropDown;
  });

  document.body.append(el);
  el.showModal();
  const autofocus = el.querySelector('[autofocus]');
  if (autofocus) autofocus.focus();

  return {
    el,
    body: bodyEl,
    close,
    requestClose,
    setTitle: (text) => { titleEl.textContent = text; },
    setFooter: (...nodes) => { footerEl.replaceChildren(...nodes); if (!footerEl.isConnected) el.firstChild.append(footerEl); },
    setBusy(busy) {
      el.classList.toggle('is-busy', busy);
      for (const b of el.querySelectorAll('.dialog-footer button')) b.disabled = busy;
    },
  };
}

function messageNodes(message) {
  if (message instanceof Node) return message;
  return String(message).split('\n\n').map((para) => h('p', { text: para }));
}

export function alertDialog({ title, message, kind = 'info', okLabel = t('common.ok') }) {
  return new Promise((resolve) => {
    const ok = button(okLabel, { variant: 'primary', autofocus: true, onClick: () => dialog.close() });
    const dialog = openDialog({
      title,
      size: 'sm',
      body: h('div', { class: ['message', `message-${kind}`] }, icon(kind === 'error' ? 'alert' : 'info', { size: 22 }), h('div', null, messageNodes(message))),
      footer: ok,
      onClose: () => resolve(),
    });
  });
}

export function confirmDialog({ title, message, confirmLabel = t('common.ok'), cancelLabel = t('common.cancel'), danger = false }) {
  return choiceDialog({
    title,
    message,
    choices: [
      { label: cancelLabel, value: false },
      { label: confirmLabel, value: true, variant: danger ? 'danger' : 'primary', autofocus: true },
    ],
  }).then((v) => v === true);
}

/** Resolves to the chosen value, or null if dismissed. */
export function choiceDialog({ title, message, choices }) {
  return new Promise((resolve) => {
    let result = null;
    const dialog = openDialog({
      title,
      size: 'sm',
      body: h('div', { class: 'message' }, h('div', null, messageNodes(message))),
      footer: choices.map((c) => button(c.label, {
        variant: c.variant || 'secondary',
        autofocus: c.autofocus || null,
        onClick: () => {
          result = c.value;
          dialog.close();
        },
      })),
      onClose: () => resolve(result),
    });
  });
}

/** A password input with a show/hide toggle. Returns { wrap, input }. */
export function passwordInput({ placeholder = '', autocomplete = 'current-password', value = '' } = {}) {
  const input = h('input', { type: 'password', class: 'input', placeholder, autocomplete, value, spellcheck: 'false' });
  const toggle = h('button', {
    type: 'button',
    class: 'input-adornment',
    title: t('common.showPassword'),
    'aria-label': t('common.showPassword'),
    onclick: () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.replaceChildren(icon(show ? 'eyeOff' : 'eye', { size: 16 }));
      toggle.title = show ? t('common.hidePassword') : t('common.showPassword');
    },
  }, icon('eye', { size: 16 }));
  return { wrap: h('div', { class: 'input-group' }, input, toggle), input };
}
