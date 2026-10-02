// STAC/OGC queryables → Query Builder fields, and the discovery of what an API
// lets the builder do.
//
// A STAC API that supports the Filter extension (and many that support only the
// Query extension) publishes the properties it can filter on as a JSON Schema at
// /queryables — globally, and per collection at /collections/{id}/queryables.
// Unlike the NGP domain schemas that schema-scanner.js walks, this is a flat
// `properties` object: one entry per queryable, keyed by the name the filter uses.

import { isNgp } from '../config/apis.js';
import { HttpError } from '../lib/http.js';
import { NGP_DIALECT, dialectFromConformance, dialectOperators } from './attribute-query.js';
import { FieldType, scan } from './schema-scanner.js';

// Queryables every STAC API lists that the Query Builder should not offer:
// `geometry` is the search area's job, and is a GeoJSON object besides.
const SKIP = new Set(['geometry']);

// Beyond this many checked collections, the API-wide queryables are used rather
// than one request per collection.
export const MAX_COLLECTION_QUERYABLES = 20;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * What the Query Builder needs to open: { dialect, title, fields }.
 *
 * NGP: the configured schema URL, walked by the schema scanner; always the Query
 * extension. STAC: the API's conformance classes decide the dialect, and its
 * queryables supply the fields — the checked collections' own when there are
 * any, since that is where APIs such as Earth Search keep them, falling back to
 * the API-wide document. `dialect` is null for a STAC API that advertises
 * neither the Filter nor the Query extension: there is nothing to build a query
 * for.
 */
export async function discoverQueryFields(client, collections = [], { signal } = {}) {
  const { api } = client;
  if (isNgp(api)) {
    const result = scan(await client.fetchSchema(api.schemaUrl, { signal }), api.schemaQueryDepth);
    return { dialect: NGP_DIALECT, ...result };
  }

  const landing = await client.getLandingPage({ signal });
  const dialect = dialectFromConformance(await client.getConformance(landing, { signal }));
  if (!dialect) return { dialect: null, title: api.name, fields: [] };

  const schemas = [];
  if (collections.length > 0 && collections.length <= MAX_COLLECTION_QUERYABLES) {
    for (const id of collections) {
      try {
        schemas.push(await client.getQueryables(id, { signal }));
      } catch (error) {
        // No per-collection queryables; the global ones may do.
        if (!(error instanceof HttpError)) throw error;
      }
    }
  }
  let merged = mergeQueryables(schemas);
  if (!Object.keys(merged.properties).length) {
    try {
      merged = await client.getQueryables(null, { landing, signal });
    } catch (error) {
      // The Query extension predates queryables; an API with only that may
      // simply not have the endpoint.
      if (!(error instanceof HttpError) || error.status !== 404) throw error;
      merged = {};
    }
  }
  merged = await resolveExternalRefs(merged, (url) => client.fetchSchema(url, { signal }));
  // Queryables titles are boilerplate ("STAC Queryables."); the API's name says
  // which builder this is.
  return { dialect, title: api.name, fields: parseQueryables(merged, dialect) };
}

/** Union several queryables documents' `properties`, first seen wins. */
export function mergeQueryables(schemas) {
  const properties = {};
  for (const schema of schemas) {
    for (const [key, node] of Object.entries(schema?.properties || {})) {
      if (!(key in properties)) properties[key] = node;
    }
  }
  const title = schemas.find((s) => s?.title)?.title || '';
  return { title, properties };
}

/**
 * Inline properties that are only an external $ref.
 *
 * STAC extensions are commonly declared by reference — Earth Search's
 * eo:cloud_cover is nothing but a pointer into the EO extension's schema — and
 * without following it the type is unknown. *fetch(url)* GETs a document; each
 * is fetched once. It must not send credentials: the referenced schemas live on
 * third-party hosts.
 *
 * A reference that cannot be fetched or resolved is left as it is, and
 * parseQueryables then treats the property as a string. Keys set beside the
 * $ref (a local title, say) win over the referenced ones.
 */
export async function resolveExternalRefs(schema, fetch) {
  const documents = new Map();
  const properties = {};
  for (const [key, node] of Object.entries(schema?.properties || {})) {
    properties[key] = node;
    if (SKIP.has(key) || !isObject(node) || 'type' in node || 'enum' in node) continue;
    const ref = String(node.$ref || '');
    const hash = ref.indexOf('#');
    const url = hash < 0 ? ref : ref.slice(0, hash);
    const pointer = hash < 0 ? '' : ref.slice(hash + 1);
    if (!/^https?:\/\//.test(url)) continue;
    if (!documents.has(url)) {
      // Stored as a promise so concurrent references share one request.
      documents.set(url, fetch(url).catch((error) => {
        if (error?.name === 'AbortError') throw error;
        return null;
      }));
    }
    const target = followPointer(await documents.get(url), pointer);
    if (isObject(target)) {
      const { $ref, ...local } = node;
      properties[key] = { ...target, ...local };
    }
  }
  return { ...schema, properties };
}

function followPointer(document, pointer) {
  let node = document;
  for (const part of pointer.split('/').filter(Boolean)) {
    if (!isObject(node)) return null;
    node = node[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return node;
}

/**
 * The fields of a queryables document, in key order.
 *
 * A property whose type cannot be filtered with a single value (object, array,
 * geometry) is left out. One with no type at all — typically an external $ref
 * such as id's pointer into the STAC item schema — is treated as a string, which
 * is what every such property in practice is.
 */
export function parseQueryables(schema, dialect) {
  const fields = [];
  const entries = Object.entries(schema?.properties || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [key, node] of entries) {
    if (SKIP.has(key) || !isObject(node)) continue;
    const fieldType = classify(node);
    if (fieldType === null) continue;
    const values = fieldType === FieldType.ENUM ? node.enum : null;
    fields.push({
      key,
      fieldType,
      operators: dialectOperators(dialect, fieldType),
      path: [key],
      values: values ? [...values] : null,
      discriminator: false,
      title: node.title || null,
      description: node.description || null,
      minimum: number(node.minimum),
      maximum: number(node.maximum),
    });
  }
  return fields;
}

function classify(node) {
  const ref = String(node.$ref || '');
  if (ref.toLowerCase().includes('geojson') || String(node.format || '').startsWith('geometry')) return null;
  if (Array.isArray(node.enum) && node.enum.length) return FieldType.ENUM;

  let type = node.type;
  if (Array.isArray(type)) {
    // JSON Schema 2020-12 allows ["string", "null"]; the null is noise here.
    const types = type.filter((t) => t !== 'null');
    type = types.length === 1 ? types[0] : undefined;
  }
  if (type === undefined && '$ref' in node) return FieldType.STRING;
  switch (type) {
    case 'string':
      if (node.format === 'date-time') return FieldType.DATETIME;
      if (node.format === 'date') return FieldType.DATE;
      if (node.format === 'uuid') return FieldType.UUID;
      return FieldType.STRING;
    case 'number': return FieldType.NUMBER;
    case 'integer': return FieldType.INTEGER;
    case 'boolean': return FieldType.BOOLEAN;
    default: return null;
  }
}

const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
