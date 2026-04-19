/**
 * Test bundle brain for Phase 2 demo.
 * This is compiled via `bun build` and loaded via Worker Loader.
 *
 * Now also exercises the bundle-http-and-ui-surface APIs:
 *  - GET /demo/echo — returns the request's query string back as JSON.
 *  - POST /demo/echo — returns the posted bytes verbatim.
 *  - capability_action `demo:ping` — broadcasts a `state_event` back to
 *    the originating session. Drive from the UI / a websocket client.
 */

import { type BundleCapability, defineBundleAgent } from "@crabbykit/bundle-sdk";

const demoCapability: BundleCapability = {
  id: "demo",
  name: "Demo",
  description: "bundle-http-and-ui-surface demo capability",
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
  capabilities: () => [demoCapability],
  metadata: {
    name: "TestBundleBrain",
    description: "Phase 2 demo bundle — echoes prompts and exposes /demo/echo + ping action",
  },
});
