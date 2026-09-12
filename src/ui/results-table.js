// The results table, virtualised: only the rows in view exist in the DOM, so a
// search returning thousands of items stays responsive.
//
// Two states per row, both owned by the app:
//   checkbox       "selected" for download (app.checked)
//   row selection  "highlighted" (app.highlighted), mirrored on the map
// Row clicks follow the usual list conventions: click selects one row,
// Ctrl/⌘-click toggles, Shift-click extends.

import { formatBytes, formatDateTime } from '../lib/format.js';
import { h, icon } from '../lib/dom.js';
import { t } from '../i18n/index.js';

const ROW_HEIGHT = 36;
const OVERSCAN = 6;

export class ResultsTable {
  #order = [];        // indices into app.results.items, in display order
  #rows = [];         // pooled row elements
  #sort = { key: null, dir: 1 };
  #anchor = null;     // uid a Shift-click extends from
  #frame = 0;

  constructor(app, { onContextMenu }) {
    this.app = app;
    this.onContextMenu = onContextMenu;

    this.columns = [
      { key: 'title', label: t('results.title'), value: (i) => i.title.toLocaleLowerCase() },
      { key: 'collection', label: t('results.collection'), value: (i) => app.collectionTitle(i.collection).toLocaleLowerCase() },
      { key: 'datetime', label: t('results.date'), value: (i) => i.datetime || '' },
      { key: 'files', label: t('results.files'), value: (i) => i.downloadable.length, align: 'end' },
      { key: 'size', label: t('results.size'), value: (i) => i.totalSize ?? -1, align: 'end' },
    ];

    this.headerCheck = h('input', { type: 'checkbox', 'aria-label': t('results.selectAllAria'), onchange: (e) => app.checkAll(e.target.checked) });
    this.headerCells = this.columns.map((col) => h(
      'button',
      { type: 'button', class: ['rt-sort', col.align === 'end' && 'is-end'], dataset: { key: col.key }, onclick: () => this.#toggleSort(col.key) },
      h('span', { text: col.label }),
      h('span', { class: 'rt-sort-icon' }),
    ));
    this.header = h('div', { class: 'rt-header rt-grid', role: 'row' }, h('div', { class: 'rt-cell rt-check' }, this.headerCheck), this.headerCells.map((c) => h('div', { class: 'rt-cell', role: 'columnheader' }, c)));

    this.spacer = h('div', { class: 'rt-spacer' });
    this.empty = h('div', { class: 'rt-empty' });
    this.viewport = h('div', { class: 'rt-viewport', tabindex: '0', role: 'rowgroup', 'aria-label': t('results.searchResultsAria') }, this.spacer, this.empty);
    this.el = h('div', { class: 'results-table', role: 'grid', 'aria-multiselectable': 'true' }, this.header, this.viewport);

    this.viewport.addEventListener('scroll', () => this.#schedule());
    new ResizeObserver(() => this.#schedule()).observe(this.viewport);
    this.viewport.addEventListener('click', (e) => this.#onClick(e));
    this.viewport.addEventListener('dblclick', (e) => {
      const uid = this.#uidAt(e);
      if (uid) app.map.zoomToItem(uid);
    });
    this.viewport.addEventListener('contextmenu', (e) => this.#onContextMenu(e));
    this.viewport.addEventListener('keydown', (e) => this.#onKey(e));

    app.on('results', () => this.reset());
    app.on('resultsAdded', () => this.#reorder());
    app.on('resultsStatus', () => this.#schedule());
    app.on('checked', () => this.#schedule());
    app.on('highlight', ({ scroll } = {}) => {
      if (scroll && app.highlighted.length) this.scrollTo(app.highlighted[0]);
      this.#schedule();
    });
    app.on('collections', () => this.#schedule());
    this.reset();
  }

  reset() {
    this.#anchor = null;
    this.#reorder();
    this.viewport.scrollTop = 0;
  }

  scrollTo(uid) {
    const index = this.app.results.items.findIndex((i) => i.uid === uid);
    const pos = this.#order.indexOf(index);
    if (pos < 0) return;
    const top = pos * ROW_HEIGHT;
    const { scrollTop, clientHeight } = this.viewport;
    if (top < scrollTop) this.viewport.scrollTop = top;
    else if (top + ROW_HEIGHT > scrollTop + clientHeight) this.viewport.scrollTop = top + ROW_HEIGHT - clientHeight;
  }

  #toggleSort(key) {
    if (this.#sort.key !== key) this.#sort = { key, dir: 1 };
    else if (this.#sort.dir === 1) this.#sort = { key, dir: -1 };
    else this.#sort = { key: null, dir: 1 };
    this.#reorder();
  }

  #reorder() {
    const items = this.app.results.items;
    this.#order = items.map((_, i) => i);
    const col = this.columns.find((c) => c.key === this.#sort.key);
    if (col) {
      const values = items.map(col.value);
      const dir = this.#sort.dir;
      this.#order.sort((a, b) => (values[a] < values[b] ? -dir : values[a] > values[b] ? dir : a - b));
    }
    for (const cell of this.headerCells) {
      const active = cell.dataset.key === this.#sort.key;
      cell.classList.toggle('is-sorted', active);
      cell.parentElement.setAttribute('aria-sort', active ? (this.#sort.dir === 1 ? 'ascending' : 'descending') : 'none');
      cell.lastChild.replaceChildren(active ? icon(this.#sort.dir === 1 ? 'arrowUp' : 'arrowDown', { size: 14 }) : '');
    }
    this.spacer.style.height = `${this.#order.length * ROW_HEIGHT}px`;
    this.#schedule();
  }

  #schedule() {
    cancelAnimationFrame(this.#frame);
    this.#frame = requestAnimationFrame(() => this.#render());
  }

  #render() {
    const { app } = this;
    const items = app.results.items;
    this.#renderEmpty();

    const checkedCount = app.checked.size;
    this.headerCheck.checked = items.length > 0 && checkedCount === items.length;
    this.headerCheck.indeterminate = checkedCount > 0 && checkedCount < items.length;
    this.headerCheck.disabled = items.length === 0;

    const { scrollTop, clientHeight } = this.viewport;
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(this.#order.length, Math.ceil((scrollTop + clientHeight) / ROW_HEIGHT) + OVERSCAN);
    const needed = Math.max(0, last - first);
    while (this.#rows.length < needed) this.#rows.push(this.#createRow());

    const highlighted = new Set(app.highlighted);
    for (let k = 0; k < this.#rows.length; k++) {
      const row = this.#rows[k];
      const pos = first + k;
      if (k >= needed) {
        if (row.isConnected) row.remove();
        continue;
      }
      if (!row.isConnected) this.viewport.append(row);
      const item = items[this.#order[pos]];
      this.#fillRow(row, item, pos, highlighted.has(item.uid), app.checked.has(item.uid));
    }
  }

  #renderEmpty() {
    const { status, items } = this.app.results;
    let message = '';
    if (!items.length) {
      if (status === 'searching') message = t('results.searching');
      else if (status === 'done' || status === 'stopped') message = t('results.noItemsMatched');
      else if (status === 'error') message = t('results.searchFailedEmpty');
      else message = t('results.chooseAreaThenSearch');
    }
    this.empty.textContent = message;
    this.empty.hidden = !message;
  }

  #createRow() {
    const check = h('input', { type: 'checkbox', class: 'rt-checkbox', tabindex: '-1' });
    return h(
      'div',
      { class: 'rt-row rt-grid', role: 'row' },
      h('div', { class: 'rt-cell rt-check' }, check),
      h('div', { class: 'rt-cell rt-title' }),
      h('div', { class: 'rt-cell rt-collection' }),
      h('div', { class: 'rt-cell rt-date' }),
      h('div', { class: 'rt-cell is-end rt-files' }),
      h('div', { class: 'rt-cell is-end rt-size' }),
    );
  }

  #fillRow(row, item, pos, isHighlighted, isChecked) {
    row.style.transform = `translateY(${pos * ROW_HEIGHT}px)`;
    row.dataset.uid = item.uid;
    row.classList.toggle('is-highlighted', isHighlighted);
    row.classList.toggle('is-checked', isChecked);
    row.setAttribute('aria-selected', String(isHighlighted));
    const [checkCell, title, collection, date, files, size] = row.children;
    const check = checkCell.firstChild;
    check.checked = isChecked;
    check.setAttribute('aria-label', t('results.selectForDownloadAria', { title: item.title }));
    title.textContent = item.title;
    title.title = item.title === item.id ? item.id : `${item.title}\n${item.id}`;
    const collectionLabel = this.app.collectionTitle(item.collection);
    collection.textContent = collectionLabel;
    collection.title = item.collection;
    date.textContent = formatDateTime(item.datetime);
    files.textContent = String(item.downloadable.length);
    size.textContent = item.totalSize === null ? (item.downloadable.length ? '—' : '') : formatBytes(item.totalSize);
  }

  #uidAt(event) {
    return event.target.closest('.rt-row')?.dataset.uid || null;
  }

  #onClick(event) {
    const uid = this.#uidAt(event);
    if (!uid) return;
    if (event.target.classList.contains('rt-checkbox')) {
      this.app.setChecked([uid], event.target.checked);
      return;
    }
    this.viewport.focus({ preventScroll: true });
    const { app } = this;
    if (event.shiftKey && this.#anchor) {
      app.setHighlighted(this.#range(this.#anchor, uid));
    } else if (event.ctrlKey || event.metaKey) {
      const set = new Set(app.highlighted);
      if (set.has(uid)) set.delete(uid);
      else set.add(uid);
      this.#anchor = uid;
      app.setHighlighted([...set]);
    } else {
      this.#anchor = uid;
      app.setHighlighted([uid]);
    }
  }

  #range(fromUid, toUid) {
    const items = this.app.results.items;
    const posOf = (uid) => this.#order.findIndex((i) => items[i].uid === uid);
    const [a, b] = [posOf(fromUid), posOf(toUid)].sort((x, y) => x - y);
    if (a < 0) return [toUid];
    return this.#order.slice(a, b + 1).map((i) => items[i].uid);
  }

  #onContextMenu(event) {
    const uid = this.#uidAt(event);
    if (!uid) return;
    event.preventDefault();
    if (!this.app.highlighted.includes(uid)) {
      this.#anchor = uid;
      this.app.setHighlighted([uid]);
    }
    this.onContextMenu({ uids: [...this.app.highlighted], x: event.clientX, y: event.clientY, source: 'table' });
  }

  #onKey(event) {
    const { app } = this;
    const items = app.results.items;
    if (!items.length) return;
    const current = app.highlighted[app.highlighted.length - 1];
    const pos = current ? this.#order.findIndex((i) => items[i].uid === current) : -1;
    const moveTo = (p) => {
      const clamped = Math.max(0, Math.min(this.#order.length - 1, p));
      const uid = items[this.#order[clamped]].uid;
      if (event.shiftKey && this.#anchor) app.setHighlighted(this.#range(this.#anchor, uid));
      else {
        this.#anchor = uid;
        app.setHighlighted([uid]);
      }
      this.scrollTo(uid);
    };
    const page = Math.max(1, Math.floor(this.viewport.clientHeight / ROW_HEIGHT) - 1);
    switch (event.key) {
      case 'ArrowDown': moveTo(pos + 1); break;
      case 'ArrowUp': moveTo(pos < 0 ? 0 : pos - 1); break;
      case 'PageDown': moveTo(pos + page); break;
      case 'PageUp': moveTo(pos - page); break;
      case 'Home': moveTo(0); break;
      case 'End': moveTo(this.#order.length - 1); break;
      case ' ': {
        if (!app.highlighted.length) return;
        const allChecked = app.highlighted.every((uid) => app.checked.has(uid));
        app.setChecked(app.highlighted, !allChecked);
        break;
      }
      case 'Enter':
        if (current) app.showProperties(current);
        break;
      case 'Escape':
        app.setHighlighted([]);
        break;
      default:
        return;
    }
    event.preventDefault();
  }
}
