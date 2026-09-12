// DOM construction helpers. Text always goes in through textContent: API
// responses and imported files are untrusted, and nothing from them may ever be
// parsed as markup.

import { ICONS } from './icons.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Create an element. Props: `class` (string or array), `text`, `dataset`,
 * `on<event>` handlers, DOM properties for non-string values (checked, disabled,
 * value…), and attributes otherwise.
 */
export function h(tag, props = null, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (typeof value !== 'string' && key in el) el[key] = value;
      else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

export function icon(name, { size = 18, className = '' } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `icon ${className}`.trim());
  for (const [tag, attrs] of ICONS[name] || []) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.append(node);
  }
  return svg;
}

/** A button with an optional leading icon. */
export function button(label, { icon: iconName = null, variant = 'secondary', size = null, title = null, onClick = null, type = 'button', class: extraClass = null, ...rest } = {}) {
  return h(
    'button',
    {
      type,
      class: ['btn', `btn-${variant}`, size && `btn-${size}`, !label && 'btn-icon', extraClass],
      title: title || (label ? null : undefined),
      'aria-label': !label ? title : null,
      onclick: onClick,
      ...rest,
    },
    iconName ? icon(iconName, { size: size === 'sm' ? 16 : 18 }) : null,
    label ? h('span', null, label) : null,
  );
}

/**
 * A labelled form field wrapping *control*.
 *
 * *htmlFor* is the element the label should actually point to and receive the
 * id, when that differs from *control* itself — a composite control such as
 * `passwordInput()` returns a wrapper div (`.wrap`) to place in the layout,
 * but the label's `for` has to resolve to the real `<input>` inside it
 * (`.input`), or the id ends up on a non-focusable div and, worse, on both
 * elements if the caller also sets one manually.
 */
export function field(label, control, { hint = null, id = null, htmlFor = null } = {}) {
  const target = htmlFor || control;
  const controlId = id || target.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  target.id = controlId;
  return h(
    'div',
    { class: 'field' },
    h('label', { for: controlId, text: label }),
    control,
    hint ? h('p', { class: 'field-hint', text: hint }) : null,
  );
}

export function select(options, value, props = {}) {
  const el = h('select', props);
  for (const [optValue, label] of options) el.append(h('option', { value: optValue, text: label }));
  if (value != null) el.value = value;
  return el;
}
