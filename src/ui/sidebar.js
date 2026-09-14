// The search panel: API, credentials, filters and the Search button.

import { hasQueryBuilder, needsAuthForBrowse } from '../config/apis.js';
import { profileTypeLabel } from '../auth/profiles.js';
import { button, clear, h, icon, select } from '../lib/dom.js';
import { debounce, formatNumber } from '../lib/format.js';
import { t, tn } from '../i18n/index.js';
import { ApiPicker } from './api-picker.js';
import { promptCredentials } from './credentials.js';
import { queryFieldCount } from './query-builder.js';
import { unlockVault } from './vault-dialogs.js';

function card(title, iconName, body, actions = null) {
  return h(
    'section',
    { class: 'card' },
    h('header', { class: 'card-header' }, icon(iconName, { size: 16 }), h('h2', { class: 'card-title', text: title }), actions),
    h('div', { class: 'card-body' }, body),
  );
}

export class Sidebar {
  constructor(app) {
    this.app = app;
    this.picker = new ApiPicker(app);
    this.authCard = this.#buildAuth();
    this.queryCard = this.#buildQuery();
    this.timeCard = this.#buildTime();
    this.collectionsCard = this.#buildCollections();
    this.el = h(
      'div',
      { class: 'sidebar-inner' },
      h('div', { class: 'sidebar-top' }, this.picker.el),
      h('div', { class: 'sidebar-scroll' }, this.authCard, this.queryCard, this.timeCard, this.collectionsCard),
      this.#buildFooter(),
    );

    app.on('api', () => {
      this.#renderAuth();
      this.#renderQuery();
    });
    app.on('query', () => this.#renderQuery());
    app.on('collections', () => this.#renderCollections());
    app.on('collectionSelection', () => this.#renderCollectionStatus());
    for (const event of ['results', 'resultsStatus']) app.on(event, () => this.#renderSearchButton());
    const auth = () => this.#renderAuth();
    app.profiles.on('change', auth);
    app.bindings.on('change', auth);
    app.vault.on('change', auth);

    this.#renderAuth();
    this.#renderQuery();
    this.#renderCollections();
    this.#renderSearchButton();
  }

  // ── Authentication ──────────────────────────────────────────────────────

  #buildAuth() {
    this.authText = h('p', { class: 'muted small' });
    this.authSelect = h('select', { 'aria-label': t('sidebar.authProfileAriaLabel'), onchange: () => this.#onAuthSelect() });
    this.authNote = h('p', { class: 'small auth-note', hidden: true }, icon('lock', { size: 14 }), h('span', { text: t('sidebar.unlockToUseProfile') }));
    const manage = button('', {
      icon: 'settings',
      title: t('sidebar.manageAuthProfiles'),
      onClick: () => this.app.openProfiles(this.app.api && this.app.bindings.get(this.app.api.name)),
    });
    return card(t('sidebar.credentialsTitle'), 'key', [this.authText, h('div', { class: 'input-row' }, this.authSelect, manage), this.authNote]);
  }

  #renderAuth() {
    const { app } = this;
    const api = app.api;
    this.authCard.hidden = !api || api.authRequired === 'none';
    if (this.authCard.hidden) return;
    this.authText.textContent = api.authRequired === 'all'
      ? t('sidebar.authAllRequired')
      : t('sidebar.authDownloadOnly');

    const bound = app.bindings.get(api.name);
    const locked = app.vault.exists && !app.vault.unlocked;
    const options = [['', t('sidebar.noCredentials')]];
    for (const p of app.profiles.all()) options.push([p.id, t('credentials.existingOption', { name: p.name, type: profileTypeLabel(p.type), saved: p.persist ? '' : `, ${t('profiles.scopeThisSession')}` })]);
    let value = '';
    if (bound && app.profiles.get(bound)) value = bound;
    else if (bound && locked) {
      options.push([bound, t('sidebar.savedProfileLocked')]);
      value = bound;
    }
    if (locked) options.push(['__unlock', t('sidebar.unlockSavedProfilesOption')]);
    options.push(['__new', t('sidebar.addCredentialsOption')]);
    clear(this.authSelect).append(...options.map(([v, label]) => h('option', { value: v, text: label })));
    this.authSelect.value = value;
    this.authSelect.dataset.value = value;
    this.authNote.hidden = !(bound && locked && !app.profiles.get(bound));
  }

  async #onAuthSelect() {
    const { app } = this;
    const api = app.api;
    const value = this.authSelect.value;
    if (value === '__unlock' || value === '__new') {
      this.authSelect.value = this.authSelect.dataset.value || '';
      if (value === '__unlock') await unlockVault(app);
      else await promptCredentials(app, api, needsAuthForBrowse(api) ? 'browse' : 'download');
      return;
    }
    app.bindings.set(api.name, value || null);
  }

  // ── Attribute query ─────────────────────────────────────────────────────

  #buildQuery() {
    this.queryText = h('p', { class: 'small' });
    this.queryClear = button(t('sidebar.clear'), { size: 'sm', variant: 'ghost', onClick: () => this.app.setQuery(null) });
    return card(t('sidebar.attributeFilter'), 'filter', [
      this.queryText,
      h('div', { class: 'button-row' }, button(t('sidebar.queryBuilderButton'), { icon: 'filter', size: 'sm', onClick: () => this.app.openQueryBuilder() }), this.queryClear),
    ]);
  }

  #renderQuery() {
    const { app } = this;
    this.queryCard.hidden = !hasQueryBuilder(app.api);
    const n = queryFieldCount(app.query);
    this.queryText.textContent = n
      ? tn('sidebar.conditionsApplied', n)
      : t('sidebar.noFilterHint');
    this.queryText.classList.toggle('muted', !n);
    this.queryClear.hidden = !n;
  }

  // ── Time range ──────────────────────────────────────────────────────────

  #buildTime() {
    const { time } = this.app;
    const enabled = h('input', { type: 'checkbox', checked: time.enabled });
    const from = h('input', { type: 'date', value: time.from, 'aria-label': t('sidebar.fromDateAria') });
    const to = h('input', { type: 'date', value: time.to, 'aria-label': t('sidebar.toDateAria') });
    const sync = () => {
      from.disabled = !enabled.checked;
      to.disabled = !enabled.checked;
    };
    enabled.addEventListener('change', () => {
      sync();
      this.app.setTime({ enabled: enabled.checked });
    });
    from.addEventListener('change', () => this.app.setTime({ from: from.value }));
    to.addEventListener('change', () => this.app.setTime({ to: to.value }));
    sync();
    return card(t('sidebar.timeRange'), 'calendar', [
      h('label', { class: 'check' }, enabled, h('span', { text: t('sidebar.onlyItemsDated') })),
      h('div', { class: 'date-row' }, h('label', { class: 'field' }, h('span', { text: t('sidebar.from') }), from), h('label', { class: 'field' }, h('span', { text: t('sidebar.to') }), to)),
    ]);
  }

