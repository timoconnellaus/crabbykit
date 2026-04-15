/**
 * Inline bundle source fixtures for the agent-runtime integration tests.
 *
 * Each fixture is a self-contained ES module string suitable for seeding into
 * {@link InMemoryBundleRegistry}. The {@link makeFakeWorkerLoader} helper runs
 * these as real modules via a `data:text/javascript` URL import, so the bundle
 * side of the dispatch path is exercised end-to-end (NDJSON framing,
 * `__SPINE_TOKEN` inspection, `env.SPINE` RPC calls, etc.).
 */

/**
 * Encode a raw bundle source string as a v1 envelope `{v:1, mainModule,
 * modules}` — the shape `@cloudflare/worker-bundler#createWorker` writes
 * and `decodeBundlePayload` expects. Use this in tests that need to
 * verify the dispatcher decodes envelopes correctly.
 */
export function encodeBundleEnvelope(source: string): string {
  return JSON.stringify({
    v: 1,
    mainModule: "bundle.js",
    modules: { "bundle.js": source },
  });
}

/**
 * Minimal bundle that echoes the prompt back as an NDJSON event stream.
 * Does not touch env.SPINE — use for pure dispatcher tests.
 */
export const REFERENCE_BUNDLE_SOURCE = `
const metadata = { name: "ReferenceBundle", description: "integration fixture" };

async function handleTurn(request, env) {
  const token = env.__SPINE_TOKEN;
  if (!token) {
    return new Response("Missing __SPINE_TOKEN", { status: 401 });
  }
  const { prompt } = await request.json();
  const lines = [
    JSON.stringify({
      type: "agent_event",
      event: "text",
      data: { content: "bundle-reply: " + prompt },
    }),
    JSON.stringify({
      type: "agent_event",
      event: "agent_end",
      data: { reason: "stop" },
    }),
  ];
  return new Response(lines.join("\\n"), {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

async function handleSmoke(env) {
  return Response.json({ status: "ok", hasToken: typeof env.__SPINE_TOKEN === "string" });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/turn": return handleTurn(request, env);
      case "/metadata": return Response.json(metadata);
      case "/smoke": return handleSmoke(env);
      case "/client-event": {
        const body = await request.json();
        if (env.__TEST_CLIENT_EVENT_SINK) {
          env.__TEST_CLIENT_EVENT_SINK.push(body);
        }
        return Response.json({ status: "acknowledged" });
      }
      default: return new Response("Unknown: " + url.pathname, { status: 404 });
    }
  },
};
`;

/**
 * Bundle that drives the SpineService bridge with real token-authed calls.
 *
 * Sequence on /turn:
 * 1. Append an assistant message via env.SPINE.appendEntry(token, entry).
 * 2. Broadcast a "message_end" event via env.SPINE.broadcast(token, event).
 * 3. Emit a cost via env.SPINE.emitCost(token, {...}).
 * 4. Return a short ack body.
 *
 * The bundle reads the `action` field from the request body to flex the
 * call site — "appendEntry", "broadcast", "emitCost", "all", or
 * "tamperedToken". When "tamperedToken", the bundle mutates the token
 * before calling — used to exercise ERR_BAD_TOKEN.
 */
export const SPINE_BRIDGE_BUNDLE_SOURCE = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/turn") {
      return new Response("Unknown: " + url.pathname, { status: 404 });
    }

    // The host dispatcher sends { prompt, agentId, sessionId }. Tests
    // stuff the action JSON inside the prompt string.
    const body = await request.json();
    let instructions = {};
    try {
      instructions = JSON.parse(body.prompt);
    } catch (parseErr) {
      // Non-JSON prompt — treat as a no-op turn.
    }
    const { action, tokenOverride } = instructions;
    const token = tokenOverride ?? env.__SPINE_TOKEN;
    const results = {};

    try {
      if (action === "appendEntry" || action === "all") {
        results.appendEntry = await env.SPINE.appendEntry(token, {
          type: "message",
          data: {
            role: "assistant",
            content: "bundle-appended-via-spine",
            timestamp: Date.now(),
          },
        });
      }

      if (action === "broadcast" || action === "all") {
        await env.SPINE.broadcast(token, {
          type: "agent_event",
          event: "text",
          data: { content: "bundle-broadcast-via-spine" },
        });
        results.broadcast = "ok";
      }

      if (action === "emitCost" || action === "all") {
        await env.SPINE.emitCost(token, {
          capabilityId: "test-bundle",
          toolName: "spine.emitCost",
          amount: 0.0025,
          currency: "USD",
        });
        results.emitCost = "ok";
      }

      if (action === "floodSql") {
        // Drive the budget past its SQL limit. Default budget is 100.
        const count = 105;
        const errors = [];
        for (let i = 0; i < count; i++) {
          try {
            await env.SPINE.appendEntry(token, {
              type: "message",
              data: { role: "system", content: "flood-" + i, timestamp: Date.now() },
            });
          } catch (err) {
            errors.push(err.code || err.message || String(err));
          }
        }
        results.floodErrors = errors;
      }
    } catch (err) {
      results.error = {
        code: err && err.code,
        message: err && err.message,
        name: err && err.name,
      };
      if (env.__TEST_RESULTS_SINK) {
        env.__TEST_RESULTS_SINK.push(results);
      }
    }
    if (env.__TEST_RESULTS_SINK) {
      env.__TEST_RESULTS_SINK.push(results);
    }

    const ndjson = JSON.stringify({
      type: "agent_event",
      event: "agent_end",
      data: { reason: "stop", results },
    });
    return new Response(ndjson, {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    });
  },
};
`;

/**
 * Poison bundle — unconditionally throws on /turn. Used to drive the
 * consecutive-failure auto-revert path.
 */
export const POISON_BUNDLE_SOURCE = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/turn") {
      throw new Error("poison bundle: /turn always fails");
    }
    if (url.pathname === "/client-event") {
      return Response.json({ status: "acknowledged" });
    }
    return new Response("Unknown: " + url.pathname, { status: 404 });
  },
};
`;

/**
 * Slow bundle — sleeps before emitting events. Used for abort tests.
 * Reads the delay from request body; defaults to 1000ms.
 */
export const SLOW_BUNDLE_SOURCE = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/turn") {
      if (url.pathname === "/client-event") return Response.json({ status: "acknowledged" });
      return new Response("Unknown: " + url.pathname, { status: 404 });
    }
    const { delayMs = 1000 } = await request.json();
    await new Promise((r) => setTimeout(r, delayMs));
    const lines = [
      JSON.stringify({
        type: "agent_event",
        event: "text",
        data: { content: "slow-reply" },
      }),
      JSON.stringify({
        type: "agent_event",
        event: "agent_end",
        data: { reason: "stop" },
      }),
    ];
    return new Response(lines.join("\\n"), {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    });
  },
};
`;
