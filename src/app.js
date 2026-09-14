// The application: its state, the actions on it, and the wiring between the
// panels. Panels read state from here and call actions; they never talk to each
// other directly.
//
// Events (app.on):
//   api                  the selected API changed
//   area                 the search area changed
//   query, time          attribute filter / time range changed
//   collections          the collection list changed (loading, loaded, error)
//   collectionSelection  which collections are ticked changed
//   results              results were reset (new search, cleared)
//   resultsAdded         a page of results arrived
//   resultsStatus        searching / done / stopped / error
//   checked              the set ticked for download changed
//   highlight            the highlighted rows changed ({ scroll })
//   drawer, download

import { ApiRegistry, hasQueryBuilder, needsAuthForBrowse } from './config/apis.js';
import { BindingStore, ProfileStore } from './auth/profiles.js';
import { AuthSession } from './auth/session.js';
import { Vault } from './auth/vault.js';
import { entriesFor } from './downloads/runner.js';
import { LARGE_VERTEX_COUNT, geometryArea, vertexCount } from './geo/area.js';
import { ACCEPTED_FILES, loadSearchGeometry } from './geo/loaders.js';
import { button, h, icon } from './lib/dom.js';
import { Emitter } from './lib/emitter.js';
import { formatNumber, todayIso } from './lib/format.js';
import { isAbort } from './lib/http.js';
import { getLanguagePref, setLanguagePref, t, tn } from './i18n/index.js';
import * as store from './lib/store.js';
import { MapView, THUMBNAIL_LIMIT } from './map/map-view.js';
import { StacClient } from './stac/client.js';
import { scan } from './stac/schema-scanner.js';
import { openApisDialog } from './ui/apis-dialog.js';
import { ensureCredentials } from './ui/credentials.js';
import { alertDialog, confirmDialog } from './ui/dialog.js';
import { startDownload } from './ui/download-dialog.js';
import { openMenu } from './ui/menu.js';
import { openProfilesDialog } from './ui/profiles-dialog.js';
import { PropertiesPanel } from './ui/properties-panel.js';
import { openQueryBuilder } from './ui/query-builder.js';
import { ResultsPanel } from './ui/results-panel.js';
import { openAboutDialog, openExportDialog, openImportDialog } from './ui/settings.js';
import { Sidebar } from './ui/sidebar.js';
import { toast } from './ui/toast.js';
import { APP_VERSION } from './version.js';

const DEFAULT_PREFS = {
  api: null,
  maxResults: 1000,
  resultsHeight: 300,
  thumbnails: true,
  basemapMuted: false,
  theme: 'system',
};

class Prefs {
  #values;

  constructor() {
    const stored = store.load('prefs', {});
    this.#values = { ...DEFAULT_PREFS, ...(stored && typeof stored === 'object' ? stored : {}) };
  }

  get(key) {
    return this.#values[key];
  }

  set(key, value) {
    this.#values[key] = value;
    store.save('prefs', this.#values);
  }

  /** Preferences worth moving between browsers (not the last API or panel size). */
  exportable() {
    const { maxResults, thumbnails, basemapMuted, theme } = this.#values;
    return { maxResults, thumbnails, basemapMuted, theme };
  }
}

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
}

const emptyResults = () => ({ items: [], byUid: new Map(), cursor: null, status: 'idle', api: null, error: null });

export class App extends Emitter {
  #searchController = null;
  #collectionsController = null;
  #schemas = new Map();
  #thumbnailNoticeShown = false;

  constructor(root) {
    super();
    this.root = root;
    this.version = APP_VERSION;
    this.prefs = new Prefs();
    this.apis = new ApiRegistry();
    this.vault = new Vault();
    this.profiles = new ProfileStore(this.vault);
    this.bindings = new BindingStore();
    this.auth = new AuthSession(this.profiles, this.bindings, this.vault);

    this.api = null;
    this.area = null;
    this.query = null;
    this.time = { enabled: false, from: todayIso(-1), to: todayIso() };
    this.collections = { apiName: null, list: [], status: 'idle', error: null, titles: new Map() };
    this.selectedCollections = new Set();
    this.results = emptyResults();
    this.checked = new Set();
    this.highlighted = [];
    this.activeDownload = null;
  }

