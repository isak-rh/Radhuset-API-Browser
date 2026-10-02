// The Query Builder: attribute filters, built from the fields an API declares
// queryable — an NGP API's JSON schema (stac/schema-scanner.js) or a STAC API's
// queryables (stac/queryables.js). The result is an AttributeQuery, which
// serialises itself in the dialect of the API it was built for
// (stac/attribute-query.js).

import { AttributeQuery, CQL2_JSON, condition, supportsAny } from '../stac/attribute-query.js';
import { FieldType } from '../stac/schema-scanner.js';
import { button, h } from '../lib/dom.js';
import { t, tn } from '../i18n/index.js';
import { confirmDialog, openDialog } from './dialog.js';

const operatorLabels = () => ({
  eq: t('query.operators.eq'),
  neq: t('query.operators.neq'),
  in: t('query.operators.in'),
  contains: t('query.operators.contains'),
  startsWith: t('query.operators.startsWith'),
  endsWith: t('query.operators.endsWith'),
  gt: t('query.operators.gt'),
  gte: t('query.operators.gte'),
  lt: t('query.operators.lt'),
  lte: t('query.operators.lte'),
});

/** The key, plus the title and description a queryable may carry. */
function fieldTooltip(field) {
  const lines = [field.key];
  if (field.title && field.title !== field.key) lines.push(field.title);
  if (field.description) lines.push(field.description);
  return lines.join('\n');
}

function fieldSelect(fields) {
  const select = h('select', { class: 'qb-field', 'aria-label': t('query.fieldAriaLabel') });
  // Flat keys (STAC queryables) have no object type to group by, and a group
  // per field would only double the list, so they are listed as is.
  if (!fields.some((f) => f.path.length > 1)) {
    select.append(...fields.map((f) => h('option', { value: f.key, text: f.key, title: fieldTooltip(f) })));
    return select;
  }
  const groups = new Map();
  for (const field of fields) {
    const group = field.path[0] || '(other)';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(field);
  }
  for (const [group, list] of groups) {
    const optgroup = h('optgroup', { label: group });
    for (const field of list) {
      optgroup.append(h('option', { value: field.key, text: field.path.length > 1 ? field.path.slice(1).join('.') : field.key, title: field.key }));
    }
    select.append(optgroup);
  }
  return select;
}

/** A multi-value picker for enum fields with the "is one of" operator. */
function checklist(values) {
  const listId = `qb-multi-${Math.random().toString(36).slice(2, 9)}`;
  // A popover renders in the top layer, so the list isn't clipped by the
  // dialog's `overflow: auto` body and can extend past its edges like a
  // normal dropdown. Position is computed on open since a popover is always
  // `position: fixed`, detached from the button's layout flow.
  const summary = h('button', { type: 'button', class: 'qb-multi-summary', popovertarget: listId, 'aria-haspopup': 'listbox', 'aria-expanded': 'false' });
  const boxes = values.map((v) => h('input', { type: 'checkbox', value: String(v) }));
  const list = h(
    'div',
    { class: 'qb-multi-list', popover: 'auto', id: listId, role: 'listbox' },
    values.map((v, i) => h('label', { class: 'check' }, boxes[i], h('span', { text: String(v) }))),
  );
  const update = () => {
    const chosen = boxes.filter((b) => b.checked).map((b) => b.value);
    summary.textContent = chosen.length ? chosen.join(', ') : t('query.chooseValues');
    summary.classList.toggle('is-placeholder', !chosen.length);
  };
  const position = () => {
    const r = summary.getBoundingClientRect();
    list.style.left = `${r.left}px`;
    list.style.top = `${r.bottom + 4}px`;
    list.style.width = `${r.width}px`;
  };
  let stopTracking = null;
  list.addEventListener('toggle', (event) => {
    const isOpen = event.newState === 'open';
    summary.classList.toggle('is-open', isOpen);
    summary.setAttribute('aria-expanded', String(isOpen));
    stopTracking?.();
    stopTracking = null;
    if (isOpen) {
      position();
      window.addEventListener('scroll', position, true);
      window.addEventListener('resize', position);
      stopTracking = () => {
        window.removeEventListener('scroll', position, true);
        window.removeEventListener('resize', position);
      };
    }
  });
  const el = h('div', { class: 'qb-multi' }, summary, list);
  el.addEventListener('change', update);
  update();
  return {
    el,
    get: () => boxes.filter((b) => b.checked).map((b) => values[boxes.indexOf(b)]),
    set: (selected) => {
      const wanted = new Set((Array.isArray(selected) ? selected : [selected]).map(String));
      boxes.forEach((b) => { b.checked = wanted.has(b.value); });
      update();
    },
  };
}

