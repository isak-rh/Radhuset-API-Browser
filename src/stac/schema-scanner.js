// Lantmäteriet domain-object schema scanner.
//
// Walks a Lantmäteriet JSON schema (as served at an NGP API's `schema_url`) and
// returns every queryable field, for the Query Builder to offer and for building
// STAC query-extension payloads (`{ "detaljplan.status": { "eq": "..." } }`).
//
//   scan(schema, maxDepth = 10) -> { title, fields: QueryField[] }
//
// QueryField: { key, fieldType, operators, path, values, discriminator }
//   key            dot-notation query key, e.g. "detaljplan.status" or "feature.typ"
//   fieldType      one of FieldType
//   operators      STAC query operators valid for the type
//   values         allowed values for enum fields, otherwise null
//   discriminator  true for fields derived from colon-named properties
//                  ("feature:typ"), whose enum values are merged across every
//                  domain-object subtype.

export const FieldType = Object.freeze({
  ENUM: 'enum',
  STRING: 'string',
  DATE: 'date',
  DATETIME: 'datetime',
  NUMBER: 'number',
  INTEGER: 'integer',
  BOOLEAN: 'boolean',
  UUID: 'uuid',
});

const OPERATORS = {
  [FieldType.ENUM]: ['eq', 'neq', 'in'],
  [FieldType.STRING]: ['eq', 'neq', 'contains', 'startsWith', 'endsWith'],
  [FieldType.DATE]: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
  [FieldType.DATETIME]: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
  [FieldType.NUMBER]: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
  [FieldType.INTEGER]: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
  [FieldType.BOOLEAN]: ['eq', 'neq'],
  [FieldType.UUID]: ['eq'],
};

// Fields skipped wherever they appear. Empty for now; kept as the place to add one.
const SKIP_FIELDS = new Set();

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ── $ref resolution and schema merging ──────────────────────────────────────

