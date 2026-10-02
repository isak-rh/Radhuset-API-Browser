// A minimal in-browser test runner for the pure modules. Network access is
// stubbed: `fetch` is replaced per test with a router that answers from fixtures.

import { DecryptionError, decryptWithPassword, encryptWithPassword, fromBase64Url, toBase64Url } from '../src/lib/crypto.js';
import * as consent from '../src/lib/consent.js';
import { Vault, WrongPasswordError } from '../src/auth/vault.js';

// These tests exercise storage persistence directly; run them as a consented session.
consent.setGranted();
import { BindingStore, ProfileStore, newProfile } from '../src/auth/profiles.js';
import { AuthSession } from '../src/auth/session.js';
import { StacClient, withParams, CRS84 } from '../src/stac/client.js';
import { parseItem } from '../src/stac/models.js';
import { FieldType, scan } from '../src/stac/schema-scanner.js';
import { AttributeQuery, CQL2_JSON, NGP_DIALECT, QUERY_EXTENSION, condition, cql2Text, dialectFromConformance, dialectOperators, queryDialect } from '../src/stac/attribute-query.js';
import { discoverQueryFields, mergeQueryables, parseQueryables, resolveExternalRefs } from '../src/stac/queryables.js';
import { filenameFromDisposition, filenameFromUrl, sanitizeFilename, uniqueName, withExtension } from '../src/downloads/filenames.js';
import { planDownload, entriesFor } from '../src/downloads/runner.js';
import { parseWkb } from '../src/geo/wkb.js';
import { parseShp } from '../src/geo/shapefile.js';
import { areaToRequest, bboxArea, vertexCount } from '../src/geo/area.js';
import { epsgFromName, epsgFromWkt, toWgs84 } from '../src/geo/crs.js';
import { LoadError, loadSearchGeometry } from '../src/geo/loaders.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message);
}
function equal(actual, expected, message = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  expected ${e}\n  actual   ${a}`);
}
function near(actual, expected, tolerance, message = '') {
  if (Math.abs(actual - expected) > tolerance) throw new Error(`${message} expected ≈${expected}, got ${actual}`);
}
async function rejects(promise, type, message = '') {
  try {
    await promise;
  } catch (error) {
    if (type && !(error instanceof type)) throw new Error(`${message} threw ${error?.name}: ${error?.message}`);
    return error;
  }
  throw new Error(`${message} did not throw`);
}

/** Replace fetch with *handler(url, init) -> Response*; returns a call log. */
function stubFetch(handler) {
  const calls = [];
  const original = window.fetch;
  window.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  calls.restore = () => { window.fetch = original; };
  return calls;
}
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function authFixture() {
  const vault = new Vault({ storageKey: `test.vault.${Math.random()}` });
  const profiles = new ProfileStore(vault);
  const bindings = new BindingStore();
  const auth = new AuthSession(profiles, bindings, vault);
  return { vault, profiles, bindings, auth };
}

// ── crypto ─────────────────────────────────────────────────────────────────

test('crypto: password round trip, wrong password and wrong context fail', async () => {
  const blob = await encryptWithPassword({ secret: 'åäö' }, 'correct horse', 'ctx/a');
  equal(await decryptWithPassword(blob, 'correct horse', 'ctx/a'), { secret: 'åäö' });
  await rejects(decryptWithPassword(blob, 'wrong', 'ctx/a'), DecryptionError, 'wrong password');
  await rejects(decryptWithPassword(blob, 'correct horse', 'ctx/b'), DecryptionError, 'wrong context');
});

test('crypto: base64url round trip', () => {
  const bytes = new Uint8Array([0, 251, 255, 62, 63, 1]);
  equal([...fromBase64Url(toBase64Url(bytes))], [...bytes]);
  assert(!/[+/=]/.test(toBase64Url(bytes)));
});

// ── vault ──────────────────────────────────────────────────────────────────

test('vault: create, lock, unlock, change password; nothing stored in clear', async () => {
  const key = `test.vault.${Date.now()}`;
  const vault = new Vault({ storageKey: key });
  await vault.create('master-password', { profiles: [{ id: 'a', name: 'Secret name', clientSecret: 's3cr3t' }] });
  const stored = localStorage.getItem(`rab.${key}`);
  assert(stored && !stored.includes('s3cr3t') && !stored.includes('Secret name'), 'plaintext in storage');
  vault.lock();
  assert(!vault.unlocked);
  await rejects(vault.unlockWithPassword('nope-nope'), WrongPasswordError);
  await vault.unlockWithPassword('master-password');
  equal(vault.payload.profiles[0].clientSecret, 's3cr3t');
  await vault.changePassword('another-password');
  vault.lock();
  await rejects(vault.unlockWithPassword('master-password'), WrongPasswordError, 'old password still works');
  const reopened = new Vault({ storageKey: key });
  await reopened.unlockWithPassword('another-password');
  equal(reopened.payload.profiles[0].name, 'Secret name');
  reopened.destroy();
  assert(localStorage.getItem(`rab.${key}`) === null);
});

test('profiles: saved profiles need the vault; session ones do not', async () => {
  const { vault, profiles } = authFixture();
  await profiles.upsert({ ...newProfile({ name: 'Session' }), clientId: 'x' });
  await rejects(profiles.upsert({ ...newProfile({ name: 'Saved', persist: true }) }), Error, 'saved without vault');
  await vault.create('password-123', { profiles: [] });
  const saved = await profiles.upsert({ ...newProfile({ name: 'Saved', persist: true }), clientId: 'y' });
  vault.lock();
  equal(profiles.all().map((p) => p.name), ['Session'], 'locked vault hides saved profiles');
  await vault.unlockWithPassword('password-123');
  assert(profiles.get(saved.id), 'saved profile back after unlock');
  vault.destroy();
});

// ── auth session ───────────────────────────────────────────────────────────

test('auth: one token per credential set, shared by APIs; basic header', async () => {
  const { profiles, bindings, auth } = authFixture();
  const calls = stubFetch(() => json({ access_token: `tok${calls.length}`, token_type: 'bearer', expires_in: 3600 }));
  try {
    const p = await profiles.upsert({ ...newProfile({ name: 'A' }), clientId: 'id', clientSecret: 'secret', tokenUrl: 'https://auth.test/token' });
    bindings.set('API 1', p.id);
    bindings.set('API 2', p.id);
    const one = await auth.credentialsFor('API 1');
    const two = await auth.credentialsFor('API 2');
    equal(calls.length, 1, 'token requests');
    equal(one.authorization, 'Bearer tok1');
    equal(two.authorization, one.authorization);
    const body = new URLSearchParams(calls[0].init.body);
    equal([body.get('grant_type'), body.get('client_id'), body.get('client_secret')], ['client_credentials', 'id', 'secret']);

    await profiles.upsert({ ...p, clientSecret: 'changed' });
    await auth.credentialsFor('API 1');
    equal(calls.length, 2, 'an edited secret needs a new token');

    const b = await profiles.upsert({ ...newProfile({ name: 'B', type: 'basic' }), username: 'user', password: 'pässword' });
    bindings.set('API 3', b.id);
    const basic = await auth.credentialsFor('API 3');
    equal(basic.authorization, `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode('user:pässword')))}`);
    bindings.set('API 1', null);
    bindings.set('API 2', null);
    bindings.set('API 3', null);
  } finally {
    calls.restore();
  }
});

test('auth: concurrent requests share one token fetch; 401 refreshes once', async () => {
  const { profiles, bindings, auth } = authFixture();
  let issued = 0;
  const calls = stubFetch(async (url, init) => {
    if (url.endsWith('/token')) {
      issued++;
      await new Promise((r) => setTimeout(r, 20));
      return json({ access_token: `tok${issued}`, expires_in: 3600 });
    }
    // The API rejects the first token before its stated expiry.
    return init.headers.Authorization === 'Bearer tok1' ? json({ error: 'expired' }, 401) : json({ collections: [{ id: 'c1' }] });
  });
  try {
    const p = await profiles.upsert({ ...newProfile({ name: 'C' }), clientId: 'id', clientSecret: 's', tokenUrl: 'https://auth.test/token' });
    bindings.set('Test API', p.id);
    await Promise.all([auth.credentialsFor('Test API'), auth.credentialsFor('Test API'), auth.credentialsFor('Test API')]);
    equal(issued, 1, 'concurrent fetches collapse');
    const client = new StacClient({ name: 'Test API', url: 'https://api.test', apiType: 'stac', authRequired: 'all' }, auth);
    const collections = await client.getCollections();
    equal(collections.map((c) => c.id), ['c1']);
    equal(issued, 2, 'one refresh after the 401');
    bindings.set('Test API', null);
  } finally {
    calls.restore();
  }
});

// ── STAC client ────────────────────────────────────────────────────────────

test('client: withParams replaces instead of appending', () => {
  const url = withParams('https://x.test/search?crs=a&afterId=5&crs=b', { crs: 'c' });
  equal(new URL(url).searchParams.getAll('crs'), ['c']);
  equal(new URL(url).searchParams.get('afterId'), '5');
});

test('client: NGP search sends CRS84 on every page; POST and GET next links are followed', async () => {
  const feature = (id) => ({ type: 'Feature', id, bbox: [18, 59, 18.1, 59.1], geometry: null, properties: {}, assets: {} });
  const calls = stubFetch((url) => {
    const u = new URL(url);
    if (!u.searchParams.get('afterId')) {
      return json({ features: [feature('a')], links: [{ rel: 'next', method: 'POST', href: `${u.origin}${u.pathname}?afterId=1&crs=${encodeURIComponent(CRS84)}` }] });
    }
    if (u.searchParams.get('afterId') === '1') return json({ features: [feature('b')], links: [{ rel: 'next', href: `${u.origin}${u.pathname}?afterId=2` }] });
    return json({ features: [feature('c')], links: [] });
  });
  try {
    const auth = { credentialsFor: async () => null, refresh: async () => null };
    const client = new StacClient({ name: 'NGP', url: 'https://ngp.test/v1', apiType: 'ngp', authRequired: 'all' }, auth);
    const { items, cursor } = await client.search({ area: bboxArea([18, 59, 18.2, 59.2]) });
    equal(items.map((i) => i.id), ['a', 'b', 'c']);
    equal(cursor, null);
    for (const call of calls) {
      const params = new URL(call.url).searchParams;
      equal(params.getAll('crs'), [CRS84], 'crs once');
      equal(params.getAll('bbox-crs'), [CRS84], 'bbox-crs once');
    }
    equal(calls[1].init.method, 'POST', 'POST next link reuses the body');
    equal(JSON.parse(calls[1].init.body).bbox, [18, 59, 18.2, 59.2]);
    equal(calls[2].init.method, 'GET');
  } finally {
    calls.restore();
  }
});

test('client: STAC search sends no CRS params; maxItems leaves a cursor', async () => {
  const calls = stubFetch(() => json({
    features: Array.from({ length: 3 }, (_, i) => ({ type: 'Feature', id: `i${i}`, collection: 'c', bbox: [1, 2, 3, 4], properties: {}, assets: {} })),
    links: [{ rel: 'next', method: 'POST', href: 'https://stac.test/search', body: { token: 'next' } }],
  }));
  try {
    const client = new StacClient({ name: 'S', url: 'https://stac.test', apiType: 'stac', authRequired: 'download' }, { credentialsFor: async () => null });
    const { items, cursor } = await client.search({}, { maxItems: 2 });
    equal(items.length, 3);
    equal(cursor.body, { token: 'next' });
    assert(!new URL(calls[0].url).searchParams.has('crs'));
  } finally {
    calls.restore();
  }
});

test('models: items get a collection-scoped uid; thumbnails are not downloads', () => {
  const item = parseItem({
    id: 'x', collection: 'c', geometry: { type: 'Point', coordinates: [18, 59] },
    properties: { datetime: '2024-01-01T00:00:00Z' },
    assets: { data: { href: 'https://x/a.tif', 'file:size': 10 }, thumbnail: { href: 'https://x/t.jpg', roles: ['thumbnail'] } },
  });
  equal(item.uid, 'c/x');
  equal(item.bbox, [18, 59, 18, 59], 'bbox from geometry');
  equal(item.downloadable.map((a) => a.key), ['data']);
  equal(item.thumbnailUrl, 'https://x/t.jpg');
  equal(item.totalSize, 10);
  equal(parseItem({ id: 'no-extent', properties: {} }), null);
});

test('models: with a link domain, assets hosted elsewhere are links, not downloads', () => {
  const feature = {
    id: 'x', bbox: [1, 2, 3, 4], properties: {},
    assets: {
      file: { href: 'https://download.lantmateriet.se/a.zip', 'file:size': 7 },
      page: { href: 'https://example.org/lamning/1' },
    },
  };
  const ngp = parseItem(feature, { linkDomain: 'lantmateriet.se' });
  equal(ngp.downloadable.map((a) => a.key), ['file']);
  equal(ngp.links.map((a) => a.key), ['page']);
  equal(ngp.totalSize, 7);
  const stac = parseItem(feature);
  equal(stac.downloadable.map((a) => a.key), ['file', 'page']);
  equal(stac.links, []);
});

test('client: credentials are only sent to the API\'s own domain', async () => {
  const calls = stubFetch(() => new Response('ok'));
  try {
    const auth = { credentialsFor: async () => ({ type: 'basic', authorization: 'Basic abc' }) };
    const client = new StacClient({ name: 'S', url: 'https://api.lantmateriet.se/stac/v1', apiType: 'stac', authRequired: 'download' }, auth);
    await client.openAsset({ href: 'https://dl1.lantmateriet.se/a.zip' });
    await client.openAsset({ href: 'https://files.example.org/a.zip' });
    equal(calls[0].init.headers.Authorization, 'Basic abc');
    equal(calls[1].init.headers.Authorization, undefined);
  } finally {
    calls.restore();
  }
});

// ── downloads ──────────────────────────────────────────────────────────────

test('downloads: one job per distinct href', () => {
  const asset = (href) => ({ key: 'k', href, title: 't', type: '', roles: [], size: 5 });
  const items = [
    { id: '1', uid: '1', downloadable: [asset('https://a/doc.pdf'), asset('https://a/1.json')] },
    { id: '2', uid: '2', downloadable: [asset('https://a/doc.pdf'), asset('https://a/2.json')] },
  ];
  const plan = planDownload(entriesFor(items));
  equal(plan.jobs.map((j) => j.asset.href), ['https://a/doc.pdf', 'https://a/1.json', 'https://a/2.json']);
  equal(plan.duplicates, 1);
  equal(plan.knownBytes, 15);
});

test('filenames: Content-Disposition forms, URL fallback, sanitising', () => {
  equal(filenameFromDisposition('attachment; filename="Plankarta%20%C3%96stermalmstorg.pdf"'), 'Plankarta Östermalmstorg.pdf');
  equal(filenameFromDisposition("attachment; filename*=UTF-8''na%C3%AFve.txt; filename=\"fallback.txt\""), 'naïve.txt');
  equal(filenameFromDisposition('inline'), null);
  equal(filenameFromUrl('https://dl1.lantmateriet.se/fastighet/fastighetsindelning_kn1480.zip?x=1'), 'fastighetsindelning_kn1480.zip');
  equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  equal(sanitizeFilename('a<b>:c?.pdf'), 'a_b__c_.pdf');
  equal(sanitizeFilename('CON.txt'), '_CON.txt');
  equal(sanitizeFilename('ok name.tif'), 'ok name.tif');
  equal(sanitizeFilename('', 'fallback'), 'fallback');
  equal(withExtension('f1fbc980', 'application/vnd.lm.detaljplan.v4+json'), 'f1fbc980.json');
  equal(withExtension('a.pdf', 'application/json'), 'a.pdf');
  const taken = new Set();
  equal([uniqueName('a.tif', taken), uniqueName('A.tif', taken), uniqueName('a.tif', taken)], ['a.tif', 'A (2).tif', 'a (3).tif']);
});

test('filenames: undoes raw UTF-8 header bytes the Fetch API hands back as Latin-1 (real Lantmäteriet backend)', () => {
  // fetch()'s Headers object decodes header bytes as Latin-1 by spec. Some
  // Lantmäteriet backends write a filename's raw UTF-8 bytes straight into
  // Content-Disposition rather than encoding them, so what a real fetch()
  // hands the app is exactly what this line reconstructs: each UTF-8 byte of
  // the original name read back as its own Latin-1 character.
  const original = 'Information om rättsverkan och höjdsystem.pdf';
  const misreadAsLatin1 = Array.from(new TextEncoder().encode(original), (b) => String.fromCharCode(b)).join('');
  assert(misreadAsLatin1 !== original, 'the fixture must actually be mangled, or this proves nothing');
  equal(filenameFromDisposition(`attachment; filename="${misreadAsLatin1}"`), original);

  // A backend that percent-encodes correctly (the other case this app meets)
  // must not be touched by the same fix-up.
  equal(filenameFromDisposition('attachment; filename="Plankarta%20%C3%96stermalmstorg.pdf"'), 'Plankarta Östermalmstorg.pdf');
  // Plain ASCII: nothing to undo either way.
  equal(filenameFromDisposition('attachment; filename="report.pdf"'), 'report.pdf');
});

// ── schema scanner ─────────────────────────────────────────────────────────

test('schema scanner: subtypes, discriminator union, depth limit', () => {
  const schema = {
    title: 'Test',
    oneOf: [{ $ref: '#/definitions/wrapperA' }, { $ref: '#/definitions/wrapperB' }],
    definitions: {
      base: { properties: { status: { type: 'string', enum: ['gällande', 'upphävd'] }, datum: { type: 'string', format: 'date' } } },
      wrapperA: { allOf: [{ $ref: '#/definitions/base' }], properties: { 'feature:typ': { const: 'a' }, nested: { type: 'object', properties: { deep: { type: 'integer' } } } } },
      wrapperB: { allOf: [{ $ref: '#/definitions/base' }], properties: { 'feature:typ': { const: 'b' }, hidden: { type: 'string', queryable: false } } },
    },
  };
  const result = scan(schema);
  equal(result.title, 'Test');
  const typ = result.fields.find((f) => f.key === 'feature.typ');
  assert(typ?.discriminator, 'discriminator found');
  equal(typ.values, ['a', 'b']);
  equal(result.fields.find((f) => f.key === 'status').fieldType, FieldType.ENUM);
  equal(result.fields.find((f) => f.key === 'datum').operators, ['eq', 'neq', 'gt', 'gte', 'lt', 'lte']);
  assert(result.fields.some((f) => f.key === 'nested.deep'));
  assert(!result.fields.some((f) => f.key === 'hidden'), 'queryable:false excluded');
  assert(!scan(schema, 1).fields.some((f) => f.key === 'nested.deep'), 'depth limit');
});

// ── attribute queries ──────────────────────────────────────────────────────

// What Lantmäteriet's STAC APIs advertise (stac-vektor/-bild/-hojd, 2026-10).
const LM_CONFORMANCE = [
  'http://www.opengis.net/spec/cql2/1.0/conf/basic-cql2',
  'http://www.opengis.net/spec/cql2/1.0/conf/cql2-json',
  'http://www.opengis.net/spec/cql2/1.0/conf/cql2-text',
  'http://www.opengis.net/spec/ogcapi-features-3/1.0/conf/filter',
  'https://api.stacspec.org/v1.0.0-rc.2/item-search#filter',
  'https://api.stacspec.org/v1.0.0/core',
  'https://api.stacspec.org/v1.0.0/item-search',
  'https://api.stacspec.org/v1.0.0/item-search#query',
];
const CQL2_BASIC = queryDialect(CQL2_JSON);
const CQL2_ADVANCED = queryDialect(CQL2_JSON, { advancedComparison: true });
const prop = (key) => ({ property: key });

test('attribute query: dialect from conformance prefers CQL2-JSON, falls back to the Query extension', () => {
  equal(dialectFromConformance(LM_CONFORMANCE), CQL2_BASIC, 'Lantmäteriet gets basic CQL2');
  equal(dialectFromConformance([...LM_CONFORMANCE, 'http://www.opengis.net/spec/cql2/1.0/conf/advanced-comparison-operators']), CQL2_ADVANCED);
  equal(dialectFromConformance(['https://api.stacspec.org/v1.0.0/item-search#query']), queryDialect(QUERY_EXTENSION), 'Earth Search');
  equal(dialectFromConformance([
    'https://api.stacspec.org/v1.0.0-rc.2/item-search#filter',
    'http://www.opengis.net/spec/cql2/1.0/conf/cql2-text',
    'https://api.stacspec.org/v1.0.0/item-search#query',
  ]).language, QUERY_EXTENSION, 'filter without cql2-json');
  equal(dialectFromConformance(['https://api.stacspec.org/v1.0.0/core']), null);
});

test('attribute query: like-based operators need advanced comparison; free-text "in" is CQL2 only', () => {
  assert(!dialectOperators(CQL2_BASIC, FieldType.STRING).includes('contains'));
  assert(dialectOperators(CQL2_ADVANCED, FieldType.STRING).includes('contains'));
  assert(dialectOperators(CQL2_BASIC, FieldType.STRING).includes('in'));
  assert(!dialectOperators(NGP_DIALECT, FieldType.STRING).includes('in'));
});

test('attribute query: NGP body is the Query extension, with day-boundary dates', () => {
  const q = new AttributeQuery([
    condition('feature.typ', 'in', ['a', 'b'], FieldType.ENUM),
    condition('detaljplan.datum', 'gte', '2020-01-01', FieldType.DATE),
    condition('detaljplan.datum', 'lte', '2020-12-31', FieldType.DATE),
    condition('detaljplan.datum', 'eq', '2020-06-01', FieldType.DATE),
  ], NGP_DIALECT);
  equal(q.body(), {
    query: {
      'feature.typ': { in: ['a', 'b'] },
      'detaljplan.datum': { gte: '2020-01-01T00:00:00Z', lte: '2020-12-31T23:59:59Z', eq: '2020-06-01' },
    },
  });
  assert(!new AttributeQuery([condition('a', 'eq', 1, FieldType.NUMBER)], NGP_DIALECT, { matchAny: true }).isAny, 'match any ignored');
  equal(new AttributeQuery([], NGP_DIALECT).body(), {});
});

test('attribute query: CQL2 body, AND/OR, unwrapped single condition', () => {
  equal(new AttributeQuery([condition('spektraltyp', 'eq', 'cir', FieldType.STRING)], CQL2_BASIC).body(), {
    'filter-lang': 'cql2-json',
    filter: { op: '=', args: [prop('spektraltyp'), 'cir'] },
  });
  const conds = [condition('spektraltyp', 'neq', 'cir', FieldType.STRING), condition('flygar', 'gte', 2020, FieldType.NUMBER)];
  equal(new AttributeQuery(conds, CQL2_BASIC).cql2().op, 'and');
  equal(new AttributeQuery(conds, CQL2_BASIC, { matchAny: true }).cql2().op, 'or');
});

test('attribute query: ranges survive OR', () => {
  const N = FieldType.NUMBER;
  const q = new AttributeQuery([
    condition('spektraltyp', 'eq', 'cir', FieldType.STRING),
    condition('flygar', 'gt', 1950, N),
    condition('flygar', 'lt', 1975, N),
  ], CQL2_BASIC, { matchAny: true });
  equal(q.preview(), "spektraltyp = 'cir' OR (flygar > 1950 AND flygar < 1975)");

  const preview = (...conds) => new AttributeQuery(conds.map(([op, v]) => condition('f', op, v, N)), CQL2_BASIC, { matchAny: true }).preview();
  equal(preview(['lt', 1975], ['gte', 1950]), 'f < 1975 AND f >= 1950', 'upper bound first');
  equal(preview(['lt', 1950], ['gt', 1975]), 'f < 1950 OR f > 1975', 'outside query left alone');
  equal(preview(['gt', 1950], ['lt', 1975], ['gt', 2000], ['lt', 2010]), '(f > 1950 AND f < 1975) OR (f > 2000 AND f < 2010)', 'two ranges');
  equal(preview(['gte', 1975], ['lte', 1975]), 'f >= 1975 AND f <= 1975', 'inclusive equal bounds');
  equal(preview(['gt', 1975], ['lt', 1975]), 'f > 1975 OR f < 1975', 'exclusive equal bounds');

  const D = FieldType.DATETIME;
  const dates = new AttributeQuery([
    condition('datetime', 'gte', '2020-01-01T00:00:00Z', D),
    condition('datetime', 'lt', '2021-01-01T00:00:00Z', D),
    condition('flygar', 'gt', 2022, N),
  ], CQL2_BASIC, { matchAny: true }).cql2();
  equal([dates.op, dates.args[0].op], ['or', 'and'], 'date range paired');
});

test('attribute query: CQL2 in, temporal literals, like escaping, preview text', () => {
  const c = condition('spektraltyp', 'in', ['rgb', 'rgbi'], FieldType.STRING);
  equal(new AttributeQuery([c], CQL2_BASIC).cql2(), {
    op: 'or',
    args: [{ op: '=', args: [prop('spektraltyp'), 'rgb'] }, { op: '=', args: [prop('spektraltyp'), 'rgbi'] }],
  });
  equal(new AttributeQuery([c], CQL2_ADVANCED).cql2(), { op: 'in', args: [prop('spektraltyp'), ['rgb', 'rgbi']] });

  const args = new AttributeQuery([
    condition('datetime', 'gte', '2022-01-01T00:00:00Z', FieldType.DATETIME),
    condition('d', 'lt', '2022-01-01', FieldType.DATE),
  ], CQL2_BASIC).cql2().args;
  equal(args[0].args[1], { timestamp: '2022-01-01T00:00:00Z' });
  equal(args[1].args[1], { date: '2022-01-01' });

  equal(new AttributeQuery([condition('n', 'startsWith', '50%_a', FieldType.STRING)], CQL2_ADVANCED).cql2(), { op: 'like', args: [prop('n'), '50\\%\\_a%'] });

  equal(new AttributeQuery([
    condition('spektraltyp', 'in', ['rgb', "it's"], FieldType.STRING),
    condition('flygar', 'gte', 2020, FieldType.NUMBER),
    condition('datetime', 'lt', '2024-01-01T00:00:00Z', FieldType.DATETIME),
  ], CQL2_BASIC).preview(), "(spektraltyp = 'rgb' OR spektraltyp = 'it''s') AND flygar >= 2020 AND datetime < TIMESTAMP('2024-01-01T00:00:00Z')");
  equal(cql2Text({ op: '=', args: [prop('b'), true] }), 'b = TRUE');
});

// stac-bild's /queryables, trimmed.
const BILD_QUERYABLES = {
  title: 'STAC Queryables.',
  properties: {
    id: { $ref: 'https://schemas.stacspec.org/v1.0.0/item-spec/json-schema/item.json#/x' },
    flygar: { type: 'number', title: 'flygår', maximum: 2050, minimum: 1950 },
    datetime: { type: 'string', format: 'date-time' },
    geometry: { $ref: 'https://geojson.org/schema/Feature.json' },
    spektraltyp: { type: 'string', description: 'spektraltyp [rgbi, rgb, cir, gra]' },
    tags: { type: 'array', items: { type: 'string' } },
    platform: { type: ['string', 'null'], enum: ['a', 'b'] },
  },
};

test('queryables: parsed into flat fields; geometry and arrays left out', () => {
  const fields = parseQueryables(BILD_QUERYABLES, CQL2_BASIC);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  equal(fields.map((f) => [f.key, f.fieldType]), [
    ['datetime', FieldType.DATETIME],
    ['flygar', FieldType.NUMBER],
    ['id', FieldType.STRING],
    ['platform', FieldType.ENUM],
    ['spektraltyp', FieldType.STRING],
  ]);
  const flygar = byKey.get('flygar');
  equal([flygar.minimum, flygar.maximum, flygar.title], [1950, 2050, 'flygår']);
  equal(byKey.get('platform').values, ['a', 'b']);
  equal(byKey.get('spektraltyp').operators, ['eq', 'neq', 'in']);
});

test('queryables: merge keeps the first definition', () => {
  const merged = mergeQueryables([
    { title: 'A', properties: { x: { type: 'number' } } },
    { properties: { x: { type: 'string' }, y: { type: 'string' } } },
  ]);
  equal(merged.title, 'A');
  equal(merged.properties.x, { type: 'number' });
  assert('y' in merged.properties);
});

test('queryables: external $refs resolved; failures and geometry left alone', async () => {
  const eo = 'https://stac-extensions.github.io/eo/v1.0.0/schema.json';
  const doc = { definitions: { fields: { properties: { 'eo:cloud_cover': { title: 'Cloud Cover', type: 'number', minimum: 0, maximum: 100 } } } } };
  const fetched = [];
  const fetch = async (url) => {
    fetched.push(url);
    if (url !== eo) throw new Error('offline');
    return doc;
  };
  const schema = {
    properties: {
      'eo:cloud_cover': { $ref: `${eo}#/definitions/fields/properties/eo:cloud_cover` },
      id: { $ref: 'https://schemas.stacspec.org/item.json#/x', title: 'Item ID' },
      geometry: { $ref: 'https://geojson.org/schema/Feature.json' },
    },
  };
  const fields = parseQueryables(await resolveExternalRefs(schema, fetch), CQL2_BASIC);
  const cc = fields.find((f) => f.key === 'eo:cloud_cover');
  equal([cc.fieldType, cc.maximum], [FieldType.NUMBER, 100]);
  equal(fields.find((f) => f.key === 'id').fieldType, FieldType.STRING, 'fetch failed');
  assert(!fetched.includes('https://geojson.org/schema/Feature.json'));
});

