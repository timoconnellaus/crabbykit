import { defineConfig } from "vitest/config";

// Channel-telegram tests are pure unit tests — no Durable Objects, no
// bindings, no cloudflare:workers APIs at runtime. We run under the node
// environment and alias `cloudflare:workers` to a no-op mock so that the
// (transitive) `@claw-for-cloudflare/agent-runtime` barrel import resolves.
// This mirrors the pattern used by `packages/browserbase`.
export default defineConfig({
  test: {
    environment: "node",
    alias: {
      "cloudflare:workers": new URL(
        "./src/__tests__/mocks/cloudflare-workers.ts",
        import.meta.url,
      ).pathname,
    },
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/__tests__/**", "src/index.ts"],
      thresholds: {
        statements: 95,
        branches: 85,
        functions: 100,
        lines: 95,
      },
    },
  },
});
