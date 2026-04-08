/**
 * Platform-agnostic runtime context passed to {@link AgentRuntime}.
 *
 * Abstracts the minimal identity and async-work primitives that the
 * business logic needs, without pulling in platform-specific types.
 *
 * - `agentId` replaces `this.ctx.id.toString()` (Cloudflare DO) or an
 *   equivalent identifier on other platforms.
 * - `waitUntil` replaces `this.ctx.waitUntil()` (Cloudflare DO). On platforms
 *   without an explicit extend-lifetime primitive, implementations MAY track
 *   the promise for graceful shutdown or fall back to a no-op.
 */
export interface RuntimeContext {
  readonly agentId: string;
  waitUntil(promise: Promise<unknown>): void;
}
