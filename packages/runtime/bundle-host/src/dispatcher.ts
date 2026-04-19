/**
 * BundleDispatcher — per-turn dispatch logic for bundle-enabled agents.
 *
 * Checks for an active bundle version, mints a capability token,
 * loads the bundle via Worker Loader, dispatches the turn, and
 * consumes the response stream. Falls back to static brain on
 * load failure or when no bundle is active.
 */

import { validateCatalogAgainstKnownIds } from "@crabbykit/bundle-registry";
import type { BundleConfig, BundleDispatchState, BundleRegistry } from "./bundle-config.js";
import { BUNDLE_SUBKEY_LABEL, deriveMintSubkey, mintToken } from "./security/mint.js";

const DEFAULT_MAX_LOAD_FAILURES = 3;
const BUNDLE_ENVELOPE_VERSION = 1;

/**
 * Module format accepted by Worker Loader. Mirrors the shape returned by
 * @cloudflare/worker-bundler. Workshop serializes these inside the
 * version-1 JSON envelope.
 */
type BundleLoaderModule =
  | string
  | {
      js?: string;
      cjs?: string;
      text?: string;
      json?: unknown;
    };

export interface BundlePayload {
  mainModule: string;
  modules: Record<string, BundleLoaderModule>;
}

interface BundleEnvelopeV1 {
  v: typeof BUNDLE_ENVELOPE_VERSION;
  mainModule: string;
  modules: Record<string, BundleLoaderModule>;
}

/**
 * Decode bundle bytes into the shape Worker Loader expects.
 *
 * Version 1 envelope: the bytes are JSON of `{v:1, mainModule, modules}`
 * written by workshop after calling `@cloudflare/worker-bundler#createWorker`.
 *
 * Legacy fallback: for bundles persisted before the workshop migration,
 * the bytes are the raw JS of a single-file bundle and we wrap them in
 * a synthetic `{mainModule: "bundle.js", modules: {"bundle.js": source}}`.
 * Any bytes that fail JSON.parse, aren't an object, or lack the envelope
 * `v` sentinel fall through to legacy so pre-migration KV entries still load.
 */
export function decodeBundlePayload(source: string): BundlePayload {
  const trimmed = source.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(source) as unknown;
      if (isBundleEnvelopeV1(parsed)) {
        return { mainModule: parsed.mainModule, modules: parsed.modules };
      }
    } catch {
      // Fall through to legacy shape.
    }
  }
  return { mainModule: "bundle.js", modules: { "bundle.js": source } };
}

function isBundleEnvelopeV1(value: unknown): value is BundleEnvelopeV1 {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.v !== BUNDLE_ENVELOPE_VERSION) return false;
  if (typeof record.mainModule !== "string") return false;
  if (record.modules === null || typeof record.modules !== "object") return false;
  return true;
}

/**
 * Agent event from the bundle's NDJSON response stream.
 */
export interface BundleAgentEvent {
  type: string;
  event?: string;
  data?: Record<string, unknown>;
}

/**
 * Result of a bundle dispatch attempt.
 */
export type DispatchResult =
  | { dispatched: true; events: BundleAgentEvent[] }
  | { dispatched: false; reason: string };

/**
 * Event broadcast by the dispatcher when a bundle is disabled — includes
 * the structured `reason` payload for catalog-mismatch disables. Other
 * disable paths (manual, auto-revert) may omit `reason`.
 */
export interface BundleDisabledEventData {
  rationale: string;
  versionId: string | null;
  sessionId?: string;
  reason?:
    | {
        code: "ERR_CAPABILITY_MISMATCH";
        missingIds: string[];
        versionId: string;
      }
    | {
        code: string;
        [key: string]: unknown;
      };
}

export interface BundleDisabledEvent {
  type: "bundle_disabled";
  data: BundleDisabledEventData;
}

/**
 * Broadcast sink for bundle events. The DO's `initBundleDispatch` wires
 * this to the transport's `broadcastToSession` / global broadcast. Kept
 * narrow so unit tests can drive the dispatcher without a full transport.
 */
export type BundleEventBroadcaster = (event: BundleDisabledEvent) => void;

/**
 * BundleDispatcher manages the lifecycle of bundle dispatch for a single agent.
 */
