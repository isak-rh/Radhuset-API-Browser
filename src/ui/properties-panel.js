// The properties drawer: raw STAC properties and assets for the highlighted or
// the selected items. Rebuilt only while open — while closed, changes just mark
// it stale.

import { button, clear, h, icon } from '../lib/dom.js';
import { formatBytes, formatDateTime } from '../lib/format.js';
import { t, tn } from '../i18n/index.js';
import { toast } from './toast.js';

const MAX_ITEMS = 50;

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('properties.copiedToClipboard'), { kind: 'success', timeout: 2000 });
  } catch {
    toast(t('properties.copyFailed'), { kind: 'error' });
  }
}

const valueText = (value) => (typeof value === 'string' ? value : JSON.stringify(value));

/** A collapsible JSON tree; children are built the first time a node is opened. */
function jsonNode(key, value, { open = false } = {}) {
  if (value !== null && typeof value === 'object') {
    const entries = Array.isArray(value) ? value.map((v, i) => [`[${i}]`, v]) : Object.entries(value);
    const details = h('details', { class: 'json-node', open: open || null });
    const summary = h(
      'summary',
      null,
      icon('chevronRight', { size: 13, className: 'json-caret' }),
      h('span', { class: 'json-key', text: key }),
      h('span', { class: 'json-meta', text: entries.length ? (Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`) : t('properties.empty') }),
      h('button', { type: 'button', class: 'json-copy', title: t('properties.copyAsJson'), onclick: (e) => { e.preventDefault(); copyText(JSON.stringify(value, null, 2)); } }, icon('copy', { size: 14 })),
    );
    details.append(summary);
    const body = h('div', { class: 'json-children' });
    details.append(body);
    let built = false;
    const build = () => {
      if (built) return;
      built = true;
      for (const [k, v] of entries) body.append(jsonNode(k, v));
    };
    if (open) build();
    details.addEventListener('toggle', () => { if (details.open) build(); });
    return details;
  }
  const text = value === null ? 'null' : valueText(value);
  return h(
    'div',
    { class: 'json-leaf' },
    h('span', { class: 'json-key', text: key }),
    h('span', { class: ['json-value', `json-${value === null ? 'null' : typeof value}`], text }),
    h('button', { type: 'button', class: 'json-copy', title: t('properties.copyValue'), onclick: () => copyText(text) }, icon('copy', { size: 14 })),
  );
}

export class PropertiesPanel {
  #tab = 'highlighted';
  #dirty = true;
  #focusUid = null;
  #frame = 0;

  constructor(app) {
    this.app = app;
    this.tabs = {
      highlighted: h('button', { type: 'button', class: 'segment', role: 'tab', onclick: () => this.setTab('highlighted') }),
      checked: h('button', { type: 'button', class: 'segment', role: 'tab', onclick: () => this.setTab('checked') }),
    };
    this.list = h('div', { class: 'props-list' });
    this.el = h(
      'aside',
      { class: 'drawer', 'aria-label': t('properties.title'), hidden: true },
      h(
        'header',
        { class: 'drawer-header' },
        h('h2', { class: 'drawer-title', text: t('properties.title') }),
        button('', { icon: 'x', variant: 'ghost', title: t('properties.close'), onClick: () => this.close() }),
      ),
      h('div', { class: 'segmented', role: 'tablist' }, this.tabs.highlighted, this.tabs.checked),
      this.list,
    );
    const stale = () => {
      this.#dirty = true;
      this.#schedule();
    };
    app.on('highlight', stale);
    app.on('checked', stale);
    app.on('results', stale);
    app.on('collections', stale);
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open(focusUid = null) {
    if (focusUid) {
      this.#focusUid = focusUid;
      this.#tab = 'highlighted';
      this.#dirty = true;
    }
    if (!this.isOpen) {
      this.el.hidden = false;
      this.app.emit('drawer', true);
    }
    this.#schedule();
  }

  close() {
    if (!this.isOpen) return;
    this.el.hidden = true;
    this.app.emit('drawer', false);
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  setTab(tab) {
    this.#tab = tab;
    this.#dirty = true;
    this.#schedule();
  }

  #schedule() {
    this.#updateTabs();
    if (!this.isOpen || !this.#dirty) return;
    cancelAnimationFrame(this.#frame);
    this.#frame = requestAnimationFrame(() => this.#render());
  }

  #updateTabs() {
    this.tabs.highlighted.textContent = t('properties.highlightedTab', { n: this.app.highlighted.length });
    this.tabs.checked.textContent = t('properties.selectedTab', { n: this.app.checked.size });
    for (const [key, tab] of Object.entries(this.tabs)) {
      tab.classList.toggle('is-active', key === this.#tab);
      tab.setAttribute('aria-selected', String(key === this.#tab));
    }
  }

  #render() {
    this.#dirty = false;
    this.#updateTabs();
    const { app } = this;
    const uids = this.#tab === 'highlighted' ? app.highlighted : [...app.checked];
    const items = uids.map((uid) => app.results.byUid.get(uid)).filter(Boolean);
    clear(this.list);
    if (!items.length) {
      this.list.append(h('p', {
        class: 'empty-state',
        text: this.#tab === 'highlighted'
          ? t('properties.highlightedEmpty')
          : t('properties.checkedEmpty'),
      }));
      return;
    }
    const shown = items.slice(0, MAX_ITEMS);
    for (const item of shown) {
      const open = shown.length === 1 || item.uid === this.#focusUid;
      const card = this.#itemCard(item, open);
      this.list.append(card);
      if (item.uid === this.#focusUid) requestAnimationFrame(() => card.scrollIntoView({ block: 'start' }));
    }
    this.#focusUid = null;
    if (items.length > shown.length) {
      this.list.append(h('p', { class: 'muted small', text: tn('properties.showingFirst', items.length, { max: MAX_ITEMS }) }));
    }
  }

  #itemCard(item, open) {
    const { app } = this;
    const assets = item.downloadable.map((asset) => h(
      'li',
      { class: 'asset-row' },
      icon('file', { size: 16 }),
      h(
        'div',
        { class: 'asset-text' },
        h('span', { class: 'asset-title', text: asset.title, title: asset.key }),
        h('span', { class: 'asset-meta', text: [asset.type.split(';')[0], asset.roles.join(', '), asset.size ? formatBytes(asset.size) : null].filter(Boolean).join(' · ') || asset.key }),
      ),
      button('', { icon: 'copy', variant: 'ghost', size: 'sm', title: t('properties.copyLink'), onClick: () => copyText(asset.href) }),
      button('', { icon: 'download', variant: 'ghost', size: 'sm', title: t('properties.downloadAsset', { title: asset.title }), onClick: () => app.downloadAssets([{ item, asset }]) }),
    ));
    return h(
      'details',
      { class: 'prop-item', open: open || null },
      h(
        'summary',
        null,
        icon('chevronRight', { size: 15, className: 'prop-item-caret' }),
        h('div', { class: 'prop-item-heading' }, h('span', { class: 'prop-item-title', text: item.title }), h('span', { class: 'prop-item-meta', text: [app.collectionTitle(item.collection), formatDateTime(item.datetime)].filter((v) => v && v !== '—').join(' · ') })),
      ),
      h(
        'div',
        { class: 'prop-item-body' },
        h(
          'div',
          { class: 'prop-actions' },
          button(t('properties.zoomTo'), { icon: 'target', size: 'sm', onClick: () => app.map.zoomToItem(item.uid) }),
          item.downloadable.length
            ? button(item.downloadable.length > 1 ? t('properties.downloadAll', { n: item.downloadable.length }) : t('properties.download'), {
                icon: 'download', size: 'sm', onClick: () => app.downloadAssets(item.downloadable.map((asset) => ({ item, asset }))),
              })
            : null,
        ),
        item.downloadable.length ? h('h3', { class: 'prop-heading', text: t('properties.filesHeading') }) : null,
        item.downloadable.length ? h('ul', { class: 'asset-list' }, assets) : null,
        h('h3', { class: 'prop-heading', text: t('properties.metadataHeading') }),
        h('div', { class: 'json-tree' }, jsonNode('id', item.id), jsonNode('collection', item.collection), jsonNode('properties', item.properties, { open: true }), jsonNode('assets', item.rawAssets)),
      ),
    );
  }
}
