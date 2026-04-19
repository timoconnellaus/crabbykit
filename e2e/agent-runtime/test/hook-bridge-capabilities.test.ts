/**
 * Phase 0 hook-bridge integration against real static capability hooks.
 *
 * Covers deferred tasks from bundle-shape-2-rollout:
 *   - 4.13: bundle-style `file_write` through the bridge → static
 *           `fileTools.afterToolExecution` (`broadcastAgentMutation`) fires
 *           → `capability_state { capabilityId: "file-tools", event:
 *           "file_changed" }` reaches a connected WebSocket client.
 *   - 4.14: bundle-style `file_move` → two `file_changed` broadcasts
 *           (destination and source), matching the static hook's behavior.
 *   - 2.11 (reframed): bundle-style `file_write` to a `skills/{id}/SKILL.md`
 *           R2 path → static `skills.afterToolExecution` dirty-tracking
 *           hook observes the mutation (writes an `InstalledSkill` record
 *           into the capability KV store).
 *   - 5.4 (tool-output-truncation half): `spineProcessBeforeInference`
 *           threads messages through `tool-output-truncation.beforeInference`,
 *           which rewrites oversized tool-result content.
 *   - 5.4 (doom-loop-detection half): `spineProcessBeforeToolExecution`
 *           threads events through `doom-loop-detection.beforeToolExecution`,
 *           which blocks repeated identical tool calls at the capability's
 *           configured threshold.
 *
 * Dispatches RPCs directly on the DO stub — matches
 * `packages/runtime/agent-runtime/test/integration/hook-bridge.test.ts`
 * and keeps the tests focused on the host-side hook invocation path
 * rather than SpineService token verification (covered elsewhere).
 *
 * NOT COVERED HERE (intentional):
 *   - `vector-memory` auto-reindex (task 3.12) needs a Vectorize binding
 *     that miniflare does not yet simulate; deferred to a Vectorize-mocking
 *     harness.
 */

import { env } from "cloudflare:test";
import { agentStorage } from "@crabbykit/agent-storage";
import { doomLoopDetection } from "@crabbykit/doom-loop-detection";
import { skills } from "@crabbykit/skills";
import { toolOutputTruncation } from "@crabbykit/tool-output-truncation";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearExtraStaticCaps,
  clearMockResponses,
  setExtraStaticCaps,
  setMockResponses,
} from "../src/test-agent.js";

// --- Test helpers ---

interface TestEnv {
  AGENT: DurableObjectNamespace;
  STORAGE_BUCKET: R2Bucket;
}

function testEnv(): TestEnv {
  return env as unknown as TestEnv;
}

function getStub(name: string): DurableObjectStub {
  return testEnv().AGENT.get(testEnv().AGENT.idFromName(name));
}

interface SpineCaller {
  readonly aid: string;
  readonly sid: string;
  readonly nonce: string;
}

// Narrow the DO stub to the SpineHost bridge methods for readability.
interface BridgeStub {
  spineRecordToolExecution(caller: SpineCaller, event: unknown): Promise<void>;
  spineProcessBeforeInference(caller: SpineCaller, messages: unknown[]): Promise<unknown[]>;
  spineProcessBeforeToolExecution(caller: SpineCaller, event: unknown): Promise<unknown>;
  spineKvList(
    caller: SpineCaller,
    capabilityId: string,
    prefix?: string,
  ): Promise<Array<{ key: string; value: unknown }>>;
}
function asBridge(stub: DurableObjectStub): BridgeStub {
  return stub as unknown as BridgeStub;
}

function makeCaller(sid: string): SpineCaller {
  return { aid: "test-agent", sid, nonce: crypto.randomUUID() };
}

interface CapStateMsg {
  type: "capability_state";
  capabilityId: string;
  event: string;
  data: Record<string, unknown>;
  scope?: string;
  sessionId?: string;
}

interface SocketHandle {
  ws: WebSocket;
  messages: unknown[];
  waitFor: (pred: (m: unknown) => boolean, timeoutMs?: number) => Promise<unknown>;
  close: () => void;
}

async function openSocket(stub: DurableObjectStub): Promise<SocketHandle> {
  const resp = await stub.fetch("http://fake/ws", {
    headers: { upgrade: "websocket" },
  });
  // Non-null assertion: test-agent upgrades /ws to a WebSocket. If this is
  // ever null, the test should fail immediately at the next line.
  const ws = resp.webSocket;
  if (!ws) throw new Error(`/ws did not upgrade (status ${resp.status})`);
  ws.accept();

  const messages: unknown[] = [];
  const waiters: Array<{ pred: (m: unknown) => boolean; resolve: (m: unknown) => void }> = [];

  ws.addEventListener("message", (event) => {
    const parsed = JSON.parse(event.data as string);
    messages.push(parsed);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(parsed)) {
        waiters[i].resolve(parsed);
        waiters.splice(i, 1);
      }
    }
  });

  const waitFor = (pred: (m: unknown) => boolean, timeoutMs = 3000): Promise<unknown> => {
    const existing = messages.find(pred);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `Timed out waiting for WS message (${timeoutMs}ms). Received types: ${messages
                .map((m) => (m as { type?: string }).type ?? "?")
                .join(", ")}`,
            ),
          ),
        timeoutMs,
      );
      waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  };

  return { ws, messages, waitFor, close: () => ws.close() };
}

