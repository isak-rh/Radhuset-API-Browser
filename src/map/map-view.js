// The map: OpenLayers in Web Mercator over OpenStreetMap.
//
// Everything that enters or leaves this module is WGS84 (search areas, item
// geometries); the conversion to and from the view's EPSG:3857 happens here and
// nowhere else.
//
// Items have two independent states, both owned by the app, never by the map:
//   checked      ticked for download — drawn in the "selected" colour
//   highlighted  the results table's row selection — drawn with a white halo
// A click on the map only reports which items are under the cursor; the app
// updates the table, and the table's state comes back here. That one-way flow is
// what keeps the two views from echoing each other.

/* global ol */

import { bboxArea, geometryArea } from '../geo/area.js';
import { Emitter } from '../lib/emitter.js';

const VIEW_PROJECTION = 'EPSG:3857';
const DATA_PROJECTION = 'EPSG:4326';

// Click tolerance in screen pixels per geometry type: the rendered symbol size
// from #buildStyles plus a little slack. Polygons are filled, so any click inside
// hits; the tolerance only widens the catchment just outside the edge.
const HIT_TOLERANCE_PX = { Point: 9, MultiPoint: 9, LineString: 5, MultiLineString: 5, Polygon: 4, MultiPolygon: 4 };
const MAX_HIT_TOLERANCE_PX = 9;

// Above this many thumbnails the map spends more time loading images than the
// user gains from seeing them.
export const THUMBNAIL_LIMIT = 400;
const MERCATOR_MAX_LAT = 85.05;

function cssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function withAlpha(hex, alpha) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}

function clampLat(geometry) {
  const clamp = (c) => (typeof c[0] === 'number'
    ? [c[0], Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, c[1]))]
    : c.map(clamp));
  return { type: geometry.type, coordinates: clamp(geometry.coordinates) };
}

export class MapView extends Emitter {
  #features = new Map(); // uid -> ol.Feature
  #checked = new Set();
  #highlighted = new Set();
  #styles = null;
  #draw = null;
  #boxDraw = null;
  #drawMode = null;
  #thumbnails = [];
  #thumbnailsVisible = true;
  #hoverFrame = 0;

