// Loading a search area from a vector file.
//
// Supported: GeoJSON, Shapefile (the .shp with its .prj, selected together or
// zipped) and GeoPackage. The file must hold exactly one feature of a supported
// geometry type; it is reprojected to WGS84 whatever its CRS.

import { GEOMETRY_TYPES, mapPositions, positions, vertexCount } from './area.js';
import { crsLabel, epsgFromName, isLonLat, reprojectToWgs84 } from './crs.js';
import { t } from '../i18n/index.js';

export const ACCEPTED_FILES = '.geojson,.json,.zip,.shp,.shx,.dbf,.prj,.cpg,.gpkg';

export class LoadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LoadError';
  }
}

const extension = (name) => (/\.([^.]+)$/.exec(name)?.[1] || '').toLowerCase();

/** A uniform view of a file, whether picked by the user or unpacked from a zip. */
const fromFile = (file) => ({
  name: file.name,
  arrayBuffer: () => file.arrayBuffer(),
  text: () => file.text(),
});
const fromBytes = (name, bytes) => ({
  name,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  text: async () => new TextDecoder().decode(bytes),
});

function onlyGeometry(geometries, what) {
  const valid = geometries.filter(Boolean);
  if (valid.length === 0) throw new LoadError(t('geo.noGeometry', { what }));
  if (valid.length > 1) {
    throw new LoadError(t('geo.multipleFeatures', { what, n: valid.length }));
  }
  const [geometry] = valid;
  if (geometry.type === 'GeometryCollection' || !GEOMETRY_TYPES.includes(geometry.type)) {
    throw new LoadError(t('geo.unsupportedGeometryType', { type: geometry.type, types: GEOMETRY_TYPES.join(', ') }));
  }
  return geometry;
}

function checkLonLat(geometry, source) {
  if (!positions(geometry).every(isLonLat)) {
    throw new LoadError(t('geo.notLonLat', { source }));
  }
}

async function readGeoJson(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new LoadError(t('geo.notValidJson', { fileName: file.name }));
  }
  let geometries;
  if (data?.type === 'FeatureCollection') geometries = (data.features || []).map((f) => f?.geometry);
  else if (data?.type === 'Feature') geometries = [data.geometry];
  else if (typeof data?.type === 'string') geometries = [data];
  else throw new LoadError(t('geo.notGeoJson', { fileName: file.name }));

  const geometry = onlyGeometry(geometries, file.name);
  // RFC 7946 GeoJSON is always WGS84; the pre-standard `crs` member may say otherwise.
  const epsg = epsgFromName(data.crs?.properties?.name);
  if (epsg && epsg !== 4326) return { geometry, crs: { epsg }, name: file.name };
  checkLonLat(geometry, file.name);
  return { geometry, crs: { epsg: 4326 }, name: file.name };
}

async function readShapefile(shp, prj) {
  const { parseShp, ShapefileError } = await import('./shapefile.js');
  let geometries;
  try {
    geometries = parseShp(await shp.arrayBuffer());
  } catch (error) {
    if (error instanceof ShapefileError) throw new LoadError(error.message);
    throw new LoadError(t('geo.shapefileReadFailed', { fileName: shp.name }));
  }
  const geometry = onlyGeometry(geometries, shp.name);
  if (prj) return { geometry, crs: { wkt: await prj.text() }, name: shp.name };
  checkLonLat(geometry, shp.name);
  throw new LoadError(t('geo.noPrjFile', { fileName: shp.name }));
}

async function readGpkg(file) {
  const { readGeoPackage, GeoPackageError } = await import('./geopackage.js');
  try {
    const { geometries, crs, layer } = await readGeoPackage(await file.arrayBuffer());
    return { geometry: onlyGeometry(geometries, t('geo.theLayer', { layer })), crs, name: file.name };
  } catch (error) {
    if (error instanceof GeoPackageError || error instanceof LoadError) throw new LoadError(error.message);
    throw new LoadError(t('geo.fileReadFailed', { fileName: file.name, message: error.message || error }));
  }
}

async function readZip(file) {
  const { unzipSync } = await import('../../vendor/fflate/fflate.js');
  let entries;
  try {
    entries = unzipSync(new Uint8Array(await file.arrayBuffer()), {
      filter: (f) => !f.name.startsWith('__MACOSX/') && !f.name.endsWith('/'),
    });
  } catch {
    throw new LoadError(t('geo.notValidZip', { fileName: file.name }));
  }
  const files = Object.entries(entries).map(([name, bytes]) => fromBytes(name.split('/').pop(), bytes));
  return readSelection(files, file.name);
}

async function readSelection(files, label) {
  const byExt = (ext) => files.filter((f) => extension(f.name) === ext);
  const [shps, gpkgs, jsons] = [byExt('shp'), byExt('gpkg'), [...byExt('geojson'), ...byExt('json')]];
  const zips = byExt('zip');
  const kinds = [shps.length, gpkgs.length, jsons.length, zips.length].filter(Boolean).length;

  if (files.some((f) => /\.gdb(table|tablx|indexes)?$|^gdb$/i.test(f.name))) {
    throw new LoadError(t('geo.gdbNotSupported'));
  }
  if (kinds === 0) throw new LoadError(t('geo.noSupportedFile', { label }));
  if (kinds > 1 || shps.length > 1 || gpkgs.length > 1 || jsons.length > 1 || zips.length > 1) {
    throw new LoadError(t('geo.selectOneAtATime'));
  }
  if (zips.length) return readZip(zips[0]);
  if (gpkgs.length) return readGpkg(gpkgs[0]);
  if (jsons.length) return readGeoJson(jsons[0]);
  const base = shps[0].name.replace(/\.shp$/i, '').toLowerCase();
  const prj = byExt('prj').find((f) => f.name.replace(/\.prj$/i, '').toLowerCase() === base) || byExt('prj')[0];
  return readShapefile(shps[0], prj);
}

/**
 * Read one search geometry from the selected files. Resolves to
 * { geometry (WGS84, 2D), name, crsLabel, vertices }.
 */
export async function loadSearchGeometry(fileList) {
  const files = [...fileList].map(fromFile);
  if (!files.length) throw new LoadError(t('geo.noFileSelected'));
  const { geometry, crs, name } = await readSelection(files, t('geo.theSelection'));

  let wgs84;
  try {
    wgs84 = reprojectToWgs84(geometry, crs);
  } catch (error) {
    throw new LoadError(error.message);
  }
  const flat = mapPositions(wgs84, ([x, y]) => [x, y]);
  if (!positions(flat).every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && isLonLat(p))) {
    throw new LoadError(t('geo.coordConversionFailed', { name }));
  }
  return { geometry: flat, name, crsLabel: crsLabel(crs), vertices: vertexCount(flat) };
}
