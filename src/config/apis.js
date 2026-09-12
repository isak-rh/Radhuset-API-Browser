// The APIs the app offers: the built-in list from config/apis.json, followed by
// the user's own, stored in this browser.
//
// An API is identified by its name everywhere — in the picker, and as the key a
// bound auth profile is stored under — so names are unique across both lists. A
// custom API whose name matches a built-in one is hidden rather than shown twice;
// the editor refuses such names, so that only happens if a later release adds a
// built-in under a name a user had already taken, and then the shipped
// definition wins.

import { Emitter } from '../lib/emitter.js';
import { t } from '../i18n/index.js';
import * as store from '../lib/store.js';

export const API_TYPES = [
  ['stac', 'STAC (spec-compliant)'],
  ['ngp', 'NGP (Nationella geodataplattformen)'],
];

export const AUTH_REQUIREMENTS = [
  ['none', 'None'],
  ['download', 'Download only'],
  ['all', 'Browsing and download'],
];

export const DEFAULT_SCHEMA_QUERY_DEPTH = 10;
const STORAGE_KEY = 'customApis';

/** Build an API from one apis.json-format object. Throws on a missing name or URL. */
export function parseApi(entry, { custom = false } = {}) {
  if (!entry || typeof entry !== 'object') throw new TypeError(t('config.entryMustBeObject'));
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  const url = typeof entry.url === 'string' ? entry.url.trim().replace(/\/+$/, '') : '';
  if (!name || !url) throw new TypeError(t('config.entryNeedsNameUrl'));
  const apiType = API_TYPES.some(([v]) => v === entry.api_type) ? entry.api_type : 'stac';
  let authRequired = AUTH_REQUIREMENTS.some(([v]) => v === entry.auth_required) ? entry.auth_required : 'none';
  // Every NGP endpoint authenticates for browsing as well as download.
  if (apiType === 'ngp') authRequired = 'all';
  const depth = Number.isInteger(entry.schema_query_depth) && entry.schema_query_depth > 0
    ? entry.schema_query_depth
    : DEFAULT_SCHEMA_QUERY_DEPTH;
  return {
    name,
    url,
    apiType,
    authRequired,
    schemaUrl: typeof entry.schema_url === 'string' && entry.schema_url.trim() ? entry.schema_url.trim() : null,
    schemaQueryDepth: depth,
    isCustom: custom,
  };
}

/** An API in apis.json format; optional fields are omitted at their defaults. */
export function serializeApi(api) {
  const entry = { name: api.name, url: api.url, api_type: api.apiType, auth_required: api.authRequired };
  if (api.schemaUrl) entry.schema_url = api.schemaUrl;
  if (api.schemaQueryDepth !== DEFAULT_SCHEMA_QUERY_DEPTH) entry.schema_query_depth = api.schemaQueryDepth;
  return entry;
}

export const isNgp = (api) => api?.apiType === 'ngp';
export const hasQueryBuilder = (api) => isNgp(api) && Boolean(api.schemaUrl);
export const needsAuthForBrowse = (api) => api?.authRequired === 'all';
export const needsAuthForDownload = (api) => api?.authRequired === 'all' || api?.authRequired === 'download';

export class ApiRegistry extends Emitter {
  #builtIn = [];
  #custom = [];

  constructor() {
    super();
    this.#custom = this.#readCustom(store.load(STORAGE_KEY, []));
    store.watch(STORAGE_KEY, (value) => {
      this.#custom = this.#readCustom(value || []);
      this.emit('change');
    });
  }

  async loadBuiltIn(url = 'config/apis.json') {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(t('config.couldNotLoad', { url, status: response.status }));
    const data = await response.json();
    this.#builtIn = data.map((entry) => parseApi(entry, { custom: false }));
    this.emit('change');
  }

  /** Malformed entries are skipped: the list is user-owned and may have been imported. */
  #readCustom(list) {
    if (!Array.isArray(list)) return [];
    const apis = [];
    for (const entry of list) {
      try {
        const api = parseApi(entry, { custom: true });
        if (!apis.some((a) => a.name === api.name)) apis.push(api);
      } catch {
        /* skip */
      }
    }
    return apis;
  }

  #writeCustom(detail = {}) {
    if (!store.save(STORAGE_KEY, this.#custom.map(serializeApi))) {
      throw new Error(t('config.couldNotSaveStorage'));
    }
    this.emit('change', detail);
  }

  get builtIn() {
    return [...this.#builtIn];
  }

  get custom() {
    const taken = new Set(this.#builtIn.map((a) => a.name));
    return this.#custom.filter((a) => !taken.has(a.name));
  }

  get all() {
    return [...this.builtIn, ...this.custom];
  }

  get(name) {
    return this.all.find((a) => a.name === name) || null;
  }

  /** True when *name* is taken by an API other than *except* (case-insensitive). */
  nameTaken(name, except = null) {
    const wanted = name.trim().toLocaleLowerCase();
    return this.all.some((a) => a.name !== except && a.name.toLocaleLowerCase() === wanted);
  }

  addCustom(api) {
    this.#custom.push({ ...api, isCustom: true });
    this.#writeCustom();
  }

  updateCustom(originalName, api) {
    const index = this.#custom.findIndex((a) => a.name === originalName);
    if (index < 0) throw new Error(t('config.noCustomApiNamed', { name: originalName }));
    this.#custom[index] = { ...api, isCustom: true };
    // Anything holding the old name — the current selection — has to follow.
    this.#writeCustom(api.name !== originalName ? { renamed: { from: originalName, to: api.name } } : {});
  }

  deleteCustom(name) {
    this.#custom = this.#custom.filter((a) => a.name !== name);
    this.#writeCustom();
  }

  /**
   * Merge imported APIs: a same-named custom API is replaced, a name taken by a
   * built-in is skipped. Returns the number added or replaced.
   */
  importCustom(entries) {
    const builtInNames = new Set(this.#builtIn.map((a) => a.name));
    let count = 0;
    for (const api of this.#readCustom(entries)) {
      if (builtInNames.has(api.name)) continue;
      const index = this.#custom.findIndex((a) => a.name === api.name);
      if (index >= 0) this.#custom[index] = api;
      else this.#custom.push(api);
      count++;
    }
    if (count) this.#writeCustom();
    return count;
  }

  exportCustom() {
    return this.custom.map(serializeApi);
  }
}