  constructor(target) {
    super();
    this.target = target;
    this.format = new ol.format.GeoJSON({ dataProjection: DATA_PROJECTION, featureProjection: VIEW_PROJECTION });
    this.#buildStyles();

    this.baseLayer = new ol.layer.Tile({ source: new ol.source.OSM(), className: 'basemap' });
    this.thumbnailGroup = new ol.layer.Group({ zIndex: 8 });
    this.resultSource = new ol.source.Vector();
    // VectorImage, not Vector: a plain vector layer re-strokes every footprint on
    // every frame while panning, which dominates with thousands of results. This
    // renders them once and moves the bitmap during interaction (slightly soft
    // mid-gesture, crisp after). A layer-level style function keeps styling off
    // the features, so a check/highlight change is one changed() call.
    this.resultLayer = new ol.layer.VectorImage({
      source: this.resultSource,
      zIndex: 9,
      imageRatio: 2,
      style: (feature) => this.#styleFor(feature.get('uid')),
    });
    this.areaSource = new ol.source.Vector();
    this.areaLayer = new ol.layer.Vector({ source: this.areaSource, zIndex: 10, style: this.#styles.area });

    this.map = new ol.Map({
      target,
      layers: [this.baseLayer, this.thumbnailGroup, this.resultLayer, this.areaLayer],
      view: new ol.View({
        projection: VIEW_PROJECTION,
        center: ol.proj.fromLonLat([16.3, 62.4]),
        zoom: 4.7,
        maxZoom: 19,
      }),
      controls: ol.control.defaults.defaults({ rotate: false, attributionOptions: { collapsible: true } })
        .extend([new ol.control.ScaleLine({ units: 'metric' })]),
    });

    // 'singleclick', not 'click', so a double-click zoom does not also select.
    this.map.on('singleclick', (event) => {
      if (this.#drawMode) return;
      this.emit('itemsClicked', this.hitTest(event.pixel), event.originalEvent);
    });
    this.map.getViewport().addEventListener('contextmenu', (event) => {
      event.preventDefault();
      if (this.#drawMode) return;
      const pixel = this.map.getEventPixel(event);
      this.emit('contextMenu', { uids: this.hitTest(pixel), x: event.clientX, y: event.clientY });
    });
    this.map.on('pointermove', (event) => {
      if (event.dragging || this.#drawMode) return;
      cancelAnimationFrame(this.#hoverFrame);
      this.#hoverFrame = requestAnimationFrame(() => {
        this.map.getViewport().style.cursor = this.hitTest(event.pixel).length ? 'pointer' : '';
      });
    });
    this.onKeyDown = (event) => {
      if (event.key === 'Escape' && this.#drawMode) {
        event.preventDefault();
        this.stopDraw();
      }
    };
    document.addEventListener('keydown', this.onKeyDown);
  }

  // ── Search area ─────────────────────────────────────────────────────────

  get drawMode() {
    return this.#drawMode;
  }

  /**
   * Start drawing a 'box' or 'polygon' search area.
   *
   * A polygon is the stock click-per-vertex interaction (double-click, or
   * click the first corner again, to finish). A box supports two gestures —
   * press and drag one corner to the other, or click one corner then click
   * the opposite one — which OpenLayers' own Draw interaction cannot mix (its
   * freehand flag picks one gesture for the whole interaction), so #startBoxDraw
   * implements both by hand.
   */
  startDraw(mode) {
    this.stopDraw();
    this.#drawMode = mode;
    this.target.classList.add('is-drawing');
    this.emit('drawModeChanged', mode);
    if (mode === 'box') {
      this.#startBoxDraw();
      return;
    }
    const draw = new ol.interaction.Draw({ type: 'Polygon', style: this.#styles.drawing });
    draw.on('drawend', (event) => {
      const area = geometryArea(this.format.writeGeometryObject(event.feature.getGeometry()), { source: 'drawn' });
      // Defer: removing the interaction inside its own drawend handler leaves
      // OpenLayers mid-event.
      setTimeout(() => {
        this.stopDraw();
        this.emit('areaDrawn', area);
      });
    });
    this.map.addInteraction(draw);
    this.#draw = draw;
  }

  /**
   * A box drawn either by dragging from corner to corner in one gesture, or by
   * clicking one corner and then the other. A plain click first fixes a
   * corner (kept until a second click finishes the box); a drag of more than a
   * few pixels finishes immediately, from wherever it started.
   */
  #startBoxDraw() {
    const source = new ol.source.Vector();
    const layer = new ol.layer.Vector({ source, zIndex: 11, style: this.#styles.drawing });
    this.map.addLayer(layer);
    const sketch = new ol.Feature();
    source.addFeature(sketch);

    // DragPan would otherwise pan the map underneath a drag-to-draw gesture.
    const dragPan = this.map.getInteractions().getArray().find((i) => i instanceof ol.interaction.DragPan);
    dragPan?.setActive(false);

    const DRAG_TOLERANCE_PX = 4;
    let fixedCorner = null; // set by a plain click, waiting for the opposite corner
    let pointerDown = null; // { pixel, coordinate } from the most recent pointerdown

    const extentOf = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    const preview = (a, b) => sketch.setGeometry(ol.geom.Polygon.fromExtent(extentOf(a, b)));

    const finish = (a, b) => {
      const extent = extentOf(a, b);
      const resolution = this.map.getView().getResolution();
      // Two corners on top of each other make a zero-sized box; keep drawing.
      if (ol.extent.getWidth(extent) < resolution * 3 || ol.extent.getHeight(extent) < resolution * 3) return false;
      const area = bboxArea(ol.proj.transformExtent(extent, VIEW_PROJECTION, DATA_PROJECTION));
      setTimeout(() => {
        this.stopDraw();
        this.emit('areaDrawn', area);
      });
      return true;
    };

    const onDown = (event) => {
      if (event.originalEvent.button > 0) return;
      pointerDown = { pixel: event.pixel, coordinate: event.coordinate };
    };
    const onMove = (event) => {
      const anchor = fixedCorner || pointerDown?.coordinate;
      if (anchor) preview(anchor, event.coordinate);
    };
    const onUp = (event) => {
      if (!pointerDown) return;
      const anchor = fixedCorner || pointerDown.coordinate;
      const moved = Math.hypot(event.pixel[0] - pointerDown.pixel[0], event.pixel[1] - pointerDown.pixel[1]);
      pointerDown = null;
      if (moved >= DRAG_TOLERANCE_PX) {
        finish(anchor, event.coordinate);
      } else if (fixedCorner) {
        finish(fixedCorner, event.coordinate);
      } else {
        fixedCorner = anchor;
        preview(anchor, anchor);
      }
    };
    this.map.on('pointerdown', onDown);
    this.map.on('pointermove', onMove);
    this.map.on('pointerup', onUp);

    this.#boxDraw = {
      destroy: () => {
        this.map.un('pointerdown', onDown);
        this.map.un('pointermove', onMove);
        this.map.un('pointerup', onUp);
        dragPan?.setActive(true);
        this.map.removeLayer(layer);
      },
    };
  }

  stopDraw() {
    if (!this.#drawMode) return;
    this.#boxDraw?.destroy();
    this.#boxDraw = null;
    if (this.#draw) {
      this.#draw.abortDrawing();
      this.map.removeInteraction(this.#draw);
      this.#draw = null;
    }
    this.#drawMode = null;
    this.target.classList.remove('is-drawing');
    this.emit('drawModeChanged', null);
  }

  setSearchArea(area, { fit = false } = {}) {
    this.areaSource.clear();
    if (!area) return;
    const geometry = area.kind === 'bbox'
      ? ol.geom.Polygon.fromExtent(ol.proj.transformExtent(area.bbox, DATA_PROJECTION, VIEW_PROJECTION))
      : this.format.readGeometry(clampLat(area.geometry));
    this.areaSource.addFeature(new ol.Feature(geometry));
    if (fit) this.fitSearchArea();
  }

  fitSearchArea() {
    const extent = this.areaSource.getExtent();
    if (extent && Number.isFinite(extent[0])) this.#fit(extent);
  }

  // ── Results ─────────────────────────────────────────────────────────────

  addItems(items) {
    const features = [];
    for (const item of items) {
      const feature = new ol.Feature(this.#itemGeometry(item));
      // Silent: a normal set() dispatches two events per feature.
      feature.set('uid', item.uid, true);
      features.push(feature);
      this.#features.set(item.uid, feature);
    }
    // One addFeatures call bulk-loads the R-tree instead of inserting one by one.
    this.resultSource.addFeatures(features);
    this.#addThumbnails(items);
  }

  clearItems() {
    this.resultSource.clear(true);
    this.#features.clear();
    this.#checked = new Set();
    this.#highlighted = new Set();
    for (const layer of this.#thumbnails) this.thumbnailGroup.getLayers().remove(layer);
    this.#thumbnails = [];
    this.resultLayer.changed();
  }

  setChecked(uids) {
    this.#checked = new Set(uids);
    this.resultLayer.changed();
  }

  setHighlighted(uids) {
    this.#highlighted = new Set(uids);
    this.resultLayer.changed();
  }

  zoomToItem(uid) {
    const feature = this.#features.get(uid);
    if (feature) this.#fit(feature.getGeometry().getExtent());
  }

  zoomToItems(uids) {
    const extent = ol.extent.createEmpty();
    for (const uid of uids) {
      const feature = this.#features.get(uid);
      if (feature) ol.extent.extend(extent, feature.getGeometry().getExtent());
    }
    if (!ol.extent.isEmpty(extent)) this.#fit(extent);
  }

  setThumbnailsVisible(visible) {
    this.#thumbnailsVisible = visible;
    this.thumbnailGroup.setVisible(visible);
  }

  get thumbnailCount() {
    return this.#thumbnails.length;
  }

  setBasemapMuted(muted) {
    this.target.classList.toggle('basemap-muted', muted);
  }

  /** Item uids under a screen pixel. */
  hitTest(pixel) {
    // Geometric, not pixel-based: forEachFeatureAtPixel re-rasterises every
    // candidate into a scratch canvas, which stalls on dense result sets. The
    // R-tree narrows the candidates; each is then tested against a box the size
    // of its rendered symbol. intersectsExtent handles every geometry type,
    // including a click inside a polygon's hole (a miss).
    const coordinate = this.map.getCoordinateFromPixel(pixel);
    const resolution = this.map.getView().getResolution();
    if (!coordinate || !resolution) return [];
    const box = (px) => {
      const r = px * resolution;
      return [coordinate[0] - r, coordinate[1] - r, coordinate[0] + r, coordinate[1] + r];
    };
    const hits = new Set();
    this.resultSource.forEachFeatureInExtent(box(MAX_HIT_TOLERANCE_PX), (feature) => {
      const uid = feature.get('uid');
      const geometry = feature.getGeometry();
      if (!uid || hits.has(uid) || !geometry) return;
      if (geometry.intersectsExtent(box(HIT_TOLERANCE_PX[geometry.getType()] ?? MAX_HIT_TOLERANCE_PX))) hits.add(uid);
    });
    return [...hits];
  }

  // ── Internals ───────────────────────────────────────────────────────────

  #itemGeometry(item) {
    const clamp = item.bbox[1] < -MERCATOR_MAX_LAT || item.bbox[3] > MERCATOR_MAX_LAT;
    if (item.geometry) {
      try {
        return this.format.readGeometry(clamp ? clampLat(item.geometry) : item.geometry);
      } catch {
        /* malformed geometry: fall back to the bbox */
      }
    }
    const [minX, minY, maxX, maxY] = item.bbox;
    const bbox = [minX, Math.max(minY, -MERCATOR_MAX_LAT), maxX, Math.min(maxY, MERCATOR_MAX_LAT)];
    return ol.geom.Polygon.fromExtent(ol.proj.transformExtent(bbox, DATA_PROJECTION, VIEW_PROJECTION));
  }

  #addThumbnails(items) {
    for (const item of items) {
      if (!item.thumbnailUrl || this.#thumbnails.length >= THUMBNAIL_LIMIT) continue;
      const layer = new ol.layer.Image({
        source: new ol.source.ImageStatic({
          url: item.thumbnailUrl,
          imageExtent: item.bbox,
          projection: DATA_PROJECTION,
          crossOrigin: 'anonymous',
        }),
        opacity: 0.85,
      });
      this.#thumbnails.push(layer);
      this.thumbnailGroup.getLayers().push(layer);
    }
  }

  #fit(extent) {
    this.map.getView().fit(extent, { duration: 350, padding: [48, 48, 48, 48], maxZoom: 16 });
  }

  /**
   * The styles, built once. Items have four visual states (checked ×
   * highlighted), so the style objects are shared by every feature in a state.
   */
  #buildStyles() {
    const result = cssVar('--map-result', '#e0782c');
    const checked = cssVar('--map-checked', '#0b8ea6');
    const area = cssVar('--map-area', '#4a4940');
    const make = (isChecked, isHighlighted) => {
      const color = isChecked ? checked : result;
      const fill = new ol.style.Fill({ color: withAlpha(color, isChecked ? 0.16 : 0.07) });
      const stroke = new ol.style.Stroke({ color, width: isHighlighted ? 2.5 : 1.5 });
      const main = new ol.style.Style({
        stroke,
        fill,
        image: new ol.style.Circle({ radius: isHighlighted ? 7 : 5, stroke, fill: new ol.style.Fill({ color: withAlpha(color, 0.35) }) }),
        zIndex: isHighlighted ? 2 : isChecked ? 1 : 0,
      });
      if (!isHighlighted) return [main];
      const halo = new ol.style.Style({
        stroke: new ol.style.Stroke({ color: 'rgba(255,255,255,0.8)', width: 7 }),
        image: new ol.style.Circle({ radius: 11, fill: new ol.style.Fill({ color: 'rgba(255,255,255,0.8)' }) }),
        zIndex: 2,
      });
      return [halo, main];
    };
    const areaStroke = new ol.style.Stroke({ color: area, width: 2, lineDash: [8, 5] });
    this.#styles = {
      // Indexed by checked | highlighted << 1.
      items: [make(false, false), make(true, false), make(false, true), make(true, true)],
      area: [
        new ol.style.Style({ stroke: new ol.style.Stroke({ color: 'rgba(255,255,255,0.85)', width: 5 }) }),
        new ol.style.Style({
          stroke: areaStroke,
          fill: new ol.style.Fill({ color: withAlpha(area, 0.08) }),
          image: new ol.style.Circle({ radius: 6, stroke: areaStroke, fill: new ol.style.Fill({ color: 'rgba(255,255,255,0.8)' }) }),
        }),
      ],
      drawing: new ol.style.Style({
        stroke: new ol.style.Stroke({ color: area, width: 2, lineDash: [6, 4] }),
        fill: new ol.style.Fill({ color: withAlpha(area, 0.1) }),
        image: new ol.style.Circle({ radius: 5, fill: new ol.style.Fill({ color: area }), stroke: new ol.style.Stroke({ color: '#fff', width: 1.5 }) }),
      }),
    };
  }

  #styleFor(uid) {
    // null draws nothing; undefined would fall back to OpenLayers' default style.
    if (uid === undefined) return null;
    return this.#styles.items[(this.#checked.has(uid) ? 1 : 0) | (this.#highlighted.has(uid) ? 2 : 0)];
  }
}