test('queryables: STAC discovery reads conformance, then collection queryables, then the global ones', async () => {
  const conformsTo = ['https://api.stacspec.org/v1.0.0/item-search#query'];
  const calls = stubFetch((url) => {
    if (url === 'https://stac.test/') return json({ conformsTo, links: [{ rel: 'http://www.opengis.net/def/rel/ogc/1.0/queryables', href: 'https://stac.test/q' }] });
    if (url === 'https://stac.test/collections/a/queryables') return json({ properties: { 'eo:cloud_cover': { type: 'number' } } });
    if (url === 'https://stac.test/collections/b%2Fc/queryables') return json({}, 404);
    if (url === 'https://stac.test/q') return json({ properties: { flygar: { type: 'number' } } });
    return json({}, 404);
  });
  try {
    const client = new StacClient({ name: 'S', url: 'https://stac.test', apiType: 'stac', authRequired: 'download' }, { credentialsFor: async () => null });
    const perCollection = await discoverQueryFields(client, ['a', 'b/c']);
    equal(perCollection.dialect, queryDialect(QUERY_EXTENSION));
    equal(perCollection.title, 'S');
    equal(perCollection.fields.map((f) => f.key), ['eo:cloud_cover']);
    equal(perCollection.fields[0].operators, ['eq', 'neq', 'gt', 'gte', 'lt', 'lte']);

    const global = await discoverQueryFields(client, []);
    equal(global.fields.map((f) => f.key), ['flygar'], 'landing page queryables link followed');
  } finally {
    calls.restore();
  }

  const none = stubFetch(() => json({ conformsTo: ['https://api.stacspec.org/v1.0.0/core'] }));
  try {
    const client = new StacClient({ name: 'S', url: 'https://stac.test', apiType: 'stac', authRequired: 'none' }, { credentialsFor: async () => null });
    equal((await discoverQueryFields(client)).dialect, null);
    equal(none.length, 1, 'no queryables fetched when there is no dialect');
  } finally {
    none.restore();
  }

  const noEndpoint = stubFetch((url) => (url === 'https://stac.test/' ? json({ conformsTo }) : json({}, 404)));
  try {
    const client = new StacClient({ name: 'S', url: 'https://stac.test', apiType: 'stac', authRequired: 'none' }, { credentialsFor: async () => null });
    const result = await discoverQueryFields(client);
    equal([result.dialect?.language, result.fields], [QUERY_EXTENSION, []], 'missing /queryables is not an error');
  } finally {
    noEndpoint.restore();
  }
});

