import { localeTag } from '../i18n/index.js';

const formatters = new Map();

export function formatNumber(n) {
  const tag = localeTag();
  let nf = formatters.get(tag);
  if (!nf) {
    nf = new Intl.NumberFormat(tag);
    formatters.set(tag, nf);
  }
  return nf.format(n);
}

/** Decimal units, as browsers' own download managers show them. */
export function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1000) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1000;
    unit++;
  } while (value >= 1000 && unit < units.length - 1);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${Math.round(seconds % 60)} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * A STAC datetime shown compactly: "2024-05-01", or with the time when it is
 * not midnight. Anything unparseable is shown as given.
 */
export function formatDateTime(value) {
  if (!value) return '—';
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::(\d{2}))?)?/.exec(String(value));
  if (!match) return String(value);
  const [, date, time, seconds] = match;
  if (!time || (time === '00:00' && (!seconds || seconds === '00'))) return date;
  return `${date} ${time}`;
}

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function todayIso(offsetYears = 0) {
  const d = new Date();
  d.setFullYear(d.getFullYear() + offsetYears);
  return d.toISOString().slice(0, 10);
}
