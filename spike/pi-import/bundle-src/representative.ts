/**
 * Spike 0.B — representative bundle with pi-agent-core + pi-ai + capabilities.
 *
 * Tests a realistic bundle size and import chain that would resemble what
 * a defineBundleAgent bundle would compile to.
 */

// Core imports
import { Agent } from "@claw-for-cloudflare/agent-core";
import { type AgentConfig, defineTool } from "@claw-for-cloudflare/agent-runtime";
import { getModel } from "@claw-for-cloudflare/ai";

// Capability imports — representative of what a bundle would inline
import { compactionSummary } from "@claw-for-cloudflare/compaction-summary";
import { promptScheduler } from "@claw-for-cloudflare/prompt-scheduler";
import { tavilyWebSearch } from "@claw-for-cloudflare/tavily-web-search";

interface CheckResult {
  imports: Record<string, string>;
  errors: string[];
}

function checkImports(): CheckResult {
  const errors: string[] = [];
  const imports: Record<string, string> = {};

  const checks: Array<[string, unknown]> = [
    ["Agent", Agent],
    ["getModel", getModel],
    ["defineTool", defineTool],
    ["compactionSummary", compactionSummary],
    ["promptScheduler", promptScheduler],
    ["tavilyWebSearch", tavilyWebSearch],
  ];

  for (const [name, value] of checks) {
    imports[name] = typeof value;
    if (typeof value !== "function") {
      errors.push(`${name} is ${typeof value}, expected function`);
    }
  }

  return { imports, errors };
}

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const result = checkImports();
      return Response.json({
        status: result.errors.length === 0 ? "ok" : "partial",
        ...result,
        timestamp: Date.now(),
      });
    } catch (err) {
      return Response.json(
        {
          status: "error",
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        { status: 500 },
      );
    }
  },
};
