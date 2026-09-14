// Auth profile manager: the list of profiles, an editor, and the encrypted
// storage controls.

import { missingFields, newProfile, normalizeProfile, profileTypeLabel } from '../auth/profiles.js';
import { requestToken } from '../auth/session.js';
import { VaultLockedError } from '../auth/vault.js';
import { button, clear, field, h, icon } from '../lib/dom.js';
import { t, tn } from '../i18n/index.js';
import { choiceDialog, confirmDialog, openDialog } from './dialog.js';
import { credentialFields, storageChoice } from './credentials.js';
import { toast } from './toast.js';
import { changePassword, createVault, openPasskeys, requireVault, unlockVault } from './vault-dialogs.js';

const comparable = (p) => JSON.stringify([p.name, p.type, p.username, p.password, p.clientId, p.clientSecret, p.tokenUrl, p.persist]);

export function openProfilesDialog(app, { selectId = null } = {}) {
  let current = null;   // the profile being edited (a stored copy, or a new draft)
  let isDraft = false;
  let editor = null;    // { read() } for the current form

  const list = h('ul', { class: 'profile-list', role: 'listbox', 'aria-label': t('profiles.title') });
  const editorEl = h('div', { class: 'profile-editor' });
  const security = h('div', { class: 'security-bar' });

  const formProfile = () => (current && editor ? editor.read() : null);
  const isDirty = () => {
    if (!current) return false;
    if (isDraft) return true;
    return comparable(formProfile()) !== comparable(current);
  };

  async function confirmLeave() {
    if (!isDirty()) return true;
    const choice = await choiceDialog({
      title: t('common.unsavedChangesTitle'),
      message: t('common.unsavedChangesMessage', { name: formProfile().name || t('profiles.newProfile') }),
      choices: [
        { label: t('common.cancel'), value: 'cancel' },
        { label: t('common.discard'), value: 'discard' },
        { label: t('common.save'), value: 'save', variant: 'primary', autofocus: true },
      ],
    });
    if (choice === 'save') return save();
    return choice === 'discard';
  }

  function renderList() {
    clear(list);
    const profiles = app.profiles.all();
    for (const p of profiles) {
      const selected = current && !isDraft && current.id === p.id;
      list.append(h(
        'li',
        {
          class: ['profile-row', selected && 'is-selected'],
          role: 'option',
          'aria-selected': String(Boolean(selected)),
          tabindex: '0',
          onclick: () => select(p.id),
          onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(p.id); } },
        },
        icon(p.persist ? 'lock' : 'key', { size: 16 }),
        h('span', { class: 'grow' }, h('span', { class: 'profile-name', text: p.name }), h('span', { class: 'muted small', text: t('profiles.typeAndScope', { type: profileTypeLabel(p.type), scope: p.persist ? t('profiles.scopeSaved') : t('profiles.scopeThisSession') }) })),
      ));
    }
    if (isDraft) {
      list.append(h('li', { class: 'profile-row is-selected', 'aria-selected': 'true' }, icon('plus', { size: 16 }), h('span', { class: 'grow' }, h('span', { class: 'profile-name', text: t('profiles.newProfile') }), h('span', { class: 'muted small', text: t('common.notSavedYet') }))));
    }
    if (app.vault.exists && !app.vault.unlocked) {
      list.append(h(
        'li',
        { class: 'profile-row is-locked' },
        icon('lock', { size: 16 }),
        h('span', { class: 'grow muted small', text: t('profiles.savedProfilesLocked') }),
        button(t('common.unlock'), { size: 'sm', onClick: () => unlockVault(app) }),
      ));
    }
    if (!profiles.length && !isDraft && !(app.vault.exists && !app.vault.unlocked)) {
      list.append(h('li', { class: 'muted small empty-row', text: t('profiles.noProfilesYet') }));
    }
  }

  function renderEditor() {
    clear(editorEl);
    editor = null;
    if (!current) {
      editorEl.append(h('div', { class: 'empty-state' }, icon('key', { size: 28 }), h('p', { text: t('profiles.selectPrompt') })));
      return;
    }
    const name = h('input', { type: 'text', value: current.name, placeholder: t('profiles.namePlaceholder'), autocomplete: 'off' });
    const creds = credentialFields(current);
    const storage = storageChoice(current.persist, `storage-${current.id}`);
    const status = h('p', { class: 'muted small', role: 'status' });
    const usedBy = isDraft ? [] : app.bindings.apisBoundTo(current.id);
    editor = { read: () => ({ ...creds.read(current), name: name.value.trim(), persist: storage.persist }) };

    async function test() {
      const profile = normalizeProfile(editor.read());
      const missing = missingFields(profile);
      if (missing.length) {
        status.textContent = t('profiles.fillInFirst', { fields: missing.join(` ${t('common.and')} `) });
        return;
      }
      status.textContent = t('profiles.requestingToken');
      try {
        const data = await requestToken(profile);
        const minutes = Number(data.expires_in) ? t('profiles.validForMinutes', { minutes: Math.round(Number(data.expires_in) / 60) }) : '';
        status.textContent = t('profiles.tokenIssued', { minutes });
      } catch (err) {
        status.textContent = err.message;
      }
    }

    editorEl.append(
      h(
        'form',
        { class: 'form', onsubmit: (e) => { e.preventDefault(); save(); } },
        field(t('apis.name'), name),
        creds.el,
        storage.el,
        usedBy.length ? h('p', { class: 'muted small', text: t('profiles.usedBy', { list: usedBy.join(', ') }) }) : null,
        h('button', { type: 'submit', hidden: true }),
      ),
      h(
        'div',
        { class: 'editor-actions' },
        button(t('profiles.testTitle'), { icon: 'refresh', variant: 'ghost', title: t('profiles.testTooltip'), onClick: test, disabled: creds.inputs.type.value !== 'oauth2' || null }),
        status,
        h('span', { class: 'spacer' }),
        isDraft ? null : button(t('common.delete'), { icon: 'trash', variant: 'ghost', class: 'is-danger', onClick: remove }),
        button(t('common.save'), { variant: 'primary', onClick: save }),
      ),
    );
    creds.inputs.type.addEventListener('change', () => {
      editorEl.querySelector('.editor-actions .btn').disabled = creds.inputs.type.value !== 'oauth2';
    });
    name.focus();
  }

  function renderSecurity() {
    clear(security);
    const { vault } = app;
    if (!vault.exists) {
      security.append(
        icon('shield', { size: 18 }),
        h('span', { class: 'grow muted small', text: t('profiles.setupTitle') }),
        button(t('profiles.setUp'), { size: 'sm', onClick: () => createVault(app) }),
      );
    } else if (!vault.unlocked) {
      security.append(icon('lock', { size: 18 }), h('span', { class: 'grow small', text: t('profiles.savedProfilesLocked') }), button(t('common.unlock'), { size: 'sm', icon: 'unlock', onClick: () => unlockVault(app) }));
    } else {
      security.append(
        icon('unlock', { size: 18 }),
        h('span', { class: 'grow small', text: t('profiles.unlockedText') }),
        button(t('profiles.lock'), { size: 'sm', icon: 'lock', onClick: () => vault.lock() }),
        button(t('profiles.passkeysButton'), { size: 'sm', icon: 'passkey', onClick: () => openPasskeys(app) }),
        button(t('profiles.changePasswordButton'), { size: 'sm', onClick: () => changePassword(app) }),
        button(t('profiles.deleteAllSaved'), { size: 'sm', variant: 'ghost', class: 'is-danger', onClick: destroyVault }),
      );
    }
    const tokens = app.auth.cachedTokenCount;
    if (tokens) {
      security.append(button(tn('profiles.forgetTokens', tokens), {
        size: 'sm',
        variant: 'ghost',
        title: t('profiles.forgetTokensTooltip'),
        onClick: () => { app.auth.clear(); toast(t('profiles.tokensDiscardedToast')); renderSecurity(); },
      }));
    }
  }

  function renderAll() {
    renderList();
    renderSecurity();
  }

  async function select(id) {
    if (current && !isDraft && current.id === id) return;
    if (!(await confirmLeave())) return;
    const profile = app.profiles.get(id);
    current = profile ? { ...profile } : null;
    isDraft = false;
    renderList();
    renderEditor();
  }

  async function create() {
    if (!(await confirmLeave())) return;
    current = newProfile({ name: '' });
    isDraft = true;
    renderList();
    renderEditor();
  }

  async function save() {
    const profile = formProfile();
    if (!profile) return false;
    if (!profile.name) {
      toast(t('profiles.giveProfileNameToast'), { kind: 'warning' });
      return false;
    }
    if (app.profiles.nameTaken(profile.name, current.id)) {
      toast(t('profiles.nameTakenToast', { name: profile.name }), { kind: 'warning' });
      return false;
    }
    const touchesVault = profile.persist || (!isDraft && current.persist);
    if (touchesVault && !(await requireVault(app, profile.persist ? t('profiles.saveReasonPersist') : t('profiles.saveReasonUnlock')))) return false;
    try {
      const stored = await app.profiles.upsert(profile);
      current = { ...stored };
      isDraft = false;
      renderAll();
      renderEditor();
      toast(t('profiles.savedToast', { name: stored.name, scope: stored.persist ? t('profiles.scopeEncrypted') : t('profiles.scopeSession') }), { kind: 'success' });
      return true;
    } catch (err) {
      toast(err instanceof VaultLockedError ? t('profiles.unlockSavedFirst') : err.message, { kind: 'error' });
      return false;
    }
  }

  async function remove() {
    const usedBy = app.bindings.apisBoundTo(current.id);
    const ok = await confirmDialog({
      title: t('profiles.deleteTitle'),
      message: t('profiles.deleteMessage', { name: current.name, usedBySuffix: usedBy.length ? t('profiles.deleteUsedBySuffix', { list: usedBy.join(', ') }) : '' }),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    if (current.persist && !(await unlockVault(app))) return;
    await app.profiles.remove(current.id);
    app.bindings.forgetProfile(current.id);
    current = null;
    isDraft = false;
    renderAll();
    renderEditor();
  }

  async function destroyVault() {
    const ok = await confirmDialog({
      title: t('profiles.destroyVaultTitle'),
      message: t('profiles.destroyVaultMessage'),
      confirmLabel: t('profiles.deleteEverythingSaved'),
      danger: true,
    });
    if (!ok) return;
    const savedIds = app.profiles.savedProfiles().map((p) => p.id);
    app.vault.destroy();
    savedIds.forEach((id) => app.bindings.forgetProfile(id));
    if (current?.persist) current = null;
    renderAll();
    renderEditor();
  }

  const offProfiles = app.profiles.on('change', renderAll);
  const offVault = app.vault.on('change', renderAll);
  // A locked vault drops its saved profiles from the store; if the editor was
  // showing one, it would otherwise keep displaying that now-stale copy as if
  // it were still selected and editable.
  const offVaultLock = app.vault.on('lock', () => {
    if (current?.persist) {
      current = null;
      isDraft = false;
      renderAll();
      renderEditor();
    }
  });

  const dialog = openDialog({
    title: t('profiles.title'),
    size: 'xl',
    className: 'profiles-dialog',
    body: h(
      'div',
      { class: 'split' },
      h('div', { class: 'split-list' }, list, button(t('profiles.newProfile'), { icon: 'plus', onClick: create })),
      editorEl,
    ),
    footer: [security],
    canClose: confirmLeave,
    onClose: () => {
      offProfiles();
      offVault();
      offVaultLock();
    },
  });

  renderAll();
  if (selectId && app.profiles.get(selectId)) select(selectId);
  else if (!app.profiles.all().length && !(app.vault.exists && !app.vault.unlocked)) create();
  else renderEditor();
  return dialog;
}