export class BundleDispatcher<TEnv = Record<string, unknown>> {
  private readonly config: BundleConfig<TEnv>;
  private readonly env: TEnv;
  private readonly agentId: string;
  private readonly getHostCapabilityIds: () => string[];
  private readonly broadcastEvent: BundleEventBroadcaster | null;
  private registry: BundleRegistry | null = null;
  private loader: WorkerLoader | null = null;
  private masterKey: string | null = null;
  private bundleSubkey: CryptoKey | null = null;
  private state: BundleDispatchState = {
    activeVersionId: null,
    consecutiveFailures: 0,
  };
  /**
   * Last active version id whose catalog we successfully validated
   * against the current host. Resets to `null` on `refreshPointer`, on
   * catalog-mismatch disable, and on cold start (new DO instance). The
   * guard in `dispatchTurn` skips re-validation while
   * `state.activeVersionId === validatedVersionId`.
   */
  private validatedVersionId: string | null = null;

  constructor(
    config: BundleConfig<TEnv>,
    env: TEnv,
    agentId: string,
    options: {
      /** Snapshot of the host's registered capability ids used by the
       *  dispatch-time catalog guard. Invoked on every guard check so
       *  consumers can return live state. */
      getHostCapabilityIds?: () => string[];
      /** Optional broadcaster for `bundle_disabled` events. When absent,
       *  the dispatcher still clears the pointer on catalog mismatch
       *  but does not emit the structured event. */
      broadcastEvent?: BundleEventBroadcaster;
    } = {},
  ) {
    this.config = config;
    this.env = env;
    this.agentId = agentId;
    this.getHostCapabilityIds = options.getHostCapabilityIds ?? (() => []);
    this.broadcastEvent = options.broadcastEvent ?? null;
  }

  /**
   * Initialize lazy-loaded dependencies.
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.registry) {
      this.registry = this.config.registry(this.env);
    }
    if (!this.loader) {
      this.loader = this.config.loader(this.env);
    }
    if (!this.masterKey) {
      this.masterKey = this.config.authKey(this.env);
    }
    if (!this.bundleSubkey) {
      this.bundleSubkey = await deriveMintSubkey(this.masterKey, BUNDLE_SUBKEY_LABEL);
    }
  }

  /**
   * Check whether an active bundle exists and should be dispatched to.
   */
  async hasActiveBundle(ctxStorage?: DurableObjectStorage): Promise<boolean> {
    await this.ensureInitialized();

    // Try ctx.storage first (warm path)
    if (ctxStorage) {
      const cached = await ctxStorage.get<string | null>("activeBundleVersionId");
      if (cached !== undefined) {
        // A cached pointer that disagrees with the dispatcher's last-
        // validated id implies the pointer changed behind our back
        // (cold start with stale cache, or out-of-band writer).
        // Invalidate the cache so the guard re-validates.
        if (cached !== this.validatedVersionId) {
          this.validatedVersionId = null;
        }
        this.state.activeVersionId = cached;
        return cached !== null;
      }
    }

    // Cold path: query registry
    const activeId = await this.registry?.getActiveForAgent(this.agentId);
    if ((activeId ?? null) !== this.validatedVersionId) {
      this.validatedVersionId = null;
    }
    this.state.activeVersionId = activeId ?? null;

    // Cache for next turn
    if (ctxStorage) {
      await ctxStorage.put("activeBundleVersionId", activeId);
    }

    return activeId !== null;
  }

