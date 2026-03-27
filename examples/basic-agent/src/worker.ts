import { AgentDO, defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import type { AgentConfig, AgentContext, AgentTool } from "@claw-for-cloudflare/agent-runtime";

interface Env {
  AGENT: DurableObjectNamespace;
  OPENROUTER_API_KEY: string;
}

/**
 * A minimal agent that can tell the time and do basic math.
 * Demonstrates extending AgentDO with custom tools.
 */
export class BasicAgent extends AgentDO {
  getConfig(): AgentConfig {
    const env = this.env as unknown as Env;
    return {
      provider: "openrouter",
      modelId: "google/gemini-2.5-flash",
      apiKey: env.OPENROUTER_API_KEY,
    };
  }

  getTools(_context: AgentContext): AgentTool<any>[] {
    return [
      defineTool({
        name: "get_current_time",
        description: "Get the current date and time in ISO format.",
        parameters: Type.Object({}),
        execute: async (_toolCallId) => ({
          content: [{ type: "text" as const, text: new Date().toISOString() }],
          details: null,
        }),
      }),
      defineTool({
        name: "calculate",
        description: "Evaluate a math expression.",
        parameters: Type.Object({
          expression: Type.String({ description: "The math expression to evaluate" }),
        }),
        execute: async (_toolCallId, { expression }) => {
          try {
            const result = Function(`"use strict"; return (${expression})`)();
            return {
              content: [{ type: "text" as const, text: String(result) }],
              details: { expression, result },
            };
          } catch (e: any) {
            return {
              content: [{ type: "text" as const, text: `Error: ${e.message}` }],
              details: { expression, error: e.message },
            };
          }
        },
      }),
    ];
  }

  buildSystemPrompt(_context: AgentContext): string {
    return "You are a helpful assistant. You can tell the time and do math.";
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Route to the agent DO
    if (url.pathname.startsWith("/agent")) {
      const id = env.AGENT.idFromName("default");
      const stub = env.AGENT.get(id);
      return stub.fetch(request);
    }

    return new Response("Basic Agent Example. Connect WebSocket to /agent", {
      status: 200,
    });
  },
};
