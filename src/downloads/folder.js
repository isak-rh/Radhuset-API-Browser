// Saving straight into a folder with the File System Access API.
//
// Only Chromium browsers implement it, and even there it can be switched off
// (Brave), refused in a cross-origin frame, or blocked by policy. So support is
// detected at runtime — first by feature, then by actually asking — and every
// failure falls back to browser downloads with an explanation.

import { t } from '../i18n/index.js';

const DB_NAME = 'rab';
const STORE = 'handles';
const FOLDER_KEY = 'downloadFolder';

export function folderAccessSupport() {
  if (typeof window.showDirectoryPicker !== 'function') {
    return { supported: false, reason: t('download.folderApiUnsupported') };
  }
  if (!window.isSecureContext) {
    return { supported: false, reason: t('download.folderNeedsHttps') };
  }
  let framed = false;
  try {
    framed = window.self !== window.top;
  } catch {
    framed = true;
  }
  if (framed) {
    return { supported: false, reason: t('download.folderFramed') };
  }
  return { supported: true, reason: '' };
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idb(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** The folder picked last time, if the browser kept it. */
export async function recallFolder() {
  try {
    return (await idb('readonly', (s) => s.get(FOLDER_KEY))) || null;
  } catch {
    return null;
  }
}

export async function rememberFolder(handle) {
  try {
    await idb('readwrite', (s) => s.put(handle, FOLDER_KEY));
  } catch {
    /* not remembering is fine */
  }
}

export function pickFolder(startIn = null) {
  return window.showDirectoryPicker({ id: 'rab-downloads', mode: 'readwrite', startIn: startIn || 'downloads' });
}

/** True once write access to *handle* is granted, asking if necessary. */
export async function ensureWritable(handle) {
  const options = { mode: 'readwrite' };
  if ((await handle.queryPermission?.(options)) === 'granted') return true;
  return (await handle.requestPermission?.(options)) === 'granted';
}
