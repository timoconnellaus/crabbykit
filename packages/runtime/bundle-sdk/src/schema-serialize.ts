/**
 * TypeBox schema serialization helpers for bundle metadata.
 *
 * TypeBox marks schema nodes with `Symbol.for("TypeBox.Kind")` — a
 * non-enumerable, non-cloneable symbol. `Value.Check` dispatches on
 * that symbol, so a naive `JSON.parse(JSON.stringify(schema))` yields
 * a schema `Value.Check` rejects with `ValueCheckUnknownTypeError`.
 *
 * {@link serializeBundleSchema} walks the schema and mirrors the Kind
 * onto a plain enumerable `Kind` string property so metadata remains
 * pure JSON. {@link hydrateBundleSchema} reverses the operation
 * host-side — reads the `Kind` string and re-attaches the symbol so
 * `Value.Check` dispatches through the TypeBox fast path.
 *
 * Covers the `Kind` set documented as supported in the
 * `bundle-config-namespaces` Decision 1: Object / String / Number /
 * Integer / Boolean / Array / Literal / Union / Intersect / Optional
 * / Recursive / Unsafe / Null / Any / Unknown / Record / Tuple /
 * Uint8Array / Never / Promise / Enum / Date / Undefined. Transform /
 * Constructor / Function schemas are REJECTED at validation time
 * before this helper runs.
 */

const KIND_SYMBOL = Symbol.for("TypeBox.Kind");

function cloneAndAnnotate(node: unknown): unknown {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    return node.map((entry) => cloneAndAnnotate(entry));
  }
  const rec = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rec)) {
    out[key] = cloneAndAnnotate(value);
  }
  const kind = (rec as Record<symbol, unknown>)[KIND_SYMBOL];
  if (typeof kind === "string" && out.Kind === undefined) {
    out.Kind = kind;
  }
  return out;
}

/**
 * Walk a TypeBox schema and produce a pure-JSON clone with every node's
 * `Symbol(TypeBox.Kind)` mirrored to an enumerable `Kind` string
 * property. Safe to JSON.stringify for metadata storage.
 */
export function serializeBundleSchema(schema: unknown): unknown {
  return cloneAndAnnotate(schema);
}

function restoreKindInPlace(node: unknown): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const entry of node) restoreKindInPlace(entry);
    return;
  }
  const rec = node as Record<string, unknown>;
  const kind = rec.Kind;
  if (typeof kind === "string") {
    (rec as Record<symbol, unknown>)[KIND_SYMBOL] = kind;
  }
  for (const value of Object.values(rec)) {
    restoreKindInPlace(value);
  }
}

/**
 * Reverse of {@link serializeBundleSchema}. Walks the schema and
 * re-attaches `Symbol(TypeBox.Kind)` from the enumerable `Kind` string
 * so TypeBox's `Value.Check` / `Value.Errors` / `Value.Create`
 * dispatch correctly.
 *
 * Operates in-place on a freshly-parsed JSON object so downstream
 * callers can hold a reference without re-hydrating on every read. The
 * returned schema is the same reference.
 */
export function hydrateBundleSchema(schema: unknown): unknown {
  restoreKindInPlace(schema);
  return schema;
}
