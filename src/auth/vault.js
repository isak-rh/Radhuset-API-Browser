// The encrypted credential vault.
//
// Saved auth profiles are encrypted with a random 256-bit data key (AES-GCM).
// The data key itself is stored only wrapped — once under a key derived from the
// master password (PBKDF2-SHA256), and once more under each registered passkey
// (WebAuthn PRF + HKDF). Any one of them opens the vault; changing the password
// or adding a passkey re-wraps the same data key without touching the data.
//
// Nothing secret is ever written unencrypted, including profile names. While
// locked the app therefore knows only that a vault exists, not what is in it.
// The unlocked data key lives in memory for the lifetime of the tab, or until
// the user locks it.
//
// Stored record (localStorage "rab.vault"):
//   { format: "rab-vault", version: 1, created, updated,
//     password: { kdf: { name, hash, iterations, salt }, key: { iv, ct } },
//     passkeys: [ { id, label, created, salt, key: { iv, ct } } ],
//     data: { iv, ct } }

import {
  DecryptionError, PBKDF2_ITERATIONS, decryptJson, encryptJson, fromBase64, generateDataKey,
  hkdfKey, passwordKey, randomBytes, toBase64, unwrapDataKey, wrapDataKey,
} from '../lib/crypto.js';
import { Emitter } from '../lib/emitter.js';
import { t } from '../i18n/index.js';
import * as store from '../lib/store.js';
import { createPrfPasskey, evaluatePrf } from './passkey.js';

const STORAGE_KEY = 'vault';
const CONTEXT_DATA = 'rab/vault/data/v1';
const CONTEXT_PASSWORD = 'rab/vault/key/password/v1';
const CONTEXT_PASSKEY = 'rab/vault/key/passkey/v1';
const PASSKEY_KEY_INFO = 'rab/vault/passkey-kek/v1';

export const MIN_PASSWORD_LENGTH = 8;

export class VaultLockedError extends Error {
  constructor() {
    super(t('vault.errors.locked'));
    this.name = 'VaultLockedError';
  }
}

export class WrongPasswordError extends Error {
  constructor() {
    super(t('vault.errors.wrongPassword'));
    this.name = 'WrongPasswordError';
  }
}

function validRecord(record) {
  return Boolean(
    record && record.format === 'rab-vault' && record.version === 1 &&
    record.password?.kdf && record.password?.key && record.data,
  );
}

export class Vault extends Emitter {
  #key;
  #record = null;
  #dataKey = null;
  #payload = null;

