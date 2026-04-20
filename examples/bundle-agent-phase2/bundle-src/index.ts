/**
 * Test bundle brain for Phase 2 demo.
 * This is compiled via `bun build` and loaded via Worker Loader.
 *
 * Exercises bundle-http-and-ui-surface APIs:
 *  - GET /demo/echo — returns the request's query string back as JSON.
 *  - POST /demo/echo — returns the posted bytes verbatim.
 *  - capability_action `demo:ping` — broadcasts a `state_event` back to
 *    the originating session.
 *
 * Exercises bundle-config-namespaces APIs:
 *  - Per-capability `configSchema` + `onConfigChange` on the demo cap.
 *  - Agent-level `setup.config` namespace `botConfig` with
 *    `agentConfigPath` projection + `onAgentConfigChange`.
 *  - Custom `configNamespaces` entry `demo-accounts` backed by kvStore.
 */

import { type BundleCapability, defineBundleAgent } from "@crabbykit/bundle-sdk";
import { Type } from "@sinclair/typebox";

const demoCapability: BundleCapability = {
  id: "demo",
  name: "Demo",
  description: "bundle-http-and-ui-surface + bundle-config-namespaces demo capability",
  configSchema: Type.Object({
    greeting: Type.String({ default: "hello" }),
    enabled: Type.Boolean({ default: true }),
  }),
  configDefault: { greeting: "hello", enabled: true },
  agentConfigPath: "botConfig",
  configNamespaces: (ctx) => [
    {
      id: "demo-accounts",
      description: "Demo key-value store of example accounts",
      schema: Type.Object({ list: Type.Array(Type.String()) }),
      get: async () => {
        const stored = await ctx.kvStore.get("demo", "accounts");
        return stored ?? { list: [] };
      },
      set: async (_ns, value) => {
        await ctx.kvStore.put("demo", "accounts", value);
        const count = Array.isArray((value as { list?: unknown[] }).list)
          ? (value as { list: unknown[] }).list.length
          : 0;
        return `Saved ${count} accounts`;
      },
    },
  ],
  hooks: {
    onConfigChange: async (oldCfg, newCfg, ctx) => {
      await ctx.channel.broadcast({
        type: "state_event",
        capabilityId: "demo",
        event: "config_changed",
        data: { oldCfg, newCfg },
      });
    },
    onAgentConfigChange: async (oldSlice, newSlice, ctx) => {
      await ctx.channel.broadcast({
        type: "state_event",
        capabilityId: "demo",
        event: "agent_config_changed",
        data: { oldSlice, newSlice },
      });
    },
  },
  httpHandlers: () => [
    {
      method: "GET",
      path: "/demo/echo",
      handler: async (req, _ctx) => {
        const body = JSON.stringify({ method: req.method, query: req.query });
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: new TextEncoder().encode(body),
        };
      },
    },
    {
      method: "POST",
      path: "/demo/echo",
      handler: async (req) => {
        return {
          status: 200,
          headers: { "content-type": req.headers["content-type"] ?? "application/octet-stream" },
          body: req.body,
        };
      },
    },
  ],
  onAction: async (action, data, ctx) => {
    if (action === "ping") {
      await ctx.channel.broadcast({
        type: "state_event",
        capabilityId: "demo",
        event: "pong",
        data,
      });
    }
  },
};

export default defineBundleAgent({
  model: { provider: "openrouter", modelId: "anthropic/claude-sonnet-4" },
  prompt: { agentName: "BundleBrain" },
  config: {
    botConfig: Type.Object({
      rateLimit: Type.Number({ default: 10 }),
      persona: Type.String({ default: "friendly" }),
    }),
  },
  capabilities: () => [demoCapability],
  metadata: {
    name: "TestBundleBrain",
    description:
      "Phase 2 + 3 demo bundle — echoes prompts, exposes /demo/echo, ping action, and all three config tiers",
  },
});
