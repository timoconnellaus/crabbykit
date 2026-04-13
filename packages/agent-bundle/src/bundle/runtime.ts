/**
 * Bundle runtime — constructs per turn from a verified token,
 * builds adapter clients from SpineService RPC, runs the bundle's
 * capabilities and tool chain, and returns agent events as a stream.
 *
 * This runtime is async-by-default and stateless across turns.
 */

import {
  createCostEmitter,
  createKvStoreClient,
  createSchedulerClient,
  createSessionChannel,
  createSessionStoreClient,
} from "./spine-clients.js";
import type { BundleAgentSetup, BundleContext, BundleEnv } from "./types.js";

interface SpineBinding {
  [method: string]: (...args: unknown[]) => Promise<unknown>;
}

/**
 * Construct a BundleContext for a single turn.
 * The context is rebuilt from the token on every turn — no warm state.
 */
export function buildBundleContext<TEnv extends BundleEnv>(
  env: TEnv,
  spine: SpineBinding,
  agentId: string,
  sessionId: string,
): BundleContext {
  const getToken = (): string => {
    const token = env.__SPINE_TOKEN;
    if (!token) throw new Error("Missing __SPINE_TOKEN");
    return token;
  };

  return {
    agentId,
    sessionId,
    env,
    sessionStore: createSessionStoreClient(spine as never, getToken),
    kvStore: createKvStoreClient(spine as never, getToken),
    scheduler: createSchedulerClient(spine as never, getToken),
    channel: createSessionChannel(spine as never, getToken),
    emitCost: createCostEmitter(spine as never, getToken),
  };
}

/**
 * Run a bundle turn: build context, resolve tools + capabilities,
 * call the LLM via LlmService, execute tools, and stream events.
 *
 * Returns a ReadableStream of NDJSON agent events.
 */
export function runBundleTurn<TEnv extends BundleEnv>(
  _setup: BundleAgentSetup<TEnv>,
  _env: TEnv,
  _prompt: string,
  _context: BundleContext,
): ReadableStream<Uint8Array> {
  // Full inference loop integration is pending — the bundle runtime
  // needs to:
  // 1. Build the system prompt from setup.prompt + capability promptSections
  // 2. Resolve tools from setup.tools + capability tools
  // 3. Build message history via context.sessionStore.buildContext()
  // 4. Call LlmService.infer via env.LLM_SERVICE with the messages + tools
  // 5. Handle tool calls by executing tools and feeding results back
  // 6. Stream agent events back to the host DO
  //
  // For now, the handleTurn in define.ts returns a placeholder stream.
  // This function will replace it once LlmService integration is complete.
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}
