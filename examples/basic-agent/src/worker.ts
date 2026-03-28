import type {
  AgentConfig,
  AgentContext,
  AgentTool,
  Capability,
  Command,
  CommandContext,
  PromptOptions,
} from "@claw-for-cloudflare/agent-runtime";
import { AgentDO, defineCommand, defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import {
  CloudflareSandboxProvider,
  SandboxContainer,
} from "@claw-for-cloudflare/cloudflare-sandbox";
import { compactionSummary } from "@claw-for-cloudflare/compaction-summary";
import { credentialStore } from "@claw-for-cloudflare/credential-store";
import { heartbeat } from "@claw-for-cloudflare/heartbeat";
import { promptScheduler } from "@claw-for-cloudflare/prompt-scheduler";
import { r2Storage } from "@claw-for-cloudflare/r2-storage";
import { sandboxCapability } from "@claw-for-cloudflare/sandbox";
import { tavilyWebSearch } from "@claw-for-cloudflare/tavily-web-search";
import { vectorMemory } from "@claw-for-cloudflare/vector-memory";

interface Env {
  AGENT: DurableObjectNamespace;
  SANDBOX_CONTAINER: DurableObjectNamespace;
  STORAGE_BUCKET: R2Bucket;
  MEMORY_INDEX: VectorizeIndex;
  AI: Ai;
  OPENROUTER_API_KEY: string;
  TAVILY_API_KEY: string;
  // R2 credentials for container FUSE mount (set via wrangler secret put)
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
}

/**
 * A minimal agent that can tell the time and do basic math.
 * Demonstrates extending AgentDO with custom tools.
 */
export class BasicAgent extends AgentDO<Env> {
  getConfig(): AgentConfig {
    return {
      provider: "openrouter",
      modelId: "minimax/minimax-m2.7",
      apiKey: this.env.OPENROUTER_API_KEY,
    };
  }

  protected getCapabilities(): Capability[] {
    return [
      compactionSummary({
        provider: "openrouter",
        modelId: "google/gemini-2.0-flash-001",
        getApiKey: () => this.env.OPENROUTER_API_KEY,
      }),
      tavilyWebSearch({
        tavilyApiKey: () => this.env.TAVILY_API_KEY,
      }),
      r2Storage({
        bucket: () => this.env.STORAGE_BUCKET,
        prefix: "default",
      }),
      vectorMemory({
        bucket: () => this.env.STORAGE_BUCKET,
        vectorizeIndex: () => this.env.MEMORY_INDEX,
        prefix: "default",
        ai: () => this.env.AI,
      }),
      promptScheduler(),
      credentialStore(),
      heartbeat({ every: "30m" }),
      sandboxCapability({
        provider: new CloudflareSandboxProvider({
          getStub: () => {
            const id = this.env.SANDBOX_CONTAINER.idFromName("default");
            return this.env.SANDBOX_CONTAINER.get(id);
          },
          agentId: "default",
          containerMode: "dev",
        }),
      }),
    ];
  }

  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance requires explicit any
  getTools(_context: AgentContext): AgentTool<any>[] {
    return [
      defineTool({
        name: "get_current_time",
        description: "Get the current date and time in ISO format.",
        parameters: Type.Object({}),
        execute: async () => ({
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
        execute: async ({ expression }) => {
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
            "save_secret",
            "list_secrets",
            "delete_secret",
            "elevate",
            "de_elevate",
            "bash",
            "start_process",
            "stop_process",
            "get_process_status",
          ];
          const commands = ["/help — List available commands and tools"];
          return {
            text: `Available tools: ${tools.join(", ")}\n\nAvailable commands:\n${commands.join("\n")}`,
          };
        },
      }),
    ];
  }

  protected getPromptOptions(): PromptOptions {
    return {
      agentName: "Basic Agent",
      timezone: "UTC",
    };
  }
}

// Re-export SandboxContainer for wrangler to bind as a DO
export { SandboxContainer };

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
