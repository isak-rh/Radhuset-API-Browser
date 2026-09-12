// Managing the user's own APIs. Built-in APIs are listed too, read-only, so they
// can be inspected and copied as a starting point.

import { API_TYPES, AUTH_REQUIREMENTS, DEFAULT_SCHEMA_QUERY_DEPTH } from '../config/apis.js';
import { append, button, clear, field, h, icon, select } from '../lib/dom.js';
import { HttpError, request } from '../lib/http.js';
import { t } from '../i18n/index.js';
import { choiceDialog, confirmDialog, openDialog } from './dialog.js';
import { toast } from './toast.js';

const comparable = (a) => JSON.stringify([a.name, a.url, a.apiType, a.authRequired, a.schemaUrl]);
const API_TYPE_LABELS = { stac: 'apis.typeStac', ngp: 'apis.typeNgp' };
const AUTH_REQUIREMENT_LABELS = { none: 'apis.authNone', download: 'apis.authDownloadOnly', all: 'apis.authAll' };
const translatedApiTypes = () => API_TYPES.map(([v]) => [v, t(API_TYPE_LABELS[v])]);
const translatedAuthRequirements = () => AUTH_REQUIREMENTS.map(([v]) => [v, t(AUTH_REQUIREMENT_LABELS[v])]);

