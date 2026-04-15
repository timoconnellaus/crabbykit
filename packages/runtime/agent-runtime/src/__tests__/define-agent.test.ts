import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../agent-runtime.js";
import { defineAgent } from "../define-agent.js";

describe("defineAgent", () => {
  const baseModel: AgentConfig = {
    provider: "openrouter",
    modelId: "test/mock",
    apiKey: "test-key",
  };

  it("returns a DurableObject class with the expected prototype methods", () => {
    const Agent = defineAgent({
      model: baseModel,
      prompt: "You are a test.",
    });

    // The returned value is a class (function with prototype)
    expect(typeof Agent).toBe("function");
    expect(Agent.prototype.getConfig).toBeTypeOf("function");
    expect(Agent.prototype.getTools).toBeTypeOf("function");
    expect(Agent.prototype.buildSystemPrompt).toBeTypeOf("function");
    expect(Agent.prototype.getPromptOptions).toBeTypeOf("function");
    expect(Agent.prototype.getCapabilities).toBeTypeOf("function");
    expect(Agent.prototype.getSubagentModes).toBeTypeOf("function");
    expect(Agent.prototype.getModes).toBeTypeOf("function");
    expect(Agent.prototype.getCommands).toBeTypeOf("function");
    expect(Agent.prototype.getA2AClientOptions).toBeTypeOf("function");
  });

  it("accepts model as a literal AgentConfig", () => {
    const Agent = defineAgent({
      model: baseModel,
    });
    expect(typeof Agent).toBe("function");
  });

  it("accepts model as a function of env", () => {
    interface Env {
      KEY: string;
    }
    const Agent = defineAgent<Env>({
      model: (env) => ({ ...baseModel, apiKey: env.KEY }),
    });
    expect(typeof Agent).toBe("function");
  });

  it("accepts prompt as a literal string", () => {
    const Agent = defineAgent({
      model: baseModel,
      prompt: "Custom literal prompt.",
    });
    expect(typeof Agent).toBe("function");
  });

  it("accepts prompt as a PromptOptions object", () => {
    const Agent = defineAgent({
      model: baseModel,
      prompt: { agentName: "Tester", agentDescription: "A test agent" },
    });
    expect(typeof Agent).toBe("function");
  });

  it("accepts capabilities as a factory function", () => {
    const Agent = defineAgent({
      model: baseModel,
      capabilities: () => [],
    });
    expect(typeof Agent).toBe("function");
  });

  it("accepts hooks as a factory function", () => {
    const Agent = defineAgent({
      model: baseModel,
      hooks: () => ({
        onTurnEnd: async () => {},
      }),
    });
    expect(typeof Agent).toBe("function");
  });

  it("accepts a custom fetch handler", () => {
    const Agent = defineAgent({
      model: baseModel,
      fetch: async () => null,
    });
    expect(typeof Agent).toBe("function");
  });

  it("accepts logger and onError slots", () => {
    const Agent = defineAgent({
      model: baseModel,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      onError: () => {},
    });
    expect(typeof Agent).toBe("function");
  });

  it("accepts publicUrl as a literal string", () => {
    const Agent = defineAgent({
      model: baseModel,
      publicUrl: "https://agent.example.com",
    });
    expect(typeof Agent).toBe("function");
  });

  it("accepts publicUrl as a function of env", () => {
    interface Env {
      DEPLOY_ORIGIN: string;
    }
    const Agent = defineAgent<Env>({
      model: baseModel,
      publicUrl: (env) => env.DEPLOY_ORIGIN,
    });
    expect(typeof Agent).toBe("function");
  });
});
