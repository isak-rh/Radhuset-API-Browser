// The Query Builder: attribute filters for NGP APIs, built from the fields the
// API's JSON schema declares queryable (see stac/schema-scanner.js). The result
// is a STAC query-extension object: { "detaljplan.status": { "eq": "..." } }.

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

function fieldSelect(fields) {
  const select = h('select', { class: 'qb-field', 'aria-label': t('query.fieldAriaLabel') });
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
    } else if (field.fieldType === FieldType.ENUM) {
      control = h('select', null, (field.values || []).map((v) => h('option', { value: String(v), text: String(v) })));
    } else if (field.fieldType === FieldType.BOOLEAN) {
      control = h('select', null, h('option', { value: 'true', text: 'true' }), h('option', { value: 'false', text: 'false' }));
    } else if (field.fieldType === FieldType.DATE) {
      control = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
    } else if (field.fieldType === FieldType.DATETIME) {
      control = h('input', { type: 'datetime-local', step: '1' });
    } else if (field.fieldType === FieldType.NUMBER) {
      control = h('input', { type: 'number', step: 'any', placeholder: t('query.numberPlaceholder') });
    } else if (field.fieldType === FieldType.INTEGER) {
      control = h('input', { type: 'number', step: '1', placeholder: t('query.wholeNumberPlaceholder') });
    } else {
      control = h('input', { type: 'text', placeholder: field.fieldType === FieldType.UUID ? t('query.uuidPlaceholder') : t('query.valuePlaceholder'), spellcheck: 'false' });
    }
    control.setAttribute('aria-label', t('query.valueAriaLabel'));
    this.control = control;
    this.valueEl.replaceChildren(control);
  }

  /** [key, operator, value], or null while the row has no value. */
  condition() {
    const { field } = this;
    const op = this.opEl.value;
    const raw = this.control.value;
    switch (field.fieldType) {
      case FieldType.ENUM: {
        if (op === 'in') {
          const values = this.multi.get();
          return values.length ? [field.key, op, values] : null;
        }
        if (!(field.values || []).length) return null;
        return [field.key, op, field.values.find((v) => String(v) === raw) ?? raw];
      }
      case FieldType.BOOLEAN:
        return [field.key, op, raw === 'true'];
      case FieldType.DATE:
        if (!raw) return null;
        // NGP needs comparisons on a date field to carry a full date-time; only
        // eq/neq take a bare date. The day boundary follows the operator's intent:
        // gte/lt at the start of the day, gt/lte at its end.
        if (op === 'gte' || op === 'lt') return [field.key, op, `${raw}T00:00:00Z`];
        if (op === 'gt' || op === 'lte') return [field.key, op, `${raw}T23:59:59Z`];
        return [field.key, op, raw];
      case FieldType.DATETIME:
        if (!raw) return null;
        return [field.key, op, `${raw.length === 16 ? `${raw}:00` : raw}Z`];
      case FieldType.NUMBER:
      case FieldType.INTEGER:
        return raw === '' || !Number.isFinite(Number(raw)) ? null : [field.key, op, Number(raw)];
      default:
        return raw.trim() ? [field.key, op, raw.trim()] : null;
    }
  }

  /** Fill from an existing query entry. False when the field or operator is unknown. */
  load(key, op, value) {
    if (!this.byKey.has(key)) return false;
    this.fieldEl.value = key;
    this.#fieldChanged();
    if (!this.field.operators.includes(op)) return false;
    this.opEl.value = op;
    this.#buildValue();
    const { fieldType } = this.field;
    if (this.multi) this.multi.set(value);
    else if (fieldType === FieldType.DATE) this.control.value = String(value).slice(0, 10);
    else if (fieldType === FieldType.DATETIME) this.control.value = String(value).replace(/Z$/, '').slice(0, 19);
    else this.control.value = String(value);
    return true;
  }
}

/** Open the builder. Resolves to the new query (null for none), or undefined if cancelled. */
export function openQueryBuilder({ scan, existing = null }) {
  return new Promise((resolve) => {
    const rows = [];
    let result;
    const rowsEl = h('div', { class: 'qb-rows' });
    const preview = h('pre', { class: 'qb-preview' });

    const build = () => {
      const query = {};
      for (const row of rows) {
        const cond = row.condition();
        if (!cond) continue;
        const [key, op, value] = cond;
        (query[key] ||= {})[op] = value;
      }
      return query;
    };
    const update = () => {
      const q = build();
      preview.textContent = Object.keys(q).length ? JSON.stringify(q, null, 2) : '{}';
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
      for (const [key, ops] of Object.entries(existing)) {
        if (!ops || typeof ops !== 'object') continue;
        for (const [op, value] of Object.entries(ops)) {
          const row = add();
          if (!row.load(key, op, value)) remove(row);
        }
      }
    }
    if (!rows.length) add();
    update();

    const dialog = openDialog({
      title: t('query.title', { subtitle: scan.title || t('query.defaultSubtitle') }),
      size: 'lg',
      body: h(
        'div',
        { class: 'qb' },
        h('p', { class: 'muted', text: t('query.intro') }),
        rowsEl,
        button(t('query.addCondition'), { icon: 'plus', variant: 'ghost', onClick: () => add().fieldEl.focus() }),
        h('details', { class: 'qb-preview-wrap' }, h('summary', { text: t('query.jsonSummary') }), preview),
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
            if (incomplete && Object.keys(query).length) {
              const ok = await confirmDialog({
                title: t('query.incompleteTitle'),
                message: tn('query.incomplete', incomplete),
                confirmLabel: t('query.apply'),
              });
              if (!ok) return;
            }
            result = Object.keys(query).length ? query : null;
            dialog.close();
          },
        }),
      ],
      onClose: () => resolve(result),
    });
    dialog.el.querySelector('.qb-field')?.focus();
  });
}

export const queryFieldCount = (query) => (query ? Object.values(query).reduce((n, ops) => n + Object.keys(ops).length, 0) : 0);
