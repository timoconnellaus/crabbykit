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
 * Configures Vite's server settings for the sandbox preview proxy and injects
 * a `<base>` tag + console capture script so the browser resolves assets
 * through the preview proxy path.
 *
 * Important: We do NOT set Vite's `base` config because the container proxy
 * strips the preview prefix before forwarding to Vite. Vite must serve from
 * `/` (its default). Instead we inject a `<base href>` tag so the browser
 * resolves relative URLs through the preview path.
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

      // Don't set `base` — Vite must serve from "/" since the container proxy
      // strips the preview prefix. The <base> tag injected via transformIndexHtml
      // handles browser-side URL resolution.
      return {
        server: {
          host: true,
          port,
          strictPort: true,
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

      const tags: HtmlTagDescriptor[] = [
        // Inject <base> tag so browser resolves all relative URLs through the
        // preview proxy path (e.g., /preview/{agentId}/src/main.tsx)
        {
          tag: "base",
          attrs: { href: resolvedBase },
          injectTo: "head-prepend",
        },
      ];

      if (options?.consoleCapture !== false) {
        tags.push({
          tag: "script",
          children: CONSOLE_CAPTURE_SCRIPT,
          injectTo: "head-prepend",
        });
      }

      return tags;
    },
  };
}
