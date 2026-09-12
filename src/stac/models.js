// Parsing of STAC items and collections into the shapes the UI uses.
//
// Every coordinate here is WGS84 (lon/lat): STAC APIs return it by spec, and NGP
// APIs are asked for CRS84 explicitly (see client.js).

import { geometryBbox, isGeometry } from '../geo/area.js';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');

function toSize(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeBbox(bbox) {
  const b = bbox.map(Number);
  // A 3D bbox is [minx, miny, minz, maxx, maxy, maxz].
  const flat = b.length >= 6 ? [b[0], b[1], b[3], b[4]] : b.slice(0, 4);
  return flat.every(Number.isFinite) ? flat : null;
}

const isThumbnail = (asset) => asset.roles.includes('thumbnail') || asset.key === 'thumbnail';

/**
 * A search result, or null for a feature without an id or any extent.
 *
 * `uid` identifies the item within one result set: STAC ids are only unique
 * within a collection, so the collection is part of it.
 */
export function parseItem(feature) {
  if (!isObject(feature) || feature.id == null) return null;
  const geometry = isGeometry(feature.geometry) ? feature.geometry : null;
  let bbox = Array.isArray(feature.bbox) && feature.bbox.length >= 4 ? normalizeBbox(feature.bbox) : null;
  if (!bbox && geometry) bbox = geometryBbox(geometry);
  if (!bbox) return null;

  const rawAssets = isObject(feature.assets) ? feature.assets : {};
  const assets = Object.entries(rawAssets)
    .filter(([, a]) => isObject(a))
    .map(([key, a]) => ({
      key,
      href: str(a.href),
      title: str(a.title) || key,
      type: str(a.type),
      roles: Array.isArray(a.roles) ? a.roles.map(String) : [],
      size: toSize(a['file:size']),
    }));
  const thumbnail = assets.find(isThumbnail) || null;
  const downloadable = assets.filter((a) => !isThumbnail(a) && a.href);
  const sizes = downloadable.map((a) => a.size);

  const properties = isObject(feature.properties) ? feature.properties : {};
  const id = String(feature.id);
  const collection = str(feature.collection);
  const title = typeof properties.title === 'string' && properties.title.trim() ? properties.title.trim() : id;
  return {
    uid: collection ? `${collection}/${id}` : id,
    id,
    collection,
    title,
    datetime: str(properties.datetime) || str(properties.start_datetime) || null,
    bbox,
    geometry,
    properties,
    rawAssets,
    downloadable,
    thumbnailUrl: thumbnail?.href || null,
    // Null when any asset's size is undeclared, so a total is never understated.
    totalSize: sizes.length && sizes.every((s) => s !== null) ? sizes.reduce((a, b) => a + b, 0) : null,
  };
}

export function parseCollection(entry) {
  if (!isObject(entry) || !entry.id) return null;
  return {
    id: String(entry.id),
    title: str(entry.title),
    description: str(entry.description),
    keywords: Array.isArray(entry.keywords) ? entry.keywords.map(String) : [],
  };
}
