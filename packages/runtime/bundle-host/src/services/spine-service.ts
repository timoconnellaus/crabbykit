/**
 * SpineService — WorkerEntrypoint that bridges bundle async RPC to the host
 * DO's existing sync SessionStore, KvStore, Scheduler, and Transport.
 *
 * Every method takes a sealed capability token as its first argument.
 * Identity (agentId, sessionId) is derived from the verified token payload.
 * No method accepts sessionId or agentId as a caller-supplied argument.
 *
 * Per-turn RPC budget enforcement prevents denial-of-service from a bundle.
 *
 * Dispatch mechanism: SpineService calls public `spine*` methods directly
 * on a typed `DurableObjectStub<SpineHost>` via native DO method-call RPC.
 * The previous HTTP-style routing (building `Request` objects against
 * `https://internal/spine/*` paths and calling `host.fetch(request)`) was
 * replaced with this direct mechanism — `AgentDO` structurally satisfies
 * `SpineHost`, so every `host.spineX(...)` call is compile-time checked.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import type { SpineHost } from "@claw-for-cloudflare/agent-runtime";
import type { VerifyOutcome } from "@claw-for-cloudflare/bundle-token";
import { deriveVerifyOnlySubkey, verifyToken } from "@claw-for-cloudflare/bundle-token";
import type { SpineBudgetConfig } from "../budget-tracker.js";
import { BudgetTracker } from "../budget-tracker.js";

// Re-export SpineHost so existing host-side consumers keep a stable
// import path through the `bundle-host` barrel.
export type { SpineHost };

export const SPINE_SUBKEY_LABEL = "claw/spine-v1";

export type { SpineBudgetConfig } from "../budget-tracker.js";

// --- Error codes ---

export type SpineErrorCode =
  | "ERR_BAD_TOKEN"
  | "ERR_TOKEN_EXPIRED"
  | "ERR_TOKEN_REPLAY"
  | "ERR_MALFORMED"
  | "ERR_BUDGET_EXCEEDED"
  | "ERR_NOT_FOUND"
  | "ERR_INVALID_ARGUMENT"
  | "ERR_INTERNAL";

export class SpineError extends Error {
  readonly code: SpineErrorCode;

  constructor(code: SpineErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "SpineError";
  }
}

// --- SpineService env ---

export interface SpineEnv {
  /**
   * Master HMAC secret (string). SpineService derives its own
   * verify-only subkey from this on first call using the HKDF label
   * `claw/spine-v1` — must match the host dispatcher's mint label.
   * Replaces the older `SPINE_SUBKEY: CryptoKey` field which couldn't
   * be expressed in wrangler.jsonc and was always undefined at runtime.
   */
  AGENT_AUTH_KEY: string;
  /** DO namespace binding to reach the agent DO. */
  AGENT: DurableObjectNamespace;
  /** Optional budget configuration. */
  SPINE_BUDGET?: SpineBudgetConfig;
}

// --- SpineService ---

export class SpineService extends WorkerEntrypoint<SpineEnv> {
  private readonly budget: BudgetTracker;
  private subkeyPromise: Promise<CryptoKey> | null = null;

  constructor(ctx: ExecutionContext, env: SpineEnv) {
    super(ctx, env);
    this.budget = new BudgetTracker(env.SPINE_BUDGET);
  }

  // --- Token verification (shared by all methods) ---

  /**
   * Lazily derive (and cache) the verify-only HKDF subkey from the
   * master `AGENT_AUTH_KEY`. Cached for the life of the WorkerEntrypoint
   * instance.
   */
  private getSubkey(): Promise<CryptoKey> {
    if (!this.subkeyPromise) {
      if (!this.env.AGENT_AUTH_KEY) {
        throw new SpineError(
          "ERR_INTERNAL",
          "SpineService misconfigured: env.AGENT_AUTH_KEY is missing",
        );
      }
      this.subkeyPromise = deriveVerifyOnlySubkey(this.env.AGENT_AUTH_KEY, SPINE_SUBKEY_LABEL);
    }
    return this.subkeyPromise;
  }