/** The number placeholder, with the field's bounds when it declares them. */
function rangePlaceholder(field, placeholder) {
  const lo = field.minimum ?? null;
  const hi = field.maximum ?? null;
  if (lo === null && hi === null) return placeholder;
  return `${placeholder} (${lo ?? '…'}–${hi ?? '…'})`;
}

class ConditionRow {
  constructor(fields, { onChange, onRemove }) {
    this.fields = fields;
    this.byKey = new Map(fields.map((f) => [f.key, f]));
    this.onChange = onChange;
    this.fieldEl = fieldSelect(fields);
    this.opEl = h('select', { class: 'qb-op', 'aria-label': t('query.operatorAriaLabel') });
    this.valueEl = h('div', { class: 'qb-value' });
    this.el = h(
      'div',
      { class: 'qb-row' },
      this.fieldEl,
      this.opEl,
      this.valueEl,
      button('', { icon: 'x', variant: 'ghost', title: t('query.removeCondition'), onClick: () => onRemove(this) }),
    );
    this.fieldEl.addEventListener('change', () => { this.#fieldChanged(); onChange(); });
    this.opEl.addEventListener('change', () => { this.#buildValue(); onChange(); });
    this.valueEl.addEventListener('input', onChange);
    this.valueEl.addEventListener('change', onChange);
    this.#fieldChanged();
  }

  get field() {
    return this.byKey.get(this.fieldEl.value);
  }

  #fieldChanged() {
    const labels = operatorLabels();
    this.opEl.replaceChildren(...this.field.operators.map((op) => h('option', { value: op, text: labels[op] || op })));
    this.#buildValue();
  }

  #buildValue() {
    const { field } = this;
    const op = this.opEl.value;
    this.multi = null;
    let control;
    if (field.fieldType === FieldType.ENUM && op === 'in') {
      this.multi = checklist(field.values || []);
      control = this.multi.el;
    } else if (op === 'in') {
      control = h('input', { type: 'text', placeholder: t('query.valueListPlaceholder'), spellcheck: 'false' });
    } else if (field.fieldType === FieldType.ENUM) {
      control = h('select', null, (field.values || []).map((v) => h('option', { value: String(v), text: String(v) })));
    } else if (field.fieldType === FieldType.BOOLEAN) {
      control = h('select', null, h('option', { value: 'true', text: 'true' }), h('option', { value: 'false', text: 'false' }));
    } else if (field.fieldType === FieldType.DATE) {
      control = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
    } else if (field.fieldType === FieldType.DATETIME) {
      control = h('input', { type: 'datetime-local', step: '1' });
    } else if (field.fieldType === FieldType.NUMBER) {
      // A "number" bounded by whole numbers far apart is a count or a year in
      // practice (Lantmäteriet's flygår: 1950–2050), so it steps by one.
      const lo = field.minimum ?? null;
      const hi = field.maximum ?? null;
      const whole = lo !== null && hi !== null && Number.isInteger(lo) && Number.isInteger(hi) && hi - lo >= 10;
      control = h('input', { type: 'number', step: whole ? '1' : 'any', min: lo, max: hi, placeholder: rangePlaceholder(field, t('query.numberPlaceholder')) });
    } else if (field.fieldType === FieldType.INTEGER) {
      control = h('input', { type: 'number', step: '1', min: field.minimum, max: field.maximum, placeholder: rangePlaceholder(field, t('query.wholeNumberPlaceholder')) });
    } else {
      control = h('input', { type: 'text', placeholder: field.fieldType === FieldType.UUID ? t('query.uuidPlaceholder') : t('query.valuePlaceholder'), spellcheck: 'false' });
    }
    control.setAttribute('aria-label', t('query.valueAriaLabel'));
    this.control = control;
    this.valueEl.replaceChildren(control);
  }

  /**
   * The row as a condition, or null while it has no value. Values are kept as
   * the user means them — a date is yyyy-mm-dd — and each query dialect
   * rewrites them as its API needs on the way out.
   */
  condition() {
    const { field } = this;
    const op = this.opEl.value;
    const value = this.#value(field, op, this.control.value);
    return value === null ? null : condition(field.key, op, value, field.fieldType);
  }

  #value(field, op, raw) {
    if (this.multi) {
      const values = this.multi.get();
      return values.length ? values : null;
    }
    if (op === 'in') {
      const values = raw.split(',').map((v) => v.trim()).filter(Boolean);
      return values.length ? values : null;
    }
    switch (field.fieldType) {
      case FieldType.ENUM:
        if (!(field.values || []).length) return null;
        return field.values.find((v) => String(v) === raw) ?? raw;
      case FieldType.BOOLEAN:
        return raw === 'true';
      case FieldType.DATE:
        return raw || null;
      case FieldType.DATETIME:
        return raw ? `${raw.length === 16 ? `${raw}:00` : raw}Z` : null;
      case FieldType.NUMBER:
      case FieldType.INTEGER:
        return raw === '' || !Number.isFinite(Number(raw)) ? null : Number(raw);
      default:
        return raw.trim() || null;
    }
  }

  /** Fill from an existing condition. False when the field or operator is unknown. */
  load({ key, op, value }) {
    if (!this.byKey.has(key)) return false;
    this.fieldEl.value = key;
    this.#fieldChanged();
    if (!this.field.operators.includes(op)) return false;
    this.opEl.value = op;
    this.#buildValue();
    const { fieldType } = this.field;
    if (this.multi) this.multi.set(value);
    else if (op === 'in') this.control.value = value.join(', ');
    else if (fieldType === FieldType.DATE) this.control.value = String(value).slice(0, 10);
    else if (fieldType === FieldType.DATETIME) this.control.value = String(value).replace(/Z$/, '').slice(0, 19);
    else this.control.value = String(value);
    return true;
  }
}

/**
 * Open the builder for *scan* ({ title, fields }) and the dialect of the API the
 * query is for. Resolves to the new AttributeQuery (null for none), or
 * undefined if cancelled.
 */
export function openQueryBuilder({ scan, dialect, existing = null }) {
  return new Promise((resolve) => {
    const rows = [];
    let result;
    const rowsEl = h('div', { class: 'qb-rows' });
    const cql2 = dialect.language === CQL2_JSON;
    // One long expression; wrapping beats a horizontal scroll bar.
    const preview = h('pre', { class: ['qb-preview', cql2 && 'is-wrapped'] });

    // All/any is a property of the whole query, not of a row, so it sits above
    // the rows. Absent when the API can only AND.
    const matchEl = supportsAny(dialect)
      ? h(
          'select',
          null,
          h('option', { value: 'all', text: t('query.matchAll') }),
          h('option', { value: 'any', text: t('query.matchAny') }),
        )
      : null;

    const build = () => new AttributeQuery(
      rows.map((row) => row.condition()).filter(Boolean),
      dialect,
      { matchAny: matchEl?.value === 'any' },
    );
    const update = () => {
      preview.textContent = build().preview() || (cql2 ? '—' : '{}');
    };
    const remove = (row) => {
      rows.splice(rows.indexOf(row), 1);
      row.el.remove();
      update();
    };
    const add = () => {
      const row = new ConditionRow(scan.fields, { onChange: update, onRemove: remove });
      rows.push(row);
      rowsEl.append(row.el);
      update();
      return row;
    };

    if (existing) {
      if (matchEl) matchEl.value = existing.isAny ? 'any' : 'all';
      for (const c of existing.conditions) {
        const row = add();
        if (!row.load(c)) remove(row);
      }
    }
    matchEl?.addEventListener('change', update);
    if (!rows.length) add();
    update();

    const dialog = openDialog({
      title: t('query.title', { subtitle: scan.title || t('query.defaultSubtitle') }),
      size: 'lg',
      body: h(
        'div',
        { class: 'qb' },
        h('p', { class: 'muted', text: matchEl ? t('query.introAnyAll') : t('query.intro') }),
        matchEl && h('label', { class: 'qb-match' }, h('span', { text: t('query.matchLabel') }), matchEl),
        rowsEl,
        button(t('query.addCondition'), { icon: 'plus', variant: 'ghost', onClick: () => add().fieldEl.focus() }),
        h('details', { class: 'qb-preview-wrap' }, h('summary', { text: cql2 ? t('query.cql2Summary') : t('query.jsonSummary') }), preview),
      ),
      footer: [
        button(t('query.clearAll'), { variant: 'ghost', onClick: () => { [...rows].forEach(remove); add(); } }),
        h('span', { class: 'spacer' }),
        button(t('common.cancel'), { onClick: () => dialog.close() }),
        button(t('query.apply'), {
          variant: 'primary',
          onClick: async () => {
            const incomplete = rows.filter((r) => !r.condition()).length;
            const query = build();
            if (incomplete && query.length) {
              const ok = await confirmDialog({
                title: t('query.incompleteTitle'),
                message: tn('query.incomplete', incomplete),
                confirmLabel: t('query.apply'),
              });
              if (!ok) return;
            }
            result = query.length ? query : null;
            dialog.close();
          },
        }),
      ],
      onClose: () => resolve(result),
    });
    dialog.el.querySelector('.qb-field')?.focus();
  });
}