  /**
   * Dispatch a turn into the active bundle.
   * Returns the events if successful, or a fallback reason if not.
   */
  async dispatchTurn(
    sessionId: string,
    prompt: string,
    ctxStorage?: DurableObjectStorage,
  ): Promise<DispatchResult> {
    await this.ensureInitialized();

    const versionId = this.state.activeVersionId;
    if (!versionId) {
      return { dispatched: false, reason: "no active bundle" };
    }

    // Catalog guard: if the active version hasn't been validated since
    // the last pointer change (or cold start), validate now against the
    // current host capability set. Cheap in the steady state (single
    // field compare). A new or out-of-band-mutated pointer triggers a
    // single `getVersion` metadata read. On mismatch: clear the pointer
    // immediately and fall back to static; do NOT count toward
    // `maxLoadFailures`.
    if (versionId !== this.validatedVersionId) {
      const guard = await this.validateCatalogCached(versionId);
      if (!guard.valid) {
        await this.disableForCatalogMismatch(guard.missingIds, versionId, ctxStorage, sessionId);
        return {
          dispatched: false,
          reason: `catalog mismatch: ${guard.missingIds.join(", ")}`,
        };
      }
    }

    try {
      // 1. Compute scope from the validated catalog and mint a single capability token
      const version = await this.registry?.getVersion?.(versionId);
      const catalogIds = (version?.metadata?.requiredCapabilities ?? []).map(
        (r: { id: string }) => r.id,
      );
      const scope = ["spine", "llm", ...catalogIds];
      const token = await mintToken(
        { agentId: this.agentId, sessionId, scope },
        this.bundleSubkey!,
      );

      // 2. Load bundle via Worker Loader
      const bundleEnv = this.config.bundleEnv(this.env);
      const worker = this.loader?.get(versionId, async () => {
        const bytes = await this.registry?.getBytes(versionId);
        if (!bytes) {
          throw new Error(`Bundle bytes not found for version ${versionId}`);
        }

        const source = new TextDecoder().decode(bytes);
        const { mainModule, modules } = decodeBundlePayload(source);
        return {
          compatibilityDate: "2025-12-01",
          compatibilityFlags: ["nodejs_compat"],
          mainModule,
          modules,
          env: { ...bundleEnv, __BUNDLE_TOKEN: token },
          globalOutbound: null, // No direct outbound network access
        };
      });

      // 3. Dispatch the turn
      const res = await worker!.getEntrypoint().fetch(
        new Request("https://bundle/turn", {
          method: "POST",
          body: JSON.stringify({ prompt }),
        }),
      );

      if (!res.ok) {
        throw new Error(`Bundle turn failed with status ${res.status}`);
      }

      // 4. Consume the NDJSON response stream
      const events = await this.consumeEventStream(res);

      // Reset failure counter on success
      this.state.consecutiveFailures = 0;

      return { dispatched: true, events };
    } catch (err) {
      this.state.consecutiveFailures++;
      const maxFailures = this.config.maxLoadFailures ?? DEFAULT_MAX_LOAD_FAILURES;

      console.error(
        `[BundleDispatcher] Bundle load failure ${this.state.consecutiveFailures}/${maxFailures}:`,
        err instanceof Error ? err.message : err,
      );

      // Auto-revert after N consecutive failures
      if (this.state.consecutiveFailures >= maxFailures) {
        await this.autoRevert(ctxStorage);
      }

      const reason = err instanceof Error ? err.message : String(err);
      return { dispatched: false, reason: `bundle load failed: ${reason}` };
    }
  }

  /**
   * Handle a client event (steer/abort) routed to the bundle.
   */
  async dispatchClientEvent(sessionId: string, event: unknown): Promise<void> {
    await this.ensureInitialized();

    const versionId = this.state.activeVersionId;
    if (!versionId) return;

    try {
      // Compute scope from the catalog (same as dispatchTurn)
      const version = await this.registry?.getVersion?.(versionId);
      const catalogIds = (version?.metadata?.requiredCapabilities ?? []).map(
        (r: { id: string }) => r.id,
      );
      const scope = ["spine", "llm", ...catalogIds];
      const token = await mintToken(
        { agentId: this.agentId, sessionId, scope },
        this.bundleSubkey!,
      );

      const bundleEnv = this.config.bundleEnv(this.env);
      const worker = this.loader?.get(versionId, async () => {
        const bytes = await this.registry?.getBytes(versionId);
        if (!bytes) throw new Error("Bundle bytes not found");
        const source = new TextDecoder().decode(bytes);
        return {
          compatibilityDate: "2025-12-01",
          compatibilityFlags: ["nodejs_compat"],
          mainModule: "bundle.js",
          modules: { "bundle.js": source },
          env: { ...bundleEnv, __BUNDLE_TOKEN: token },
          globalOutbound: null,
        };
      });

      await worker!.getEntrypoint().fetch(
        new Request("https://bundle/client-event", {
          method: "POST",
          body: JSON.stringify(event),
        }),
      );
    } catch (err) {
      // Client event delivery is best-effort (matches static behavior
      // under isolate restart)
      console.error("[BundleDispatcher] Client event delivery failed:", err);
    }
  }

  /**
   * Clear the active bundle and revert to static brain.
   */
  async disable(
    ctxStorage?: DurableObjectStorage,
    rationale = "manual disable",
    sessionId?: string,
  ): Promise<void> {
    await this.ensureInitialized();

    // Clearing always skips catalog validation — there is nothing to
    // validate. Passing `skipCatalogCheck: true` makes the clearing
    // intent self-documenting.
    await this.registry?.setActive(this.agentId, null, {
      rationale,
      sessionId,
      skipCatalogCheck: true,
    });
    this.state.activeVersionId = null;
    this.state.consecutiveFailures = 0;

    if (ctxStorage) {
      await ctxStorage.put("activeBundleVersionId", null);
    }
  }

