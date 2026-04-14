import type { AgentContext } from "../agent-runtime.js";

/**
 * A named scoped view of the agent's capabilities, tools, and prompt.
 *
 * Modes are the SDK's mechanism for presenting a filtered subset of an
 * agent's full surface to the LLM for a single session turn (or a subagent
 * spawn). They are a pure filter layer: capability lifecycle hooks
 * (`onConnect`, `afterToolExecution`, `httpHandlers`, `schedules`) are not
 * affected.
 *
 * Modes are registered via `defineAgent({ modes: () => [...] })` (current
 * session) or `defineAgent({ subagentModes: () => [...] })` (subagent
 * spawns). The same `Mode` constant may appear in both slots.
 */
export interface Mode {
  /** Unique, kebab-case identifier (e.g. `"plan"`). */
  id: string;
  /** Human-readable display name (e.g. `"Planning"`). */
  name: string;
  /** One-line description. */
  description: string;
  /**
   * Capability ID allow/deny filter (coarse-grained). `allow` and `deny`
   * are mutually exclusive — setting both on the same filter causes
   * {@link defineMode} to throw.
   */
  capabilities?: { allow?: string[]; deny?: string[] };
  /**
   * Tool name allow/deny filter (fine-grained). `allow` and `deny` are
   * mutually exclusive — setting both on the same filter causes
   * {@link defineMode} to throw.
   */
  tools?: { allow?: string[]; deny?: string[] };
  /** Text appended to the system prompt after base and capability sections. */
  promptAppend?: string | ((context: AgentContext) => string);
  /**
   * Full replacement of the base system prompt. When used for a subagent
   * spawn, the function form receives `(parentSystemPrompt, parentContext)`.
   */
  systemPromptOverride?: string | ((base: string, context: AgentContext) => string);
  /**
   * Transient config merged into capability configs while the mode is
   * active. Keyed by capability ID.
   */
  capabilityConfig?: Record<string, Record<string, unknown>>;
  /**
   * OpenRouter model ID override. Applied only when the mode is used to
   * spawn a subagent. **Silently ignored** when activated on the current
   * session — swapping models mid-session would drop the context cache.
   */
  model?: string;
}

/**
 * Resolved shape returned by `applyMode` after filtering.
 */
export interface AppliedMode {
  // biome-ignore lint/suspicious/noExplicitAny: tool generics intentionally erased
  tools: any[];
  promptSections: import("../prompt/types.js").PromptSection[];
  promptAppend?: string;
  systemPromptOverride?: (base: string) => string;
}

/**
 * Identity-typed factory for {@link Mode}. Validates that `capabilities`
 * and `tools` filters do not set both `allow` and `deny` simultaneously.
 *
 * @throws `Error` when `mode.capabilities` or `mode.tools` has both
 *         `allow` and `deny` populated on the same filter.
 */
export function defineMode(mode: Mode): Mode {
  assertFilterNotConflicting(mode.capabilities, "capabilities");
  assertFilterNotConflicting(mode.tools, "tools");
  return mode;
}

function assertFilterNotConflicting(
  filter: { allow?: string[]; deny?: string[] } | undefined,
  fieldName: "capabilities" | "tools",
): void {
  if (!filter) return;
  const hasAllow = filter.allow !== undefined && filter.allow.length > 0;
  const hasDeny = filter.deny !== undefined && filter.deny.length > 0;
  if (hasAllow && hasDeny) {
    throw new Error(
      `defineMode: \`${fieldName}\` filter cannot specify both \`allow\` and \`deny\`. Choose one.`,
    );
  }
}
