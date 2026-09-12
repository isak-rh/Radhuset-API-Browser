// localStorage wrapper. Every read and write is guarded: storage can be
// unavailable (blocked site data, some private modes) or full, and the app has to
// keep working — it just cannot remember anything.

const PREFIX = 'rab.';

export function load(key, fallback = null) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Returns false when the value could not be stored. */
export function save(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function remove(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* nothing to do */
  }
}

/** Call *handler(newValue)* when another tab changes *key*. */
export function watch(key, handler) {
  const listener = (event) => {
    if (event.storageArea !== localStorage || event.key !== PREFIX + key) return;
    let value = null;
    try {
      value = event.newValue == null ? null : JSON.parse(event.newValue);
    } catch {
      value = null;
    }
    handler(value);
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
}