  /** *storageKey* exists for tests, which must never touch the real vault. */
  constructor({ storageKey = STORAGE_KEY } = {}) {
    super();
    this.#key = storageKey;
    const record = store.load(this.#key, null);
    this.#record = validRecord(record) ? record : null;
    // Another tab changed the vault. Adopt its record; if we are unlocked, the
    // data key is the same unless the vault was deleted and re-created, so try
    // to keep up with the new contents and lock only if that fails.
    store.watch(this.#key, (value) => this.#adoptExternal(value));
  }

  get exists() {
    return this.#record !== null;
  }

  get unlocked() {
    return this.#dataKey !== null;
  }

  /** The decrypted contents. Only available while unlocked. */
  get payload() {
    if (!this.unlocked) throw new VaultLockedError();
    return structuredClone(this.#payload);
  }

  get passkeys() {
    return (this.#record?.passkeys || []).map(({ id, label, created }) => ({ id, label, created }));
  }

  async create(password, payload) {
    if (this.exists) throw new Error(t('vault.errors.alreadyExists'));
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(t('vault.errors.passwordTooShort', { n: MIN_PASSWORD_LENGTH }));
    }
    const dataKey = await generateDataKey();
    const salt = randomBytes(16);
    const now = new Date().toISOString();
    const record = {
      format: 'rab-vault',
      version: 1,
      created: now,
      updated: now,
      password: {
        kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: toBase64(salt) },
        key: await wrapDataKey(dataKey, await passwordKey(password, salt), CONTEXT_PASSWORD),
      },
      passkeys: [],
      data: await encryptJson(dataKey, payload, CONTEXT_DATA),
    };
    this.#persist(record);
    this.#dataKey = dataKey;
    this.#payload = structuredClone(payload);
    this.emit('change');
    this.emit('unlock', this.payload);
  }

  async unlockWithPassword(password) {
    const record = this.#requireRecord();
    const { salt, iterations } = record.password.kdf;
    let dataKey;
    try {
      const key = await passwordKey(password, fromBase64(salt), iterations);
      dataKey = await unwrapDataKey(record.password.key, key, CONTEXT_PASSWORD);
    } catch (error) {
      if (error instanceof DecryptionError) throw new WrongPasswordError();
      throw error;
    }
    await this.#open(dataKey, record);
  }

  async unlockWithPasskey() {
    const record = this.#requireRecord();
    const entries = record.passkeys || [];
    const { id, output } = await evaluatePrf(entries);
    const entry = entries.find((e) => e.id === id);
    if (!entry) throw new Error(t('vault.errors.passkeyNotRegistered'));
    const key = await hkdfKey(output, PASSKEY_KEY_INFO);
    let dataKey;
    try {
      dataKey = await unwrapDataKey(entry.key, key, CONTEXT_PASSKEY);
    } catch (error) {
      if (error instanceof DecryptionError) throw new Error(t('vault.errors.passkeyCouldNotOpen'));
      throw error;
    }
    await this.#open(dataKey, record);
  }

  lock() {
    if (!this.unlocked) return;
    this.#dataKey = null;
    this.#payload = null;
    this.emit('change');
    this.emit('lock');
  }

  /** Replace the vault's contents. */
  async write(payload) {
    const record = this.#requireUnlocked();
    const updated = {
      ...record,
      updated: new Date().toISOString(),
      data: await encryptJson(this.#dataKey, payload, CONTEXT_DATA),
    };
    this.#persist(updated);
    this.#payload = structuredClone(payload);
  }

  async changePassword(newPassword) {
    const record = this.#requireUnlocked();
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      throw new Error(t('vault.errors.passwordTooShort', { n: MIN_PASSWORD_LENGTH }));
    }
    const salt = randomBytes(16);
    this.#persist({
      ...record,
      updated: new Date().toISOString(),
      password: {
        kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: toBase64(salt) },
        key: await wrapDataKey(this.#dataKey, await passwordKey(newPassword, salt), CONTEXT_PASSWORD),
      },
    });
  }

  async addPasskey(label) {
    this.#requireUnlocked();
    const { id, salt, output } = await createPrfPasskey(label);
    const key = await hkdfKey(output, PASSKEY_KEY_INFO);
    const wrapped = await wrapDataKey(this.#dataKey, key, CONTEXT_PASSKEY);
    // Re-read: the ceremony can take a while, and the record may have moved on.
    const record = this.#requireUnlocked();
    this.#persist({
      ...record,
      updated: new Date().toISOString(),
      passkeys: [...(record.passkeys || []), { id, label, created: new Date().toISOString(), salt, key: wrapped }],
    });
    this.emit('change');
  }

  removePasskey(id) {
    const record = this.#requireUnlocked();
    this.#persist({ ...record, passkeys: (record.passkeys || []).filter((p) => p.id !== id) });
    this.emit('change');
  }

  /** Delete the vault and everything in it. */
  destroy() {
    store.remove(this.#key);
    this.#record = null;
    const wasUnlocked = this.unlocked;
    this.#dataKey = null;
    this.#payload = null;
    this.emit('change');
    if (wasUnlocked) this.emit('lock');
  }

  // ── internals ───────────────────────────────────────────────────────────

  async #open(dataKey, record) {
    let payload;
    try {
      payload = await decryptJson(dataKey, record.data, CONTEXT_DATA);
    } catch {
      throw new Error(t('vault.errors.decryptFailed'));
    }
    this.#dataKey = dataKey;
    this.#payload = payload;
    this.emit('change');
    this.emit('unlock', this.payload);
  }

  #requireRecord() {
    if (!this.#record) throw new Error(t('vault.errors.noVault'));
    return this.#record;
  }

  #requireUnlocked() {
    const record = this.#requireRecord();
    if (!this.unlocked) throw new VaultLockedError();
    return record;
  }

  #persist(record) {
    if (!store.save(this.#key, record)) {
      throw new Error(t('vault.errors.storageBlocked'));
    }
    this.#record = record;
  }

  async #adoptExternal(value) {
    if (!validRecord(value)) {
      if (this.#record) this.destroy();
      return;
    }
    this.#record = value;
    if (this.unlocked) {
      try {
        this.#payload = await decryptJson(this.#dataKey, value.data, CONTEXT_DATA);
        this.emit('unlock', this.payload);
      } catch {
        this.lock();
      }
    }
    this.emit('change');
  }
}