test('client: the search body carries the query in its dialect', () => {
  const client = new StacClient({ name: 'S', url: 'https://stac.test', apiType: 'stac', authRequired: 'none' }, {});
  const cql2 = new AttributeQuery([condition('flygar', 'gte', 2020, FieldType.NUMBER)], CQL2_BASIC);
  equal(client.searchBody({ query: cql2 }), { limit: 100, 'filter-lang': 'cql2-json', filter: { op: '>=', args: [prop('flygar'), 2020] } });
  const ext = new AttributeQuery([condition('flygar', 'gte', 2020, FieldType.NUMBER)], NGP_DIALECT);
  equal(client.searchBody({ query: ext }), { limit: 100, query: { flygar: { gte: 2020 } } });
  equal(client.searchBody({ query: null }), { limit: 100 });
});

// ── geometry ───────────────────────────────────────────────────────────────

test('wkb: ISO polygon and Z point', () => {
  const buf = new ArrayBuffer(1 + 4 + 4 + 4 + 4 * 16);
  const v = new DataView(buf);
  v.setUint8(0, 1); v.setUint32(1, 3, true); v.setUint32(5, 1, true); v.setUint32(9, 4, true);
  [[0, 0], [1, 0], [1, 1], [0, 0]].forEach(([x, y], i) => { v.setFloat64(13 + i * 16, x, true); v.setFloat64(21 + i * 16, y, true); });
  equal(parseWkb(new Uint8Array(buf)), { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] });
  const p = new DataView(new ArrayBuffer(29));
  p.setUint8(0, 0); p.setUint32(1, 1001, false); p.setFloat64(5, 18.5, false); p.setFloat64(13, 59.5, false); p.setFloat64(21, 12, false);
  equal(parseWkb(new Uint8Array(p.buffer)), { type: 'Point', coordinates: [18.5, 59.5] });
});

