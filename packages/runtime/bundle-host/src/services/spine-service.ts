/**
 * SpineService — stateless verify-and-forward bridge between bundle RPC
 * callers and the host agent DO.
 *
 * Every method takes a sealed capability token as its first argument.
 * Identity (agentId, sessionId, nonce) is derived from the verified
 * token payload. No method accepts sessionId or agentId as a
 * caller-supplied argument.
 *
 * Per-turn RPC budget enforcement lives in `AgentRuntime` (the DO), NOT
 * here. `SpineService` is a `WorkerEntrypoint` whose instance may not
 * persist across RPC invocations — keeping the budget counter here would
 * lose state on instance recycle and produce flaky cap enforcement. The
 * DO has stable per-agent state for the full turn lifetime, so the
 * tracker there is authoritative. SpineService's only remaining
 * per-instance state is the HKDF subkey cache (pure crypto, no
 * correctness implications if re-derived).
 *
 * Dispatch mechanism: SpineService calls public `spine*` methods directly
 * on a typed `DurableObjectStub<SpineHost>` via native DO method-call RPC.
 * The previous HTTP-style routing (building `Request` objects against
 * `https://internal/spine/*` paths and calling `host.fetch(request)`) was
 * replaced with this direct mechanism — `AgentDO` structurally satisfies
 * `SpineHost`, so every `host.spineX(...)` call is compile-time checked.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import type { SpineCaller, SpineHost } from "@claw-for-cloudflare/agent-runtime";
import type { VerifyOutcome } from "@claw-for-cloudflare/bundle-token";
import {
  BUNDLE_SUBKEY_LABEL,
  deriveVerifyOnlySubkey,
  verifyToken,
} from "@claw-for-cloudflare/bundle-token";

// Re-export SpineHost so existing host-side consumers keep a stable
// import path through the `bundle-host` barrel.
export type { SpineHost };

// --- Error codes ---

export type SpineErrorCode =
  | "ERR_BAD_TOKEN"
  | "ERR_TOKEN_EXPIRED"
  | "ERR_TOKEN_REPLAY"
  | "ERR_MALFORMED"
  | "ERR_SCOPE_DENIED"
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
   * verify-only subkey from this on first call using the unified HKDF
   * label `claw/bundle-v1` — must match the host dispatcher's mint label.
   * Domain separation between services is enforced by per-service `scope`
   * checks on the token payload rather than separate HKDF subkeys.
   */
  AGENT_AUTH_KEY: string;
  /** DO namespace binding to reach the agent DO. */
  AGENT: DurableObjectNamespace;
}

// --- SpineService ---

export class SpineService extends WorkerEntrypoint<SpineEnv> {
  private subkeyPromise: Promise<CryptoKey> | null = null;

  // --- Token verification (shared by all methods) ---