/** Resolve a local JSON Pointer $ref. Returns {} for external refs. */
function resolveRef(ref, root) {
  if (!ref.startsWith('#/')) return {};
  let node = root;
  for (const raw of ref.replace(/^[#/]+/, '').split('/')) {
    const part = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObject(node) || !(part in node)) return {};
    node = node[part];
  }
  return isObject(node) ? node : {};
}

function resolve(node, root) {
  return isObject(node) && '$ref' in node ? resolveRef(node.$ref, root) : node;
}

function refName(node) {
  const ref = isObject(node) ? node.$ref || '' : '';
  return ref.startsWith('#/definitions/') ? ref.split('/').pop() : null;
}

/** Every property visible from *node*, merging allOf branches and following $refs. */
function mergedProperties(node, root) {
  node = resolve(node, root);
  const props = {};
  if (isObject(node.properties)) Object.assign(props, node.properties);
  for (const branch of node.allOf || []) {
    Object.assign(props, mergedProperties(resolve(branch, root), root));
  }
  return props;
}

// ── Domain-object discovery ──────────────────────────────────────────────────

function allOfRefNames(node) {
  return (node.allOf || []).map(refName).filter((n) => n !== null);
}

/** The definition shared in every subtype's allOf — the namespace prefix of a oneOf group. */
function commonBase(subtypes, root) {
  if (!subtypes.length) return null;
  const sets = subtypes.map((s) => new Set(allOfRefNames(resolve(s, root))));
  for (const name of sets[0]) {
    if (sets.every((set) => set.has(name))) return name;
  }
  return null;
}

/** Follow $ref / oneOf / allOf until reaching a node with properties. */
function followToObject(node, root, depth = 0) {
  if (depth > 12) return null;
  node = resolve(node, root);
  if (!isObject(node)) return null;
  if ('properties' in node || 'allOf' in node) return node;
  for (const branch of [...(node.oneOf || []), ...(node.anyOf || [])]) {
    const found = followToObject(branch, root, depth + 1);
    if (found) return found;
  }
  return null;
}

function domainObjectsFromPropField(propField, root) {
  if (isObject(propField) && '$ref' in propField) {
    const obj = followToObject(propField, root);
    return obj ? [[refName(propField), obj]] : [];
  }
  const branches = propField.oneOf || propField.anyOf || [];
  if (!branches.length) {
    const obj = followToObject(propField, root);
    return obj ? [[null, obj]] : [];
  }
  const prefix = commonBase(branches, root);
  const results = [];
  for (const branch of branches) {
    const obj = followToObject(branch, root);
    if (obj) results.push([prefix || refName(branch), obj]);
  }
  return results;
}

/** Domain objects inside a FeatureCollection wrapper: features[].items.*.properties. */
function domainObjectsFromFeatureCollection(rootNode, schema) {
  const props = mergedProperties(rootNode, schema);
  const featuresSchema = resolve(props.features || {}, schema);
  const items = resolve(featuresSchema.items || {}, schema);
  let branches = items.oneOf || items.anyOf || [];
  if (!branches.length) branches = [items];

  const result = [];
  for (const branch of branches) {
    const feature = followToObject(branch, schema);
    if (!feature) continue;
    const propField = mergedProperties(feature, schema).properties;
    if (propField === undefined) continue;
    result.push(...domainObjectsFromPropField(propField, schema));
  }
  return result;
}

/**
 * Every domain-object node in the schema, as [namespacePrefix, node] pairs.
 *
 * Three structural patterns occur: a flat root that is itself the wrapper; a
 * FeatureCollection wrapper with the objects under features[].items; and a root
 * oneOf/anyOf listing several subtype wrappers (detaljplan / planbestämmelse),
 * each of which must be walked — following only the first branch would drop
 * every other subtype's fields and discriminator values.
 */
function findDomainObjects(schema) {
  const root = resolve(schema, schema);
  const branches = root.oneOf || root.anyOf || [];
  let wrappers;
  if (branches.length) {
    wrappers = branches.map((b) => followToObject(b, schema)).filter(Boolean);
  } else {
    const wrapper = followToObject(root, schema);
    wrappers = wrapper ? [wrapper] : [];
  }
  const results = [];
  for (const wrapper of wrappers) {
    if ('features' in mergedProperties(wrapper, schema)) {
      results.push(...domainObjectsFromFeatureCollection(wrapper, schema));
    } else {
      results.push([null, wrapper]);
    }
  }
  return results;
}

// ── Leaf classification ─────────────────────────────────────────────────────

function classify(node, root) {
  if (node.queryable === false) return null;
  const resolved = resolve(node, root);
  if (!isObject(resolved) || resolved.queryable === false) return null;
  if (resolved.type === 'null') return null;
  const pattern = resolved.pattern || '';
  if (pattern.includes('a-f0-9') && pattern.length > 20) return FieldType.UUID;

  // `const` is a degenerate enum: fixed within one subtype but different between
  // subtypes (feature.typ = "strandskydd" vs "beslut"), so it is unioned with
  // the other subtypes' values exactly like an enum.
  if (resolved.enum != null || 'const' in resolved) return FieldType.ENUM;
  switch (resolved.type) {
    case 'string':
      if (resolved.format === 'date-time') return FieldType.DATETIME;
      if (resolved.format === 'date') return FieldType.DATE;
      if (resolved.format === 'uuid') return FieldType.UUID;
      return FieldType.STRING;
    case 'number': return FieldType.NUMBER;
    case 'integer': return FieldType.INTEGER;
    case 'boolean': return FieldType.BOOLEAN;
    default: return null;
  }
}

// ── Recursive walker ─────────────────────────────────────────────────────────

function walk(node, root, path, regular, colonFields, seen, maxDepth) {
  // A field is included only while its path length is within maxDepth. The
  // namespace prefix counts as one segment, so maxDepth 2 yields
  // "detaljplan.status" and 3 allows one level of nesting below that.
  if (path.length >= maxDepth) return;

  node = resolve(node, root);
  if (!isObject(node) || seen.has(node)) return;
  const nextSeen = new Set(seen).add(node);
  if (node.queryable === false) return;

  for (const [name, childSchema] of Object.entries(mergedProperties(node, root))) {
    if (!isObject(childSchema)) continue;

    // Colon field: rewrite to dot notation and accumulate its enum values.
    if (name.includes(':')) {
      if (!SKIP_FIELDS.has(name)) {
        const child = resolve(childSchema, root);
        let values = child.enum || [];
        if (!values.length && 'const' in child) values = [child.const];
        if (values.length) {
          const key = name.replace(/:/g, '.');
          if (!colonFields.has(key)) colonFields.set(key, new Set());
          values.forEach((v) => colonFields.get(key).add(v));
        }
      }
      continue;
    }
    if (SKIP_FIELDS.has(name)) continue;

    const child = resolve(childSchema, root);
    if (!isObject(child)) continue;
    if (childSchema.queryable === false || child.queryable === false) continue;

    const childPath = [...path, name];
    const fieldType = classify(childSchema, root);
    if (fieldType !== null) {
      let values = child.enum ?? null;
      if (values === null && 'const' in child) values = [child.const];
      regular.push({
        path: childPath,
        key: childPath.join('.'),
        fieldType,
        values: values !== null ? [...values] : null,
      });
      continue;
    }

    if ('properties' in child || 'allOf' in child || child.type === 'object') {
      walk(child, root, childPath, regular, colonFields, nextSeen, maxDepth);
      continue;
    }

    if (child.type === 'array') {
      const itemsSchema = child.items || {};
      const items = resolve(itemsSchema, root);
      if (isObject(items) && ('properties' in items || 'allOf' in items || '$ref' in itemsSchema)) {
        walk(items, root, childPath, regular, colonFields, nextSeen, maxDepth);
      }
    }
  }
}

const byText = (a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);

/**
 * Every queryable field in *schema*: discriminators first, then regular fields
 * in discovery order, deduplicated by key with enum values unioned across
 * subtypes.
 */
export function scan(schema, maxDepth = 10) {
  const title = (isObject(schema) && schema.title) || '';
  const domainObjects = isObject(schema) ? findDomainObjects(schema) : [];
  if (!domainObjects.length) return { title, fields: [] };

  // Pass 1: every colon-field value across every subtype, before any dedupe, so
  // the discriminator dropdowns are complete.
  const allColon = new Map();
  for (const [prefix, obj] of domainObjects) {
    const colon = new Map();
    walk(obj, schema, prefix ? [prefix] : [], [], colon, new Set(), maxDepth);
    for (const [key, values] of colon) {
      if (!allColon.has(key)) allColon.set(key, new Set());
      values.forEach((v) => allColon.get(key).add(v));
    }
  }

  // Pass 2: regular fields, deduplicated by key. A key present in several
  // subtypes with different enum values gets their union.
  const seenKeys = new Map();
  const allRegular = [];
  for (const [prefix, obj] of domainObjects) {
    const regular = [];
    walk(obj, schema, prefix ? [prefix] : [], regular, new Map(), new Set(), maxDepth);
    for (const r of regular) {
      const existing = seenKeys.get(r.key);
      if (!existing) {
        seenKeys.set(r.key, r);
        allRegular.push(r);
      } else if (r.values && existing.values) {
        for (const v of r.values) if (!existing.values.includes(v)) existing.values.push(v);
      }
    }
  }

  const fields = [];
  for (const key of [...allColon.keys()].sort(byText)) {
    fields.push({
      key,
      fieldType: FieldType.ENUM,
      operators: OPERATORS[FieldType.ENUM],
      path: key.split('.'),
      values: [...allColon.get(key)].sort(byText),
      discriminator: true,
    });
  }
  for (const r of allRegular) {
    fields.push({
      key: r.key,
      fieldType: r.fieldType,
      operators: OPERATORS[r.fieldType] || ['eq'],
      path: r.path,
      values: r.values,
      discriminator: false,
    });
  }
  return { title, fields };
}
