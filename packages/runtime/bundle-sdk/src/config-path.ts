/**
 * Shared dotted-path evaluator used by:
 *
 * - Runtime agent-config slice projection (host-side, invoked by
 *   `AgentRuntime.handleAgentConfigSet` when firing
 *   `onAgentConfigChange` on bundle capabilities).
 * - Build-time `agentConfigPath` validation inside `defineBundleAgent`.
 *
 * Safe-traversal: missing intermediate segments return `undefined`
 * rather than throwing. This diverges from the static
 * `agentConfigMapping: (s) => s.a.b.c` contract (which would
 * `TypeError` on a missing intermediate), but matches the defensive
 * contract most static capability mappings already implement — bundle
 * authors MUST treat `ctx.agentConfig === undefined` as a valid
 * outcome.
 */
export function evaluateAgentConfigPath(snapshot: unknown, path: string): unknown {
  if (path.length === 0) return snapshot;
  const segments = path.split(".");
  let cursor: unknown = snapshot;
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}