test('shapefile: polygon with a hole becomes RFC 7946 oriented', () => {
  const outer = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]; // clockwise
  const hole = [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]];      // counter-clockwise
  const points = [...outer, ...hole];
  const content = 44 + 2 * 4 + points.length * 16;
  const buf = new ArrayBuffer(100 + 8 + content);
  const v = new DataView(buf);
  v.setInt32(0, 9994, false); v.setInt32(24, buf.byteLength / 2, false); v.setInt32(28, 1000, true); v.setInt32(32, 5, true);
  v.setInt32(100, 1, false); v.setInt32(104, content / 2, false);
  const s = 108;
  v.setInt32(s, 5, true); v.setInt32(s + 36, 2, true); v.setInt32(s + 40, points.length, true);
  v.setInt32(s + 44, 0, true); v.setInt32(s + 48, outer.length, true);
  points.forEach(([x, y], i) => { v.setFloat64(s + 52 + i * 16, x, true); v.setFloat64(s + 60 + i * 16, y, true); });
  const [geometry] = parseShp(buf);
  equal(geometry.type, 'Polygon');
  equal(geometry.coordinates.length, 2);
  equal(geometry.coordinates[0][1], [10, 0], 'exterior reversed to counter-clockwise');
});

test('area: bbox normalised and rounded; request shape', () => {
  const area = bboxArea([18.123456789, 59.2, 18.0, 59.1]);
  equal(area.bbox, [18, 59.1, 18.1234568, 59.2]);
  equal(areaToRequest(area), { bbox: area.bbox });
  equal(vertexCount({ type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [0, 1], [0, 0]]]] }), 4);
});

