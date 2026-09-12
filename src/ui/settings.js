// Exporting and importing settings, and the About dialog.
//
// An export is a JSON file. Your APIs, profile assignments and preferences are
// stored in the clear. Saved auth profiles are only ever included encrypted,
// under a password chosen for the export — never in plaintext.

import { MIN_PASSWORD_LENGTH } from '../auth/vault.js';
import { DecryptionError, decryptWithPassword, encryptWithPassword } from '../lib/crypto.js';
import { button, field, h } from '../lib/dom.js';
import { t, tn } from '../i18n/index.js';
import { saveBlob } from '../downloads/targets.js';
import { alertDialog, openDialog, passwordInput } from './dialog.js';
import { toast } from './toast.js';
import { requireVault, unlockVault } from './vault-dialogs.js';

const FORMAT = 'radhuset-api-browser-settings';
const PROFILES_CONTEXT = 'rab/export/profiles/v1';

const check = (label, { checked = true, disabled = false, note = null } = {}) => {
  const input = h('input', { type: 'checkbox', checked: checked && !disabled, disabled: disabled || null });
  return { input, el: h('label', { class: 'check' }, input, h('span', { class: 'check-text' }, h('span', { text: label }), note ? h('span', { class: 'check-sub', text: note }) : null)) };
};

export function openExportDialog(app) {
  const customCount = app.apis.custom.length;
  const bindingCount = Object.keys(app.bindings.entries()).length;
  const locked = app.vault.exists && !app.vault.unlocked;
  const savedCount = app.vault.unlocked ? app.profiles.savedProfiles().length : 0;

  const apis = check(t('settings.export.yourApis', { n: customCount }), { disabled: !customCount });
  const bindings = check(t('settings.export.bindings'), { disabled: !bindingCount });
  const prefs = check(t('settings.export.prefs'));
  const profiles = check(savedCount ? t('settings.export.profiles', { n: savedCount }) : t('settings.export.profilesNoCount'), {
    checked: false,
    disabled: !savedCount,
    note: locked ? t('settings.export.unlockNote') : !app.vault.exists ? t('settings.export.noProfilesNote') : null,
  });
  const pw = passwordInput({ autocomplete: 'new-password', placeholder: t('common.passwordMinLength', { n: MIN_PASSWORD_LENGTH }) });
  const pw2 = passwordInput({ autocomplete: 'new-password' });
  const passwordFields = h(
    'div',
    { class: 'form-group', hidden: true },
    h('p', { class: 'muted small', text: t('settings.export.passwordExplain') }),
    field(t('settings.export.passwordField'), pw.wrap, { id: 'export-pw', htmlFor: pw.input }),
    field(t('common.repeatPassword'), pw2.wrap, { id: 'export-pw2', htmlFor: pw2.input }),
  );
  profiles.input.addEventListener('change', () => { passwordFields.hidden = !profiles.input.checked; });
  const error = h('p', { class: 'error-text', role: 'alert', hidden: true });

  async function doExport() {
    error.hidden = true;
    const data = { format: FORMAT, version: 1, exported: new Date().toISOString() };
    if (apis.input.checked) data.apis = app.apis.exportCustom();
    if (bindings.input.checked) data.bindings = app.bindings.entries();
    if (prefs.input.checked) data.preferences = app.prefs.exportable();
    if (profiles.input.checked) {
      if (pw.input.value.length < MIN_PASSWORD_LENGTH) {
        error.textContent = t('settings.export.passwordTooShort', { n: MIN_PASSWORD_LENGTH });
        error.hidden = false;
        return;
      }
      if (pw.input.value !== pw2.input.value) {
        error.textContent = t('common.passwordMismatch');
        error.hidden = false;
        return;
      }
      dialog.setBusy(true);
      const list = app.profiles.savedProfiles();
      data.profileCount = list.length;
      data.profiles = await encryptWithPassword(list, pw.input.value, PROFILES_CONTEXT);
    }
    if (Object.keys(data).length <= 3) {
      error.textContent = t('settings.export.chooseSomething');
      error.hidden = false;
      dialog.setBusy(false);
      return;
    }
    const date = new Date().toISOString().slice(0, 10);
    saveBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `radhuset-api-browser-settings-${date}.json`);
    dialog.close();
    toast(t('settings.export.toast'), { kind: 'success' });
  }

  const dialog = openDialog({
    title: t('settings.export.title'),
    size: 'sm',
    body: h(
      'div',
      { class: 'form' },
      h('p', { class: 'muted', text: t('settings.export.intro') }),
      h('div', { class: 'check-list' }, apis.el, bindings.el, prefs.el, profiles.el),
      locked ? button(t('settings.export.unlockButton'), { icon: 'unlock', size: 'sm', onClick: async () => { if (await unlockVault(app)) { dialog.close(); openExportDialog(app); } } }) : null,
      passwordFields,
      error,
    ),
    footer: [button(t('common.cancel'), { onClick: () => dialog.close() }), button(t('settings.export.button'), { icon: 'export', variant: 'primary', onClick: doExport })],
  });
}

