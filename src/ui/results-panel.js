// The panel under the map: search status, selection summary, actions, table.

import { button, h } from '../lib/dom.js';
import { formatBytes } from '../lib/format.js';
import { t, tn } from '../i18n/index.js';
import { ResultsTable } from './results-table.js';

export class ResultsPanel {
  constructor(app) {
    this.app = app;
    this.status = h('div', { class: 'results-status', role: 'status' });
    this.stop = button(t('results.stop'), { icon: 'stop', size: 'sm', onClick: () => app.stopSearch() });
    this.loadMore = button(t('results.loadMore'), { icon: 'plus', size: 'sm', variant: 'ghost', onClick: () => app.loadMore() });
    this.selection = h('div', { class: 'results-selection' });
    this.selectAll = button(t('results.selectAll'), { size: 'sm', variant: 'ghost', onClick: () => app.checkAll(true) });
    this.selectNone = button(t('results.selectNone'), { size: 'sm', variant: 'ghost', onClick: () => app.checkAll(false) });
    this.download = button(t('results.downloadSelected'), { icon: 'download', size: 'sm', variant: 'primary', onClick: () => app.downloadChecked() });
    this.table = new ResultsTable(app, { onContextMenu: (context) => app.openItemMenu(context) });

    this.el = h(
      'div',
      { class: 'results-inner' },
      h(
        'div',
        { class: 'results-toolbar' },
        h('div', { class: 'toolbar-group' }, this.status, this.stop, this.loadMore),
        h('span', { class: 'spacer' }),
        h('div', { class: 'toolbar-group' }, this.selection, this.selectAll, this.selectNone, this.download),
      ),
      this.table.el,
    );

    const render = () => this.render();
    for (const event of ['results', 'resultsAdded', 'resultsStatus', 'checked', 'download']) app.on(event, render);
    this.render();
  }

  render() {
    const { app } = this;
    const { items, status, cursor } = app.results;
    const count = tn('results.itemsCount', items.length);
    const text = {
      idle: t('results.noSearchYet'),
      searching: items.length ? t('results.searchingCount', { count }) : t('results.searching'),
      done: items.length ? (cursor ? t('results.moreAvailable', { count }) : count) : t('results.noItemsFound'),
      stopped: t('results.stoppedCount', { count }),
      error: items.length ? t('results.searchFailedCount', { count }) : t('results.searchFailed'),
    }[status];
    this.status.replaceChildren(status === 'searching' ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : '', text);
    this.stop.hidden = status !== 'searching';
    this.loadMore.hidden = !cursor || status === 'searching';

    const checked = [...app.checked].map((uid) => app.results.byUid.get(uid)).filter(Boolean);
    const known = checked.reduce((sum, item) => sum + (item.totalSize || 0), 0);
    const partial = checked.some((item) => item.totalSize === null && item.downloadable.length);
    const sizeSuffix = known ? ` · ${formatBytes(known)}${partial ? '+' : ''}` : '';
    this.selection.textContent = checked.length
      ? `${t('results.selectedCount', { items: tn('results.itemsCount', checked.length) })}${sizeSuffix}`
      : '';
    this.download.disabled = !checked.length || Boolean(app.activeDownload);
    this.selectAll.disabled = !items.length || checked.length === items.length;
    this.selectNone.disabled = !checked.length;
  }
}