  async start() {
    applyTheme(this.prefs.get('theme'));
    this.#localizeStaticMarkup();
    this.#buildLayout();
    try {
      await this.apis.loadBuiltIn();
    } catch (error) {
      toast(t('app.builtInListError', { message: error.message }), { kind: 'error' });
    }
    this.apis.on('change', (detail) => this.#onApisChanged(detail));
    const first = this.apis.get(this.prefs.get('api')) || this.apis.all[0];
    if (first) this.selectApi(first.name, { force: true });

    // Credentials becoming available (a profile bound, the vault unlocked) is
    // the moment an auth-only API's collections can load.
    const retryCollections = () => {
      if (this.api && this.collections.status === 'idle') this.#autoLoadCollections(this.api);
    };
    this.bindings.on('change', retryCollections);
    this.profiles.on('change', retryCollections);

    window.addEventListener('beforeunload', (event) => {
      if (this.activeDownload) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
  }

  // ── Layout ──────────────────────────────────────────────────────────────

  /** index.html's static text and aria attributes, set once the locale is known. */
  #localizeStaticMarkup() {
    const { root } = this;
    const toggle = root.querySelector('#sidebar-toggle');
    toggle.title = t('index.searchPanel');
    toggle.setAttribute('aria-label', t('index.searchPanel'));
    root.querySelector('.brand').setAttribute('aria-label', t('index.brandHomeAria', { name: 'Rådhuset API Browser' }));
    root.querySelector('#map').setAttribute('aria-label', t('index.map'));
    root.querySelector('#sidebar').setAttribute('aria-label', t('common.search'));
    root.querySelector('#results').setAttribute('aria-label', t('index.results'));
    root.querySelector('.splitter').setAttribute('aria-label', t('index.resizeResults'));
    document.querySelector('meta[name="description"]')?.setAttribute('content', t('index.metaDescription'));
  }

  #buildLayout() {
    const { root } = this;
    const actions = root.querySelector('.appbar-actions');
    this.propsToggle = button(t('app.showProperties'), { icon: 'panelRight', class: 'props-toggle', 'aria-pressed': 'false', 'aria-label': t('app.showProperties'), onClick: () => this.properties.toggle() });
    const menuButton = button('', { icon: 'settings', variant: 'ghost', title: t('app.settingsTitle'), 'aria-haspopup': 'menu', onClick: () => this.#openAppMenu(menuButton) });
    actions.append(this.propsToggle, menuButton);
    this.on('drawer', (open) => this.propsToggle.setAttribute('aria-pressed', String(open)));
    root.querySelector('#sidebar-toggle').addEventListener('click', () => root.classList.toggle('sidebar-open'));

    const mapArea = root.querySelector('.map-area');
    this.map = new MapView(root.querySelector('#map'));
    this.map.setThumbnailsVisible(this.prefs.get('thumbnails'));
    this.map.setBasemapMuted(this.prefs.get('basemapMuted'));
    this.map.on('areaDrawn', (area) => this.#acceptDrawnArea(area));
    this.map.on('itemsClicked', (uids, event) => {
      if (event?.ctrlKey || event?.metaKey) {
        const set = new Set(this.highlighted);
        for (const uid of uids) (set.has(uid) ? set.delete(uid) : set.add(uid));
        this.setHighlighted([...set], { scroll: true });
      } else {
        this.setHighlighted(uids, { scroll: true });
      }
    });
    this.map.on('contextMenu', ({ uids, x, y }) => {
      if (uids.length) this.openItemMenu({ uids, x, y, source: 'map' });
    });
    this.#buildMapOverlay(mapArea);

    this.sidebar = new Sidebar(this);
    root.querySelector('#sidebar').append(this.sidebar.el);
    this.resultsPanel = new ResultsPanel(this);
    root.querySelector('#results').append(this.resultsPanel.el);
    this.properties = new PropertiesPanel(this);
    root.querySelector('.workspace').append(this.properties.el);
    this.#initSplitter(root.querySelector('.splitter'), root.querySelector('.stage'));
  }

  #buildMapOverlay(mapArea) {
    const tool = (iconName, title, onClick, pressed = null) => h(
      'button',
      { type: 'button', class: 'map-tool', title, 'aria-label': title, 'aria-pressed': pressed === null ? null : String(pressed), onclick: onClick },
      icon(iconName, { size: 18 }),
    );
    const togglePref = (key, apply) => function onToggle() {
      const value = !this.getAttribute('aria-pressed') || this.getAttribute('aria-pressed') === 'false';
      this.setAttribute('aria-pressed', String(value));
      apply(value);
    };
    const thumbnails = tool('image', t('app.showThumbnails'), null, this.prefs.get('thumbnails'));
    thumbnails.onclick = togglePref('thumbnails', (v) => { this.prefs.set('thumbnails', v); this.map.setThumbnailsVisible(v); });
    const muted = tool('layers', t('app.greyBaseMap'), null, this.prefs.get('basemapMuted'));
    muted.onclick = togglePref('basemapMuted', (v) => { this.prefs.set('basemapMuted', v); this.map.setBasemapMuted(v); });

    const hintText = h('span');
    const hint = h('div', { class: 'draw-hint', hidden: true, role: 'status' }, hintText, button(t('common.cancel'), { size: 'sm', variant: 'ghost', onClick: () => this.map.stopDraw() }));
    const searchAreaBar = this.#buildSearchAreaBar();
    const mobileSearchBar = this.#buildMobileSearchBar();
    this.map.on('drawModeChanged', (mode) => {
      hint.hidden = !mode;
      hintText.textContent = mode === 'box'
        ? t('app.drawBoxHint')
        : t('app.drawPolygonHint');
      searchAreaBar.drawBox.setAttribute('aria-pressed', String(mode === 'box'));
      searchAreaBar.drawPolygon.setAttribute('aria-pressed', String(mode === 'polygon'));
    });

    const dropZone = h('div', { class: 'drop-zone', hidden: true }, icon('upload', { size: 28 }), h('p', { text: t('app.dropToUseAsSearchArea') }));
    let dragDepth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    mapArea.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; dropZone.hidden = false; } });
    mapArea.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    mapArea.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropZone.hidden = true; });
    mapArea.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      dropZone.hidden = true;
      this.loadAreaFromFiles([...e.dataTransfer.files]);
    });

    const mapTools = h(
      'div',
      { class: 'map-tools' },
      tool('target', t('app.zoomToResults'), () => this.map.zoomToItems([...this.results.byUid.keys()])),
      h('span', { class: 'map-tools-sep' }),
      thumbnails,
      muted,
    );
    // Reparent OpenLayers' own attribution control below the toolbar (rather
    // than its default bottom-right corner), so that corner stays free for
    // the search-area toolbar to use. It keeps OL's own look — it's a single
    // control, not a row of our own icon buttons — but a matching card behind
    // it (see .map-tools-attribution in app.css) ties it visually to the
    // toolbar above it.
    const attribution = this.map.attributionElement;
    if (attribution) mapTools.append(h('div', { class: 'map-tools-attribution' }, attribution));

    mapArea.append(mapTools, searchAreaBar.el, mobileSearchBar, hint, dropZone);
  }

  /**
   * A small floating bar above the search-area toolbar, holding just the
   * Search button — only shown on narrow screens (see .mobile-search-bar in
   * app.css), where the sidebar with the "real" search button isn't open by
   * default.
   */
  #buildMobileSearchBar() {
    const search = button(t('common.search'), { icon: 'search', size: 'sm', variant: 'primary', onClick: () => this.search() });
    const stop = button(t('sidebar.stopSearching'), { icon: 'stop', size: 'sm', hidden: true, onClick: () => this.stopSearch() });
    const sync = () => {
      const searching = this.results.status === 'searching';
      search.hidden = searching;
      stop.hidden = !searching;
    };
    this.on('resultsStatus', sync);
    return h('div', { class: 'mobile-search-bar' }, search, stop);
  }

  /** The search-area toolbar docked on the map: draw, load, zoom to and clear. */
  #buildSearchAreaBar() {
    const fileInput = h('input', {
      type: 'file',
      accept: ACCEPTED_FILES,
      multiple: true,
      hidden: true,
      onchange: (event) => {
        const files = [...event.target.files];
        event.target.value = '';
        if (files.length) this.loadAreaFromFiles(files);
      },
    });
    const drawBox = button(t('sidebar.drawBox'), { icon: 'box', size: 'sm', 'aria-pressed': 'false', title: t('sidebar.drawBoxTitle'), onClick: () => this.#toggleDraw('box') });
    const drawPolygon = button(t('sidebar.drawPolygon'), { icon: 'polygon', size: 'sm', 'aria-pressed': 'false', title: t('sidebar.drawPolygonTitle'), onClick: () => this.#toggleDraw('polygon') });
    const load = button(t('sidebar.loadFile'), { icon: 'upload', size: 'sm', variant: 'ghost', title: t('sidebar.loadFileTitle'), onClick: () => fileInput.click() });
    const zoomTo = button(t('sidebar.zoomTo'), { icon: 'target', size: 'sm', variant: 'ghost', title: t('sidebar.zoomTo'), onClick: () => this.map.fitSearchArea() });
    const clearArea = button(t('sidebar.clear'), { icon: 'x', size: 'sm', variant: 'ghost', title: t('sidebar.clear'), onClick: () => this.setArea(null) });
    for (const btn of [drawBox, drawPolygon, load, zoomTo, clearArea]) btn.setAttribute('aria-label', btn.title);
    const syncArea = () => {
      zoomTo.hidden = !this.area;
      clearArea.hidden = !this.area;
    };
    this.on('area', syncArea);
    syncArea();

    const el = h(
      'div',
      { class: 'search-area-bar' },
      h('div', { class: 'search-area-label' }, icon('map', { size: 14 }), h('span', { text: t('sidebar.searchArea') })),
      h('span', { class: 'toolbar-sep' }),
      drawBox,
      drawPolygon,
      load,
      h('span', { class: 'toolbar-sep' }),
      zoomTo,
      clearArea,
      fileInput,
    );
    return { el, drawBox, drawPolygon };
  }

  #toggleDraw(mode) {
    const { map } = this;
    if (map.drawMode === mode) map.stopDraw();
    else map.startDraw(mode);
  }

  #initSplitter(handle, stage) {
    const results = this.root.querySelector('#results');
    const apply = (px) => stage.style.setProperty('--results-height', `${Math.round(px)}px`);
    const clamp = (px) => Math.max(120, Math.min(stage.clientHeight - 180, px));
    apply(this.prefs.get('resultsHeight'));
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const startY = event.clientY;
      const start = results.getBoundingClientRect().height;
      let latest = start;
      const move = (e) => {
        latest = clamp(start - (e.clientY - startY));
        apply(latest);
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        this.prefs.set('resultsHeight', Math.round(latest));
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
    handle.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      const next = clamp(results.getBoundingClientRect().height + (event.key === 'ArrowUp' ? 32 : -32));
      apply(next);
      this.prefs.set('resultsHeight', Math.round(next));
    });
  }

  #openAppMenu(anchor) {
    const theme = this.prefs.get('theme');
    const themeItem = (value, label) => ({
      label,
      icon: theme === value ? 'check' : null,
      onSelect: () => {
        this.prefs.set('theme', value);
        applyTheme(value);
      },
    });
    const language = getLanguagePref();
    const languageItem = (value, label) => ({
      label,
      icon: language === value ? 'check' : null,
      onSelect: () => {
        if (value === language) return;
        setLanguagePref(value);
        window.location.reload();
      },
    });
    openMenu({
      anchor,
      align: 'end',
      items: [
        { label: t('app.menu.authProfiles'), icon: 'key', onSelect: () => this.openProfiles() },
        { label: t('app.menu.yourApis'), icon: 'api', onSelect: () => this.openApis() },
        'separator',
        { label: t('app.menu.exportSettings'), icon: 'export', onSelect: () => openExportDialog(this) },
        { label: t('app.menu.importSettings'), icon: 'import', onSelect: () => openImportDialog(this) },
        'separator',
        { heading: t('app.menu.theme') },
        themeItem('system', t('app.menu.themeSystem')),
        themeItem('light', t('app.menu.themeLight')),
        themeItem('dark', t('app.menu.themeDark')),
        'separator',
        { heading: t('app.menu.language') },
        languageItem('system', t('app.menu.languageSystem')),
        languageItem('en', t('app.menu.languageEn')),
        languageItem('sv', t('app.menu.languageSv')),
        'separator',
        { label: t('app.menu.about'), icon: 'info', onSelect: () => openAboutDialog(this) },
      ],
    });
  }

  applyPreferences(values) {
    for (const key of ['maxResults', 'thumbnails', 'basemapMuted', 'theme']) {
      if (key in values && typeof values[key] === typeof DEFAULT_PREFS[key]) this.prefs.set(key, values[key]);
    }
    applyTheme(this.prefs.get('theme'));
    this.map.setThumbnailsVisible(this.prefs.get('thumbnails'));
    this.map.setBasemapMuted(this.prefs.get('basemapMuted'));
  }

  // ── API ─────────────────────────────────────────────────────────────────

  selectApi(name, { force = false } = {}) {
    const api = this.apis.get(name);
    if (!api || (!force && this.api?.name === name)) return;
    this.stopSearch();
    this.#collectionsController?.abort();
    this.api = api;
    this.prefs.set('api', api.name);
    // A query is written against one API's schema, and collections belong to
    // one API: neither carries over. The search area and time range do.
    this.query = null;
    this.collections = { apiName: api.name, list: [], status: 'idle', error: null, titles: new Map() };
    this.selectedCollections = new Set();
    this.clearResults();
    this.root.classList.remove('sidebar-open');
    this.emit('api');
    this.emit('query');
    this.emit('collections');
    this.emit('collectionSelection');
    this.#autoLoadCollections(api);
  }

  #onApisChanged(detail = {}) {
    if (!this.api) return;
    if (detail.renamed?.from === this.api.name) {
      this.selectApi(detail.renamed.to, { force: true });
      return;
    }
    const fresh = this.apis.get(this.api.name);
    if (!fresh) {
      const first = this.apis.all[0];
      if (first) this.selectApi(first.name, { force: true });
    } else if (JSON.stringify(fresh) !== JSON.stringify(this.api)) {
      // Its URL, type or auth changed: everything fetched from it is suspect.
      this.selectApi(fresh.name, { force: true });
    }
  }

  // ── Collections ─────────────────────────────────────────────────────────

  async #autoLoadCollections(api) {
    if (needsAuthForBrowse(api)) {
      // Only if credentials are at hand already — never prompt unasked.
      try {
        if (!(await this.auth.credentialsFor(api.name))) return;
      } catch {
        return;
      }
    }
    if (this.api === api && this.collections.status === 'idle') this.loadCollections({ interactive: false });
  }

  async loadCollections({ interactive = true } = {}) {
    const { api } = this;
    if (!api) return;
    if (interactive && !(await ensureCredentials(this, api, 'browse'))) return;
    if (this.api !== api) return;
    this.#collectionsController?.abort();
    const controller = new AbortController();
    this.#collectionsController = controller;
    this.collections = { ...this.collections, status: 'loading', error: null };
    this.emit('collections');
    try {
      const list = await new StacClient(api, this.auth).getCollections({ signal: controller.signal });
      if (this.api !== api) return;
      const ids = new Set(list.map((c) => c.id));
      this.selectedCollections = new Set([...this.selectedCollections].filter((id) => ids.has(id)));
      this.collections = { apiName: api.name, list, status: 'loaded', error: null, titles: new Map(list.filter((c) => c.title).map((c) => [c.id, c.title])) };
    } catch (error) {
      if (isAbort(error) || this.api !== api) return;
      this.collections = { ...this.collections, status: 'error', error: error.message };
      if (interactive) toast(t('app.collectionsLoadFailedToast', { message: error.message }), { kind: 'error' });
    }
    this.emit('collections');
    this.emit('collectionSelection');
  }

  collectionTitle(id) {
    return this.collections.titles.get(id) || id || '—';
  }

  setCollectionsSelected(ids, selected) {
    for (const id of ids) {
      if (selected) this.selectedCollections.add(id);
      else this.selectedCollections.delete(id);
    }
    this.emit('collectionSelection');
  }

  // ── Search area and filters ─────────────────────────────────────────────

  setArea(area, { fit = false } = {}) {
    this.map.stopDraw();
    this.area = area;
    this.map.setSearchArea(area, { fit });
    // Results belong to the area they were searched in.
    if (this.results.status !== 'idle') this.clearResults();
    this.emit('area');
  }

  #acceptDrawnArea(area) {
    if (area.kind === 'geometry' && vertexCount(area.geometry) > LARGE_VERTEX_COUNT) {
      toast(t('app.complexGeometryToast'), { kind: 'warning' });
    }
    this.setArea(area);
  }

  async loadAreaFromFiles(files) {
    try {
      const { geometry, name, crsLabel, vertices } = await loadSearchGeometry(files);
      if (vertices > LARGE_VERTEX_COUNT) {
        const ok = await confirmDialog({
          title: t('app.complexGeometryTitle'),
          message: t('app.complexGeometryMessage', { name, vertices: formatNumber(vertices) }),
          confirmLabel: t('app.useAnyway'),
        });
        if (!ok) return;
      }
      this.setArea(geometryArea(geometry, { source: 'file', name }), { fit: true });
      toast(t('app.areaLoadedToast', { name, crs: crsLabel }), { kind: 'success' });
    } catch (error) {
      alertDialog({ title: t('app.areaLoadFailedTitle'), message: error.message, kind: 'error' });
    }
  }

  setQuery(query) {
    this.query = query || null;
    this.emit('query');
  }

  setTime(patch) {
    Object.assign(this.time, patch);
    this.emit('time');
  }

  #datetimeRange() {
    const { enabled, from, to } = this.time;
    if (!enabled || (!from && !to)) return null;
    if (from && to && from > to) throw new Error(t('app.timeRangeError'));
    return `${from ? `${from}T00:00:00Z` : '..'}/${to ? `${to}T23:59:59Z` : '..'}`;
  }

  async openQueryBuilder() {
    const { api } = this;
    if (!hasQueryBuilder(api)) return;
    if (!(await ensureCredentials(this, api, 'browse'))) return;
    const key = `${api.schemaUrl}#${api.schemaQueryDepth}`;
    let result = this.#schemas.get(key);
    if (!result) {
      const notice = toast(t('app.loadingQuerySchema'), { timeout: 0 });
      try {
        const schema = await new StacClient(api, this.auth).fetchSchema(api.schemaUrl);
        result = scan(schema, api.schemaQueryDepth);
        this.#schemas.set(key, result);
      } catch (error) {
        alertDialog({ title: t('app.querySchemaFailedTitle'), message: error.message, kind: 'error' });
        return;
      } finally {
        notice.dismiss();
      }
    }
    if (this.api !== api) return;
    if (!result.fields.length) {
      alertDialog({ title: t('app.noQueryableFieldsTitle'), message: t('app.noQueryableFieldsMessage') });
      return;
    }
    const query = await openQueryBuilder({ scan: result, existing: this.query });
    if (query !== undefined && this.api === api) this.setQuery(query);
  }

  // ── Search ──────────────────────────────────────────────────────────────

  async search() {
    const { api } = this;
    if (!api || this.results.status === 'searching') return;
    let datetime;
    try {
      datetime = this.#datetimeRange();
    } catch (error) {
      alertDialog({ title: t('app.checkTimeRangeTitle'), message: error.message });
      return;
    }
    if (!this.area) {
      const go = await confirmDialog({
        title: t('app.noSearchAreaTitle'),
        message: t('app.noSearchAreaMessage'),
        confirmLabel: t('app.searchEverywhere'),
      });
      if (!go) return;
    }
    if (!(await ensureCredentials(this, api, 'browse')) || this.api !== api) return;

    const params = {
      area: this.area,
      datetime,
      collections: [...this.selectedCollections],
      query: hasQueryBuilder(api) ? this.query : null,
    };
    this.clearResults();
    this.results = { ...emptyResults(), status: 'searching', api };
    this.#thumbnailNoticeShown = false;
    this.root.classList.remove('sidebar-open');
    this.emit('results');
    this.emit('resultsStatus');
    // Titles for the collection column, if they are not loaded yet.
    if (this.collections.status === 'idle' || this.collections.status === 'error') this.loadCollections({ interactive: false });
    const client = new StacClient(api, this.auth);
    await this.#runSearch((options) => client.search(params, options));
  }

  async loadMore() {
    const { cursor, api, status } = this.results;
    if (!cursor || status === 'searching') return;
    if (!(await ensureCredentials(this, api, 'browse'))) return;
    this.results.status = 'searching';
    this.emit('resultsStatus');
    const client = new StacClient(api, this.auth);
    await this.#runSearch((options) => client.continueSearch(cursor, options));
  }

  async #runSearch(run) {
    const controller = new AbortController();
    this.#searchController = controller;
    const results = this.results;
    const maxItems = Number(this.prefs.get('maxResults')) || Infinity;
    try {
      const { cursor } = await run({
        signal: controller.signal,
        maxItems,
        onPage: (page, next) => {
          if (this.results !== results) return;
          results.cursor = next;
          this.#addPage(page);
        },
      });
      if (this.results !== results) return;
      results.cursor = cursor;
      results.status = 'done';
    } catch (error) {
      if (this.results !== results) return;
      if (isAbort(error)) {
        results.status = 'stopped';
      } else {
        results.status = 'error';
        results.error = error.message;
        alertDialog({ title: t('app.searchFailedTitle'), message: error.message, kind: 'error' });
      }
    } finally {
      if (this.#searchController === controller) this.#searchController = null;
    }
    this.emit('resultsStatus');
  }

  #addPage(page) {
    const fresh = [];
    for (const item of page) {
      if (this.results.byUid.has(item.uid)) continue;
      this.results.byUid.set(item.uid, item);
      this.results.items.push(item);
      fresh.push(item);
    }
    if (!fresh.length) return;
    this.map.addItems(fresh);
    this.emit('resultsAdded', fresh);
    if (!this.#thumbnailNoticeShown && this.map.thumbnailCount >= THUMBNAIL_LIMIT && this.prefs.get('thumbnails')) {
      this.#thumbnailNoticeShown = true;
      toast(t('app.thumbnailLimitToast', { n: formatNumber(THUMBNAIL_LIMIT) }));
    }
  }

  stopSearch() {
    this.#searchController?.abort();
  }

  clearResults() {
    this.stopSearch();
    this.results = emptyResults();
    this.checked = new Set();
    this.highlighted = [];
    this.map.clearItems();
    this.emit('results');
    this.emit('resultsStatus');
    this.emit('checked');
    this.emit('highlight', {});
  }

  // ── Selection ───────────────────────────────────────────────────────────

  setChecked(uids, checked) {
    for (const uid of uids) {
      if (!this.results.byUid.has(uid)) continue;
      if (checked) this.checked.add(uid);
      else this.checked.delete(uid);
    }
    this.map.setChecked(this.checked);
    this.emit('checked');
  }

  checkAll(checked) {
    this.checked = checked ? new Set(this.results.byUid.keys()) : new Set();
    this.map.setChecked(this.checked);
    this.emit('checked');
  }

  setHighlighted(uids, { scroll = false } = {}) {
    this.highlighted = [...new Set(uids)].filter((uid) => this.results.byUid.has(uid));
    this.map.setHighlighted(this.highlighted);
    this.emit('highlight', { scroll });
  }

  showProperties(uid = null) {
    this.properties.open(uid);
  }

  openItemMenu({ uids, x, y, source }) {
    const items = uids.map((uid) => this.results.byUid.get(uid)).filter(Boolean);
    if (!items.length) return;
    const suffix = items.length > 1 ? ` (${items.length})` : '';
    const allChecked = uids.every((uid) => this.checked.has(uid));
    const files = items.reduce((n, item) => n + item.downloadable.length, 0);
    openMenu({
      x,
      y,
      items: [
        allChecked
          ? { label: t('app.itemMenu.deselect', { suffix }), icon: 'x', onSelect: () => this.setChecked(uids, false) }
          : { label: t('app.itemMenu.selectForDownload', { suffix }), icon: 'check', onSelect: () => this.setChecked(uids, true) },
        {
          label: t('app.itemMenu.properties'),
          icon: 'panelRight',
          onSelect: () => {
            if (source === 'map') this.setHighlighted(uids, { scroll: true });
            this.showProperties(uids[0]);
          },
        },
        { label: items.length > 1 ? t('app.itemMenu.zoomToItems') : t('app.itemMenu.zoomToItem'), icon: 'target', onSelect: () => this.map.zoomToItems(uids) },
        'separator',
        { label: tn('app.itemMenu.downloadFiles', files), icon: 'download', disabled: !files, onSelect: () => this.downloadItems(items) },
      ],
    });
  }

  // ── Downloads ───────────────────────────────────────────────────────────

  downloadChecked() {
    this.downloadItems([...this.checked].map((uid) => this.results.byUid.get(uid)).filter(Boolean));
  }

  downloadItems(items) {
    return startDownload(this, { entries: entriesFor(items) });
  }

  downloadAssets(entries) {
    return startDownload(this, { entries });
  }

  // ── Dialogs ─────────────────────────────────────────────────────────────

  openProfiles(selectId = null) {
    openProfilesDialog(this, { selectId });
  }

  openApis() {
    openApisDialog(this);
  }
}
