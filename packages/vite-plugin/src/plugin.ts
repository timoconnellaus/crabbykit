import type { HtmlTagDescriptor, Plugin } from "vite";
import { CONSOLE_CAPTURE_SCRIPT } from "./console-script";

export interface ClawPluginOptions {
  /**
   * Override the preview base path.
   * Default: CLAW_PREVIEW_BASE env var, or `/preview/${AGENT_ID}/` if AGENT_ID is set.
   * When neither is available, the plugin is a no-op.
   */
  base?: string;

  /**
   * Port the Vite dev server should bind to.
   * Default: CLAW_PREVIEW_PORT env var, or 3000.
   */
  port?: number;

  /**
   * Whether to inject the console capture script into the HTML.
   * Default: true when running in the CLAW sandbox.
   */
  consoleCapture?: boolean;
}

/**
 * Vite plugin for CLAW for Cloudflare.
 *
 * Configures Vite's `base` and server settings for the sandbox preview proxy,
 * and injects a console capture script for the agent to read browser logs.
 *
 * Setting `base` to the preview path (e.g., `/preview/<agentId>/`) ensures Vite
 * emits prefixed absolute paths in transformed JS/HTML. The preview proxy
 * forwards the full path (including prefix) to Vite, which strips the base
 * on incoming requests and serves files from `/`.
 *
 * Outside the sandbox (no AGENT_ID env var), the plugin is a no-op —
 * local development works unchanged.
 */
export function clawForCloudflare(options?: ClawPluginOptions): Plugin {
  let active = false;
  let resolvedBase = "";

  return {
    name: "claw-for-cloudflare",

    config(_userConfig, { command }) {
      // Only activate in dev server mode, not during build
      if (command !== "serve") return;

      const base =
        options?.base ??
        process.env.CLAW_PREVIEW_BASE ??
        (process.env.AGENT_ID ? `/preview/${process.env.AGENT_ID}/` : null);

      if (!base) return; // Not in CLAW sandbox — no-op

      active = true;
      resolvedBase = base.endsWith("/") ? base : `${base}/`;

      const port = options?.port ?? (Number(process.env.CLAW_PREVIEW_PORT) || 3000);

      return {
        base: resolvedBase,
        server: {
          host: true,
          port,
          strictPort: true,
          watch: {
            // FUSE mounts (tigrisfs on /mnt/r2) don't support inotify.
            // Polling lets chokidar detect file changes for HMR.
            usePolling: true,
            interval: 500,
          },
        },
      };
    },

    configResolved(config) {
      if (active) {
        console.log(`[claw] Preview proxy base: ${resolvedBase}`);
        console.log(`[claw] Dev server: http://localhost:${config.server.port}`);
      }
    },

    transformIndexHtml() {
      if (!active) return [];

      if (options?.consoleCapture === false) return [];

      return [
        {
          tag: "script",
          children: CONSOLE_CAPTURE_SCRIPT,
          injectTo: "head-prepend",
        },
      ];
    },
  };
}
