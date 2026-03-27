import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
    exclude: [
      "test/fixtures/generate-fixtures.test.ts",
      "**/node_modules/**",
    ],
    poolOptions: {
      workers: {
        wrangler: {
          configPath: "./wrangler.test.jsonc",
        },
      },
    },
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/index.ts",
        "src/client/index.ts",
        "src/compaction/index.ts",
        "src/client/use-agent-chat.ts", // React hook tested separately
        "src/client/types.ts", // Pure type exports
        "src/test-helpers/**", // Test infrastructure
        "src/transport/types.ts", // Pure type exports
        "src/session/types.ts", // Pure type exports
        "src/compaction/types.ts", // Pure type exports
        "src/mcp/types.ts", // Pure type exports
        "src/capabilities/types.ts", // Pure type exports
        "src/capabilities/index.ts", // Barrel export
        "src/agent-do.ts", // Integration - tested via DO integration tests
        "src/mcp/mcp-manager.ts", // Protocol code needs live MCP servers - tested via integration
      ],
      thresholds: {
        statements: 98,
        branches: 90,
        functions: 100,
        lines: 99,
      },
    },
  },
});
