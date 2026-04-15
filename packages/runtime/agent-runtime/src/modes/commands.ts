import type { Command } from "../commands/define-command.js";
import type { Mode } from "./define-mode.js";

/**
 * Dependencies injected into the `/mode` command factory. The runtime
 * constructs these at resolution time so the command closure can read
 * the live mode list and append a `mode_change` entry via the session
 * store.
 */
export interface ModeCommandDeps {
  /** Available modes (live accessor — re-read per invocation). */
  getModes: () => Mode[];
  /**
   * Append a `mode_change` session entry for the given session and
   * emit a `mode_event` transport broadcast. Returns the mode that
   * was entered (or null for an exit). Unknown-id errors are raised
   * here so the command returns a user-facing error.
   */
  enterMode: (sessionId: string, modeId: string) => Mode;
  exitMode: (sessionId: string) => Mode | null;
  /** Read the active mode for the session (from metadata cache). */
  readActiveMode: (sessionId: string) => Mode | null;
}

function listAvailable(modes: Mode[]): string {
  return modes.map((m) => `  /mode ${m.id} — ${m.description}`).join("\n");
}

/**
 * Build the `/mode` slash command. Semantics:
 *   - `/mode <id>` — enter the mode with the given id. Unknown id
 *     returns an error listing available ids; no entry is appended.
 *   - `/mode` (no arg) — exit the active mode (no-op if none active).
 *
 * Emits the corresponding `mode_event` via the injected dependencies.
 */
export function createModeCommand(deps: ModeCommandDeps): Command {
  return {
    name: "mode",
    description:
      "Enter or exit a mode. `/mode <id>` enters a mode. `/mode` with no argument exits.",
    execute: (_args, ctx) => {
      // Raw arg parsing: `args?: string` on the inbound CommandMessage
      // is parsed upstream, but `execute` above declares no
      // parameters object, so we access the raw input through the
      // command's out-of-band args field in CommandContext. Use
      // ctx.sessionId and the injected deps; raw args arrive via the
      // message dispatch path in `handleCommand`.
      //
      // The runtime passes the unparsed args string as a single
      // positional property on the args object when the command
      // declares no TypeBox schema: in that case `execute` receives
      // `undefined`. The actual parsing of "`/mode plan`" is done by
      // the slash handler which splits on whitespace before invoking
      // the command — it places the remainder into `args` typed as
      // `{ _raw?: string }` when no schema is present. See
      // `handleCommand` and `createModeCommand` wiring in
      // agent-runtime.ts for the exact shape. We re-check here:
      // unwrap `_raw` if present, otherwise assume no argument.
      // biome-ignore lint/suspicious/noExplicitAny: _raw is an out-of-band channel injected by the dispatcher
      const raw = (_args as any)?._raw as string | undefined;
      const trimmed = raw?.trim() ?? "";

      const modes = deps.getModes();
      if (trimmed.length === 0) {
        const active = deps.readActiveMode(ctx.sessionId);
        if (!active) {
          return { text: "No mode is active." };
        }
        deps.exitMode(ctx.sessionId);
        return { text: `Exited mode: ${active.name} (${active.id}).` };
      }

      const mode = modes.find((m) => m.id === trimmed);
      if (!mode) {
        return {
          text: `Unknown mode "${trimmed}". Available:\n${listAvailable(modes)}`,
        };
      }
      deps.enterMode(ctx.sessionId, mode.id);
      return { text: `Entered mode: ${mode.name} (${mode.id}).` };
    },
  };
}