async function getFirstSessionId(stub: DurableObjectStub): Promise<string> {
  // /prompt creates a session (and fires onConnect hooks inside ensureAgent,
  // warming any caches the static caps rely on).
  setMockResponses([{ text: "priming" }]);
  const res = await stub.fetch("http://fake/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "prime" }),
  });
  const body = (await res.json()) as { sessionId: string };
  clearMockResponses();
  return body.sessionId;
}

function isCapState(m: unknown, capabilityId: string, event: string): m is CapStateMsg {
  const msg = m as { type?: string; capabilityId?: string; event?: string };
  return (
    msg.type === "capability_state" && msg.capabilityId === capabilityId && msg.event === event
  );
}

// --- Tests ---

describe("hook bridge — file-tools broadcastAgentMutation via Phase 0 bridge", () => {
  afterEach(() => {
    clearExtraStaticCaps();
    clearMockResponses();
  });

  it("4.13 — bundle-style file_write fires the static file-tools broadcast hook; WS sees file_changed", async () => {
    // fileTools is already part of the e2e test agent's default getCapabilities()
    // — no extra static caps needed.
    const stub = getStub("bridge-file-write-1");
    const sessionId = await getFirstSessionId(stub);
    const socket = await openSocket(stub);

    await asBridge(stub).spineRecordToolExecution(makeCaller(sessionId), {
      toolName: "file_write",
      args: { path: "notes/hello.md", content: "hi" },
      isError: false,
    });

    const msg = (await socket.waitFor((m) =>
      isCapState(m, "file-tools", "file_changed"),
    )) as CapStateMsg;
    expect(msg.data.path).toBe("notes/hello.md");
    // Static hook documents a `global` scope for mutations.
    expect(msg.scope).toBe("global");

    socket.close();
  });

  it("4.14 — bundle-style file_move fires two file_changed broadcasts (destination + source)", async () => {
    const stub = getStub("bridge-file-move-1");
    const sessionId = await getFirstSessionId(stub);
    const socket = await openSocket(stub);

    await asBridge(stub).spineRecordToolExecution(makeCaller(sessionId), {
      toolName: "file_move",
      // Static hook's MUTATION_PATH_FIELDS expects `destination` for
      // file_move (not `path`) and `source` for the origin path.
      args: { source: "old.md", destination: "new.md" },
      isError: false,
    });

    // Both broadcasts land on the same WS; we just assert both paths
    // appear among the observed file_changed events. Static hook broadcasts
    // the destination first, then the source — but ordering is an
    // implementation detail and not what this test is pinning.
    await socket.waitFor(
      (m) =>
        isCapState(m, "file-tools", "file_changed") && (m as CapStateMsg).data.path === "new.md",
    );
    await socket.waitFor(
      (m) =>
        isCapState(m, "file-tools", "file_changed") && (m as CapStateMsg).data.path === "old.md",
    );

    socket.close();
  });

  it("isError events are not broadcast (static hook contract)", async () => {
    const stub = getStub("bridge-file-write-err-1");
    const sessionId = await getFirstSessionId(stub);
    const socket = await openSocket(stub);

    await asBridge(stub).spineRecordToolExecution(makeCaller(sessionId), {
      toolName: "file_write",
      args: { path: "nope.md", content: "hi" },
      isError: true,
    });

    // Give the runtime a moment; any broadcast would have landed synchronously.
    await new Promise((r) => setTimeout(r, 100));
    const matched = socket.messages.find((m) => isCapState(m, "file-tools", "file_changed"));
    expect(matched).toBeUndefined();

    socket.close();
  });
});

