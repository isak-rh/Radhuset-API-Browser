// Getting credentials in front of the user before an operation needs them.
//
// Resolving credentials is what fetches a token, so doing it before a search or
// download starts keeps authentication problems in a dialog the user can act on
// — enter credentials, unlock the vault, fix a profile — instead of a failure
// halfway through.

import { needsAuthForBrowse, needsAuthForDownload } from '../config/apis.js';
import { IncompleteProfileError, TokenFetchError } from '../auth/session.js';
import { DEFAULT_TOKEN_URL, missingFields, newProfile, profileTypeLabel } from '../auth/profiles.js';
import { VaultLockedError } from '../auth/vault.js';
import { button, field, h, select } from '../lib/dom.js';
import { t } from '../i18n/index.js';
import { alertDialog, openDialog, passwordInput } from './dialog.js';
import { requireVault, unlockVault } from './vault-dialogs.js';

const PROFILE_TYPE_LABELS = { oauth2: 'credentials.typeOAuth2', basic: 'credentials.typeBasic' };

/** Radio pair for the profile type: OAuth2 first and default, both visible at once. */
function typeChoice(type, name) {
  const oauth = h('input', { type: 'radio', name, value: 'oauth2', checked: type !== 'basic' });
  const basic = h('input', { type: 'radio', name, value: 'basic', checked: type === 'basic' });
  return {
    el: h(
      'fieldset',
      { class: 'choice-cards' },
      h('legend', { text: t('credentials.type') }),
      h('label', { class: 'choice-card' }, oauth, h('span', null, h('strong', { text: t(PROFILE_TYPE_LABELS.oauth2) }))),
      h('label', { class: 'choice-card' }, basic, h('span', null, h('strong', { text: t(PROFILE_TYPE_LABELS.basic) }))),
    ),
    get value() {
      return basic.checked ? 'basic' : 'oauth2';
    },
    addEventListener(eventType, fn) {
      oauth.addEventListener(eventType, fn);
      basic.addEventListener(eventType, fn);
    },
  };
}

/**
 * True once *api* has usable credentials for *purpose* ('browse' | 'download'),
 * or needs none. Prompts for whatever is missing.
 */
export async function ensureCredentials(app, api, purpose) {
  const needed = purpose === 'browse' ? needsAuthForBrowse(api) : needsAuthForDownload(api);
  if (!needed) return true;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      if (await app.auth.credentialsFor(api.name)) return true;
      if (!(await promptCredentials(app, api, purpose))) return false;
    } catch (error) {
      if (error instanceof VaultLockedError) {
        if (!(await unlockVault(app, { reason: t('vault.usesProfileReason', { name: api.name }) }))) return false;
      } else if (error instanceof IncompleteProfileError) {
        await alertDialog({ title: t('vault.incompleteAuthProfileTitle'), message: `${error.message}\n\n${t('vault.completeItInAuthProfiles')}`, kind: 'error' });
        app.openProfiles(error.profile.id);
        return false;
      } else if (error instanceof TokenFetchError) {
        await alertDialog({ title: t('vault.authenticationFailedTitle'), message: `${t('vault.couldNotGetToken', { name: api.name })}\n\n${error.message}`, kind: 'error' });
        return false;
      } else {
        throw error;
      }
    }
  }
  return false;
}

/** The credential fields of a profile form, for either profile type. */
export function credentialFields(profile) {
  const inputs = {
    type: typeChoice(profile.type, `cred-type-${profile.id}`),
    clientId: h('input', { type: 'text', value: profile.clientId, autocomplete: 'off', spellcheck: 'false' }),
    clientSecret: passwordInput({ value: profile.clientSecret, autocomplete: 'off' }),
    tokenUrl: h('input', { type: 'url', value: profile.tokenUrl || DEFAULT_TOKEN_URL, spellcheck: 'false' }),
    username: h('input', { type: 'text', value: profile.username, autocomplete: 'username', spellcheck: 'false' }),
    password: passwordInput({ value: profile.password, autocomplete: 'current-password' }),
  };
  const oauth = h(
    'div',
    { class: 'form-group' },
    field(t('credentials.clientId'), inputs.clientId),
    field(t('credentials.clientSecret'), inputs.clientSecret.wrap, { id: `cred-secret-${profile.id}`, htmlFor: inputs.clientSecret.input }),
    field(t('credentials.tokenUrl'), inputs.tokenUrl, { hint: t('credentials.tokenUrlHint') }),
  );
  const basic = h(
    'div',
    { class: 'form-group' },
    field(t('credentials.username'), inputs.username),
    field(t('credentials.password'), inputs.password.wrap, { id: `cred-pw-${profile.id}`, htmlFor: inputs.password.input }),
  );
  const sync = () => {
    oauth.hidden = inputs.type.value !== 'oauth2';
    basic.hidden = inputs.type.value !== 'basic';
  };
  inputs.type.addEventListener('change', sync);
  sync();
  return {
    inputs,
    el: h('div', { class: 'form-group' }, inputs.type.el, oauth, basic),
    /** The profile with the form's values applied. */
    read: (base) => ({
      ...base,
      type: inputs.type.value,
      clientId: inputs.clientId.value.trim(),
      clientSecret: inputs.clientSecret.input.value,
      tokenUrl: inputs.tokenUrl.value.trim(),
      username: inputs.username.value.trim(),
      password: inputs.password.input.value,
    }),
  };
}