export function openApisDialog(app) {
  let current = null;       // the API shown in the editor
  let originalName = null;  // its stored name (null for a draft)
  let isDraft = false;
  let form = null;

  const list = h('ul', { class: 'profile-list', role: 'listbox', 'aria-label': t('apis.title') });
  const editorEl = h('div', { class: 'profile-editor' });

  const isDirty = () => {
    if (!current || !current.isCustom || !form) return false;
    return isDraft || comparable(form.read()) !== comparable(current);
  };

  async function confirmLeave() {
    if (!isDirty()) return true;
    const choice = await choiceDialog({
      title: t('common.unsavedChangesTitle'),
      message: t('common.unsavedChangesMessage', { name: form.read().name || t('apis.newApi') }),
      choices: [
        { label: t('common.cancel'), value: 'cancel' },
        { label: t('common.discard'), value: 'discard' },
        { label: t('common.save'), value: 'save', variant: 'primary', autofocus: true },
      ],
    });
    if (choice === 'save') return save();
    return choice === 'discard';
  }

  function row(api) {
    const selected = current && !isDraft && current.name === api.name;
    return h(
      'li',
      {
        class: ['profile-row', selected && 'is-selected'],
        role: 'option',
        tabindex: '0',
        'aria-selected': String(Boolean(selected)),
        onclick: () => choose(api),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(api); } },
      },
      icon(api.isCustom ? 'api' : 'lock', { size: 16 }),
      h('span', { class: 'grow' }, h('span', { class: 'profile-name', text: api.name }), h('span', { class: 'muted small ellipsis', text: api.url })),
    );
  }

  function renderList() {
    clear(list);
    list.append(h('li', { class: 'list-heading', text: t('apiPicker.builtIn') }), ...app.apis.builtIn.map(row));
    list.append(h('li', { class: 'list-heading', text: t('apiPicker.yourApis') }));
    const custom = app.apis.custom;
    if (custom.length) list.append(...custom.map(row));
    else if (!isDraft) list.append(h('li', { class: 'muted small empty-row', text: t('apis.noneYet') }));
    if (isDraft) list.append(h('li', { class: 'profile-row is-selected' }, icon('plus', { size: 16 }), h('span', { class: 'grow' }, h('span', { class: 'profile-name', text: t('apis.newApi') }), h('span', { class: 'muted small', text: t('common.notSavedYet') }))));
  }

  function renderEditor() {
    clear(editorEl);
    form = null;
    if (!current) {
      editorEl.append(h('div', { class: 'empty-state' }, icon('api', { size: 28 }), h('p', { text: t('apis.selectPrompt') })));
      return;
    }
    const readOnly = !current.isCustom;
    const name = h('input', { type: 'text', value: current.name, readonly: readOnly, placeholder: t('apis.displayNamePlaceholder') });
    const url = h('input', { type: 'url', value: current.url, readonly: readOnly, placeholder: t('apis.urlPlaceholder'), spellcheck: 'false' });
    const type = select(translatedApiTypes(), current.apiType, { disabled: readOnly });
    const auth = select(translatedAuthRequirements(), current.authRequired, { disabled: readOnly });
    const schema = h('input', { type: 'url', value: current.schemaUrl || '', readonly: readOnly, placeholder: t('apis.schemaPlaceholder'), spellcheck: 'false' });
    const schemaField = field(t('apis.schemaField'), schema, { hint: t('apis.schemaHint') });
    const status = h('p', { class: 'muted small', role: 'status' });
    let unlockedAuth = current.apiType === 'ngp' ? 'none' : current.authRequired;

    const sync = () => {
      const ngp = type.value === 'ngp';
      // Every NGP endpoint authenticates for browsing as well as download.
      if (ngp) auth.value = 'all';
      else if (!readOnly && auth.disabled) auth.value = unlockedAuth;
      auth.disabled = readOnly || ngp;
      schemaField.hidden = !ngp;
    };
    type.addEventListener('change', sync);
    auth.addEventListener('change', () => { unlockedAuth = auth.value; });
    sync();

    form = {
      read: () => ({
        name: name.value.trim(),
        url: url.value.trim().replace(/\/+$/, ''),
        apiType: type.value,
        authRequired: type.value === 'ngp' ? 'all' : auth.value,
        schemaUrl: type.value === 'ngp' && schema.value.trim() ? schema.value.trim() : null,
        schemaQueryDepth: current.schemaQueryDepth || DEFAULT_SCHEMA_QUERY_DEPTH,
        isCustom: true,
      }),
    };

    async function test() {
      const target = url.value.trim().replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(target)) {
        status.textContent = t('apis.enterUrlHttps');
        return;
      }
      status.textContent = t('apis.connecting');
      try {
        const response = await request(target, { headers: { Accept: 'application/json' } });
        if (response.status === 401 || response.status === 403) {
          status.textContent = t('apis.connectedRequiresCreds');
          return;
        }
        if (!response.ok) throw new HttpError(response.status, '', target);
        const data = await response.json().catch(() => null);
        const label = data?.title || data?.id;
        status.textContent = t('apis.connected', {
          toLabel: label ? t('apis.connectedTo', { label }) : '',
          stacVersion: data?.stac_version ? t('apis.connectedStacVersion', { version: data.stac_version }) : '',
        });
      } catch (err) {
        status.textContent = err.message;
      }
    }

    // append(), not the native .append(): it skips a null/false argument
    // instead of stringifying it into the DOM as literal "null" text.
    append(editorEl, [
      readOnly ? h('p', { class: 'notice small', text: t('apis.readOnlyNotice') }) : null,
      h(
        'form',
        { class: 'form', onsubmit: (e) => { e.preventDefault(); save(); } },
        field(t('apis.name'), name),
        field(t('apis.url'), url, { hint: readOnly ? null : t('apis.urlHint') }),
        h('div', { class: 'grid-2' }, field(t('apis.type'), type), field(t('apis.credentialsNeededFor'), auth)),
        schemaField,
        h('button', { type: 'submit', hidden: true }),
      ),
      h(
        'div',
        { class: 'editor-actions' },
        button(t('apis.testConnection'), { icon: 'refresh', variant: 'ghost', onClick: test }),
        status,
        h('span', { class: 'spacer' }),
        readOnly ? button(t('apis.makeACopy'), { icon: 'copy', onClick: copy }) : null,
        !readOnly && !isDraft ? button(t('common.delete'), { icon: 'trash', variant: 'ghost', class: 'is-danger', onClick: remove }) : null,
        readOnly ? null : button(t('common.save'), { variant: 'primary', onClick: save }),
      ),
    ]);
    if (!readOnly) name.focus();
  }

  async function choose(api) {
    if (current && !isDraft && current.name === api.name) return;
    if (!(await confirmLeave())) return;
    current = { ...api };
    originalName = api.name;
    isDraft = false;
    renderList();
    renderEditor();
  }

  function uniqueName(base) {
    let name = base;
    for (let n = 2; app.apis.nameTaken(name); n++) name = `${base} ${n}`;
    return name;
  }

  async function create(template = null) {
    if (!(await confirmLeave())) return;
    current = template
      ? { ...template, name: uniqueName(`${template.name} (copy)`), isCustom: true }
      : { name: uniqueName('New API'), url: '', apiType: 'stac', authRequired: 'none', schemaUrl: null, schemaQueryDepth: DEFAULT_SCHEMA_QUERY_DEPTH, isCustom: true };
    originalName = null;
    isDraft = true;
    renderList();
    renderEditor();
  }

  const copy = () => create(current);

  function save() {
    const api = form.read();
    const fail = (message) => {
      toast(message, { kind: 'warning' });
      return false;
    };
    if (!api.name) return fail(t('apis.giveApiName'));
    if (app.apis.nameTaken(api.name, originalName)) return fail(t('apis.nameTaken', { name: api.name }));
    if (!api.url) return fail(t('apis.enterUrl'));
    if (!/^https?:\/\//i.test(api.url)) return fail(t('apis.urlMustStartWithHttps'));
    try {
      if (isDraft) {
        app.apis.addCustom(api);
        app.selectApi(api.name);
      } else {
        app.apis.updateCustom(originalName, api);
        if (api.name !== originalName) app.bindings.rename(originalName, api.name);
      }
    } catch (err) {
      return fail(err.message);
    }
    current = { ...api };
    originalName = api.name;
    isDraft = false;
    renderList();
    renderEditor();
    toast(t('apis.savedToast', { name: api.name }), { kind: 'success' });
    return true;
  }

  async function remove() {
    const ok = await confirmDialog({ title: t('apis.deleteTitle'), message: t('apis.deleteMessage', { name: current.name }), confirmLabel: t('common.delete'), danger: true });
    if (!ok) return;
    app.apis.deleteCustom(originalName);
    // The binding is keyed by name; left behind it would silently attach to a
    // later API that reuses the name.
    app.bindings.set(originalName, null);
    current = null;
    originalName = null;
    renderList();
    renderEditor();
  }

  renderList();
  renderEditor();
  return openDialog({
    title: t('apis.title'),
    size: 'xl',
    className: 'apis-dialog',
    body: h('div', { class: 'split' }, h('div', { class: 'split-list' }, list, button(t('apis.newApi'), { icon: 'plus', onClick: () => create() })), editorEl),
    canClose: confirmLeave,
  });
}
