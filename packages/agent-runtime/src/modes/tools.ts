import type { AgentTool } from "@claw-for-cloudflare/agent-core";
import { Type } from "@sinclair/typebox";
import { defineTool, toolResult } from "../tools/define-tool.js";
import type { Mode } from "./define-mode.js";

/**
 * Dependencies injected into the mode-tool factories. Mirrors
 * {@link import("./commands.js").ModeCommandDeps} — the runtime wires
 * both sets through the same enter/exit callbacks so slash commands
 * and agent tools produce identical side effects.
 */
export interface ModeToolDeps {
  getModes: () => Mode[];
  enterMode: (sessionId: string, modeId: string) => Mode;
  exitMode: (sessionId: string) => Mode | null;
  readActiveMode: (sessionId: string) => Mode | null;
  getSessionId: () => string;
}

function listAvailable(modes: Mode[]): string {
  return modes.map((m) => `- ${m.id}: ${m.description}`).join("\n");
}

/**
 * Build the `enter_mode` agent tool — the model-initiated analogue of
 * `/mode <id>`. Appends a `mode_change` entry and broadcasts a
 * `mode_event` via the injected enterMode callback.
 */
// biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
export function createEnterModeTool(deps: ModeToolDeps): AgentTool<any> {
  return defineTool({
    name: "enter_mode",
    description:
      "Enter a named mode. Filters your tool surface and adjusts the system prompt " +
      "according to the mode's configuration. Mirrors the user-facing `/mode <id>` command.",
    parameters: Type.Object({
      id: Type.String({ description: "Mode ID to enter" }),
    }),
    execute: async (args) => {
      const sessionId = deps.getSessionId();
      const modes = deps.getModes();
      const mode = modes.find((m) => m.id === args.id);
      if (!mode) {
        return toolResult.error(`Unknown mode "${args.id}". Available:\n${listAvailable(modes)}`);
      }
      deps.enterMode(sessionId, mode.id);
      return toolResult.text(`Entered mode: ${mode.name} (${mode.id}).`, {
        modeId: mode.id,
        modeName: mode.name,
      });
    },
  });
}

/**
 * Build the `exit_mode` agent tool — mirrors `/mode` with no argument.
 * No-op when no mode is active.
 */
// biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
export function createExitModeTool(deps: ModeToolDeps): AgentTool<any> {
  return defineTool({
    name: "exit_mode",
    description:
      "Exit the active mode and restore the default tool surface and system prompt. " +
      "No-op when no mode is active.",
    parameters: Type.Object({}),
    execute: async () => {
      const sessionId = deps.getSessionId();
      const active = deps.readActiveMode(sessionId);
      if (!active) {
        return toolResult.text("No mode is active.", { exited: false });
      }
      deps.exitMode(sessionId);
      return toolResult.text(`Exited mode: ${active.name} (${active.id}).`, {
        modeId: active.id,
        modeName: active.name,
        exited: true,
      });
    },
  });
}
