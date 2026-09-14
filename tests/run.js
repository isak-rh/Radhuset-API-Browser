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
