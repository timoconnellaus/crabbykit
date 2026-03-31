/** Format a duration in milliseconds as a human-readable string. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Summarize tool input args into a short display string. */
export function summarizeToolInput(input: unknown): string {
  if (!input) return "";
  if (typeof input === "string") {
    try {
      return summarizeToolInput(JSON.parse(input));
    } catch {
      return input.length > 60 ? `${input.slice(0, 57)}...` : input;
    }
  }
  if (typeof input === "object" && input !== null) {
    const obj = input as Record<string, unknown>;
    // agent_message: show agent name + message preview
    if ("agentId" in obj && "message" in obj && typeof obj.message === "string") {
      const name = (obj.agentName as string) ?? (obj.agentId as string);
      const msg = obj.message;
      const preview = msg.length > 50 ? `${msg.slice(0, 47)}...` : msg;
      return `${name} \u00b7 ${preview}`;
    }
    // start_process: show name + command
    if ("name" in obj && "command" in obj && typeof obj.command === "string") {
      const cmd = obj.command;
      const short = cmd.length > 50 ? `${cmd.slice(0, 47)}...` : cmd;
      return `${obj.name} \u00b7 ${short}`;
    }
    // config_set/config_get: show namespace + value summary
    if ("namespace" in obj && typeof obj.namespace === "string") {
      const ns = obj.namespace;
      if ("value" in obj && obj.value != null) {
        const v = typeof obj.value === "string" ? obj.value : JSON.stringify(obj.value);
        const short = v.length > 40 ? `${v.slice(0, 37)}...` : v;
        return `${ns} \u00b7 ${short}`;
      }
      return ns;
    }
    const vals = Object.values(obj).filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    const first = vals[0];
    if (first) return first.length > 60 ? `${first.slice(0, 57)}...` : first;
  }
  return "";
}

export type ToolCategory = "bash" | "code" | "web" | "memory" | "default";

/** Map a tool name to a color category for CSS styling. */
export function toolColorCategory(name: string): ToolCategory {
  switch (name) {
    case "bash":
    case "start_process":
      return "bash";
    case "run_code":
      return "code";
    case "web_search":
    case "web_fetch":
      return "web";
    case "memory_read":
    case "memory_write":
    case "memory_search":
    case "memory_get":
      return "memory";
    default:
      return "default";
  }
}

export type ResultSummary = { text: string; variant: "success" | "error" | "muted" };

