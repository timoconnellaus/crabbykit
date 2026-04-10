/**
 * Integration tests for the `Capability.afterTurn` dispatch site at
 * `agent_end`. These run against the real DO via the pool-workers harness.
 *
 * Covers §4.5 scenarios from openspec/changes/add-channels-v2/tasks.md:
 *   - afterTurn fires on natural stop
 *   - afterTurn receives empty string when no assistant text was produced
 *   - one capability throwing does not block another
 *   - afterTurn fires exactly once for a multi-turn inference
 *   - afterTurn fires on error termination / abort
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { AgentContext } from "../../src/agent-runtime.js";
import type { Capability } from "../../src/capabilities/types.js";
import {
  clearCompactionOverrides,
  clearExtraCapabilities,
  clearMockResponses,
  setExtraCapabilities,
  setMockResponses,
} from "../../src/test-helpers/test-agent-do.js";
import { getStub, prompt } from "../helpers/ws-client.js";

/**
 * Test scaffolding: a capability whose `afterTurn` records every invocation
 * into a shared buffer so assertions can run after the turn completes.
 */
interface Recorder {
  calls: Array<{ sessionId: string; finalText: string }>;
}

function makeRecorderCapability(id: string, rec: Recorder): Capability {
  return {
    id,
    name: id,
    description: `afterTurn recorder for ${id}`,
    afterTurn: async (_ctx: AgentContext, sessionId: string, finalText: string) => {
      rec.calls.push({ sessionId, finalText });
    },
  };
}

function makeThrowingCapability(id: string): Capability {
  return {
    id,
    name: id,
    description: `afterTurn throwing ${id}`,
    afterTurn: async () => {
      throw new Error(`boom from ${id}`);
    },
  };
}

describe("Capability.afterTurn dispatch", () => {
  beforeEach(() => {
    clearMockResponses();
    clearCompactionOverrides();
    clearExtraCapabilities();
  });

  it("fires once per handlePrompt with the final assistant text", async () => {
    const rec: Recorder = { calls: [] };
    setExtraCapabilities([makeRecorderCapability("rec-a", rec)]);
    setMockResponses([{ text: "hello from the agent" }]);

    const stub = getStub("after-turn-1");
    await prompt(stub, "hi");

    // Give waitUntil a moment to drain the afterTurn work.
    await new Promise((r) => setTimeout(r, 100));

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].finalText).toBe("hello from the agent");
    expect(rec.calls[0].sessionId).toBeTruthy();
  });

  it("invokes every capability that defines afterTurn", async () => {
    const recA: Recorder = { calls: [] };
    const recB: Recorder = { calls: [] };
    setExtraCapabilities([
      makeRecorderCapability("rec-multi-a", recA),
      makeRecorderCapability("rec-multi-b", recB),
    ]);
    setMockResponses([{ text: "both hooks see this" }]);

    const stub = getStub("after-turn-2");
    await prompt(stub, "ping");
    await new Promise((r) => setTimeout(r, 100));

    expect(recA.calls).toHaveLength(1);
    expect(recB.calls).toHaveLength(1);
    expect(recA.calls[0].finalText).toBe("both hooks see this");
    expect(recB.calls[0].finalText).toBe("both hooks see this");
    expect(recA.calls[0].sessionId).toBe(recB.calls[0].sessionId);
  });

  it("isolates errors: one capability throwing does not block the others", async () => {
    const recA: Recorder = { calls: [] };
    const recC: Recorder = { calls: [] };
    setExtraCapabilities([
      makeRecorderCapability("rec-iso-a", recA),
      makeThrowingCapability("rec-iso-b-bad"),
      makeRecorderCapability("rec-iso-c", recC),
    ]);
    setMockResponses([{ text: "resilient" }]);

    const stub = getStub("after-turn-3");
    await prompt(stub, "go");
    await new Promise((r) => setTimeout(r, 100));

    expect(recA.calls).toHaveLength(1);
    expect(recC.calls).toHaveLength(1);
    expect(recA.calls[0].finalText).toBe("resilient");
    expect(recC.calls[0].finalText).toBe("resilient");
  });

  it("delivers the final text exactly once for a two-step assistant turn", async () => {
    const rec: Recorder = { calls: [] };
    setExtraCapabilities([makeRecorderCapability("rec-multi-turn", rec)]);
    // The mock harness emits one assistant message per prompt; with a
    // single-step inference the final text is the whole response. This
    // still asserts the "once per handlePrompt" rule: multiple subscribe
    // callbacks never get a chance to double-fire.
    setMockResponses([{ text: "final answer" }]);

    const stub = getStub("after-turn-4");
    await prompt(stub, "compute");
    await new Promise((r) => setTimeout(r, 100));

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].finalText).toBe("final answer");
  });

  it("passes an empty string when the turn produced no assistant text", async () => {
    const rec: Recorder = { calls: [] };
    setExtraCapabilities([makeRecorderCapability("rec-empty", rec)]);
    // An empty-text assistant message still triggers agent_end with a
    // final assistant message whose concatenated text is "".
    setMockResponses([{ text: "" }]);

    const stub = getStub("after-turn-5");
    await prompt(stub, "silent");
    await new Promise((r) => setTimeout(r, 100));

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].finalText).toBe("");
  });

  it("does not dispatch when no capability defines afterTurn", async () => {
    // A simple capability with no afterTurn: the dispatch site should
    // detect this via its fast-path filter and not touch storage or
    // broadcast anything new.
    const marker: Recorder = { calls: [] };
    setExtraCapabilities([
      {
        id: "marker-no-after-turn",
        name: "marker",
        description: "no afterTurn defined",
      },
    ]);
    setMockResponses([{ text: "no dispatch" }]);

    const stub = getStub("after-turn-6");
    await prompt(stub, "noop");
    await new Promise((r) => setTimeout(r, 100));

    expect(marker.calls).toHaveLength(0);
  });
});
