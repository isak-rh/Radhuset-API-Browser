// Popup menus: context menus at a point, and dropdowns under an anchor.

import { h, icon } from '../lib/dom.js';

let current = null;

export function closeMenu() {
  current?.();
  current = null;
}

/**
 * Items: { label, icon?, onSelect, disabled?, danger?, hint? }, 'separator',
 * or { heading }. Position under *anchor* (an element), or at client
 * coordinates *x* and *y*.
 */
export function openMenu({ items, anchor = null, x = 0, y = 0, align = 'start', className = null, matchWidth = false }) {
  closeMenu();
  const menu = h('div', { class: ['menu', className], role: 'menu' });
  if (anchor && matchWidth) menu.style.width = `${anchor.getBoundingClientRect().width}px`;
  const buttons = [];
  for (const item of items) {
    if (item === 'separator') {
      menu.append(h('div', { class: 'menu-separator', role: 'separator' }));
    } else if (item.heading) {
      menu.append(h('div', { class: 'menu-heading', text: item.heading }));
    } else {
      const b = h(
        'button',
        {
          type: 'button',
          class: ['menu-item', item.danger && 'is-danger'],
          role: 'menuitem',
          disabled: item.disabled || null,
          onclick: () => {
            close();
            item.onSelect?.();
          },
        },
        item.icon ? icon(item.icon, { size: 16 }) : h('span', { class: 'menu-icon-space' }),
        h(
          'span',
          { class: 'menu-text' },
          h('span', { class: 'menu-label', text: item.label }),
          item.description ? h('span', { class: 'menu-description', text: item.description }) : null,
        ),
        item.hint ? h('span', { class: 'menu-hint', text: item.hint }) : null,
      );
      buttons.push(b);
      menu.append(b);
    }
  }
  document.body.append(menu);

  // Place, then keep inside the viewport.
  const rect = menu.getBoundingClientRect();
  let left = x;
  let top = y;
  if (anchor) {
    const a = anchor.getBoundingClientRect();
    left = align === 'end' ? a.right - rect.width : a.left;
    top = a.bottom + 4;
    if (top + rect.height > window.innerHeight - 8) top = a.top - rect.height - 4;
  }
  left = Math.max(8, Math.min(left, window.innerWidth - rect.width - 8));
  top = Math.max(8, Math.min(top, window.innerHeight - rect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const onPointer = (e) => { if (!menu.contains(e.target) && e.target !== anchor && !anchor?.contains(e.target)) close(); };
  const onKey = (e) => {
    const enabled = buttons.filter((b) => !b.disabled);
    const index = enabled.indexOf(document.activeElement);
    if (e.key === 'Escape') { close(); anchor?.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); enabled[(index + 1) % enabled.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); enabled[(index - 1 + enabled.length) % enabled.length]?.focus(); }
    else if (e.key === 'Tab') close();
  };
  const onScroll = (e) => { if (!menu.contains(e.target)) close(); };
  setTimeout(() => {
    document.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('blur', close);
  });
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', close);
  document.addEventListener('scroll', onScroll, true);

  function close() {
    menu.remove();
    document.removeEventListener('pointerdown', onPointer, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('blur', close);
    document.removeEventListener('scroll', onScroll, true);
    anchor?.setAttribute('aria-expanded', 'false');
    if (current === close) current = null;
  }
  current = close;
  anchor?.setAttribute('aria-expanded', 'true');
  buttons.find((b) => !b.disabled)?.focus({ preventScroll: true });
  return close;
}
