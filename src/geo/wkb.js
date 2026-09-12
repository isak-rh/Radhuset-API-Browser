// Well-known binary → GeoJSON geometry, as found in GeoPackages.
//
// Handles both ISO WKB (type + 1000/2000/3000 for Z/M/ZM) and the older extended
// flags (0x80000000 Z, 0x40000000 M, 0x20000000 SRID). Only X and Y are kept.

import { t } from '../i18n/index.js';

const TYPES = { 1: 'Point', 2: 'LineString', 3: 'Polygon', 4: 'MultiPoint', 5: 'MultiLineString', 6: 'MultiPolygon', 7: 'GeometryCollection' };

export class WkbError extends Error {}

export function parseWkb(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;

  function readGeometry() {
    if (pos + 5 > view.byteLength) throw new WkbError(t('geo.truncatedGeometry'));
    const little = view.getUint8(pos) === 1;
    let type = view.getUint32(pos + 1, little);
    pos += 5;
    let hasZ = (type & 0x80000000) !== 0;
    let hasM = (type & 0x40000000) !== 0;
    const hasSrid = (type & 0x20000000) !== 0;
    type &= 0x0fffffff;
    if (type >= 3000) { hasZ = true; hasM = true; type -= 3000; }
    else if (type >= 2000) { hasM = true; type -= 2000; }
    else if (type >= 1000) { hasZ = true; type -= 1000; }
    if (hasSrid) pos += 4;
    const dims = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);

    const readPoint = () => {
      const x = view.getFloat64(pos, little);
      const y = view.getFloat64(pos + 8, little);
      pos += 8 * dims;
      return [x, y];
    };
    const readCount = () => {
      const n = view.getUint32(pos, little);
      pos += 4;
      return n;
    };
    const readPoints = () => Array.from({ length: readCount() }, readPoint);

    const name = TYPES[type];
    switch (name) {
      case 'Point': {
        const p = readPoint();
        return Number.isNaN(p[0]) ? null : { type: name, coordinates: p };
      }
      case 'LineString':
        return { type: name, coordinates: readPoints() };
      case 'Polygon':
        return { type: name, coordinates: Array.from({ length: readCount() }, readPoints) };
      case 'MultiPoint':
      case 'MultiLineString':
      case 'MultiPolygon': {
        const parts = Array.from({ length: readCount() }, readGeometry).filter(Boolean);
        return { type: name, coordinates: parts.map((g) => g.coordinates) };
      }
      case 'GeometryCollection':
        return { type: name, geometries: Array.from({ length: readCount() }, readGeometry).filter(Boolean) };
      default:
        throw new WkbError(t('geo.unsupportedGeometryTypeCode', { type }));
    }
  }

  return readGeometry();
}
