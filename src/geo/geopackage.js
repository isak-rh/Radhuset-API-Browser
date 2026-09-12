// GeoPackage reader, on sql.js (SQLite compiled to WebAssembly). The reader is
// fetched only when a GeoPackage is actually opened.

import { parseWkb } from './wkb.js';
import { t } from '../i18n/index.js';

let sqlPromise = null;

function loadSqlJs() {
  if (!sqlPromise) {
    sqlPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'vendor/sqljs/sql-wasm.js';
      script.onload = () => window.initSqlJs({ locateFile: (file) => `vendor/sqljs/${file}` }).then(resolve, reject);
      script.onerror = () => reject(new Error(t('geo.gpkgLoadFailed')));
      document.head.append(script);
    }).catch((error) => {
      sqlPromise = null;
      throw error;
    });
  }
  return sqlPromise;
}

export class GeoPackageError extends Error {}

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

function rows(db, sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const out = [];
    while (stmt.step()) out.push(stmt.getAsObject());
    return out;
  } finally {
    stmt.free();
  }
}

/** Strip the GeoPackage binary header (GP magic, flags, srs id, envelope) and parse the WKB. */
function parseGeoPackageBlob(blob) {
  if (!(blob instanceof Uint8Array) || blob.length < 8 || blob[0] !== 0x47 || blob[1] !== 0x50) {
    throw new GeoPackageError(t('geo.gpkgNotGeoPackageFormat'));
  }
  const flags = blob[3];
  if (flags & 0x20) throw new GeoPackageError(t('geo.gpkgExtendedNotSupported'));
  if (flags & 0x10) return null; // empty geometry
  const envelope = (flags >> 1) & 0x07;
  const envelopeBytes = [0, 32, 48, 48, 64][envelope];
  if (envelopeBytes === undefined) throw new GeoPackageError(t('geo.gpkgInvalidHeader'));
  return parseWkb(blob.subarray(8 + envelopeBytes));
}

/**
 * The single feature geometry in a GeoPackage, with its CRS:
 * { geometries: [geometry], crs: { epsg, wkt }, layer }.
 * Throws when there is not exactly one feature layer.
 */
export async function readGeoPackage(buffer) {
  const SQL = await loadSqlJs();
  let db;
  try {
    db = new SQL.Database(new Uint8Array(buffer));
  } catch {
    throw new GeoPackageError(t('geo.gpkgOpenFailed'));
  }
  try {
    let layers;
    try {
      layers = rows(db, "SELECT table_name FROM gpkg_contents WHERE data_type = 'features'");
    } catch {
      throw new GeoPackageError(t('geo.gpkgNoContentsTable'));
    }
    if (layers.length !== 1) {
      throw new GeoPackageError(
        layers.length
          ? t('geo.gpkgMultipleLayers', { n: layers.length })
          : t('geo.gpkgNoLayers'),
      );
    }
    const table = layers[0].table_name;
    const [column] = rows(db, 'SELECT column_name, srs_id FROM gpkg_geometry_columns WHERE table_name = ?', [table]);
    if (!column) throw new GeoPackageError(t('geo.gpkgNoGeometryColumn', { table }));

    const [srs] = rows(
      db,
      'SELECT organization, organization_coordsys_id, definition FROM gpkg_spatial_ref_sys WHERE srs_id = ?',
      [column.srs_id],
    );
    const crs = { epsg: null, wkt: null };
    if (srs) {
      if (String(srs.organization).toUpperCase() === 'EPSG' && srs.organization_coordsys_id > 0) {
        crs.epsg = Number(srs.organization_coordsys_id);
      }
      if (srs.definition && srs.definition !== 'undefined') crs.wkt = String(srs.definition);
    }

    const blobs = rows(db, `SELECT ${quoteIdent(column.column_name)} AS g FROM ${quoteIdent(table)} LIMIT 2`);
    const geometries = blobs.map((r) => (r.g ? parseGeoPackageBlob(r.g) : null)).filter(Boolean);
    if (blobs.length > 1) {
      const [{ n }] = rows(db, `SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`);
      throw new GeoPackageError(t('geo.gpkgTooManyFeatures', { table, n }));
    }
    return { geometries, crs, layer: table };
  } finally {
    db.close();
  }
}
