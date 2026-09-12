// Deciding what a downloaded file is called.

/**
 * Undo a server putting raw UTF-8 bytes into a header value instead of
 * encoding them (percent-encoding, or RFC 2231/5987).
 *
 * The Fetch API decodes header bytes as Latin-1 — one byte, one code point —
 * which is what the spec requires, not a browser bug. When a server writes
 * non-ASCII bytes straight into Content-Disposition without encoding them,
 * what arrives here is exactly those UTF-8 bytes, each misread as its own
 * Latin-1 character: "höjdsystem" turns up as "hÃ¶jdsystem". Rebuilding the
 * byte sequence from those code points and decoding it as UTF-8 recovers the
 * original text.
 *
 * Safe to call on anything: a string with no byte above U+007F round-trips
 * unchanged (ASCII means the same thing in both encodings), and one already
 * correctly decoded to Unicode is rejected by the strict UTF-8 decode below
 * unless its extended-Latin characters happen to chain into another valid
 * multi-byte sequence — vanishingly unlikely, and the failure mode is a
 * wrong-looking name, not lost data.
 */
function undoLatin1Mojibake(str) {
  // A candidate needs at least one byte above ASCII (code point 128-255),
  // and every character has to fit in one byte (code point 0-255) -- a
  // genuine wider Unicode character rules out "this is raw Latin-1-misread
  // bytes" outright. Written with numeric charCodeAt() comparisons, not a
  // regex character range, so the byte range can't be mangled in transit
  // through a text-based tool pipeline the way \uXXXX escapes were.
  let hasHighByte = false;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code > 255) return str;
    if (code >= 128) hasHighByte = true;
  }
  if (!hasHighByte) return str;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(str, (ch) => ch.charCodeAt(0)));
  } catch {
    return str;
  }
}

/**
 * The filename in a Content-Disposition header. Prefers the RFC 5987 extended
 * form (filename*=UTF-8''…). The plain form is percent-decoded too — some
 * Lantmäteriet backends put percent-encoded UTF-8 there
 * ("Plankarta%20%C3%96stermalmstorg.pdf") rather than following RFC 6266 —
 * and, either way, the result is passed through undoLatin1Mojibake() for
 * backends that instead write the raw UTF-8 bytes unencoded.
 */
export function filenameFromDisposition(header) {
  if (!header) return null;
  const extended = /filename\*\s*=\s*([\w-]*)'[^']*'([^;]+)/i.exec(header);
  if (extended) {
    try {
      return undoLatin1Mojibake(decodeURIComponent(extended[2].trim().replace(/^"|"$/g, '')));
    } catch {
      /* fall through to the plain parameter */
    }
  }
  const plain = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header) || /filename\s*=\s*([^;]+)/i.exec(header);
  if (!plain) return null;
  const raw = plain[1].trim().replace(/\\(.)/g, '$1');
  try {
    return undoLatin1Mojibake(decodeURIComponent(raw));
  } catch {
    return undoLatin1Mojibake(raw);
  }
}

export function filenameFromUrl(href) {
  try {
    const last = new URL(href).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : null;
  } catch {
    return null;
  }
}

const EXTENSIONS = {
  'application/json': '.json',
  'application/geo+json': '.geojson',
  'application/zip': '.zip',
  'application/pdf': '.pdf',
  'application/xml': '.xml',
  'text/xml': '.xml',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'image/tiff': '.tif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'application/geopackage+sqlite3': '.gpkg',
};

/** An extension for *contentType* when *name* has none. */
export function withExtension(name, contentType) {
  if (/\.[a-z0-9]{1,8}$/i.test(name)) return name;
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  const ext = EXTENSIONS[type] || (type.endsWith('+json') ? '.json' : '');
  return name + ext;
}

/** A name safe on every file system this might be saved to. */
export function sanitizeFilename(name, fallback = 'download') {
  // Basename only: a decoded header value could contain "../".
  let clean = String(name || '').split(/[\\/]/).pop();
  clean = clean.replace(/[\p{Cc}<>:"|?*]/gu, '_').replace(/[. ]+$/, '').trim();
  if (!clean || clean === '.' || clean === '..') clean = fallback;
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(clean)) clean = `_${clean}`;
  if (clean.length > 180) {
    const ext = /\.[^.]{1,10}$/.exec(clean)?.[0] || '';
    clean = clean.slice(0, 180 - ext.length) + ext;
  }
  return clean;
}

/**
 * *name*, or "name (2).ext" etc. if already in *taken* (lower-cased names).
 * Records the result in *taken*.
 */
export function uniqueName(name, taken) {
  let candidate = name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}
