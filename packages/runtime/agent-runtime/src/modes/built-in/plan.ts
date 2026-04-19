import type { Mode } from "../define-mode.js";

/**
 * Built-in planning mode. Denies common CLAW-ecosystem write/exec tool
 * names and appends a planning instruction to the system prompt.
 *
 * ⚠️ **The deny list only covers CLAW ecosystem tool names.** If your
 * agent exposes custom write tools (e.g. `db_insert`, `write_file`,
 * `api_post`), `planMode` will NOT filter them and the LLM may still
 * invoke them. You MUST compose or override the deny list for any
 * custom tool names that should be restricted:
 *
 * ```ts
 * import { defineMode, planMode } from "@crabbykit/agent-runtime/modes";
 *
 * const myPlanMode = defineMode({
 *   ...planMode,
 *   tools: {
 *     deny: [...(planMode.tools?.deny ?? []), "db_insert", "write_file"],
 *   },
 * });
 * ```
 *
 * Safe-by-construction caveat: a deny entry that does not match any
 * registered tool is a harmless no-op — `planMode` is safe to apply to
 * agents that do not use `file-tools`, `sandbox`, `vibe-coder`, or
 * `browserbase`.
 */
export const planMode: Mode = {
  id: "plan",
  name: "Planning",
  description:
    "Read-only exploration mode. Investigate the task and produce a plan before executing any changes.",
  tools: {
    deny: [
      "file_write",
      "file_edit",
      "file_delete",
      "file_move",
      "file_copy",
      "exec",
      "process",
      "show_preview",
      "hide_preview",
      "browser_click",
      "browser_type",
      "browser_navigate",
    ],
  },
  promptAppend: `# Planning mode

You are operating in planning mode. Your goal is to investigate and produce a plan, not to execute changes. Rules:

- Do not use write, edit, delete, move, or execution tools — they are filtered from your tool surface in this mode.
- Use read-only tools (file_read, file_list, grep, browser_snapshot, etc.) to gather context.
- Produce a concrete plan: files to touch, changes to make, risks, and verification steps.
- When the plan is ready, stop and present it. Do not transition out of planning mode on your own — wait for the user to confirm and run \`/mode\` or \`exit_mode\`.`,
};
