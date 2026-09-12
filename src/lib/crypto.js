// Web Crypto helpers for everything this app encrypts: the credential vault and
// exported settings files.
//
// Primitives: PBKDF2-SHA256 for passwords, HKDF-SHA256 for passkey PRF output,
// AES-256-GCM for every ciphertext. Each ciphertext is bound to what it is for
// through GCM's additional data (a context string), so a blob lifted out of one
// place cannot be decrypted as if it were another.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// OWASP's 2023 recommendation for PBKDF2-HMAC-SHA256. The count is stored beside
// every salt, so it can be raised later without orphaning existing vaults.
export const PBKDF2_ITERATIONS = 600_000;
// Bounds accepted when reading a stored or imported count. The upper bound stops a
// crafted file from hanging the tab; the lower one refuses a trivially weak blob.
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 10_000_000;

/** Raised when a password, passkey or key does not open a ciphertext. */
export class DecryptionError extends Error {
  constructor(message = 'Decryption failed') {
    super(message);
    this.name = 'DecryptionError';
  }
}

export function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function toBase64(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toBase64Url(data) {
  return toBase64(data).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text) {
  let b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return fromBase64(b64);
}

function checkIterations(iterations) {
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new DecryptionError(`Unsupported key-derivation iteration count: ${iterations}`);
  }
}

/** An AES-GCM key derived from a password. Usable to wrap keys and to encrypt. */
export async function passwordKey(password, salt, iterations = PBKDF2_ITERATIONS) {
  checkIterations(iterations);
  // NFC so the same password typed on two platforms (composed vs decomposed
  // "å") derives the same key.
  const material = await crypto.subtle.importKey(
    'raw', encoder.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
  );
}

/** An AES-GCM wrapping key derived from high-entropy input (a passkey's PRF output). */
export async function hkdfKey(inputKeyMaterial, info, salt = new Uint8Array(32)) {
  const material = await crypto.subtle.importKey('raw', inputKeyMaterial, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

/**
 * A fresh random data key. Extractable only so it can be wrapped: the vault
 * keeps one copy per unlock method (password, each passkey), all of the same key.
 */
export function generateDataKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function wrapDataKey(dataKey, wrappingKey, context) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.wrapKey('raw', dataKey, wrappingKey, {
    name: 'AES-GCM', iv, additionalData: encoder.encode(context),
  });
  return { iv: toBase64(iv), ct: toBase64(ct) };
}

export async function unwrapDataKey(box, wrappingKey, context) {
  try {
    return await crypto.subtle.unwrapKey(
      'raw',
      fromBase64(box.ct),
      wrappingKey,
      { name: 'AES-GCM', iv: fromBase64(box.iv), additionalData: encoder.encode(context) },
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
  } catch {
    throw new DecryptionError();
  }
}

export async function encryptJson(key, value, context) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
    key,
    encoder.encode(JSON.stringify(value)),
  );
  return { iv: toBase64(iv), ct: toBase64(ct) };
}

export async function decryptJson(key, box, context) {
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(box.iv), additionalData: encoder.encode(context) },
      key,
      fromBase64(box.ct),
    );
  } catch {
    throw new DecryptionError();
  }
  return JSON.parse(decoder.decode(plain));
}

/** Encrypt *value* under a password, as one self-describing blob (salt, count, iv, ct). */
export async function encryptWithPassword(value, password, context) {
  const salt = randomBytes(16);
  const key = await passwordKey(password, salt);
  const box = await encryptJson(key, value, context);
  return {
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: toBase64(salt) },
    cipher: 'AES-GCM',
    ...box,
  };
}

export async function decryptWithPassword(blob, password, context) {
  if (!blob || blob.kdf?.name !== 'PBKDF2' || blob.kdf?.hash !== 'SHA-256' || blob.cipher !== 'AES-GCM') {
    throw new DecryptionError('Unrecognised encryption format');
  }
  const key = await passwordKey(password, fromBase64(blob.kdf.salt), blob.kdf.iterations);
  return decryptJson(key, blob, context);
}
