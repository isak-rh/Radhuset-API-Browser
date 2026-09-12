// Dialogs for the encrypted vault: create, unlock, change password, passkeys.

import { MIN_PASSWORD_LENGTH, WrongPasswordError } from '../auth/vault.js';
import { PasskeyError, passkeySupport } from '../auth/passkey.js';
import { button, field, h, icon } from '../lib/dom.js';
import { t } from '../i18n/index.js';
import { alertDialog, confirmDialog, openDialog, passwordInput } from './dialog.js';
import { toast } from './toast.js';

const errorLine = () => h('p', { class: 'error-text', role: 'alert', hidden: true });
function showError(el, message) {
  el.textContent = message;
  el.hidden = !message;
}

/** Create the vault with a new master password. Resolves true on success. */
export function createVault(app, { reason = null } = {}) {
  return new Promise((resolve) => {
    let ok = false;
    const pw = passwordInput({ autocomplete: 'new-password', placeholder: t('common.passwordMinLength', { n: MIN_PASSWORD_LENGTH }) });
    const confirm = passwordInput({ autocomplete: 'new-password' });
    const error = errorLine();
    const form = h(
      'form',
      { class: 'form', onsubmit: (e) => { e.preventDefault(); submit(); } },
      reason ? h('p', { text: reason }) : null,
      h('p', { class: 'muted', text: t('vault.createExplain') }),
      field(t('vault.masterPassword'), pw.wrap, { id: 'vault-new-pw', htmlFor: pw.input }),
      field(t('common.repeatPassword'), confirm.wrap, { id: 'vault-new-pw2', htmlFor: confirm.input }),
      error,
      h('button', { type: 'submit', hidden: true }),
    );

    async function submit() {
      const value = pw.input.value;
      if (value.length < MIN_PASSWORD_LENGTH) return showError(error, t('vault.passwordTooShort', { n: MIN_PASSWORD_LENGTH }));
      if (value !== confirm.input.value) return showError(error, t('common.passwordMismatch'));
      dialog.setBusy(true);
      try {
        await app.vault.create(value, { profiles: [] });
        ok = true;
        dialog.close();
        toast(t('vault.setupDoneToast'), { kind: 'success' });
      } catch (err) {
        showError(error, err.message);
        dialog.setBusy(false);
      }
    }

    const dialog = openDialog({
      title: t('vault.createTitle'),
      size: 'sm',
      body: form,
      footer: [button(t('common.cancel'), { onClick: () => dialog.close() }), button(t('vault.createButton'), { variant: 'primary', icon: 'shield', onClick: submit })],
      onClose: () => resolve(ok),
    });
    pw.input.focus();
  });
}

/** Unlock with the master password or a passkey. Resolves true when unlocked. */
export function unlockVault(app, { reason = null } = {}) {
  if (app.vault.unlocked) return Promise.resolve(true);
  return new Promise((resolve) => {
    let ok = false;
    const pw = passwordInput({ autocomplete: 'current-password' });
    const error = errorLine();
    const passkeys = app.vault.passkeys;

    async function withPassword() {
      if (!pw.input.value) return showError(error, t('vault.enterMasterPassword'));
      dialog.setBusy(true);
      try {
        await app.vault.unlockWithPassword(pw.input.value);
        ok = true;
        dialog.close();
      } catch (err) {
        showError(error, err instanceof WrongPasswordError ? t('vault.wrongPassword') : err.message);
        dialog.setBusy(false);
        pw.input.select();
      }
    }

    async function withPasskey() {
      showError(error, '');
      dialog.setBusy(true);
      try {
        await app.vault.unlockWithPasskey();
        ok = true;
        dialog.close();
      } catch (err) {
        if (!(err instanceof PasskeyError && err.cancelled)) showError(error, err.message);
        dialog.setBusy(false);
      }
    }

    async function forgot() {
      const confirmed = await confirmDialog({
        title: t('vault.forgotTitle'),
        message: t('vault.forgotMessage'),
        confirmLabel: t('vault.deleteSavedProfiles'),
        danger: true,
      });
      if (!confirmed) return;
      app.vault.destroy();
      dialog.close();
      toast(t('vault.deletedToast'), { kind: 'info' });
    }

    const body = h(
      'form',
      { class: 'form', onsubmit: (e) => { e.preventDefault(); withPassword(); } },
      reason ? h('p', { text: reason }) : null,
      field(t('vault.masterPassword'), pw.wrap, { id: 'vault-unlock-pw', htmlFor: pw.input }),
      error,
      passkeys.length
        ? h('div', { class: 'or-divider' }, h('span', { text: t('common.or') }))
        : null,
      passkeys.length ? button(t('vault.unlockWithPasskey'), { icon: 'passkey', onClick: withPasskey, class: 'btn-block' }) : null,
      h('button', { type: 'button', class: 'link-button', text: t('vault.forgotPassword'), onclick: forgot }),
      h('button', { type: 'submit', hidden: true }),
    );

    const dialog = openDialog({
      title: t('vault.unlockTitle'),
      size: 'sm',
      body,
      footer: [button(t('common.cancel'), { onClick: () => dialog.close() }), button(t('vault.unlockButton'), { variant: 'primary', icon: 'unlock', onClick: withPassword })],
      onClose: () => resolve(ok),
    });
    pw.input.focus();
  });
}

