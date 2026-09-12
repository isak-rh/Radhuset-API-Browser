// Shapefile (.shp) geometry reader. Attributes (.dbf) are not needed for a
// search area and are ignored; the CRS comes from the .prj beside it.

import { t } from '../i18n/index.js';

export class ShapefileError extends Error {}

function signedArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[i][0] - ring[j][0]) * (ring[i][1] + ring[j][1]);
  }
  return sum / 2; // > 0 clockwise, < 0 counter-clockwise (y up)
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const clockwise = (ring) => (signedArea(ring) > 0 ? ring : [...ring].reverse());
const counterClockwise = (ring) => (signedArea(ring) < 0 ? ring : [...ring].reverse());

/**
 * Group a shapefile polygon's rings into polygons. Shapefiles mark outer rings
 * clockwise and holes counter-clockwise; GeoJSON wants the opposite, so rings
 * are also re-oriented (RFC 7946 §3.1.6).
 */
function assemblePolygons(rings) {
  let outers = rings.filter((r) => signedArea(r) > 0);
  let holes = rings.filter((r) => signedArea(r) <= 0);
  // Some writers ignore the orientation rule; treat every ring as an outer.
  if (!outers.length) {
    outers = holes;
    holes = [];
  }
  const polygons = outers.map((outer) => [counterClockwise(outer)]);
  for (const hole of holes) {
    const owner = outers.findIndex((outer) => pointInRing(hole[0], outer));
    if (owner >= 0) polygons[owner].push(clockwise(hole));
    else polygons.push([counterClockwise(hole)]);
  }
  return polygons.length === 1
    ? { type: 'Polygon', coordinates: polygons[0] }
    : { type: 'MultiPolygon', coordinates: polygons };
}

/** Every non-null geometry in a .shp file, as GeoJSON in the file's own CRS. */
export function parseShp(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 100 || view.getInt32(0, false) !== 9994) {
    throw new ShapefileError(t('geo.notValidShp'));
  }
  const geometries = [];
  let pos = 100;
  while (pos + 12 <= view.byteLength) {
    const contentBytes = view.getInt32(pos + 4, false) * 2;
    const start = pos + 8;
    pos = start + contentBytes;
    if (contentBytes < 4 || pos > view.byteLength) break;
    const type = view.getInt32(start, true);
    const point = (at) => [view.getFloat64(at, true), view.getFloat64(at + 8, true)];

    switch (type) {
      case 0:
        break;
      case 1: case 11: case 21:
        geometries.push({ type: 'Point', coordinates: point(start + 4) });
        break;
      case 8: case 18: case 28: {
        const n = view.getInt32(start + 36, true);
        const coords = Array.from({ length: n }, (_, i) => point(start + 40 + i * 16));
        geometries.push({ type: 'MultiPoint', coordinates: coords });
        break;
      }
      case 3: case 13: case 23:
      case 5: case 15: case 25: {
        const numParts = view.getInt32(start + 36, true);
        const numPoints = view.getInt32(start + 40, true);
        const partsAt = start + 44;
        const pointsAt = partsAt + numParts * 4;
        const starts = Array.from({ length: numParts }, (_, i) => view.getInt32(partsAt + i * 4, true));
        const parts = starts.map((s, i) => {
          const end = i + 1 < numParts ? starts[i + 1] : numPoints;
          return Array.from({ length: end - s }, (_, k) => point(pointsAt + (s + k) * 16));
        });
        const isLine = type === 3 || type === 13 || type === 23;
        if (isLine) {
          geometries.push(parts.length === 1
            ? { type: 'LineString', coordinates: parts[0] }
            : { type: 'MultiLineString', coordinates: parts });
        } else {
          geometries.push(assemblePolygons(parts));
        }
        break;
      }
      default:
        throw new ShapefileError(t('geo.unsupportedShapeType', { type }));
    }
  }
  return geometries;
}
