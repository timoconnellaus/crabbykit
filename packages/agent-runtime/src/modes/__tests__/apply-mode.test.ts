import type { AnyAgentTool } from "@claw-for-cloudflare/agent-core";
import { describe, expect, it } from "vitest";
import type { AgentContext } from "../../agent-runtime.js";
import type { ResolvedCapabilities } from "../../capabilities/resolve.js";
import type { Capability } from "../../capabilities/types.js";
import type { PromptSection } from "../../prompt/types.js";
import { applyMode } from "../apply-mode.js";
import { defineMode } from "../define-mode.js";

function tool(name: string): AnyAgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: {},
    execute: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
  } as unknown as AnyAgentTool;
}

function capSection(capabilityId: string, key: string): PromptSection {
  return {
    name: capabilityId,
    key,
    content: "section",
    lines: 1,
    tokens: 1,
    source: { type: "capability", capabilityId, capabilityName: capabilityId },
    included: true,
  };
}

function ctx(overrides?: Partial<AgentContext>): AgentContext {
  return {
    agentId: "agent",
    sessionId: "sess",
    stepNumber: 0,
    emitCost: () => {},
    broadcast: () => {},
    broadcastToAll: () => {},
    requestFromClient: () => Promise.reject(new Error("nope")),
    storage: {} as AgentContext["storage"],
    broadcastState: () => {},
    schedules: {} as AgentContext["schedules"],
    rateLimit: {} as AgentContext["rateLimit"],
    notifyBundlePointerChanged: async () => {},
    ...overrides,
  };
}

function fakeCap(id: string, toolNames: string[]): Capability {
  return {
    id,
    name: id,
    description: id,
    tools: () => toolNames.map((n) => tool(n)),
  };
}

const emptyResolved: ResolvedCapabilities = {
  tools: [],
  commands: [],
  promptSections: [],
  mcpServers: [],
  beforeInferenceHooks: [],
  beforeToolExecutionHooks: [],
  afterToolExecutionHooks: [],
  onConnectHooks: [],
  schedules: [],
  httpHandlers: [],
  onActionHandlers: new Map(),
  disposers: [],
};

describe("applyMode", () => {
  it("null mode is a pass-through", () => {
    const tools = [tool("a"), tool("b")];
    const sections = [capSection("r2", "cap-r2-1")];
    const resolved = { ...emptyResolved, promptSections: sections };
    const result = applyMode(resolved, [], tools, null, ctx());
    expect(result.tools).toBe(tools);
    expect(result.promptSections).toBe(sections);
    expect(result.promptAppend).toBeUndefined();
    expect(result.systemPromptOverride).toBeUndefined();
  });

  it("removes tools contributed by dead capabilities (allow filter)", () => {
    const r2 = fakeCap("r2", ["file_read", "file_write"]);
    const vibe = fakeCap("vibe", ["show_preview"]);
    const allTools = [tool("file_read"), tool("file_write"), tool("show_preview"), tool("grep")];
    const mode = defineMode({
      id: "p",
      name: "p",
      description: "p",
      capabilities: { allow: ["r2"] },
    });
    const result = applyMode(emptyResolved, [r2, vibe], allTools, mode, ctx());
    expect(result.tools.map((t) => t.name)).toEqual(["file_read", "file_write", "grep"]);
  });

  it("removes tools contributed by deny-listed capabilities", () => {
    const vibe = fakeCap("vibe", ["show_preview"]);
    const allTools = [tool("file_read"), tool("show_preview")];
    const mode = defineMode({
      id: "p",
      name: "p",
      description: "p",
      capabilities: { deny: ["vibe"] },
    });
    const result = applyMode(emptyResolved, [vibe], allTools, mode, ctx());
    expect(result.tools.map((t) => t.name)).toEqual(["file_read"]);
  });

  it("delegates remaining tool/section filter to filterToolsAndSections", () => {
    const sections = [capSection("vibe", "cap-vibe-1"), capSection("tavily", "cap-tavily-1")];
    const resolved = { ...emptyResolved, promptSections: sections };
    const mode = defineMode({
      id: "p",
      name: "p",
      description: "p",
      capabilities: { deny: ["vibe"] },
      tools: { deny: ["file_write"] },
    });
    const allTools = [tool("file_read"), tool("file_write")];
    const result = applyMode(resolved, [], allTools, mode, ctx());
    expect(result.tools.map((t) => t.name)).toEqual(["file_read"]);
    const flipped = result.promptSections.find((s) => s.key === "cap-vibe-1");
    expect(flipped?.included).toBe(false);
    expect(flipped?.excludedReason).toBe("Filtered by mode: p");
  });

  it("resolves promptAppend function form with the supplied context", () => {
    const mode = defineMode({
      id: "p",
      name: "p",
      description: "p",
      promptAppend: (c) => `Session: ${c.sessionId}`,
    });
    const result = applyMode(emptyResolved, [], [], mode, ctx({ sessionId: "abc" }));
    expect(result.promptAppend).toBe("Session: abc");
  });

  it("resolves systemPromptOverride function form via the returned closure", () => {
    const mode = defineMode({
      id: "p",
      name: "p",
      description: "p",
      systemPromptOverride: (base, c) => `${base}\nSession ${c.sessionId}`,
    });
    const result = applyMode(emptyResolved, [], [], mode, ctx({ sessionId: "abc" }));
    expect(result.systemPromptOverride).toBeDefined();
    expect(result.systemPromptOverride!("BASE")).toBe("BASE\nSession abc");
  });

  it("resolves systemPromptOverride string form", () => {
    const mode = defineMode({
      id: "p",
      name: "p",
      description: "p",
      systemPromptOverride: "STATIC",
    });
    const result = applyMode(emptyResolved, [], [], mode, ctx());
    expect(result.systemPromptOverride!("BASE")).toBe("STATIC");
  });
});
