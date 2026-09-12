// Localisation: language detection, persistence, and the t()/tn() lookup used
// throughout the UI.
//
// The app has no reactive re-render system — panels build their DOM once — so a
// language change takes effect on reload (see app.js's language menu). What
// matters here is that the locale is settled *before* anything is built: main.js
// calls initLocale() first thing, and everything else just calls t()/tn().

import * as store from '../lib/store.js';
import { en } from './en.js';
import { sv } from './sv.js';

const DICTS = { en, sv };
export const LANGUAGES = ['en', 'sv'];
const LOCALE_TAG = { en: 'en-US', sv: 'sv-SE' };

let current = null;

function systemLocale() {
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language || 'en'];
  for (const lang of langs) {
    const base = String(lang).slice(0, 2).toLowerCase();
    if (LANGUAGES.includes(base)) return base;
  }
  return 'en';
}

/** Must run once, before any UI is built. Returns the resolved locale. */
export function initLocale() {
  const pref = store.load('language', 'system');
  current = LANGUAGES.includes(pref) ? pref : systemLocale();
  document.documentElement.lang = current;
  return current;
}

export function getLocale() {
  return current || initLocale();
}

/** The BCP-47 tag for Intl formatters (Intl.NumberFormat, toLocaleDateString…). */
export function localeTag() {
  return LOCALE_TAG[getLocale()] || LOCALE_TAG.en;
}

/** 'system', or a language explicitly chosen in settings. */
export function getLanguagePref() {
  const pref = store.load('language', 'system');
  return LANGUAGES.includes(pref) ? pref : 'system';
}

export function setLanguagePref(pref) {
  store.save('language', LANGUAGES.includes(pref) ? pref : 'system');
}

function lookup(dict, key) {
  let node = dict;
  for (const part of key.split('.')) {
    if (node == null) return undefined;
    node = node[part];
  }
  return node;
}

function interpolate(str, params) {
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (match, name) => (params[name] != null ? String(params[name]) : match));
}

/** A translated string. Missing keys fall back to English, then to the key itself. */
export function t(key, params) {
  const node = lookup(DICTS[getLocale()], key) ?? lookup(en, key);
  if (node == null) return key;
  if (typeof node === 'string') return interpolate(node, params);
  if (typeof node === 'object' && typeof node.other === 'string') return interpolate(node.other, params);
  return key;
}

const pluralRules = new Map();
function rulesFor(locale) {
  if (!pluralRules.has(locale)) pluralRules.set(locale, new Intl.PluralRules(locale));
  return pluralRules.get(locale);
}

/**
 * A pluralised string. Dictionary entries are { one: '…', other: '…' } (both
 * with a {n} placeholder); *params* adds further placeholders.
 */
export function tn(key, n, params) {
  const locale = getLocale();
  const node = lookup(DICTS[locale], key) ?? lookup(en, key);
  const all = { n, ...params };
  if (node == null) return String(n);
  if (typeof node === 'string') return interpolate(node, all);
  const form = rulesFor(locale).select(n);
  const str = node[form] ?? node.other ?? node.one;
  return interpolate(str, all);
}
