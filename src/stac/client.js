// A small STAC API client: search with pagination, collections, schemas, and
// asset downloads — all with the bound auth profile applied.
//
// Coordinates are WGS84 end to end. The two API types differ only in how they
// are told so:
//
//   STAC  bbox / intersects are WGS84 by the spec; nothing extra is sent.
//   NGP   Lantmäteriet's NGP APIs are a STAC 0.9 / OGC API Features offshoot that
//         defaults to SWEREF 99 TM for both the query geometry and the response.
//         Advertising OGC CRS84 (lon/lat) in `bbox-crs` and `crs` makes them
//         accept and return WGS84 instead — for `intersects` as well as `bbox`.
//         EPSG:4326 must not be used here: OGC API Features gives it lat/lon
//         axis order, so the same numbers would mean a different place.

import { isNgp, needsAuthForBrowse, needsAuthForDownload } from '../config/apis.js';
import { areaToRequest } from '../geo/area.js';
import { NetworkError, ensureOk, request } from '../lib/http.js';
import { parseCollection, parseItem, siteDomain } from './models.js';

export const CRS84 = 'http://www.opengis.net/def/crs/OGC/1.3/CRS84';
export const PAGE_SIZE = 100;
const JSON_ACCEPT = 'application/geo+json, application/json';

/**
 * *url* with *params* set, replacing same-named params already on it. NGP echoes
 * the CRS params back in its `next` link, so appending would grow the query
 * string by one copy per page until the server rejects it.
 */
export function withParams(url, params) {
  const u = new URL(url);
  for (const [key, value] of Object.entries(params)) u.searchParams.set(key, value);
  return u.toString();
}

/** Where the next page is, given a response and the request that produced it. */
function nextCursor(data, current) {
  const link = Array.isArray(data.links) ? data.links.find((l) => l?.rel === 'next' && l.href) : null;
  if (!link) return null;
  const method = String(link.method || 'GET').toUpperCase();
  if (method === 'GET') return { url: link.href, method: 'GET', body: null };
  let body = current.body;
  if (link.body && typeof link.body === 'object') body = link.merge ? { ...current.body, ...link.body } : link.body;
  return { url: link.href, method: 'POST', body };
}

export class StacClient {
  constructor(api, auth) {
    this.api = api;
    this.auth = auth;
  }

