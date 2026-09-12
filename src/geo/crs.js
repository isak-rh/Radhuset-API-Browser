// Coordinate reference systems for loaded files.
//
// The map and every API request are WGS84, so reprojection is only ever needed
// one way: from whatever CRS a loaded file is in, to lon/lat. Files usually carry
// their CRS as WKT (a Shapefile .prj, a GeoPackage srs definition), which proj4
// can read directly; an EPSG code alone needs a definition, so the systems a
// Swedish user is likely to meet are registered here.

/* global proj4 */

import { mapPositions } from './area.js';
import { t } from '../i18n/index.js';

const SWEREF = '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
const RT90 = '+ellps=bessel +towgs84=414.1,41.3,603.1,-0.855,2.141,-7.023,0 +units=m +no_defs';
const tmerc = (lon0, x0, rest) => `+proj=tmerc +lat_0=0 +lon_0=${lon0} +k=1 +x_0=${x0} +y_0=0 ${rest}`;

const DEFINITIONS = {
  // SWEREF 99 TM and the twelve local SWEREF 99 zones.
  3006: `+proj=utm +zone=33 ${SWEREF}`,
  3007: tmerc(12, 150000, SWEREF),
  3008: tmerc(13.5, 150000, SWEREF),
  3009: tmerc(15, 150000, SWEREF),
  3010: tmerc(16.5, 150000, SWEREF),
  3011: tmerc(18, 150000, SWEREF),
  3012: tmerc(14.25, 150000, SWEREF),
  3013: tmerc(15.75, 150000, SWEREF),
  3014: tmerc(17.25, 150000, SWEREF),
  3015: tmerc(18.75, 150000, SWEREF),
  3016: tmerc(20.25, 150000, SWEREF),
  3017: tmerc(21.75, 150000, SWEREF),
  3018: tmerc(23.25, 150000, SWEREF),
  // RT 90, the older Swedish national grid, still common in archived data.
  3019: tmerc(11.30827777777778, 1500000, RT90),
  3020: tmerc(13.55827777777778, 1500000, RT90),
  3021: tmerc(15.80827777777778, 1500000, RT90),
  3022: tmerc(18.05827777777778, 1500000, RT90),
  3023: tmerc(20.30827777777778, 1500000, RT90),
  3024: tmerc(22.55827777777778, 1500000, RT90),
  // Geographic ETRS89 / SWEREF 99.
  4258: '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs',
  4619: '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs',
  // UTM zones covering the Nordics, on ETRS89 and on WGS 84.
  25832: `+proj=utm +zone=32 ${SWEREF}`,
  25833: `+proj=utm +zone=33 ${SWEREF}`,
  25834: `+proj=utm +zone=34 ${SWEREF}`,
  25835: `+proj=utm +zone=35 ${SWEREF}`,
  32632: '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs',
  32633: '+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs',
  32634: '+proj=utm +zone=34 +datum=WGS84 +units=m +no_defs',
  32635: '+proj=utm +zone=35 +datum=WGS84 +units=m +no_defs',
};

let registered = false;

function register() {
  if (registered) return;
  for (const [code, def] of Object.entries(DEFINITIONS)) proj4.defs(`EPSG:${code}`, def);
  registered = true;
}

export class UnsupportedCrsError extends Error {
  constructor(label) {
    super(t('geo.unsupportedCrs', { label }));
    this.name = 'UnsupportedCrsError';
  }
}

const WGS84_CODES = new Set([4326, 4979, 84]);

/** EPSG code from a CRS name such as "EPSG:3006", "urn:ogc:def:crs:EPSG::3006" or an OGC URI. */
export function epsgFromName(name) {
  const text = String(name || '');
  if (/CRS:?84$/i.test(text)) return 4326;
  const match = /EPSG(?::+|\/\d+\/|\/)(\d+)$/i.exec(text) || /^(\d{4,5})$/.exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * The EPSG code a WKT string declares for itself, if any. The root element's
 * authority is the last one in the string, after those of its datum, units and
 * axes.
 */
export function epsgFromWkt(wkt) {
  const matches = [...String(wkt).matchAll(/(?:AUTHORITY|ID)\s*\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]/gi)];
  return matches.length ? Number(matches[matches.length - 1][1]) : null;
}

/** A short name for a CRS, for display. */
export function crsLabel({ epsg = null, wkt = null } = {}) {
  if (epsg) return WGS84_CODES.has(epsg) ? 'WGS 84' : `EPSG:${epsg}`;
  const name = /^\s*\w+\s*\[\s*"([^"]+)"/.exec(String(wkt || ''));
  return name ? name[1].replace(/_/g, ' ') : t('geo.unknownCrs');
}

/**
 * A function mapping [x, y] in the given CRS to [lon, lat]. A known EPSG code
 * wins over WKT, because proj4's WKT reading is best-effort and our definitions
 * carry the correct datum shifts.
 */
export function toWgs84({ epsg = null, wkt = null } = {}) {
  register();
  const code = epsg || (wkt ? epsgFromWkt(wkt) : null);
  if (code && WGS84_CODES.has(code)) return (p) => [p[0], p[1]];
  let source = null;
  if (code && proj4.defs(`EPSG:${code}`)) {
    source = `EPSG:${code}`;
  } else if (wkt) {
    try {
      proj4(wkt, 'EPSG:4326', [0, 0]);
      source = wkt;
    } catch {
      source = null;
    }
  }
  if (!source) throw new UnsupportedCrsError(crsLabel({ epsg: code, wkt }));
  const converter = proj4(source, 'EPSG:4326');
  return (p) => converter.forward([p[0], p[1]]);
}

/** *geometry* reprojected to WGS84, and reduced to 2D. */
export function reprojectToWgs84(geometry, crs) {
  const fn = toWgs84(crs);
  return mapPositions(geometry, fn);
}

export const isLonLat = ([x, y]) => Math.abs(x) <= 180 && Math.abs(y) <= 90;
