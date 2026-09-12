// Auth profiles, and which profile each API uses.
//
// A profile is either session-only — held in memory, gone when the tab closes —
// or saved, in which case it lives in the encrypted vault and is only visible
// while the vault is unlocked. Bindings (API name → profile id) are stored in the
// clear: a random id reveals nothing, and keeping them readable lets the app know
// to ask for an unlock when a locked profile is needed.

import { Emitter } from '../lib/emitter.js';
import { t } from '../i18n/index.js';
import * as store from '../lib/store.js';
import { VaultLockedError } from './vault.js';

export const PROFILE_TYPES = [
  ['oauth2', 'OAuth2 client credentials'],
  ['basic', 'Basic (username and password)'],
];

// Lantmäteriet's token endpoint, prefilled for new OAuth2 profiles because the
// built-in APIs all use it.
export const DEFAULT_TOKEN_URL = 'https://apimanager.lantmateriet.se/oauth2/token';

const str = (v) => (typeof v === 'string' ? v : '');

export function newProfileId() {
  return crypto.randomUUID().replace(/-/g, '');
}

export function newProfile({ name = '', type = 'oauth2', persist = false } = {}) {
  return {
    id: newProfileId(),
    name,
    type,
    username: '',
    password: '',
    clientId: '',
    clientSecret: '',
    tokenUrl: type === 'oauth2' ? DEFAULT_TOKEN_URL : '',
    persist,
  };
}

/** A clean profile object from untrusted input (the vault, an import, a form). */
export function normalizeProfile(raw, persist = Boolean(raw?.persist)) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id: str(raw.id) || newProfileId(),
    name: str(raw.name).trim() || t('profiles.unnamedProfile'),
    type: raw.type === 'basic' ? 'basic' : 'oauth2',
    username: str(raw.username).trim(),
    password: str(raw.password),
    clientId: str(raw.clientId).trim(),
    clientSecret: str(raw.clientSecret),
    tokenUrl: str(raw.tokenUrl).trim(),
    persist,
  };
}

/** Labels of the fields a profile needs before it can authenticate. */
export function missingFields(profile) {
  if (profile.type === 'basic') return profile.username ? [] : [t('session.fieldUsername')];
  const missing = [];
  if (!profile.clientId) missing.push(t('session.fieldClientId'));
  if (!profile.tokenUrl) missing.push(t('session.fieldTokenUrl'));
  return missing;
}

export function profileTypeLabel(type) {
  return type === 'basic' ? 'Basic' : 'OAuth2';
}

const forVault = ({ persist, ...rest }) => rest;
const byName = (a, b) => a.name.localeCompare(b.name, 'sv');

export class ProfileStore extends Emitter {
  #session = [];
  #saved = [];

  constructor(vault) {
    super();
    this.vault = vault;
    vault.on('unlock', (payload) => {
      const list = Array.isArray(payload?.profiles) ? payload.profiles : [];
      this.#saved = list.map((p) => normalizeProfile(p, true)).filter(Boolean);
      this.emit('change');
    });
    vault.on('lock', () => {
      this.#saved = [];
      this.emit('change');
    });
  }

  all() {
    return [...this.#saved, ...this.#session].sort(byName);
  }

  get(id) {
    return this.#saved.find((p) => p.id === id) || this.#session.find((p) => p.id === id) || null;
  }

  get hasSessionProfiles() {
    return this.#session.length > 0;
  }

  nameTaken(name, exceptId = null) {
    const wanted = name.trim().toLocaleLowerCase();
    return this.all().some((p) => p.id !== exceptId && p.name.toLocaleLowerCase() === wanted);
  }

  /**
   * Add or replace a profile. A saved profile (or one being moved out of the
   * vault) needs the vault unlocked; the caller is expected to have created or
   * unlocked it first.
   */
  async upsert(profile) {
    const clean = normalizeProfile(profile);
    const wasSaved = this.#saved.some((p) => p.id === clean.id);
    const touchesVault = clean.persist || wasSaved;
    if (touchesVault && !this.vault.unlocked) throw new VaultLockedError();

    const saved = this.#saved.filter((p) => p.id !== clean.id);
    const session = this.#session.filter((p) => p.id !== clean.id);
    (clean.persist ? saved : session).push(clean);
    if (touchesVault) await this.vault.write({ profiles: saved.map(forVault) });
    this.#saved = saved;
    this.#session = session;
    this.emit('change');
    return clean;
  }

  async remove(id) {
    const wasSaved = this.#saved.some((p) => p.id === id);
    if (wasSaved) {
      if (!this.vault.unlocked) throw new VaultLockedError();
      const saved = this.#saved.filter((p) => p.id !== id);
      await this.vault.write({ profiles: saved.map(forVault) });
      this.#saved = saved;
    } else {
      this.#session = this.#session.filter((p) => p.id !== id);
    }
    this.emit('change');
  }

  /** Saved profiles, for export. */
  savedProfiles() {
    return this.#saved.map(forVault);
  }

  /** Merge profiles into the vault, replacing any with the same id. */
  async importSaved(profiles) {
    if (!this.vault.unlocked) throw new VaultLockedError();
    const incoming = profiles.map((p) => normalizeProfile(p, true)).filter(Boolean);
    const ids = new Set(incoming.map((p) => p.id));
    const saved = [...this.#saved.filter((p) => !ids.has(p.id)), ...incoming];
    await this.vault.write({ profiles: saved.map(forVault) });
    this.#saved = saved;
    this.emit('change');
    return incoming.length;
  }
}

/** API name → profile id, persisted in the clear. */
export class BindingStore extends Emitter {
  static #KEY = 'bindings';
  #map = {};

  constructor() {
    super();
    this.#map = BindingStore.#clean(store.load(BindingStore.#KEY, {}));
    store.watch(BindingStore.#KEY, (value) => {
      this.#map = BindingStore.#clean(value);
      this.emit('change');
    });
  }

  static #clean(value) {
    const out = {};
    if (value && typeof value === 'object') {
      for (const [api, id] of Object.entries(value)) if (typeof id === 'string' && id) out[api] = id;
    }
    return out;
  }

  #write() {
    store.save(BindingStore.#KEY, this.#map);
    this.emit('change');
  }

  get(apiName) {
    return this.#map[apiName] || null;
  }

  set(apiName, profileId) {
    if (profileId) this.#map[apiName] = profileId;
    else delete this.#map[apiName];
    this.#write();
  }

  rename(oldName, newName) {
    if (oldName === newName || !(oldName in this.#map)) return;
    this.#map[newName] = this.#map[oldName];
    delete this.#map[oldName];
    this.#write();
  }

  /** Drop every binding to *profileId*. */
  forgetProfile(profileId) {
    let changed = false;
    for (const [api, id] of Object.entries(this.#map)) {
      if (id === profileId) {
        delete this.#map[api];
        changed = true;
      }
    }
    if (changed) this.#write();
  }

  apisBoundTo(profileId) {
    return Object.entries(this.#map).filter(([, id]) => id === profileId).map(([api]) => api);
  }

  entries() {
    return { ...this.#map };
  }

  merge(entries) {
    this.#map = { ...this.#map, ...BindingStore.#clean(entries) };
    this.#write();
  }
}