  // ── Collections ─────────────────────────────────────────────────────────

  #buildCollections() {
    this.collStatus = h('p', { class: 'muted small' });
    this.collLoad = button(t('sidebar.loadCollections'), { icon: 'refresh', size: 'sm', onClick: () => this.app.loadCollections() });
    this.collFilter = h('input', { type: 'search', placeholder: t('sidebar.filterCollectionsPlaceholder'), 'aria-label': t('sidebar.filterCollectionsAria'), oninput: debounce(() => this.#filterCollections(), 100) });
    this.collList = h('div', { class: 'coll-list', role: 'group', 'aria-label': t('sidebar.collectionsAria') });
    this.collLinks = h(
      'div',
      { class: 'button-row' },
      h('button', { type: 'button', class: 'link-button', text: t('sidebar.selectShown'), onclick: () => this.#selectShown() }),
      h('button', { type: 'button', class: 'link-button', text: t('sidebar.clearSelection'), onclick: () => this.app.setCollectionsSelected([...this.app.selectedCollections], false) }),
    );
    this.collList.addEventListener('change', (event) => {
      if (event.target.type === 'checkbox') this.app.setCollectionsSelected([event.target.value], event.target.checked);
    });
    const reload = button('', { icon: 'refresh', size: 'sm', variant: 'ghost', title: t('sidebar.reloadCollections'), onClick: () => this.app.loadCollections() });
    return card(t('sidebar.collections'), 'layers', [this.collStatus, this.collLoad, this.collFilter, this.collList, this.collLinks], reload);
  }

  #renderCollections() {
    const { status, list } = this.app.collections;
    const loaded = status === 'loaded' && list.length > 0;
    this.collLoad.hidden = status === 'loaded' || status === 'loading';
    this.collFilter.hidden = !loaded;
    this.collList.hidden = !loaded;
    this.collLinks.hidden = !loaded;
    clear(this.collList);
    if (loaded) {
      const selected = this.app.selectedCollections;
      for (const c of list) {
        this.collList.append(h(
          'label',
          { class: 'check', title: c.description || c.id, dataset: { search: [c.title, c.id, ...c.keywords].join(' ').toLocaleLowerCase() } },
          h('input', { type: 'checkbox', value: c.id, checked: selected.has(c.id) }),
          h('span', { class: 'check-text' }, h('span', { text: c.title || c.id }), c.title && c.title !== c.id ? h('span', { class: 'check-sub', text: c.id }) : null),
        ));
      }
      this.#filterCollections();
    }
    this.#renderCollectionStatus();
  }

  #renderCollectionStatus() {
    const { app } = this;
    const { status, list, error } = app.collections;
    const n = app.selectedCollections.size;
    let text = '';
    if (status === 'loading') text = t('sidebar.loadingCollections');
    else if (status === 'error') text = t('sidebar.collectionsLoadError', { error });
    else if (status === 'loaded') text = list.length ? `${tn('sidebar.collectionsCount', list.length)} · ${n ? t('sidebar.selectedCount', { n: formatNumber(n) }) : t('sidebar.noneSelectedAllSearched')}` : t('sidebar.noCollectionsListed');
    else text = t('sidebar.loadHint');
    this.collStatus.textContent = text;
    this.collStatus.classList.toggle('error-text', status === 'error');
    for (const box of this.collList.querySelectorAll('input')) box.checked = app.selectedCollections.has(box.value);
  }

  #filterCollections() {
    const query = this.collFilter.value.trim().toLocaleLowerCase();
    for (const label of this.collList.children) label.hidden = Boolean(query) && !label.dataset.search.includes(query);
  }

  #selectShown() {
    const ids = [...this.collList.children].filter((label) => !label.hidden).map((label) => label.querySelector('input').value);
    this.app.setCollectionsSelected(ids, true);
  }

  // ── Search ──────────────────────────────────────────────────────────────

  #buildFooter() {
    const limits = [['100', formatNumber(100)], ['500', formatNumber(500)], ['1000', formatNumber(1000)], ['5000', formatNumber(5000)], ['0', t('sidebar.noLimit')]];
    const max = select(limits, String(this.app.prefs.get('maxResults')), { id: 'max-results' });
    max.addEventListener('change', () => this.app.prefs.set('maxResults', Number(max.value)));
    this.searchButton = button(t('common.search'), { icon: 'search', variant: 'primary', class: 'btn-block btn-lg', onClick: () => this.app.search() });
    this.stopButton = button(t('sidebar.stopSearching'), { icon: 'stop', class: 'btn-block btn-lg', hidden: true, onClick: () => this.app.stopSearch() });
    return h(
      'div',
      { class: 'sidebar-footer' },
      h('div', { class: 'footer-row' }, h('label', { for: 'max-results', class: 'small muted', text: t('sidebar.resultsPerSearch') }), max),
      this.searchButton,
      this.stopButton,
    );
  }

  #renderSearchButton() {
    const searching = this.app.results.status === 'searching';
    this.searchButton.hidden = searching;
    this.stopButton.hidden = !searching;
  }
}
