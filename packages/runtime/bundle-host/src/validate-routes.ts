/**
 * Promotion-time and dispatch-time validators for
 * `bundle-http-and-ui-surface`.
 *
 * - {@link validateBundleRoutesAgainstKnownRoutes} compares a bundle's
 *   declared `surfaces.httpRoutes` against the host's currently-resolved
 *   static handler shape (method+path tuples). Used by
 *   `BundleRegistry.setActive` and the dispatch-time guard.
 * - {@link validateBundleActionIdsAgainstKnownIds} compares a bundle's
 *   declared `surfaces.actionCapabilityIds` against host-registered
 *   capability ids.
 */

/** Minimal route shape used for collision detection. */
export interface RouteSpec {
  method: string;
  path: string;
}

export type RouteValidationResult = { valid: true } | { valid: false; collisions: RouteSpec[] };

export type ActionIdValidationResult = { valid: true } | { valid: false; collidingIds: string[] };

/**
 * Detect collisions between a bundle's declared HTTP routes and the
 * host's currently-resolved static handler shape.
 *
 * - `declared` undefined/empty → always valid.
 * - `known` undefined → always valid (caller opted out).
 * - Otherwise: any declared `${method}:${path}` that matches a known
 *   tuple is a collision. Duplicates within the result are deduped.
 */
export function validateBundleRoutesAgainstKnownRoutes(
  declared: readonly RouteSpec[] | undefined,
  known: readonly RouteSpec[] | undefined,
): RouteValidationResult {
  if (!declared || declared.length === 0) return { valid: true };
  if (!known || known.length === 0) return { valid: true };

  const knownKeys = new Set<string>();
  for (const r of known) knownKeys.add(`${r.method}:${r.path}`);

  const collisions: RouteSpec[] = [];
  const seen = new Set<string>();
  for (const r of declared) {
    if (!r || typeof r.method !== "string" || typeof r.path !== "string") continue;
    const key = `${r.method}:${r.path}`;
    if (!knownKeys.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    collisions.push({ method: r.method, path: r.path });
  }

  if (collisions.length === 0) return { valid: true };
  return { valid: false, collisions };
}

/**
 * Detect collisions between a bundle's declared action capability ids
 * and the host's registered capability ids.
 *
 * - `declared` undefined/empty → always valid.
 * - `knownCapabilityIds` undefined → always valid (caller opted out).
 * - Otherwise: any declared id present in the known set is a collision.
 */
export function validateBundleActionIdsAgainstKnownIds(
  declared: readonly string[] | undefined,
  knownCapabilityIds: ReadonlySet<string> | readonly string[] | undefined,
): ActionIdValidationResult {
  if (!declared || declared.length === 0) return { valid: true };
  if (!knownCapabilityIds) return { valid: true };

  const knownSet =
    knownCapabilityIds instanceof Set
      ? knownCapabilityIds
      : new Set(knownCapabilityIds as readonly string[]);
  if (knownSet.size === 0) return { valid: true };

  const collidingIds: string[] = [];
  const seen = new Set<string>();
  for (const id of declared) {
    if (typeof id !== "string") continue;
    if (!knownSet.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    collidingIds.push(id);
  }

  if (collidingIds.length === 0) return { valid: true };
  return { valid: false, collidingIds };
}

/**
 * Thrown by `BundleRegistry.setActive` (and surfaced by the dispatch-
 * time route-collision guard) when a bundle's declared
 * `surfaces.httpRoutes` overlaps the host's currently-resolved static
 * handler shape. The `code` field survives structured-clone boundaries
 * even when class identity is lost across RPC frames.
 */
export class RouteCollisionError extends Error {
  readonly code = "ERR_HTTP_ROUTE_COLLISION" as const;
  readonly collisions: RouteSpec[];
  readonly versionId: string;

  constructor(args: { collisions: RouteSpec[]; versionId: string; message?: string }) {
    const list = args.collisions.map((c) => `${c.method} ${c.path}`).join(", ");
    const msg =
      args.message ??
      `bundle version '${args.versionId}' declares HTTP route(s) that collide with host static handlers: ${list}`;
    super(msg);
    this.name = "RouteCollisionError";
    this.collisions = args.collisions;
    this.versionId = args.versionId;
  }
}

/**
 * Thrown by `BundleRegistry.setActive` (and surfaced by the dispatch-
 * time action-id-collision guard) when a bundle's declared
 * `surfaces.actionCapabilityIds` overlaps a host-registered capability
 * id. Discriminate via `code === "ERR_ACTION_ID_COLLISION"`.
 */
export class ActionIdCollisionError extends Error {
  readonly code = "ERR_ACTION_ID_COLLISION" as const;
  readonly collidingIds: string[];
  readonly versionId: string;

  constructor(args: { collidingIds: string[]; versionId: string; message?: string }) {
    const msg =
      args.message ??
      `bundle version '${args.versionId}' declares onAction on capability id(s) that collide with host-registered capabilities: ${args.collidingIds.join(", ")}`;
    super(msg);
    this.name = "ActionIdCollisionError";
    this.collidingIds = args.collidingIds;
    this.versionId = args.versionId;
  }
}