export function openImportDialog(app) {
  const input = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.remove();
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      alertDialog({ title: t('settings.import.failedTitle'), message: t('settings.import.notValidFile', { fileName: file.name }), kind: 'error' });
      return;
    }
    if (data?.format !== FORMAT || data.version !== 1) {
      alertDialog({ title: t('settings.import.failedTitle'), message: t('settings.import.notOurFile', { fileName: file.name }), kind: 'error' });
      return;
    }
    showImport(app, data, file.name);
  });
  document.body.append(input);
  input.click();
}

function showImport(app, data, fileName) {
  const has = (key) => data[key] !== undefined && data[key] !== null;
  const apis = has('apis') ? check(t('settings.import.yourApis', { n: Array.isArray(data.apis) ? data.apis.length : 0 })) : null;
  const bindings = has('bindings') ? check(t('settings.export.bindings')) : null;
  const prefs = has('preferences') ? check(t('settings.import.prefs')) : null;
  const profiles = has('profiles') ? check(data.profileCount ? t('settings.import.profiles', { n: data.profileCount }) : t('settings.import.profilesNoCount')) : null;
  const pw = passwordInput({ autocomplete: 'off' });
  const passwordField = profiles
    ? field(t('settings.import.passwordField'), pw.wrap, { id: 'import-pw', htmlFor: pw.input, hint: t('settings.import.passwordHint') })
    : null;
  profiles?.input.addEventListener('change', () => { passwordField.hidden = !profiles.input.checked; });
  const error = h('p', { class: 'error-text', role: 'alert', hidden: true });

  async function doImport() {
    error.hidden = true;
    const done = [];
    let decrypted = null;
    if (profiles?.input.checked) {
      if (!pw.input.value) {
        error.textContent = t('settings.import.enterPassword');
        error.hidden = false;
        return;
      }
      dialog.setBusy(true);
      try {
        decrypted = await decryptWithPassword(data.profiles, pw.input.value, PROFILES_CONTEXT);
        if (!Array.isArray(decrypted)) throw new DecryptionError();
      } catch (err) {
        error.textContent = err instanceof DecryptionError ? t('settings.import.wrongPassword') : err.message;
        error.hidden = false;
        dialog.setBusy(false);
        return;
      }
      dialog.setBusy(false);
      if (!(await requireVault(app, t('settings.import.needVaultReason')))) return;
    }
    try {
      if (apis?.input.checked) done.push(tn('settings.import.apisImported', app.apis.importCustom(data.apis)));
      if (bindings?.input.checked && data.bindings && typeof data.bindings === 'object') {
        app.bindings.merge(data.bindings);
        done.push(t('settings.import.bindingsImported'));
      }
      if (prefs?.input.checked && data.preferences && typeof data.preferences === 'object') {
        app.applyPreferences(data.preferences);
        done.push(t('settings.import.prefsImported'));
      }
      if (decrypted) done.push(tn('settings.import.profilesImported', await app.profiles.importSaved(decrypted)));
    } catch (err) {
      error.textContent = t('settings.import.failed', { message: err.message });
      error.hidden = false;
      return;
    }
    dialog.close();
    toast(done.length ? t('settings.import.doneToast', { list: done.join(', ') }) : t('settings.import.nothingToast'), { kind: done.length ? 'success' : 'info' });
  }

  const dialog = openDialog({
    title: t('settings.import.title'),
    size: 'sm',
    body: h(
      'div',
      { class: 'form' },
      h('p', { class: 'muted', text: t('settings.import.fromLine', { fileName, exportedSuffix: data.exported ? t('settings.import.exportedSuffix', { date: new Date(data.exported).toLocaleString() }) : '' }) }),
      h('div', { class: 'check-list' }, apis?.el, bindings?.el, prefs?.el, profiles?.el),
      passwordField,
      error,
    ),
    footer: [button(t('common.cancel'), { onClick: () => dialog.close() }), button(t('settings.import.button'), { icon: 'import', variant: 'primary', onClick: doImport })],
  });
  pw.input.focus();
}

/** The source repository, when served from GitHub Pages (user.github.io/repo). */
function repositoryUrl() {
  const { hostname, pathname } = window.location;
  if (!hostname.endsWith('.github.io')) return null;
  const user = hostname.slice(0, -'.github.io'.length);
  const repo = pathname.split('/').filter(Boolean)[0];
  return `https://github.com/${user}/${repo || `${user}.github.io`}`;
}

export function openAboutDialog(app) {
  const repo = repositoryUrl();
  const dialog = openDialog({
    title: t('settings.about.title'),
    size: 'sm',
    body: h(
      'div',
      { class: 'about' },
      h('img', { src: 'assets/radhuset-logo.svg', alt: 'Rådhuset Arkitekter', class: 'about-logo' }),
      h('p', null, h('strong', { text: 'Rådhuset API Browser' }), ` ${app.version}`),
      h('p', { text: t('settings.about.description') }),
      h('p', { class: 'muted small', text: t('settings.about.privacy') }),
      h('p', { class: 'small' }, t('settings.about.licensePrefix'), h('a', { href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener', text: t('settings.about.osmContributors') }), '.'),
      h('p', { class: 'small' }, repo ? h('a', { href: repo, target: '_blank', rel: 'noopener', text: t('settings.about.sourceCode') }) : null, repo ? ' · ' : null, h('a', { href: 'https://radhuset.se', target: '_blank', rel: 'noopener', text: 'radhuset.se' })),
    ),
    footer: button(t('common.close'), { variant: 'primary', onClick: () => dialog.close() }),
  });
}
