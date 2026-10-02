// A small STAC API client: search with pagination, collections, schemas and
// queryables, and asset downloads — all with the bound auth profile applied.
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
import { ensureOk, request } from '../lib/http.js';
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
   * A JSON schema for the Query Builder: an NGP API's domain schema, or a STAC
   * extension schema that a queryable points to.
   *
   * A schema URL is an arbitrary absolute URL and may live on a different
   * host than the API itself — Lantmäteriet serves its NGP schemas from
   * namespace.lantmateriet.se, not api.lantmateriet.se, and STAC extension
   * schemas live on third-party hosts. Both are openly served regardless of
   * the API's own auth requirement, so this never sends credentials.
   */
  fetchSchema(url, { signal } = {}) {
    return this.#unauthedJson(url, { signal, headers: { Accept: 'application/schema+json, application/json' } });
  }

  /** The API root: `conformsTo` and the `links` that locate its endpoints. */
  getLandingPage({ signal } = {}) {
    return this.#json(`${this.api.url}/`, { signal, headers: { Accept: 'application/json' } }, needsAuthForBrowse(this.api));
  }

  /**
   * The conformance classes the API advertises. Read from the landing page's
   * `conformsTo` when present (STAC API); OGC API - Features servers may publish
   * them only at /conformance.
   */
  async getConformance(landing = null, { signal } = {}) {
    landing ??= await this.getLandingPage({ signal });
    if (Array.isArray(landing.conformsTo)) return landing.conformsTo;
    const data = await this.#json(`${this.api.url}/conformance`, { signal, headers: { Accept: 'application/json' } }, needsAuthForBrowse(this.api));
    return Array.isArray(data.conformsTo) ? data.conformsTo : [];
  }

  /**
   * A queryables JSON Schema — one collection's, or with *collectionId* null the
   * API-wide one. The API-wide URL comes from the landing page's queryables link
   * when there is one, falling back to the conventional /queryables.
   */
  getQueryables(collectionId, { landing = null, signal } = {}) {
    let url = `${this.api.url}/queryables`;
    if (collectionId != null) {
      url = `${this.api.url}/collections/${encodeURIComponent(collectionId)}/queryables`;
    } else {
      const link = (landing?.links || []).find((l) => l?.rel === 'queryables' || l?.rel === 'http://www.opengis.net/def/rel/ogc/1.0/queryables');
      if (link?.href) url = new URL(link.href, `${this.api.url}/`).toString();
    }
    return this.#json(url, { signal, headers: { Accept: 'application/schema+json, application/json' } }, needsAuthForBrowse(this.api));
  }

  /**
   * *query* is an AttributeQuery. It serialises itself in the dialect it was
   * built for — the Query extension's `query` or the Filter extension's
   * CQL2-JSON `filter` — so this does not need to know which.
   */
  searchBody({ area = null, datetime = null, collections = [], query = null } = {}) {
    const body = { limit: PAGE_SIZE };
    if (area) Object.assign(body, areaToRequest(area));
    if (datetime) body.datetime = datetime;
    if (collections.length) body.collections = collections;
    if (query) Object.assign(body, query.body());
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