/** Summarize a tool result into a short display string with semantic variant. */
export function summarizeResult(
  toolName: string,
  output: unknown,
  isError: boolean,
  errorText?: string,
): ResultSummary | null {
  if (isError) {
    if (errorText) {
      const short = errorText.match(/^(\w+Error|exit code \d+)/)?.[0] || errorText.slice(0, 40);
      return { text: short, variant: "error" };
    }
    return { text: "error", variant: "error" };
  }

  if (!output) return null;
  const text = typeof output === "string" ? output : JSON.stringify(output);

  switch (toolName) {
    case "bash":
    case "start_process": {
      const added = text.match(/added (\d+) packages/);
      if (added) return { text: `added ${added[1]} packages`, variant: "success" };

      const tests = text.match(/(\d+) passed/);
      if (tests) {
        const failed = text.match(/(\d+) failed/);
        if (failed)
          return {
            text: `${tests[1]} passed \u00b7 ${failed[1]} failed`,
            variant: "success",
          };
        return { text: `${tests[1]} passed`, variant: "success" };
      }

      const exitCode = text.match(/exit code (\d+)/);
      if (exitCode && exitCode[1] !== "0")
        return { text: `exit code ${exitCode[1]}`, variant: "error" };

      const built = text.match(/built in ([\d.]+s)/i);
      if (built) return { text: `built in ${built[1]}`, variant: "success" };

      const modified = text.match(/(\d+) files? changed/);
      if (modified) return { text: `${modified[1]} changed`, variant: "muted" };

      const lines = text.split("\n").filter(Boolean);
      if (lines.length === 1) return { text: lines[0].slice(0, 50), variant: "muted" };
      if (lines.length > 1) return { text: `${lines.length} lines`, variant: "muted" };
      return null;
    }

    case "run_code": {
      const parsed =
        typeof output === "object"
          ? output
          : (() => {
              try {
                return JSON.parse(text) as unknown;
              } catch {
                return null;
              }
            })();
      if (parsed !== null && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        if (Array.isArray(parsed))
          return { text: `\u2192 ${parsed.length} items`, variant: "success" };
        if (obj.ok === true) return { text: "\u2192 ok", variant: "success" };
        if (obj.ok === false)
          return {
            text: obj.error ? String(obj.error).slice(0, 40) : "\u2192 failed",
            variant: "error",
          };
        if (obj.result !== undefined) {
          const r = String(obj.result);
          return {
            text: `\u2192 ${r.length > 40 ? `${r.slice(0, 37)}...` : r}`,
            variant: "success",
          };
        }
      }
      if (text.length <= 50) return { text: `\u2192 ${text}`, variant: "success" };
      return { text: `\u2192 ${text.slice(0, 40)}...`, variant: "success" };
    }

    case "file_read": {
      const lineCount = text.split("\n").length;
      return { text: `${lineCount} lines`, variant: "muted" };
    }

    case "file_write":
    case "file_edit": {
      let adds = 0;
      let removes = 0;
      for (const line of text.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) adds++;
        if (line.startsWith("-") && !line.startsWith("---")) removes++;
      }
      if (adds > 0 || removes > 0) {
        const parts: string[] = [];
        if (adds > 0) parts.push(`+${adds}`);
        if (removes > 0) parts.push(`-${removes}`);
        return { text: parts.join(" "), variant: adds > 0 ? "success" : "error" };
      }
      const lineCount = text.split("\n").length;
      if (lineCount > 1) return { text: `created \u00b7 ${lineCount} lines`, variant: "success" };
      return { text: "written", variant: "success" };
    }

    case "file_list": {
      const items = text.split("\n").filter(Boolean);
      return { text: `${items.length} files`, variant: "muted" };
    }

    case "file_tree": {
      const allLines = text.split("\n").filter(Boolean);
      const dirs = allLines.filter((l) => l.endsWith("/")).length;
      const files = allLines.length - dirs;
      const parts: string[] = [];
      if (files > 0) parts.push(`${files} files`);
      if (dirs > 0) parts.push(`${dirs} dirs`);
      return { text: parts.join(" \u00b7 ") || `${allLines.length} entries`, variant: "muted" };
    }

    case "file_find": {
      const matches = text.split("\n").filter(Boolean);
      if (matches.length === 0) return { text: "no matches", variant: "muted" };
      return { text: `${matches.length} matches`, variant: "muted" };
    }

    case "web_search": {
      const parsed =
        typeof output === "object"
          ? output
          : (() => {
              try {
                return JSON.parse(text) as unknown;
              } catch {
                return null;
              }
            })();
      if (
        parsed &&
        typeof parsed === "object" &&
        "results" in parsed &&
        Array.isArray((parsed as Record<string, unknown>).results)
      )
        return {
          text: `${(parsed as { results: unknown[] }).results.length} results`,
          variant: "muted",
        };
      const results = text.match(/(\d+) results?/);
      if (results) return { text: `${results[1]} results`, variant: "muted" };
      return { text: "results", variant: "muted" };
    }

    case "web_fetch": {
      const title = text.match(/^#\s+(.+)/m)?.[1] || text.match(/<title>(.+?)<\/title>/i)?.[1];
      if (title) return { text: title.slice(0, 40), variant: "muted" };
      const kb = (text.length / 1024).toFixed(1);
      return { text: `${kb}kb`, variant: "muted" };
    }

    case "memory_search": {
      const parsed =
        typeof output === "object"
          ? output
          : (() => {
              try {
                return JSON.parse(text) as unknown;
              } catch {
                return null;
              }
            })();
      if (parsed && Array.isArray(parsed)) {
        if (parsed.length === 0) return { text: "no results", variant: "muted" };
        return { text: `${parsed.length} memories`, variant: "muted" };
      }
      if (text.includes("no") || text.length === 0) return { text: "no results", variant: "muted" };
      return { text: "retrieved", variant: "muted" };
    }

    case "memory_get": {
      if (!text || text === "null") return { text: "not found", variant: "muted" };
      return { text: "retrieved", variant: "muted" };
    }

    case "elevate":
      return { text: "sandbox activated", variant: "success" };

    case "de_elevate":
      return { text: "sandbox deactivated", variant: "muted" };

    default: {
      const lines = text.split("\n").filter(Boolean);
      if (lines.length === 0) return { text: "done", variant: "muted" };
      if (lines.length === 1 && lines[0].length <= 50) return { text: lines[0], variant: "muted" };
      return { text: `${lines.length} lines`, variant: "muted" };
    }
  }
}
