// Attribute queries: what the Query Builder produces and the search sends.
//
// Two wire formats exist, and an API speaks one of them:
//
//   the STAC Query extension   { "query": { key: { op: value } } }. Every
//                              condition is ANDed; there is no way to say OR.
//                              NGP speaks only this, and so do some STAC APIs
//                              (Earth Search).
//   the STAC Filter extension  { "filter-lang": "cql2-json", "filter": <expr> }.
//   with CQL2-JSON             A real expression language; we use the part of
//                              it that a flat list of conditions needs, plus a
//                              global AND/OR.
//
// A query is therefore kept as a structured AttributeQuery — conditions, how
// they combine, and the dialect of the API it was built for — and serialised to
// the request body only at search time. Conditions use one operator vocabulary
// (the Query extension's names: eq, gte, in…) whichever dialect sends them, so
// the dialog does not care which it is.
//
// Values are stored as the user means them: a DATE field holds "yyyy-mm-dd", not
// an NGP-shaped date-time. Each dialect does its own rewriting on the way out.

import { FieldType } from './schema-scanner.js';

export const QUERY_EXTENSION = 'query';
export const CQL2_JSON = 'cql2-json';

// Conformance URI fragments. Matched as substrings, because the version segment
// differs between servers (v1.0.0-rc.2, v1.0.0) and the fact we need does not.
const CONF_FILTER = '/item-search#filter';
const CONF_CQL2_JSON = '/cql2/1.0/conf/cql2-json';
const CONF_ADVANCED_COMPARISON = '/cql2/1.0/conf/advanced-comparison-operators';
const CONF_QUERY = '/item-search#query';

const QUERY_EXTENSION_OPERATORS = {
  [FieldType.ENUM]: ['eq', 'neq', 'in'],
  [FieldType.STRING]: ['eq', 'neq', 'contains', 'startsWith', 'endsWith'],
  [FieldType.DATE]: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
  [FieldType.DATETIME]: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
  [FieldType.NUMBER]: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
  [FieldType.INTEGER]: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
  [FieldType.BOOLEAN]: ['eq', 'neq'],
  [FieldType.UUID]: ['eq'],
};

// `in` on a free-text field takes a comma-separated list. It is offered here and
// not for the Query extension because an OR of equalities is always expressible
// in CQL2, advanced operators or not.
const CQL2_OPERATORS = {
  ...QUERY_EXTENSION_OPERATORS,
  [FieldType.STRING]: ['eq', 'neq', 'in'],
};

const CQL2_COMPARISON = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
const LIKE_OPERATORS = ['contains', 'startsWith', 'endsWith'];

/**
 * How an API accepts attribute queries: { language, advancedComparison }.
 *
 * `advancedComparison` is CQL2's advanced-comparison-operators conformance
 * class: like, in and between. Without it, CQL2 is basic-cql2 — comparisons,
 * and/or/not and isNull only — so `in` is sent as an OR of equalities and the
 * like-based operators are not offered. Lantmäteriet's servers accept `like`
 * without advertising it; we go by what is advertised, since that is all a
 * server promises.
 */
export function queryDialect(language, { advancedComparison = false } = {}) {
  return Object.freeze({ language, advancedComparison });
}

export const NGP_DIALECT = queryDialect(QUERY_EXTENSION);

/** True when conditions can be ORed, not only ANDed. */
export const supportsAny = (dialect) => dialect.language === CQL2_JSON;

/** The operators the Query Builder offers for *fieldType* in *dialect*. */
export function dialectOperators(dialect, fieldType) {
  if (dialect.language === QUERY_EXTENSION) return [...(QUERY_EXTENSION_OPERATORS[fieldType] || ['eq'])];
  const ops = [...(CQL2_OPERATORS[fieldType] || ['eq'])];
  if (fieldType === FieldType.STRING && dialect.advancedComparison) ops.push(...LIKE_OPERATORS);
  return ops;
}

/**
 * The best dialect an API advertises, or null if it offers neither.
 *
 * CQL2 is preferred when both are advertised: it is the newer of the two, and
 * the only one that can express OR. Filter conformance alone is not enough — the
 * server must also take CQL2 *as JSON*, because a POST search carries the filter
 * in the body (Lantmäteriet's servers reject cql2-text there).
 */
