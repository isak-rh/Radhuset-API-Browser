// The API selector: the current API's name and URL, opening a grouped list.

import { h, icon } from '../lib/dom.js';
import { t } from '../i18n/index.js';
import { openMenu } from './menu.js';

const typeLabel = (api) => (api.apiType === 'ngp' ? 'NGP' : 'STAC');

export class ApiPicker {
  constructor(app) {
    this.app = app;
    this.nameEl = h('span', { class: 'api-picker-name' });
    this.urlEl = h('span', { class: 'api-picker-url' });
    this.badgeEl = h('span', { class: 'badge' });
    this.el = h(
      'button',
      { type: 'button', class: 'api-picker', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => this.open() },
      h('span', { class: 'api-picker-text' }, h('span', { class: 'api-picker-title' }, this.nameEl, this.badgeEl), this.urlEl),
      icon('chevronDown', { size: 18, className: 'api-picker-chevron' }),
    );
    app.on('api', () => this.render());
    app.apis.on('change', () => this.render());
    this.render();
  }

  render() {
    const api = this.app.api;
    this.nameEl.textContent = api?.name || t('apiPicker.noApiSelected');
    this.urlEl.textContent = api?.url || '';
    this.badgeEl.textContent = api ? typeLabel(api) : '';
    this.badgeEl.hidden = !api;
    this.el.title = api ? `${api.name}\n${api.url}` : '';
  }

  open() {
    const current = this.app.api?.name;
    const entry = (api) => ({
      label: api.name,
      description: api.url,
      hint: typeLabel(api),
      icon: api.name === current ? 'check' : null,
      onSelect: () => this.app.selectApi(api.name),
    });
    const { builtIn, custom } = this.app.apis;
    const items = [{ heading: t('apiPicker.builtIn') }, ...builtIn.map(entry)];
    if (custom.length) items.push({ heading: t('apiPicker.yourApis') }, ...custom.map(entry));
    items.push('separator', { label: t('apiPicker.addOrEdit'), icon: 'settings', onSelect: () => this.app.openApis() });
    openMenu({ items, anchor: this.el, className: 'api-menu', matchWidth: true });
  }
}
