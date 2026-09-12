// Search areas and GeoJSON geometry helpers.
//
// A search area is always WGS84 lon/lat, whatever it was drawn on or loaded from:
//   { kind: 'bbox', bbox: [minLon, minLat, maxLon, maxLat] }
//   { kind: 'geometry', geometry, source: 'drawn' | 'file', name? }
// A bbox is sent to the API as `bbox`; any other geometry as `intersects`.

export const GEOMETRY_TYPES = ['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'];

// Above this, a warning: complex geometries can make the API slow or fail.
export const LARGE_VERTEX_COUNT = 1000;

export function isGeometry(value) {
  return Boolean(value && typeof value === 'object' && GEOMETRY_TYPES.includes(value.type) && Array.isArray(value.coordinates));
}

/** Every [x, y] position in a geometry. */
export function positions(geometry) {
  const c = geometry.coordinates;
  switch (geometry.type) {
    case 'Point': return [c];
    case 'MultiPoint':
    case 'LineString': return c;
    case 'MultiLineString':
    case 'Polygon': return c.flat();
    case 'MultiPolygon': return c.flat(2);
    default: return [];
  }
}

export function vertexCount(geometry) {
  return positions(geometry).length;
}

export function geometryBbox(geometry) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const [x, y] of positions(geometry)) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

/** Apply *fn([x, y]) -> [x, y]* to every position, returning a new geometry. */
export function mapPositions(geometry, fn) {
  const depth = { Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3 }[geometry.type];
  const walk = (coords, level) => (level === 0 ? fn(coords) : coords.map((c) => walk(c, level - 1)));
  return { type: geometry.type, coordinates: walk(geometry.coordinates, depth) };
}

// 1e-7 degrees is about a centimetre: plenty for a search, and it keeps the
// request small.
const round = (v) => Math.round(v * 1e7) / 1e7;

export function bboxArea(bbox) {
  const [x1, y1, x2, y2] = bbox;
  return {
    kind: 'bbox',
    bbox: [round(Math.min(x1, x2)), round(Math.min(y1, y2)), round(Math.max(x1, x2)), round(Math.max(y1, y2))],
  };
}

export function geometryArea(geometry, { source = 'drawn', name = null } = {}) {
  return { kind: 'geometry', geometry: mapPositions(geometry, ([x, y]) => [round(x), round(y)]), source, name };
}

export function areaBbox(area) {
  return area.kind === 'bbox' ? area.bbox : geometryBbox(area.geometry);
}

export function areaToRequest(area) {
  return area.kind === 'bbox' ? { bbox: area.bbox } : { intersects: area.geometry };
}

/** Approximate size of a lon/lat bbox in km, for display. */
export function bboxSizeKm([minX, minY, maxX, maxY]) {
  const midLat = ((minY + maxY) / 2) * (Math.PI / 180);
  const width = (maxX - minX) * 111.32 * Math.cos(midLat);
  const height = (maxY - minY) * 110.57;
  return [width, height];
}