describe("hook bridge — skills dirty-tracking via Phase 0 bridge", () => {
  afterEach(() => {
    clearExtraStaticCaps();
    clearMockResponses();
  });

  it("2.11 (reframed) — bundle-style file_write to skills/{id}/SKILL.md fires skills.afterToolExecution; installed-skill record is created", async () => {
    // Register the real `skills(...)` factory. Storage (R2) is shared with
    // file-tools via the same agent-storage; skill content lookup uses
    // `${namespace}/skills/{id}/SKILL.md`. No `registry` / `skills`
    // declarations on the factory — we exercise the agent-origin-creation
    // branch of the dirty-tracking hook.
    const stub = getStub("bridge-skills-dirty-1");

    // Capability hooks are resolved once per DO lifetime on first
    // `ensureAgent` call (which happens inside /prompt). Register the
    // `skills` factory BEFORE priming the session so the hook chain sees
    // it.
    const bucket = testEnv().STORAGE_BUCKET;
    const storage = agentStorage({
      bucket: () => bucket,
      namespace: "ns-dirty-1",
    });
    setExtraStaticCaps([skills({ storage, skills: [] })]);

    // Seed the skill file in R2 at the path the hook reads from. The hook
    // parses frontmatter to populate the installed-skill record.
    const skillKey = `${storage.namespace()}/skills/my-skill/SKILL.md`;
    const content = `---
name: My Skill
description: A test skill for the bridge dirty-tracking path.
---
Body of the skill.`;
    await bucket.put(skillKey, content);

    const sessionId = await getFirstSessionId(stub);

    await asBridge(stub).spineRecordToolExecution(makeCaller(sessionId), {
      toolName: "file_write",
      args: { path: `skills/my-skill/SKILL.md`, content },
      isError: false,
    });

    // The dirty-tracking hook persists an `InstalledSkill` record under
    // the `skills` capability KV, keyed `installed:my-skill`. Verify via
    // the DO's spineKvList method — reading the real capability KV
    // through the same path a bundle would use.
    const entries = await asBridge(stub).spineKvList(makeCaller(sessionId), "skills", "installed:");
    const record = entries.find((e) => e.key === "installed:my-skill");
    expect(record).toBeDefined();
    const value = record?.value as {
      name?: string;
      description?: string;
      origin?: string;
      enabled?: boolean;
    };
    expect(value.name).toBe("My Skill");
    expect(value.description).toBe("A test skill for the bridge dirty-tracking path.");
    // Agent-origin creation branch marks enabled=true.
    expect(value.enabled).toBe(true);
    expect(value.origin).toBe("agent");
  });
});

describe("hook bridge — tool-output-truncation via Phase 0 bridge", () => {
  afterEach(() => {
    clearExtraStaticCaps();
    clearMockResponses();
  });

  it("5.4 (partial) — spineProcessBeforeInference routes messages through tool-output-truncation.beforeInference", async () => {
    // Register with a very tight maxTokens so any tool-result message of
    // non-trivial length is truncated — the test then asserts the
    // returned array carries a shorter content than what went in.
    setExtraStaticCaps([toolOutputTruncation({ maxTokens: 10 })]);

    const stub = getStub("bridge-truncation-1");
    const sessionId = await getFirstSessionId(stub);

    // A tool-result message with content well above 10 tokens. Shape
    // mirrors what pi-agent-core emits for a tool result; the capability
    // only looks at role === "tool" and content-array text blocks.
    const longText = "lorem ipsum ".repeat(40);
    const input = [
      {
        role: "tool",
        toolCallId: "call-1",
        name: "echo",
        content: [{ type: "text", text: longText }],
      },
    ];

    const out = (await asBridge(stub).spineProcessBeforeInference(
      makeCaller(sessionId),
      input,
    )) as Array<{
      role: string;
      content: Array<{ type: string; text: string }>;
    }>;

    expect(out).toHaveLength(1);
    const returnedText = out[0].content[0].text;
    // Truncated text is strictly shorter than the input, carrying a
    // truncation marker the capability appends.
    expect(returnedText.length).toBeLessThan(longText.length);
    expect(returnedText.length).toBeGreaterThan(0);
  });
});

describe("hook bridge — doom-loop-detection via Phase 0 bridge", () => {
  afterEach(() => {
    clearExtraStaticCaps();
    clearMockResponses();
  });

  it("5.4 (doom-loop half) — three identical spineProcessBeforeToolExecution calls block on the third at threshold=3", async () => {
    // Register doom-loop-detection BEFORE priming the session: capability
    // hooks are resolved once on first bridge call / ensureAgent, and the
    // resolved arrays are what the bridge iterates. Register first, then
    // prime so the hook sees the capability.
    setExtraStaticCaps([doomLoopDetection({ threshold: 3 })]);

    const stub = getStub("bridge-doom-loop-1");
    const sessionId = await getFirstSessionId(stub);

    const event = {
      toolName: "echo",
      args: { text: "spin" },
      toolCallId: "c-1",
    };

    // First two calls should NOT block (consecutiveCount+1 = 1, then 2).
    const r1 = await asBridge(stub).spineProcessBeforeToolExecution(makeCaller(sessionId), event);
    expect(r1).toBeUndefined();

    const r2 = await asBridge(stub).spineProcessBeforeToolExecution(makeCaller(sessionId), {
      ...event,
      toolCallId: "c-2",
    });
    expect(r2).toBeUndefined();

    // Third identical call should block: consecutiveCount+1 = 3 >= threshold=3.
    const r3 = (await asBridge(stub).spineProcessBeforeToolExecution(makeCaller(sessionId), {
      ...event,
      toolCallId: "c-3",
    })) as { block?: boolean; reason?: string } | undefined;

    expect(r3).toBeDefined();
    expect(r3?.block).toBe(true);
    expect(r3?.reason).toMatch(/Doom loop detected/i);
    expect(r3?.reason).toContain("echo");
  });
});
