import type { RuntimeContext } from "./runtime-context.js";

/**
 * Build a {@link RuntimeContext} from a Cloudflare Durable Object state.
 * Maps `ctx.id.toString()` to `agentId` and forwards `waitUntil` directly.
 */
export function createCfRuntimeContext(ctx: DurableObjectState): RuntimeContext {
  return {
    agentId: ctx.id.toString(),
    waitUntil: (promise) => ctx.waitUntil(promise),
  };
}
