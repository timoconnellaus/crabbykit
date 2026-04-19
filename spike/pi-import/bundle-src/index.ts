/**
 * Spike 0.A bundle — compiled via `bun build --target=browser --format=esm`.
 *
 * This bundle imports the key symbols from pi-agent-core and pi-ai (via the
 * CLAW workspace packages) and reports whether they loaded successfully.
 * The host DO loads this via Worker Loader and calls its fetch handler.
 */

// The critical imports — these pull in pi-agent-core (which depends on pi-ai,
// which depends on partial-json, the CJS package that causes the known issue).
import { Agent } from "@crabbykit/agent-core";
// Also test importing from agent-runtime itself, since that's what
// defineBundleAgent would ultimately need.
import { defineTool } from "@crabbykit/agent-runtime";
import { getModel } from "@crabbykit/ai";

interface ImportCheckResult {
  agentType: string;
  agentConstructable: boolean;
  getModelType: string;
  defineToolType: string;
  partialJsonResolved: boolean;
  errors: string[];
}

function checkImports(): ImportCheckResult {
  const errors: string[] = [];
  let agentConstructable = false;

  // Check Agent class
  const agentType = typeof Agent;
  if (agentType !== "function") {
    errors.push(`Agent is ${agentType}, expected function`);
  } else {
    // Try to verify it's constructable (don't actually construct)
    try {
      agentConstructable = typeof Agent.prototype === "object";
    } catch (e) {
      errors.push(`Agent.prototype check failed: ${e}`);
    }
  }

  // Check getModel function
  const getModelType = typeof getModel;
  if (getModelType !== "function") {
    errors.push(`getModel is ${getModelType}, expected function`);
  }

  // Check defineTool function
  const defineToolType = typeof defineTool;
  if (defineToolType !== "function") {
    errors.push(`defineTool is ${defineToolType}, expected function`);
  }

  // partial-json is the known CJS issue — if we got this far without
  // a module resolution error, it resolved successfully
  const partialJsonResolved = errors.length === 0;

  return {
    agentType,
    agentConstructable,
    getModelType,
    defineToolType,
    partialJsonResolved,
    errors,
  };
}

export default {
  async fetch(_request: Request): Promise<Response> {
    try {
      const result = checkImports();
      return Response.json({
        status: result.errors.length === 0 ? "ok" : "partial",
        imports: result,
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