  #crsParams() {
    return isNgp(this.api) ? { 'bbox-crs': CRS84, crs: CRS84 } : {};
  }

  /** Credentials if any are bound. Errors only matter when they are *required*. */
  async #credentials(required) {
    try {
      return await this.auth.credentialsFor(this.api.name);
    } catch (error) {
      if (required) throw error;
      return null;
    }
  }

  /**
   * Send one request with auth applied; on a 401 with an OAuth2 token, refresh
   * the token and retry once. Wraps a single request, not an operation: a 401 on
   * page 7 of a search retries page 7. Only 401 is retried — a 403 is usually a
   * scope problem, and retrying would mint a token per request for nothing.
   *
   * Credentials only ever go to the API's own domain (dl1.lantmateriet.se is
   * fine for api.lantmateriet.se): hrefs come from server responses, and a
   * token must not follow one to an unrelated host.
   */
  async #authed(url, init, required) {
    const credentials = siteDomain(url) === siteDomain(this.api.url) ? await this.#credentials(required) : null;
    const send = (c) => request(url, {
      ...init,
      headers: { ...(init.headers || {}), ...(c ? { Authorization: c.authorization } : {}) },
    });
    let response = await send(credentials);
    if (response.status === 401 && credentials?.type === 'oauth2') {
      const fresh = await this.auth.refresh(this.api.name, credentials.token);
      if (fresh) {
        await response.body?.cancel();
        response = await send(fresh);
      }
    }
    return response;
  }

  async #json(url, init, required) {
    const response = await ensureOk(await this.#authed(url, init, required));
    return response.json();
  }

  /** A GET with no Authorization header, full stop — not "skip if unavailable". */
  async #unauthedJson(url, init) {
    const response = await ensureOk(await request(url, init));
    return response.json();
  }

  async getCollections({ signal } = {}) {
    const collections = [];
    const seen = new Set();
    let url = `${this.api.url}/collections`;
    while (url && !seen.has(url)) {
      seen.add(url);
      const data = await this.#json(url, { signal, headers: { Accept: 'application/json' } }, needsAuthForBrowse(this.api));
      for (const entry of data.collections || []) {
        const collection = parseCollection(entry);
        if (collection) collections.push(collection);
      }
      const next = (data.links || []).find((l) => l?.rel === 'next' && String(l.method || 'GET').toUpperCase() === 'GET');
      url = next?.href || null;
    }
    return collections.sort((a, b) => (a.title || a.id).localeCompare(b.title || b.id, 'sv'));
  }

  /**
   * A JSON schema for the Query Builder.
   *
   * A schema URL is an arbitrary absolute URL and may live on a different
   * host than the API itself — Lantmäteriet serves its NGP schemas from
   * namespace.lantmateriet.se, not api.lantmateriet.se. When the API needs
   * auth to browse, the first attempt sends it, so a schema genuinely behind
   * the same auth on a CORS-friendly host still works. But a browser blocks
   * the request at the CORS preflight when the schema's host does not allow
   * the Authorization header, and that surfaces only as a generic network
   * failure — indistinguishable from a real outage from here — so on that
   * failure the fetch is retried once without credentials, which is what an
   * openly-served schema (the common case) needs.
   */
  async fetchSchema(url, { signal } = {}) {
    const init = { signal, headers: { Accept: 'application/schema+json, application/json' } };
    if (!needsAuthForBrowse(this.api)) return this.#unauthedJson(url, init);
    try {
      return await this.#json(url, init, true);
    } catch (error) {
      // #json(url, init, false) would not do here: with credentials on hand it
      // would still attach them (a required:false request means "don't fail if
      // there are none", not "send none") and repeat the exact CORS failure.
      if (!(error instanceof NetworkError)) throw error;
      return this.#unauthedJson(url, init);
    }
  }

  searchBody({ area = null, datetime = null, collections = [], query = null } = {}) {
    const body = { limit: PAGE_SIZE };
    if (area) Object.assign(body, areaToRequest(area));
    if (datetime) body.datetime = datetime;
    if (collections.length) body.collections = collections;
    if (query && Object.keys(query).length) body.query = query;
    return body;
  }

  /**
   * Search page by page until *maxItems* are collected or the pages run out.
   * Resolves to { items, cursor }; a non-null cursor continues the search.
   * *onPage(items, cursor)* is called as each page arrives.
   */
  search(params, options = {}) {
    const cursor = { url: `${this.api.url}/search`, method: 'POST', body: this.searchBody(params) };
    return this.continueSearch(cursor, options);
  }

  async continueSearch(cursor, { signal, maxItems = Infinity, onPage } = {}) {
    const required = needsAuthForBrowse(this.api);
    const linkDomain = isNgp(this.api) ? siteDomain(this.api.url) : null;
    const items = [];
    const visited = new Set();
    let next = cursor;
    while (next && items.length < maxItems) {
      signal?.throwIfAborted();
      const url = withParams(next.url, this.#crsParams());
      // A server that links a page to itself would otherwise loop forever.
      const fingerprint = `${next.method} ${url} ${JSON.stringify(next.body)}`;
      if (visited.has(fingerprint)) break;
      visited.add(fingerprint);

      const init = next.method === 'GET'
        ? { method: 'GET', signal, headers: { Accept: JSON_ACCEPT } }
        : {
            method: 'POST',
            signal,
            headers: { 'Content-Type': 'application/json', Accept: JSON_ACCEPT },
            body: JSON.stringify(next.body),
          };
      const data = await this.#json(url, init, required);
      const page = (Array.isArray(data.features) ? data.features : []).map((f) => parseItem(f, { linkDomain })).filter(Boolean);
      items.push(...page);
      next = nextCursor(data, next);
      // The cursor travels with each page, so a search stopped between pages
      // can still be continued from the last one that arrived.
      onPage?.(page, next);
    }
    return { items, cursor: next };
  }

  /** The Response for an asset, after authentication and at most one 401 retry. */
  async openAsset(asset, { signal } = {}) {
    return ensureOk(await this.#authed(asset.href, { signal }, needsAuthForDownload(this.api)));
  }
}
