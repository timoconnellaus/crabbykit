/**
 * BundleDispatcher — per-turn dispatch logic for bundle-enabled agents.
 *
 * Checks for an active bundle version, mints a capability token,
 * loads the bundle via Worker Loader, dispatches the turn, and
 * consumes the response stream. Falls back to static brain on
 * load failure or when no bundle is active.
 */

import { deriveSubkey, mintToken } from "../security/capability-token.js";
import type { BundleConfig, BundleDispatchState, BundleRegistry } from "./bundle-config.js";

const DEFAULT_MAX_LOAD_FAILURES = 3;
const SPINE_SUBKEY_LABEL = "claw/spine-v1";

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
 * BundleDispatcher manages the lifecycle of bundle dispatch for a single agent.
 */
export class BundleDispatcher<TEnv = Record<string, unknown>> {
  private readonly config: BundleConfig<TEnv>;
  private readonly env: TEnv;
  private readonly agentId: string;
  private registry: BundleRegistry | null = null;
  private loader: WorkerLoader | null = null;
  private masterKey: string | null = null;
  private spineSubkey: CryptoKey | null = null;
  private state: BundleDispatchState = {
    activeVersionId: null,
    consecutiveFailures: 0,
  };

  constructor(config: BundleConfig<TEnv>, env: TEnv, agentId: string) {
    this.config = config;
    this.env = env;
    this.agentId = agentId;
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
    if (!this.spineSubkey) {
      this.spineSubkey = await deriveSubkey(this.masterKey, SPINE_SUBKEY_LABEL);
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
        this.state.activeVersionId = cached;
        return cached !== null;
      }
    }

    // Cold path: query registry
    const activeId = await this.registry!.getActiveForAgent(this.agentId);
    this.state.activeVersionId = activeId;

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

    try {
      // 1. Mint a capability token for this turn
      const token = await mintToken({ agentId: this.agentId, sessionId }, this.spineSubkey!);

      // 2. Load bundle via Worker Loader
      const bundleEnv = this.config.bundleEnv(this.env);
      const worker = this.loader!.get(versionId, async () => {
        const bytes = await this.registry!.getBytes(versionId);
        if (!bytes) {
          throw new Error(`Bundle bytes not found for version ${versionId}`);
        }

        const source = new TextDecoder().decode(bytes);
        return {
          compatibilityDate: "2025-12-01",
          compatibilityFlags: ["nodejs_compat"],
          mainModule: "bundle.js",
          modules: { "bundle.js": source },
          env: { ...bundleEnv, __SPINE_TOKEN: token },
          globalOutbound: null, // No direct outbound network access
        };
      });

      // 3. Dispatch the turn
      const res = await worker.getEntrypoint().fetch(
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
      const token = await mintToken({ agentId: this.agentId, sessionId }, this.spineSubkey!);

      const bundleEnv = this.config.bundleEnv(this.env);
      const worker = this.loader!.get(versionId, async () => {
        const bytes = await this.registry!.getBytes(versionId);
        if (!bytes) throw new Error("Bundle bytes not found");
        const source = new TextDecoder().decode(bytes);
        return {
          compatibilityDate: "2025-12-01",
          compatibilityFlags: ["nodejs_compat"],
          mainModule: "bundle.js",
          modules: { "bundle.js": source },
          env: { ...bundleEnv, __SPINE_TOKEN: token },
          globalOutbound: null,
        };
      });

      await worker.getEntrypoint().fetch(
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

    await this.registry!.setActive(this.agentId, null, { rationale, sessionId });
    this.state.activeVersionId = null;
    this.state.consecutiveFailures = 0;

    if (ctxStorage) {
      await ctxStorage.put("activeBundleVersionId", null);
    }
  }

  /**
   * Refresh the cached active version pointer (called after deploy/rollback).
   */
  async refreshPointer(ctxStorage?: DurableObjectStorage): Promise<void> {
    await this.ensureInitialized();

    const activeId = await this.registry!.getActiveForAgent(this.agentId);
    this.state.activeVersionId = activeId;

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
      await this.registry!.setActive(this.agentId, null, {
        rationale: "auto-revert: poison bundle",
      });
    } catch (err) {
      console.error("[BundleDispatcher] Failed to clear registry pointer:", err);
    }

    this.state.activeVersionId = null;
    this.state.consecutiveFailures = 0;

    if (ctxStorage) {
      await ctxStorage.put("activeBundleVersionId", null);
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
