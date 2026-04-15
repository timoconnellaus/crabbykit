import type { Static, TObject } from "@sinclair/typebox";
import type { ScheduleManager } from "../agent-do.js";
import type { CapabilityStorage } from "../capabilities/storage.js";
import type { SessionStore } from "../session/session-store.js";

/**
 * Context provided to command execute functions.
 * Similar to AgentContext but without LLM-specific fields (stepNumber, emitCost).
 */
export interface CommandContext {
  sessionId: string;
  sessionStore: SessionStore;
  /** Persistent key-value storage scoped to a capability. Only set for capability-contributed commands. */
  storage?: CapabilityStorage;
  /** Manage prompt-based schedules. */
  schedules: ScheduleManager;
}

/**
 * Result returned by a command's execute function.
 * Commands are synchronous (no streaming) — they return a single result.
 */
export interface CommandResult {
  /** Text to display to the user. */
  text?: string;
  /** Structured data (rendered as JSON or consumed by custom renderers). */
  data?: unknown;
}

/**
 * A slash command definition. Commands bypass the LLM inference loop
 * and execute directly on the server.
 */
export interface Command<TArgs extends TObject = TObject> {
  /** Command name without leading slash (e.g. "help", "clear"). */
  name: string;
  /** One-line description shown in autocomplete and /help. */
  description: string;
  /** Optional TypeBox schema for argument validation. */
  parameters?: TArgs;
  /** Execute the command. */
  execute: (
    args: TArgs extends TObject ? Static<TArgs> : undefined,
    context: CommandContext,
  ) => Promise<CommandResult> | CommandResult;
}

/**
 * Define a slash command with optional TypeBox schema and type-safe execute function.
 * Commands bypass the LLM and execute directly on the server.
 *
 * @example
 * ```ts
 * const helpCommand = defineCommand({
 *   name: "help",
 *   description: "List available commands",
 *   execute: async (_args, ctx) => ({
 *     text: "Available commands: /help",
 *   }),
 * });
 * ```
 */
export function defineCommand<TArgs extends TObject = TObject>(opts: {
  name: string;
  description: string;
  parameters?: TArgs;
  execute: (
    args: TArgs extends TObject ? Static<TArgs> : undefined,
    context: CommandContext,
  ) => Promise<CommandResult> | CommandResult;
}): Command<TArgs> {
  return {
    name: opts.name,
    description: opts.description,
    parameters: opts.parameters,
    execute: opts.execute,
  };
}