test('crs: SWEREF 99 TM and RT 90 to WGS 84; names and WKT', () => {
  // Reference: Lantmäteriet's Gauss–Krüger formulas, evaluated independently.
  const [lon, lat] = toWgs84({ epsg: 3006 })([674032.357, 6580821.991]);
  near(lon, 18.059196, 0.000001, 'lon');
  near(lat, 59.330231, 0.000001, 'lat');
  // Same physical point, in Lantmäteriet's RT90 2.5 gon V example coordinates.
  // The two national systems use different Helmert parameters, so this only
  // agrees with the SWEREF 99 TM point to the few-metre accuracy of the
  // published 7-parameter RT90->WGS84 transform, not to survey precision.
  const [lon2, lat2] = toWgs84({ epsg: 3021 })([1628294.199, 6580994.219]);
  near(lon2, 18.059196, 0.0005, 'RT 90 lon');
  near(lat2, 59.330231, 0.0005, 'RT 90 lat');
  equal(epsgFromName('urn:ogc:def:crs:EPSG::3006'), 3006);
  equal(epsgFromName('http://www.opengis.net/def/crs/OGC/1.3/CRS84'), 4326);
  equal(epsgFromWkt('PROJCS["SWEREF99 TM",GEOGCS["SWEREF99",AUTHORITY["EPSG","4619"]],AUTHORITY["EPSG","3006"]]'), 3006);
});

