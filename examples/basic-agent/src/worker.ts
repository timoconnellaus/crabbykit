import type {
  AgentConfig,
  AgentContext,
  AgentTool,
  Capability,
  Command,
  CommandContext,
} from "@claw-for-cloudflare/agent-runtime";
import { AgentDO, defineCommand, defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import { compactionSummary } from "@claw-for-cloudflare/compaction-summary";
import { promptScheduler } from "@claw-for-cloudflare/prompt-scheduler";
import { r2Storage } from "@claw-for-cloudflare/r2-storage";
import { tavilyWebSearch } from "@claw-for-cloudflare/tavily-web-search";
import { vectorMemory } from "@claw-for-cloudflare/vector-memory";

interface Env {
  AGENT: DurableObjectNamespace;
  STORAGE_BUCKET: R2Bucket;
  MEMORY_INDEX: VectorizeIndex;
  AI: Ai;
  OPENROUTER_API_KEY: string;
  TAVILY_API_KEY: string;
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
      modelId: "minimax/minimax-m2.7",
      apiKey: env.OPENROUTER_API_KEY,
    };
  }

  protected getCapabilities(): Capability[] {
    const env = this.env as unknown as Env;
    return [
      compactionSummary({
        provider: "openrouter",
        modelId: "google/gemini-2.0-flash-001",
        getApiKey: () => env.OPENROUTER_API_KEY,
      }),
      tavilyWebSearch({
        tavilyApiKey: () => env.TAVILY_API_KEY,
      }),
      r2Storage({
        bucket: () => env.STORAGE_BUCKET,
        prefix: "default",
      }),
      vectorMemory({
        bucket: () => env.STORAGE_BUCKET,
        vectorizeIndex: () => env.MEMORY_INDEX,
        prefix: "default",
        ai: () => env.AI,
      }),
      promptScheduler(),
    ];
  }

  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance requires explicit any
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
          } catch (e: unknown) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            return {
              content: [{ type: "text" as const, text: `Error: ${errorMessage}` }],
              details: { expression, error: errorMessage },
            };
          }
        },
      }),
    ];
  }

  protected getCommands(_context: CommandContext): Command[] {
    return [
      defineCommand({
        name: "help",
        description: "List available commands and tools",
        execute: (_args, ctx) => {
          const tools = [
            "get_current_time",
            "calculate",
            "web_search",
            "web_fetch",
            "file_read",
            "file_write",
            "file_edit",
            "file_delete",
            "file_list",
            "file_tree",
            "file_find",
            "memory_search",
            "memory_get",
          ];
          const commands = ["/help — List available commands and tools"];
          return {
            text: `Available tools: ${tools.join(", ")}\n\nAvailable commands:\n${commands.join("\n")}`,
          };
        },
      }),
    ];
  }

  buildSystemPrompt(_context: AgentContext): string {
    return "You are a helpful assistant. You can tell the time, do math, search the web, fetch web pages, manage files in storage, and create scheduled tasks. When you learn something important about the user or a conversation worth remembering, save it to memory using file_write to MEMORY.md or memory/*.md files. Before answering questions that might relate to previous conversations, use memory_search to check your memory first.";
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