export function dialectFromConformance(conformsTo) {
  const uris = (Array.isArray(conformsTo) ? conformsTo : []).filter((u) => typeof u === 'string');
  const has = (fragment) => uris.some((u) => u.includes(fragment));
  if (has(CONF_FILTER) && has(CONF_CQL2_JSON)) {
    return queryDialect(CQL2_JSON, { advancedComparison: has(CONF_ADVANCED_COMPARISON) });
  }
  if (has(CONF_QUERY)) return queryDialect(QUERY_EXTENSION);
  return null;
}

/** `key op value`. `value` is an array for `in`, a scalar otherwise. */
export const condition = (key, op, value, fieldType) => Object.freeze({ key, op, value, fieldType });

export class AttributeQuery {
  /**
   * *matchAny* ORs the conditions instead of ANDing them. Only meaningful when
   * the dialect supports it; ignored (always AND) otherwise.
   */
  constructor(conditions, dialect, { matchAny = false } = {}) {
    this.conditions = conditions;
    this.dialect = dialect;
    this.matchAny = matchAny;
  }

  get length() {
    return this.conditions.length;
  }

  get isAny() {
    return this.matchAny && supportsAny(this.dialect);
  }

  /** The keys this query adds to a /search POST body. */
  body() {
    if (!this.conditions.length) return {};
    if (this.dialect.language === CQL2_JSON) return { 'filter-lang': CQL2_JSON, filter: this.cql2() };
    return { query: this.queryExtension() };
  }

  /** Human-readable form of what will be sent, for the dialog. */
  preview() {
    if (!this.conditions.length) return '';
    if (this.dialect.language === CQL2_JSON) return cql2Text(this.cql2());
    return JSON.stringify(this.queryExtension(), null, 2);
  }

  // ── Query extension ──────────────────────────────────────────────────────

  queryExtension() {
    const query = {};
    for (const c of this.conditions) (query[c.key] ||= {})[c.op] = queryExtensionValue(c);
    return query;
  }

  // ── CQL2 ─────────────────────────────────────────────────────────────────