test('loaders: GeoJSON with a legacy CRS is reprojected; two features are refused', async () => {
  const file = (name, data) => new File([JSON.stringify(data)], name, { type: 'application/json' });
  const result = await loadSearchGeometry([file('a.geojson', {
    type: 'Feature',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3006' } },
    geometry: { type: 'Point', coordinates: [674032.357, 6580821.991] },
  })]);
  near(result.geometry.coordinates[0], 18.059196, 0.000001);
  equal(result.crsLabel, 'EPSG:3006');
  const pt = { type: 'Feature', geometry: { type: 'Point', coordinates: [18, 59] } };
  await rejects(loadSearchGeometry([file('b.geojson', { type: 'FeatureCollection', features: [pt, pt] })]), LoadError);
  await rejects(loadSearchGeometry([file('c.geojson', { type: 'Feature', geometry: { type: 'Point', coordinates: [674032, 6580821] } })]), LoadError, 'projected without CRS');
});

// ── run ────────────────────────────────────────────────────────────────────

const list = document.getElementById('results');
let failed = 0;
for (const { name, fn } of tests) {
  const li = document.createElement('li');
  try {
    await fn();
    li.className = 'pass';
    li.textContent = `✓ ${name}`;
  } catch (error) {
    failed++;
    li.className = 'fail';
    li.textContent = `✗ ${name}`;
    const pre = document.createElement('pre');
    pre.textContent = error?.stack || String(error);
    li.append(pre);
  }
  list.append(li);
}
const summary = `${tests.length - failed} of ${tests.length} passed`;
document.getElementById('summary').textContent = failed ? `FAILED — ${summary}` : `All tests passed (${tests.length})`;
document.title = failed ? `FAIL ${summary}` : `PASS ${summary}`;
window.testResults = { total: tests.length, failed };
