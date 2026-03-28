import { Container } from "@cloudflare/containers";

/**
 * Durable Object that manages a sandbox container lifecycle.
 * Consumers export this class from their worker and reference it
 * in wrangler.jsonc under both `durable_objects` and `containers`.
 *
 * The container image runs the sandbox HTTP server on port 8080.
 * CloudflareSandboxProvider proxies requests through this DO.
 *
 * @example
 * ```ts
 * // worker.ts
 * export { SandboxContainer } from "@claw-for-cloudflare/cloudflare-sandbox";
 * ```
 */
export class SandboxContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "2h";
  enableInternet = true;
}