  cql2() {
    if (!this.isAny) return combine('and', this.conditions.map((c) => this.#cql2Condition(c)));
    return combine('or', rangeGroups(this.conditions).map((group) => combine('and', group.map((c) => this.#cql2Condition(c)))));
  }

  #cql2Condition(c) {
    const prop = { property: c.key };
    if (c.op in CQL2_COMPARISON) return { op: CQL2_COMPARISON[c.op], args: [prop, cql2Literal(c.value, c.fieldType)] };
    if (c.op === 'in') {
      const values = c.value.map((v) => cql2Literal(v, c.fieldType));
      if (this.dialect.advancedComparison) return { op: 'in', args: [prop, values] };
      return combine('or', values.map((v) => ({ op: '=', args: [prop, v] })));
    }
    if (LIKE_OPERATORS.includes(c.op)) {
      const text = likeEscape(String(c.value));
      const pattern = { contains: `%${text}%`, startsWith: `${text}%`, endsWith: `%${text}` }[c.op];
      return { op: 'like', args: [prop, pattern] };
    }
    throw new Error(`Unsupported operator for CQL2: ${c.op}`);
  }
}

const LOWER = ['gt', 'gte'];
const UPPER = ['lt', 'lte'];

/**
 * Split ORed conditions into groups, pairing range bounds into one group.
 *
 * `flygar > 1950 OR flygar < 1975` matches every item with a flygar, which
 * nobody asks for: the user meant a range. So, on the same key, a lower bound
 * below an upper bound is ANDed instead. The reverse — `flygar < 1950 OR
 * flygar > 1975` — is a meaningful "outside" query and is left alone, as is a
 * lower bound equal to an upper one unless both are inclusive (`>= 1975 OR
 * <= 1975` is everything; ANDed it is `= 1975`).
 *
 * Within a key, bounds are paired in value order: each upper bound closes the
 * nearest lower bound before it, so `> 1950, < 1975, > 2000, < 2010` is two
 * ranges. Groups keep the position of their first condition. Values that do not
 * compare (mixed types) are not paired.
 */
export function rangeGroups(conditions) {
  const byKey = new Map();
  conditions.forEach((c, i) => {
    if (LOWER.includes(c.op) || UPPER.includes(c.op)) {
      if (!byKey.has(c.key)) byKey.set(c.key, []);
      byKey.get(c.key).push(i);
    }
  });

  const partner = new Map();
  for (const indices of byKey.values()) {
    // JavaScript compares anything with anything; only same-typed values pair.
    if (new Set(indices.map((i) => typeof conditions[i].value)).size > 1) continue;
    // Lower bounds sort before upper bounds of the same value, so an inclusive
    // pair at one value meets in the walk below.
    const ordered = [...indices].sort((a, b) => {
      const va = conditions[a].value;
      const vb = conditions[b].value;
      if (va !== vb) return va < vb ? -1 : 1;
      return Number(!LOWER.includes(conditions[a].op)) - Number(!LOWER.includes(conditions[b].op));
    });
    let pending = null;
    for (const i of ordered) {
      if (LOWER.includes(conditions[i].op)) pending = i;
      else if (pending !== null && closes(conditions[pending], conditions[i])) {
        partner.set(pending, i);
        partner.set(i, pending);
        pending = null;
      }
    }
  }

  const groups = [];
  conditions.forEach((c, i) => {
    if (!partner.has(i)) groups.push([c]);
    else if (partner.get(i) > i) groups.push([c, conditions[partner.get(i)]]);
  });
  return groups;
}

function closes(lower, upper) {
  if (lower.value < upper.value) return true;
  return lower.value === upper.value && lower.op === 'gte' && upper.op === 'lte';
}

/**
 * The value as the Query extension wants it.
 *
 * NGP requires comparison operators on a date field to carry a full date-time
 * value; only eq/neq accept a bare date. The day boundary follows the operator's
 * intent: gte/lt at the start of the day, gt/lte at its end.
 */
function queryExtensionValue(c) {
  if (c.fieldType === FieldType.DATE) {
    if (c.op === 'gte' || c.op === 'lt') return `${c.value}T00:00:00Z`;
    if (c.op === 'gt' || c.op === 'lte') return `${c.value}T23:59:59Z`;
  }
  return c.value;
}

/** Temporal values are typed literals in CQL2; everything else is plain JSON. */
function cql2Literal(value, fieldType) {
  if (fieldType === FieldType.DATETIME) return { timestamp: value };
  if (fieldType === FieldType.DATE) return { date: value };
  return value;
}

/** Escape CQL2 `like` wildcards so user text matches literally. */
const likeEscape = (text) => text.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');

const combine = (op, exprs) => (exprs.length === 1 ? exprs[0] : { op, args: exprs });

// ── CQL2-JSON → text, for the preview ────────────────────────────────────────

/**
 * Render the CQL2-JSON subset this module produces as CQL2 text.
 *
 * Only for display: the request always carries the JSON form. Parenthesises a
 * nested and/or so `a OR (b OR c)` from an expanded `in` under a global AND
 * reads unambiguously.
 */
export function cql2Text(expr, parent = null) {
  if (expr !== null && typeof expr === 'object' && !Array.isArray(expr)) {
    if ('property' in expr) return String(expr.property);
    if ('timestamp' in expr) return `TIMESTAMP('${expr.timestamp}')`;
    if ('date' in expr) return `DATE('${expr.date}')`;
    const { op, args = [] } = expr;
    if (op === 'and' || op === 'or') {
      const text = args.map((a) => cql2Text(a, op)).join(` ${op.toUpperCase()} `);
      return parent !== null ? `(${text})` : text;
    }
    if (op === 'in') return `${cql2Text(args[0])} IN (${args[1].map((v) => cql2Text(v)).join(', ')})`;
    if (op === 'like') return `${cql2Text(args[0])} LIKE ${cql2Text(args[1])}`;
    return `${cql2Text(args[0])} ${op} ${cql2Text(args[1])}`;
  }
  if (typeof expr === 'string') return `'${expr.replace(/'/g, "''")}'`;
  if (typeof expr === 'boolean') return expr ? 'TRUE' : 'FALSE';
  return JSON.stringify(expr);
}