  /**
   * Refresh the cached active version pointer (called after deploy/rollback).
   *
   * Resets `validatedVersionId` BEFORE re-reading so the next turn
   * triggers revalidation — a pointer change may swap to a version
   * with a different `requiredCapabilities` declaration.
   */
  async refreshPointer(ctxStorage?: DurableObjectStorage): Promise<void> {
    await this.ensureInitialized();

    this.validatedVersionId = null;

    const activeId = await this.registry?.getActiveForAgent(this.agentId);
    this.state.activeVersionId = activeId ?? null;

    if (ctxStorage) {
      await ctxStorage.put("activeBundleVersionId", activeId);
    }
  }

  /**
   * Get the current active bundle version ID (for entry tagging).
   */
  get activeVersionId(): string | null {
    return this.state.activeVersionId;
  }

  // --- Private helpers ---

  private async autoRevert(ctxStorage?: DurableObjectStorage): Promise<void> {
    console.warn("[BundleDispatcher] Auto-reverting to static brain after consecutive failures");

    try {
      // Auto-revert clears the pointer — never mint-side catalog-validate.
      await this.registry?.setActive(this.agentId, null, {
        rationale: "auto-revert: poison bundle",
        skipCatalogCheck: true,
      });
    } catch (err) {
      console.error("[BundleDispatcher] Failed to clear registry pointer:", err);
    }

    this.state.activeVersionId = null;
    this.state.consecutiveFailures = 0;
    this.validatedVersionId = null;

    if (ctxStorage) {
      await ctxStorage.put("activeBundleVersionId", null);
    }
  }

  /**
   * Validate the bundle's declared `requiredCapabilities` against the
   * current host capability set. Short-circuits to `{ valid: true }`
   * when `getVersion` is unavailable, the version has no metadata, or
   * the declaration is empty.
   *
   * On success: caches `validatedVersionId` so subsequent guard passes
   * are O(1). On failure: leaves the cache untouched so the caller can
   * route through `disableForCatalogMismatch`.
   */
  private async validateCatalogCached(
    versionId: string,
  ): Promise<{ valid: true } | { valid: false; missingIds: string[] }> {
    const getVersion = this.registry?.getVersion?.bind(this.registry);
    if (!getVersion) {
      // Narrow registry implementations without metadata access cannot
      // validate — treat as pass (matches legacy behavior).
      this.validatedVersionId = versionId;
      return { valid: true };
    }

    const version = await getVersion(versionId);
    const required = version?.metadata?.requiredCapabilities;
    const result = validateCatalogAgainstKnownIds(required, new Set(this.getHostCapabilityIds()));
    if (result.valid) {
      this.validatedVersionId = versionId;
      return { valid: true };
    }
    return { valid: false, missingIds: result.missingIds };
  }

  /**
   * Handle a dispatch-time catalog mismatch: clear the pointer via
   * `setActive(..., null, { skipCatalogCheck: true })`, reset internal
   * state (including `consecutiveFailures` so transient load-failure
   * counting does not cross-contaminate), and broadcast a structured
   * `bundle_disabled` event. Consecutive-failure counter reset matches
   * the spec's "pointer cleared → counter reset" invariant.
   */
  private async disableForCatalogMismatch(
    missingIds: string[],
    versionId: string,
    ctxStorage: DurableObjectStorage | undefined,
    sessionId: string,
  ): Promise<void> {
    const rationale = `catalog mismatch: missing [${missingIds.join(", ")}] declared by version '${versionId}'`;

    console.warn("[BundleDispatcher] Disabling bundle for catalog mismatch", {
      agentId: this.agentId,
      versionId,
      missingIds,
    });

    try {
      await this.registry?.setActive(this.agentId, null, {
        rationale,
        sessionId,
        skipCatalogCheck: true,
      });
    } catch (err) {
      console.error("[BundleDispatcher] Failed to clear registry pointer on catalog mismatch", err);
    }

    this.state.activeVersionId = null;
    this.state.consecutiveFailures = 0;
    this.validatedVersionId = null;

    if (ctxStorage) {
      await ctxStorage.put("activeBundleVersionId", null);
    }

    if (this.broadcastEvent) {
      this.broadcastEvent({
        type: "bundle_disabled",
        data: {
          rationale,
          versionId,
          sessionId,
          reason: {
            code: "ERR_CAPABILITY_MISMATCH",
            missingIds,
            versionId,
          },
        },
      });
    }
  }

  private async consumeEventStream(res: Response): Promise<BundleAgentEvent[]> {
    const text = await res.text();
    const lines = text.trim().split("\n").filter(Boolean);
    const events: BundleAgentEvent[] = [];

    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as BundleAgentEvent);
      } catch {
        console.warn("[BundleDispatcher] Skipping malformed event line:", line);
      }
    }

    return events;
  }
}