/** Radio pair: keep a profile for this session only, or save it encrypted. */
export function storageChoice(persist, name) {
  const session = h('input', { type: 'radio', name, value: 'session', checked: !persist });
  const saved = h('input', { type: 'radio', name, value: 'saved', checked: persist });
  return {
    el: h(
      'fieldset',
      { class: 'choice-cards' },
      h('legend', { text: t('credentials.keepTitle') }),
      h('label', { class: 'choice-card' }, session, h('span', null, h('strong', { text: t('credentials.sessionOnlyTitle') }), h('span', { class: 'muted small', text: t('credentials.sessionOnlyDesc') }))),
      h('label', { class: 'choice-card' }, saved, h('span', null, h('strong', { text: t('credentials.savedTitle') }), h('span', { class: 'muted small', text: t('credentials.savedDesc') }))),
    ),
    get persist() {
      return saved.checked;
    },
  };
}

/**
 * Ask for credentials for *api*: pick an existing profile, or enter new ones.
 * Binds the result to the API. Resolves true when something was bound.
 */
export function promptCredentials(app, api, purpose) {
  return new Promise((resolve) => {
    let ok = false;
    const existing = app.profiles.all();
    const draft = newProfile({ name: t('credentials.defaultName', { host: new URL(api.url).hostname.split('.').slice(-2, -1)[0] || 'API' }) });
    if (/lantmateriet/i.test(api.url)) draft.name = t('credentials.lantmaterietName', { apiType: api.apiType === 'ngp' ? 'NGP' : 'STAC' });
    const nameInput = h('input', { type: 'text', value: draft.name });
    const creds = credentialFields(draft);
    // If they've saved credentials before, they likely want this one saved too.
    const storage = storageChoice(existing.some((p) => p.persist), 'cred-storage');
    const error = h('p', { class: 'error-text', role: 'alert', hidden: true });

    const existingSelect = existing.length
      ? select(existing.map((p) => [p.id, t('credentials.existingOption', { name: p.name, type: profileTypeLabel(p.type), saved: p.persist ? t('credentials.savedSuffix') : '' })]), existing[0].id)
      : null;

    const when = purpose === 'browse' || api.authRequired === 'all' ? t('credentials.whenBrowseDownload') : t('credentials.whenDownload');
    const lockedNote = app.vault.exists && !app.vault.unlocked
      ? h('p', { class: 'notice' }, t('credentials.lockedNotePrefix'), h('button', {
          type: 'button',
          class: 'link-button',
          text: t('credentials.unlockThem'),
          onclick: async () => {
            if (await unlockVault(app)) {
              dialog.close();
              resolve(true);
            }
          },
        }), t('credentials.lockedNoteSuffix'))
      : null;

    async function useExisting() {
      app.bindings.set(api.name, existingSelect.value);
      ok = true;
      dialog.close();
    }

    async function submit() {
      const profile = { ...creds.read(draft), name: nameInput.value.trim() || draft.name, persist: storage.persist };
      const missing = missingFields(profile);
      if (profile.type === 'oauth2' && !profile.clientSecret) missing.push(t('credentials.fieldClientSecret'));
      if (missing.length) {
        error.textContent = t('credentials.fillInFields', { fields: missing.join(` ${t('common.and')} `) });
        error.hidden = false;
        return;
      }
      if (app.profiles.nameTaken(profile.name)) profile.name = `${profile.name} (${new Date().toLocaleDateString()})`;
      if (profile.persist && !(await requireVault(app, t('credentials.saveVaultReason')))) return;
      dialog.setBusy(true);
      try {
        const saved = await app.profiles.upsert(profile);
        app.bindings.set(api.name, saved.id);
        ok = true;
        dialog.close();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        dialog.setBusy(false);
      }
    }

    const dialog = openDialog({
      title: t('credentials.title', { name: api.name }),
      size: 'md',
      body: h(
        'div',
        { class: 'form' },
        h('p', { text: t('credentials.neededFor', { when }) }),
        lockedNote,
        existingSelect
          ? h('div', { class: 'inline-form' }, field(t('credentials.useExistingProfile'), existingSelect), button(t('credentials.use'), { onClick: useExisting }))
          : null,
        existingSelect ? h('div', { class: 'or-divider' }, h('span', { text: t('credentials.orAddNew') })) : null,
        h('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); submit(); } }, field(t('credentials.profileName'), nameInput), creds.el, storage.el, error, h('button', { type: 'submit', hidden: true })),
        /lantmateriet/i.test(api.url)
          ? h('p', { class: 'muted small' }, t('lantmateriet.setupPrefix'), h('a', { href: 'https://geotorget.lantmateriet.se/', target: '_blank', rel: 'noopener', text: t('lantmateriet.geotorget') }), t('lantmateriet.setupMid'), h('a', { href: 'https://apimanager.lantmateriet.se/devportal/apis', target: '_blank', rel: 'noopener', text: t('lantmateriet.apiPortalen') }), t('lantmateriet.setupSuffix'))
          : null,
      ),
      footer: [button(t('common.cancel'), { onClick: () => dialog.close() }), button(t('common.continue'), { variant: 'primary', onClick: submit })],
      onClose: () => resolve(ok),
    });
    (existingSelect || creds.inputs.clientId).focus();
  });
}