  /**
   * Verify a capability token and return the identity fields.
   *
   * Replay protection is intentionally NOT enforced here: a single
   * per-turn token carries the bundle through many SpineService RPCs,
   * and a single-use nonce would cap a turn at exactly one spine op.
   * The budget tracker (keyed by nonce) caps total calls per turn; the
   * token's `exp` (default 60s) bounds the reuse window; `globalOutbound:
   * null` on the bundle isolate prevents token exfiltration.
   *
   * The nonce stays in the payload for log correlation and is consumed
   * once by `BudgetTracker` per call to increment its per-turn counter.
   */
  private async verify(token: string): Promise<{ aid: string; sid: string; nonce: string }> {
    const subkey = await this.getSubkey();
    const result: VerifyOutcome = await verifyToken(token, subkey);

    if (!result.valid) {
      throw new SpineError(result.code as SpineErrorCode);
    }

    return { aid: result.payload.aid, sid: result.payload.sid, nonce: result.payload.nonce };
  }

  /**
   * Resolve the host DO stub for an agent, narrowed to the `SpineHost`
   * method surface. `agentId` is the host DO's `ctx.id.toString()` — a
   * hex-encoded 256-bit DO id, NOT a human name. Resolve via
   * `idFromString` so we round-trip back to the exact same DO that
   * minted the token. Using `idFromName(agentId)` would hash the hex
   * string as a fresh name and route to a completely different DO.
   *
   * Returning `DurableObjectStub<SpineHost>` narrows the stub's RPC
   * surface to the 19 `spine*` methods declared on the interface —
   * every `host.spineX(...)` call below is compile-time checked against
   * the real method signature, turning method-name typos and signature
   * drift into build errors instead of runtime 404s.
   */
  private getHost(agentId: string): DurableObjectStub<SpineHost> {
    const id = this.env.AGENT.idFromString(agentId);
    return this.env.AGENT.get(id) as DurableObjectStub<SpineHost>;
  }

  // --- Session store methods ---