/** Make sure a vault exists and is unlocked, asking the user as needed. */
export async function requireVault(app, reason) {
  if (!app.vault.exists) return createVault(app, { reason });
  return unlockVault(app, { reason });
}

export function changePassword(app) {
  return new Promise((resolve) => {
    let ok = false;
    const pw = passwordInput({ autocomplete: 'new-password' });
    const confirm = passwordInput({ autocomplete: 'new-password' });
    const error = errorLine();
    async function submit() {
      if (pw.input.value.length < MIN_PASSWORD_LENGTH) return showError(error, t('vault.passwordTooShort', { n: MIN_PASSWORD_LENGTH }));
      if (pw.input.value !== confirm.input.value) return showError(error, t('common.passwordMismatch'));
      dialog.setBusy(true);
      try {
        await app.vault.changePassword(pw.input.value);
        ok = true;
        dialog.close();
        toast(t('vault.changedToast'), { kind: 'success' });
      } catch (err) {
        showError(error, err.message);
        dialog.setBusy(false);
      }
    }
    const dialog = openDialog({
      title: t('vault.changePasswordTitle'),
      size: 'sm',
      body: h(
        'form',
        { class: 'form', onsubmit: (e) => { e.preventDefault(); submit(); } },
        field(t('vault.newMasterPassword'), pw.wrap, { id: 'vault-change-pw', htmlFor: pw.input }),
        field(t('vault.repeatNewPassword'), confirm.wrap, { id: 'vault-change-pw2', htmlFor: confirm.input }),
        error,
        h('button', { type: 'submit', hidden: true }),
      ),
      footer: [button(t('common.cancel'), { onClick: () => dialog.close() }), button(t('vault.changePasswordButton'), { variant: 'primary', onClick: submit })],
      onClose: () => resolve(ok),
    });
    pw.input.focus();
  });
}

/** Manage the passkeys that can unlock the vault. */
export async function openPasskeys(app) {
  const support = await passkeySupport();
  const list = h('ul', { class: 'simple-list' });
  const error = errorLine();

  const render = () => {
    const keys = app.vault.passkeys;
    list.replaceChildren(...(keys.length ? keys.map((key) => h(
      'li',
      null,
      icon('passkey', { size: 18 }),
      h('div', { class: 'grow' }, h('div', { text: key.label }), h('div', { class: 'muted small', text: t('vault.addedOn', { date: new Date(key.created).toLocaleDateString() }) })),
      button('', {
        icon: 'trash',
        variant: 'ghost',
        size: 'sm',
        title: t('vault.removePasskeyTitle', { label: key.label }),
        onClick: async () => {
          if (await confirmDialog({ title: t('vault.removePasskeyConfirmTitle'), message: t('vault.removePasskeyConfirmMessage', { label: key.label }), confirmLabel: t('vault.remove'), danger: true })) {
            app.vault.removePasskey(key.id);
            render();
          }
        },
      }),
    )) : [h('li', { class: 'muted', text: t('vault.noPasskeysYet') })]));
  };

  async function add() {
    showError(error, '');
    const label = `Passkey ${app.vault.passkeys.length + 1} (${new Date().toLocaleDateString()})`;
    dialog.setBusy(true);
    try {
      await app.vault.addPasskey(label);
      render();
      toast(t('vault.passkeyAddedToast'), { kind: 'success' });
    } catch (err) {
      if (!(err instanceof PasskeyError && err.cancelled)) showError(error, err.message);
    } finally {
      dialog.setBusy(false);
    }
  }

  render();
  const dialog = openDialog({
    title: t('vault.passkeysTitle'),
    size: 'sm',
    body: h(
      'div',
      { class: 'form' },
      h('p', { class: 'muted', text: t('vault.passkeysExplain') }),
      support.supported ? null : h('p', { class: 'notice notice-warning', text: support.reason }),
      list,
      error,
    ),
    footer: [
      button(t('common.close'), { onClick: () => dialog.close() }),
      button(t('vault.addPasskey'), { variant: 'primary', icon: 'plus', disabled: !support.supported || null, onClick: add }),
    ],
  });
}

export function explainLocked() {
  return alertDialog({ title: t('vault.lockedTitle'), message: t('vault.unlockThemFirst') });
}
