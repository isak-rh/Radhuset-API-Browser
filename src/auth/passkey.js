// Passkeys as a vault unlock method, through the WebAuthn PRF extension.
//
// PRF asks the authenticator for a secret derived from the passkey and a salt we
// choose. The same passkey and salt always give the same 32 bytes, and nothing
// else can produce them, so they can be turned into an encryption key without any
// server: the passkey never leaves the authenticator, and no assertion needs to be
// verified — only the PRF output is used.
//
// Support depends on browser, platform and authenticator all at once, so it is
// detected, never assumed: a passkey whose creation does not report
// `prf.enabled` is rejected with an explanation.

import { fromBase64, fromBase64Url, randomBytes, toBase64, toBase64Url } from '../lib/crypto.js';
import { t } from '../i18n/index.js';

export class PasskeyError extends Error {
  constructor(message, { cancelled = false } = {}) {
    super(message);
    this.name = 'PasskeyError';
    this.cancelled = cancelled;
  }
}

/** { supported, reason } — whether this browser can use a passkey for encryption. */
export async function passkeySupport() {
  if (!window.isSecureContext) {
    return { supported: false, reason: t('vault.passkeySupport.needsHttps') };
  }
  if (!window.PublicKeyCredential || !navigator.credentials?.create) {
    return { supported: false, reason: t('vault.passkeySupport.notSupported') };
  }
  try {
    if (typeof PublicKeyCredential.getClientCapabilities === 'function') {
      const caps = await PublicKeyCredential.getClientCapabilities();
      if (caps && caps['extension:prf'] === false) {
        return {
          supported: false,
          reason: t('vault.passkeySupport.noPrf'),
        };
      }
    }
  } catch {
    /* capability query unavailable — find out when creating */
  }
  return { supported: true, reason: '' };
}

function translate(error, action) {
  if (error instanceof PasskeyError) return error;
  if (error?.name === 'NotAllowedError' || error?.name === 'AbortError') {
    return new PasskeyError(t('vault.passkeyError.cancelledOrTimedOut', { action }), { cancelled: true });
  }
  if (error?.name === 'InvalidStateError') {
    return new PasskeyError(t('vault.passkeyError.alreadyRegistered'));
  }
  if (error?.name === 'SecurityError') {
    return new PasskeyError(t('vault.passkeyError.notAllowedAddress'));
  }
  return new PasskeyError(t('vault.passkeyError.genericFailed', { action, message: error?.message || error }));
}

/**
 * Evaluate PRF for one of *entries* ([{ id: base64url, salt: base64 }]), letting
 * the user pick which passkey. Resolves to { id, output: Uint8Array }.
 */
export async function evaluatePrf(entries) {
  if (!entries.length) throw new PasskeyError(t('vault.passkeyError.noneRegistered'));
  let assertion;
  try {
    assertion = await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        allowCredentials: entries.map((e) => ({ type: 'public-key', id: fromBase64Url(e.id) })),
        userVerification: 'required',
        timeout: 120_000,
        extensions: {
          prf: {
            evalByCredential: Object.fromEntries(entries.map((e) => [e.id, { first: fromBase64(e.salt) }])),
          },
        },
      },
    });
  } catch (error) {
    throw translate(error, t('vault.passkeyError.actionSignIn'));
  }
  if (!assertion) throw new PasskeyError(t('vault.passkeyError.noneSelected'), { cancelled: true });
  const output = assertion.getClientExtensionResults?.().prf?.results?.first;
  if (!output) {
    throw new PasskeyError(t('vault.passkeyError.noPrfOutput'));
  }
  return { id: toBase64Url(assertion.rawId), output: new Uint8Array(output) };
}

/**
 * Create a passkey that supports PRF and return { id, salt, output }. Throws a
 * PasskeyError when the authenticator does not support PRF.
 */
export async function createPrfPasskey(label) {
  const salt = randomBytes(32);
  let credential;
  try {
    credential = await navigator.credentials.create({
      publicKey: {
        rp: { name: 'Rådhuset API Browser' },
        user: { id: randomBytes(16), name: label, displayName: label },
        challenge: randomBytes(32),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },   // ES256
          { type: 'public-key', alg: -257 }, // RS256
        ],
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        timeout: 120_000,
        extensions: { prf: { eval: { first: salt } } },
      },
    });
  } catch (error) {
    throw translate(error, t('vault.passkeyError.actionCreation'));
  }
  if (!credential) throw new PasskeyError(t('vault.passkeyError.noneCreated'), { cancelled: true });

  const id = toBase64Url(credential.rawId);
  const prf = credential.getClientExtensionResults?.().prf;
  if (!prf?.enabled) {
    throw new PasskeyError(t('vault.passkeyError.noPrfSupport'));
  }
  // Some authenticators evaluate PRF during creation; the rest need one sign-in.
  let output = prf.results?.first ? new Uint8Array(prf.results.first) : null;
  if (!output) output = (await evaluatePrf([{ id, salt: toBase64(salt) }])).output;
  return { id, salt: toBase64(salt), output };
}