  /**
   * Lazily derive (and cache) the verify-only HKDF subkey from the
   * master `AGENT_AUTH_KEY`. Uses the unified `BUNDLE_SUBKEY_LABEL`
   * (`"claw/bundle-v1"`). Cached for the life of the WorkerEntrypoint
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
      this.subkeyPromise = deriveVerifyOnlySubkey(this.env.AGENT_AUTH_KEY, BUNDLE_SUBKEY_LABEL);
    }
    return this.subkeyPromise;
  }

  /**
   * Verify a capability token and return the identity fields.
   *
   * Verifies the HMAC signature under `claw/bundle-v1` and checks that
   * the token's `scope` array includes `"spine"`, authorizing calls to
   * this service.
   *
   * Replay protection is intentionally NOT enforced here: a single
   * per-turn token carries the bundle through many SpineService RPCs,
   * and a single-use nonce would cap a turn at exactly one spine op.
   * Budget enforcement (keyed by nonce) lives on the DO side
   * (`AgentRuntime.spineBudget`) — it caps total calls per turn; the
   * token's `exp` (default 60s) bounds the reuse window; `globalOutbound:
   * null` on the bundle isolate prevents token exfiltration.
   *
   * The nonce stays in the payload for log correlation and is forwarded
   * to the DO via the `SpineCaller` context object.
   */
  private async verify(token: string): Promise<SpineCaller> {
    const subkey = await this.getSubkey();
    const result: VerifyOutcome = await verifyToken(token, subkey, { requiredScope: "spine" });

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
    const caller = await this.verify(token);
    try {
      return await this.getHost(caller.aid).spineAppendEntry(caller, entry);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  async getEntries(token: string, options?: unknown): Promise<unknown[]> {
    const caller = await this.verify(token);
    try {
      return await this.getHost(caller.aid).spineGetEntries(caller, options);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  async getSession(token: string): Promise<unknown> {
    const caller = await this.verify(token);
    try {
      return await this.getHost(caller.aid).spineGetSession(caller);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  async createSession(token: string, init?: unknown): Promise<unknown> {
    const caller = await this.verify(token);
    try {
      return await this.getHost(caller.aid).spineCreateSession(caller, init);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  async listSessions(token: string, filter?: unknown): Promise<unknown[]> {
    const caller = await this.verify(token);
    try {
      return await this.getHost(caller.aid).spineListSessions(caller, filter);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  async buildContext(token: string): Promise<unknown> {
    const caller = await this.verify(token);
    try {
      return await this.getHost(caller.aid).spineBuildContext(caller);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  async getCompactionCheckpoint(token: string): Promise<unknown> {
    const caller = await this.verify(token);
    try {
      return await this.getHost(caller.aid).spineGetCompactionCheckpoint(caller);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  // --- KV store methods ---

  async kvGet(token: string, capabilityId: string, key: string): Promise<unknown> {
    const caller = await this.verify(token);
    try {
      return await this.getHost(caller.aid).spineKvGet(caller, capabilityId, key);
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
    const caller = await this.verify(token);
    try {
      await this.getHost(caller.aid).spineKvPut(caller, capabilityId, key, value, options);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  async kvDelete(token: string, capabilityId: string, key: string): Promise<void> {
    const caller = await this.verify(token);
    try {
      await this.getHost(caller.aid).spineKvDelete(caller, capabilityId, key);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  async kvList(token: string, capabilityId: string, prefix?: string): Promise<unknown[]> {
    const caller = await this.verify(token);
    try {
      return await this.getHost(caller.aid).spineKvList(caller, capabilityId, prefix);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  // --- Scheduler methods ---

  async scheduleCreate(token: string, schedule: unknown): Promise<unknown> {
    const caller = await this.verify(token);
    try {
      return await this.getHost(caller.aid).spineScheduleCreate(caller, schedule);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  async scheduleUpdate(token: string, scheduleId: string, patch: unknown): Promise<void> {
    const caller = await this.verify(token);
    try {
      await this.getHost(caller.aid).spineScheduleUpdate(caller, scheduleId, patch);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  async scheduleDelete(token: string, scheduleId: string): Promise<void> {
    const caller = await this.verify(token);
    try {
      await this.getHost(caller.aid).spineScheduleDelete(caller, scheduleId);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  async scheduleList(token: string): Promise<unknown[]> {
    const caller = await this.verify(token);
    try {
      return await this.getHost(caller.aid).spineScheduleList(caller);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  async alarmSet(token: string, timestamp: number): Promise<void> {
    const caller = await this.verify(token);
    try {
      await this.getHost(caller.aid).spineAlarmSet(caller, timestamp);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  // --- Transport-out methods (send-only) ---

  async broadcast(token: string, event: unknown): Promise<void> {
    const caller = await this.verify(token);
    try {
      await this.getHost(caller.aid).spineBroadcast(caller, event);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  async broadcastGlobal(token: string, event: unknown): Promise<void> {
    const caller = await this.verify(token);
    try {
      await this.getHost(caller.aid).spineBroadcastGlobal(caller, event);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  // --- Cost emission ---

  async emitCost(token: string, costEvent: unknown): Promise<void> {
    const caller = await this.verify(token);
    try {
      await this.getHost(caller.aid).spineEmitCost(caller, costEvent);
    } catch (err) {
      throw this.sanitize(err);
    }
  }

  // --- Error sanitization ---

  /**
   * Sanitize errors before returning to the bundle. Only whitelisted
   * error codes cross the RPC boundary; everything else collapses to
   * `ERR_INTERNAL` with no stack / DO state leaking out.
   *
   * Cloudflare's native DO RPC does NOT round-trip `Error.code` or the
   * subclass `name` — on the receiving side the error is a generic
   * `Error` whose `message` is the original `"${name}: ${message}"`
   * concatenation. The only field we can rely on is `message`. Budget
   * errors embed their code as a message-prefix sentinel
   * (`ERR_BUDGET_EXCEEDED:`) so detection survives the boundary.
   */
  private sanitize(err: unknown): SpineError {
    if (err instanceof SpineError) {
      return err;
    }

    if (err !== null && typeof err === "object") {
      const shape = err as { code?: unknown; name?: unknown; message?: unknown };
      const msgStr = typeof shape.message === "string" ? shape.message : "";
      if (
        shape.code === "ERR_BUDGET_EXCEEDED" ||
        shape.name === "BudgetExceededError" ||
        msgStr.includes("ERR_BUDGET_EXCEEDED:")
      ) {
        return new SpineError("ERR_BUDGET_EXCEEDED", msgStr || "Budget exceeded");
      }
      if (msgStr.includes("ERR_SCOPE_DENIED:") || shape.code === "ERR_SCOPE_DENIED") {
        return new SpineError("ERR_SCOPE_DENIED", msgStr || "Scope denied");
      }
    }

    console.error("[SpineService] Internal error:", err);
    return new SpineError("ERR_INTERNAL", "An internal error occurred");
  }
}
