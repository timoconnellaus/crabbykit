import type { AgentContext, Capability } from "@claw-for-cloudflare/agent-runtime";
import { defineCommand } from "@claw-for-cloudflare/agent-runtime";
import { createGetConsoleLogsTool } from "./tools/get-console-logs.js";
import { createHidePreviewTool } from "./tools/hide-preview.js";
import { createShowPreviewTool } from "./tools/show-preview.js";
import type { VibeCoderOptions } from "./types.js";

/**
 * Create a vibe-coder capability that provides live app preview and console log tools.
 *
 * Tools provided:
 * - `show_preview` — Open a live preview iframe for a dev server port
 * - `hide_preview` — Close the preview iframe
 * - `get_console_logs` — Retrieve console logs from the preview iframe
 */
export function vibeCoder(options: VibeCoderOptions): Capability {
  return {
    id: "vibe-coder",
    name: "Vibe Coder",
    description: "Live app preview with console log capture for iterative web development.",

    tools: (context: AgentContext) => {
      const basePath = options.previewBasePath ?? `/preview/${context.agentId}/`;
      // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance requires cast when building heterogeneous arrays
      const tools: any[] = [
        createShowPreviewTool(options.provider, context, basePath),
        createHidePreviewTool(options.provider, context),
        createGetConsoleLogsTool(context),
      ];
      return tools;
    },

    commands: (context: AgentContext) => [
      defineCommand({
        name: "close_preview",
        description: "Close the live preview (triggered by the user via the UI close button).",
        execute: async (_args, ctx) => {
          // Verify this session owns the preview
          if (context.storage) {
            const preview = await context.storage.get<{ port: number; sessionId: string }>(
              "preview",
            );
            if (!preview || preview.sessionId !== ctx.sessionId) {
              return { text: "No active preview for this session." };
            }
          }

          // Clean up server-side state (same as hide_preview tool)
          if (options.provider.clearDevPort) {
            await options.provider.clearDevPort();
          }
          if (context.storage) {
            await context.storage.delete("preview");
          }

          // Broadcast to this session's clients
          context.broadcast("preview_close", {});

          // Append a session entry so the agent knows the user closed the preview
          ctx.sessionStore.appendEntry(ctx.sessionId, {
            type: "custom",
            data: {
              customType: "notification",
              role: "user",
              content: "[The user closed the live preview]",
            },
          });

          return { text: "Preview closed." };
        },
      }),
    ],

    promptSections: () => {
      const sections: string[] = [];

      if (options.backend) {
        // Fullstack app with Bun — one process, HMR, API + UI together
        sections.push(
          "You have live preview capabilities for fullstack web development using Bun.\n\n" +
            "Fullstack App Workflow:\n" +
            "1. Create a project directory and set up the files:\n" +
            "   - index.html — the HTML entry point with a <script> tag for your React app\n" +
            "   - app.tsx — your React frontend\n" +
            "   - server.ts — the Bun.serve() entry point\n" +
            "   - package.json with dependencies (react, react-dom)\n" +
            "2. bun install\n" +
            "3. Start the server (via exec with background=true): bun run server.ts\n" +
            "4. Call show_preview with the server port (default 3000)\n\n" +
            "Example server.ts:\n" +
            "```\n" +
            'import { Database } from "bun:sqlite";\n' +
            'import homepage from "./index.html";\n\n' +
            'const db = new Database("/mnt/r2/app.db");\n' +
            'db.run("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");\n\n' +
            "Bun.serve({\n" +
            '  hostname: "0.0.0.0",\n' +
            "  port: 3000,\n" +
            "  routes: {\n" +
            '    "/": homepage,\n' +
            '    "/api/items": {\n' +
            "      async GET() {\n" +
            '        const items = db.query("SELECT * FROM items").all();\n' +
            "        return Response.json(items);\n" +
            "      },\n" +
            "      async POST(req) {\n" +
            "        const { name } = await req.json();\n" +
            '        db.run("INSERT INTO items (name) VALUES (?)", [name]);\n' +
            "        return Response.json({ ok: true });\n" +
            "      },\n" +
            "    },\n" +
            "  },\n" +
            "  development: true,\n" +
            "});\n" +
            "```\n\n" +
            "Example index.html:\n" +
            "```\n" +
            "<!DOCTYPE html>\n" +
            '<html><head><title>My App</title></head>\n' +
            "<body>\n" +
            '  <div id="root"></div>\n' +
            '  <script type="module" src="./app.tsx"></script>\n' +
            "</body></html>\n" +
            "```\n\n" +
            "Key points:\n" +
            "- Bun handles bundling TypeScript/JSX, HMR, and serving — no build tools needed\n" +
            "- Import HTML files directly in server.ts — Bun bundles the referenced scripts/styles\n" +
            "- Use bun:sqlite for the database — it's built into Bun, zero dependencies\n" +
            "- Store the database file on /mnt/r2/ so it persists\n" +
            '- Set development: true for HMR and console output\n' +
            '- The server MUST bind to 0.0.0.0 or use the "host" option — use port 3000\n' +
            "- Frontend fetch calls use relative paths: fetch('/api/items')\n\n" +
            "Use get_console_logs to check for errors. Call hide_preview when done.",
        );
      } else {
        // Frontend-only app with Bun
        sections.push(
          "You have live preview capabilities for web development using Bun.\n\n" +
            "Frontend App Workflow:\n" +
            "1. Create a project directory with:\n" +
            "   - index.html — HTML entry point with <script> for your app\n" +
            "   - app.tsx — your React frontend\n" +
            "   - server.ts — simple Bun.serve() to host it\n" +
            "   - package.json with dependencies (react, react-dom)\n" +
            "2. bun install\n" +
            "3. Start the server (via exec with background=true): bun run server.ts\n" +
            "4. Call show_preview with the server port (default 3000)\n\n" +
            "Example server.ts:\n" +
            "```\n" +
            'import homepage from "./index.html";\n' +
            "Bun.serve({\n" +
            '  hostname: "0.0.0.0",\n' +
            "  port: 3000,\n" +
            '  routes: { "/": homepage },\n' +
            "  development: true,\n" +
            "});\n" +
            "```\n\n" +
            "Key points:\n" +
            "- Bun handles TypeScript/JSX bundling and HMR automatically\n" +
            "- Import HTML files directly — Bun bundles referenced scripts/styles\n" +
            '- Set development: true for HMR\n' +
            "- No Vite or build tools needed\n\n" +
            "Use get_console_logs to check for errors. Call hide_preview when done.",
        );
      }

      return sections;
    },

    hooks: {
      afterToolExecution: async (event, ctx) => {
        // When the sandbox de-elevates, close the preview if this session owns it
        if (event.toolName === "de_elevate") {
          const preview = await ctx.storage.get<{ port: number; sessionId: string }>("preview");
          if (preview && preview.sessionId === ctx.sessionId) {
            if (options.provider.clearDevPort) {
              await options.provider.clearDevPort();
            }
            await ctx.storage.delete("preview");
            ctx.broadcast?.("preview_close", {});
          }
        }
      },

      onConnect: async (ctx) => {
        const preview = await ctx.storage.get<{ port: number; sessionId: string }>("preview");

        if (!preview || preview.sessionId !== ctx.sessionId) {
          // This session doesn't own the preview — tell this client to close
          // but don't touch storage or provider (another session may own it)
          ctx.broadcast?.("preview_close", {});
          return;
        }

        // This session owns the preview — verify container and re-establish
        try {
          const health = await options.provider.health();
          if (!health.ready) {
            throw new Error("Container not ready");
          }

          if (options.provider.setDevPort) {
            const basePath = options.previewBasePath ?? `/preview/${ctx.agentId}/`;
            await options.provider.setDevPort(preview.port, basePath);
          }

          ctx.broadcast?.("preview_open", { port: preview.port });
        } catch {
          console.warn("[vibe-coder] Stale preview detected on connect — clearing");
          await ctx.storage.delete("preview");
          ctx.broadcast?.("preview_close", {});
        }
      },
    },
  };
}