  async appendEntry(token: string, entry: unknown): Promise<unknown> {
    const { aid, sid, nonce } = await this.verify(token);
    this.budget.check(nonce, "sql");

    try {
      const host = this.getHost(aid);
      return await host.spineAppendEntry(sid, entry);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  async getEntries(token: string, options?: unknown): Promise<unknown[]> {
    const { aid, sid, nonce } = await this.verify(token);
    this.budget.check(nonce, "sql");

    try {
      const host = this.getHost(aid);
      return await host.spineGetEntries(sid, options);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  async getSession(token: string): Promise<unknown> {
    const { aid, sid, nonce } = await this.verify(token);
    this.budget.check(nonce, "sql");

    try {
      const host = this.getHost(aid);
      return await host.spineGetSession(sid);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  async createSession(token: string, init?: unknown): Promise<unknown> {
    const { aid, nonce } = await this.verify(token);
    this.budget.check(nonce, "sql");

    try {
      const host = this.getHost(aid);
      return await host.spineCreateSession(init);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  async listSessions(token: string, filter?: unknown): Promise<unknown[]> {
    const { aid, nonce } = await this.verify(token);
    this.budget.check(nonce, "sql");

    try {
      const host = this.getHost(aid);
      return await host.spineListSessions(filter);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  async buildContext(token: string): Promise<unknown> {
    const { aid, sid, nonce } = await this.verify(token);
    this.budget.check(nonce, "sql");

    try {
      const host = this.getHost(aid);
      return await host.spineBuildContext(sid);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  async getCompactionCheckpoint(token: string): Promise<unknown> {
    const { aid, sid, nonce } = await this.verify(token);
    this.budget.check(nonce, "sql");

    try {
      const host = this.getHost(aid);
      return await host.spineGetCompactionCheckpoint(sid);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  // --- KV store methods ---

  async kvGet(token: string, capabilityId: string, key: string): Promise<unknown> {
    const { aid, nonce } = await this.verify(token);
    this.budget.check(nonce, "kv");

    try {
      const host = this.getHost(aid);
      return await host.spineKvGet(capabilityId, key);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  async kvPut(
    token: string,
    capabilityId: string,
    key: string,
    value: unknown,
    options?: unknown,
  ): Promise<void> {
    const { aid, nonce } = await this.verify(token);
    this.budget.check(nonce, "kv");

    try {
      const host = this.getHost(aid);
      await host.spineKvPut(capabilityId, key, value, options);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  async kvDelete(token: string, capabilityId: string, key: string): Promise<void> {
    const { aid, nonce } = await this.verify(token);
    this.budget.check(nonce, "kv");

    try {
      const host = this.getHost(aid);
      await host.spineKvDelete(capabilityId, key);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  async kvList(token: string, capabilityId: string, prefix?: string): Promise<unknown[]> {
    const { aid, nonce } = await this.verify(token);
    this.budget.check(nonce, "kv");

    try {
      const host = this.getHost(aid);
      return await host.spineKvList(capabilityId, prefix);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  // --- Scheduler methods ---

  async scheduleCreate(token: string, schedule: unknown): Promise<unknown> {
    const { aid, nonce } = await this.verify(token);
    this.budget.check(nonce, "alarm");

    try {
      const host = this.getHost(aid);
      return await host.spineScheduleCreate(schedule);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  async scheduleUpdate(token: string, scheduleId: string, patch: unknown): Promise<void> {
    const { aid, nonce } = await this.verify(token);
    this.budget.check(nonce, "alarm");

    try {
      const host = this.getHost(aid);
      await host.spineScheduleUpdate(scheduleId, patch);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  async scheduleDelete(token: string, scheduleId: string): Promise<void> {
    const { aid, nonce } = await this.verify(token);
    this.budget.check(nonce, "alarm");

    try {
      const host = this.getHost(aid);
      await host.spineScheduleDelete(scheduleId);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  async scheduleList(token: string): Promise<unknown[]> {
    const { aid, nonce } = await this.verify(token);
    this.budget.check(nonce, "alarm");

    try {
      const host = this.getHost(aid);
      return await host.spineScheduleList();
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  async alarmSet(token: string, timestamp: number): Promise<void> {
    const { aid, nonce } = await this.verify(token);
    this.budget.check(nonce, "alarm");

    try {
      const host = this.getHost(aid);
      await host.spineAlarmSet(timestamp);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  // --- Transport-out methods (send-only) ---

  async broadcast(token: string, event: unknown): Promise<void> {
    const { aid, sid, nonce } = await this.verify(token);
    this.budget.check(nonce, "broadcast");

    try {
      const host = this.getHost(aid);
      await host.spineBroadcast(sid, event);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  async broadcastGlobal(token: string, event: unknown): Promise<void> {
    const { aid, nonce } = await this.verify(token);
    this.budget.check(nonce, "broadcast");

    try {
      const host = this.getHost(aid);
      await host.spineBroadcastGlobal(event);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  // --- Cost emission ---

  async emitCost(token: string, costEvent: unknown): Promise<void> {
    const { aid, sid, nonce } = await this.verify(token);
    this.budget.check(nonce, "sql"); // cost emission appends a session entry

    try {
      const host = this.getHost(aid);
      await host.spineEmitCost(sid, costEvent);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  // --- Error sanitization ---

  /**
   * Sanitize errors before returning to the bundle.
   * Only whitelisted error codes and generic messages cross the RPC boundary.
   */
  private sanitize(err: unknown): SpineError {
    if (err instanceof SpineError) {
      return err;
    }

    // Log the real error internally
    console.error("[SpineService] Internal error:", err);

    // Return a sanitized error — no sessionId, no DO state, no stack trace
    return new SpineError("ERR_INTERNAL", "An internal error occurred");
  }
}
