/**
 * skillsClient unit tests (task 2.10).
 *
 * Verifies:
 *  - capability id matches the scope string "skills"
 *  - skill_load tool forwards __BUNDLE_TOKEN + args + SCHEMA_CONTENT_HASH to service.load
 *  - tool throws when __BUNDLE_TOKEN is absent from env
 *  - no host-only surfaces (`hooks`, `httpHandlers`, `configNamespaces`, `onAction`, `promptSections`) are registered
 */

import type { AgentTool } from "@claw-for-cloudflare/agent-core";
import type { AgentContext } from "@claw-for-cloudflare/agent-runtime";
import { createNoopStorage } from "@claw-for-cloudflare/agent-runtime";
import { textOf } from "@claw-for-cloudflare/agent-runtime/test-utils";
import { describe, expect, it, vi } from "vitest";
import { skillsClient } from "../client.js";
import { SCHEMA_CONTENT_HASH, SKILL_LOAD_TOOL_NAME } from "../schemas.js";
import type { SkillsService } from "../service.js";

function makeMockService() {
  return {
    load: vi.fn(),
  } as unknown as Service<SkillsService> & {
    load: ReturnType<typeof vi.fn>;
  };
}

function makeContext(token?: string): AgentContext & {
  env: { __BUNDLE_TOKEN?: string };
} {
  return {
    agentId: "agent",
    sessionId: "session",
    stepNumber: 0,
    emitCost: vi.fn(),
    broadcast: () => {},
    broadcastToAll: () => {},
    broadcastState: () => {},
    requestFromClient: () => Promise.reject(new Error("Not available")),
    storage: createNoopStorage(),
    schedules: {} as never,
    rateLimit: { consume: async () => ({ allowed: true }) },
    env: { __BUNDLE_TOKEN: token },
  } as unknown as AgentContext & { env: { __BUNDLE_TOKEN?: string } };
}

function toolByName(tools: AgentTool<any>[], name: string): AgentTool<any> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

describe("skillsClient capability shape", () => {
  it("has id 'skills' matching the catalog scope string", () => {
    const cap = skillsClient({ service: makeMockService() });
    expect(cap.id).toBe("skills");
  });

  it("registers no lifecycle hooks", () => {
    const cap = skillsClient({ service: makeMockService() });
    expect(cap.hooks).toBeUndefined();
  });

  it("registers no httpHandlers", () => {
    const cap = skillsClient({ service: makeMockService() });
    expect(cap.httpHandlers).toBeUndefined();
  });

  it("registers no configNamespaces", () => {
    const cap = skillsClient({ service: makeMockService() });
    expect(cap.configNamespaces).toBeUndefined();
  });

  it("registers no onAction handler", () => {
    const cap = skillsClient({ service: makeMockService() });
    expect(cap.onAction).toBeUndefined();
  });

  it("registers no promptSections", () => {
    const cap = skillsClient({ service: makeMockService() });
    expect(cap.promptSections).toBeUndefined();
  });

  it("produces a single skill_load tool", () => {
    const cap = skillsClient({ service: makeMockService() });
    const ctx = makeContext("tok");
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe(SKILL_LOAD_TOOL_NAME);
  });
});

describe("skill_load tool", () => {
  it("forwards __BUNDLE_TOKEN + args + SCHEMA_CONTENT_HASH to service.load", async () => {
    const service = makeMockService();
    service.load.mockResolvedValue({ content: "# Skill body\n" });

    const cap = skillsClient({ service });
    const ctx = makeContext("tok-abc");
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const load = toolByName(tools, SKILL_LOAD_TOOL_NAME);

    const result = await load.execute!({ name: "my-skill" }, ctx as never);

    expect(service.load).toHaveBeenCalledOnce();
    const [token, passedArgs, hash] = service.load.mock.calls[0];
    expect(token).toBe("tok-abc");
    expect(passedArgs).toEqual({ name: "my-skill" });
    expect(hash).toBe(SCHEMA_CONTENT_HASH);
    expect(textOf(result)).toBe("# Skill body\n");
  });

  it("reads token from env only — LLM args containing a token are ignored", async () => {
    const service = makeMockService();
    service.load.mockResolvedValue({ content: "body" });
    const cap = skillsClient({ service });
    const ctx = makeContext("real-env-token");
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const load = toolByName(tools, SKILL_LOAD_TOOL_NAME);

    await load.execute!(
      {
        name: "skill",
        // LLM-supplied field should be ignored by the client
        __BUNDLE_TOKEN: "llm-forged-token",
      },
      ctx as never,
    );

    expect(service.load.mock.calls[0][0]).toBe("real-env-token");
  });

  it("throws when __BUNDLE_TOKEN is absent from env", async () => {
    const service = makeMockService();
    const cap = skillsClient({ service });
    const ctx = makeContext(undefined);
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const load = toolByName(tools, SKILL_LOAD_TOOL_NAME);

    await expect(load.execute!({ name: "skill" }, ctx as never)).rejects.toThrow(
      "Missing __BUNDLE_TOKEN",
    );
    expect(service.load).not.toHaveBeenCalled();
  });

  it("surfaces service's { content } as the tool result text verbatim", async () => {
    const service = makeMockService();
    service.load.mockResolvedValue({ content: "Skill 'foo' not found" });
    const cap = skillsClient({ service });
    const ctx = makeContext("tok");
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const load = toolByName(tools, SKILL_LOAD_TOOL_NAME);

    const result = await load.execute!({ name: "foo" }, ctx as never);
    expect(textOf(result)).toBe("Skill 'foo' not found");
  });
});
