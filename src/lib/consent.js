// Consent to store data on this device (EU ePrivacy/GDPR). Deliberately kept
// outside store.js's rab.-prefixed, gated keyspace: this flag has to be
// writable before, and regardless of, consent itself.
//
// Granting persists in localStorage — never ask again. Declining is remembered
// only for the current browser session (sessionStorage), the closest thing
// this cookie-free app has to a "necessary session cookie": the next session
// asks again, but a reload of the same tab doesn't nag repeatedly.

const KEY = 'rab.consent';

export function getState() {
  try {
    if (localStorage.getItem(KEY) === 'granted') return 'granted';
  } catch {
    /* ignore */
  }
  try {
    if (sessionStorage.getItem(KEY) === 'declined') return 'declined';
  } catch {
    /* ignore */
  }
  return null;
}

export function hasConsent() {
  return getState() === 'granted';
}

export function setGranted() {
  try {
    localStorage.setItem(KEY, 'granted');
  } catch {
    /* ignore */
  }
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function setDeclined() {
  try {
    sessionStorage.setItem(KEY, 'declined');
  } catch {
    /* ignore */
  }
}
