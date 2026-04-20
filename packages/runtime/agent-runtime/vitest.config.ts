import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
    // Known noise: @cloudflare/vitest-pool-workers + miniflare 4.x
    // races on shutdown — a SynchronousFetcher.fetch retry fires
    // after the runtime has been torn down, surfacing as an
    // `AssertionError: false == true` with a stack rooted entirely in
    // miniflare/vitest-pool-workers (no line in our code). All tests
    // have already passed by the time this fires. Ignoring unhandled
    // errors lets the process exit cleanly. Revisit after upgrading
    // miniflare / vitest-pool-workers.
    dangerouslyIgnoreUnhandledErrors: true,
    exclude: [
      "test/fixtures/generate-fixtures.test.ts",
      "**/node_modules/**",
    ],
    poolOptions: {
      workers: {
        // Disabled because @cloudflare/vitest-pool-workers' isolated storage
        // frame checker doesn't handle .sqlite-shm/.sqlite-wal files created
        // by DO KV storage operations. Tests use unique DO names for isolation.
        isolatedStorage: false,
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
        "src/agent-runtime.ts", // Extracted runtime - tested via DO integration tests (unit backfill is tech debt)
        "src/runtime-delegating.ts", // Thin wiring helper - tested via integration
        "src/define-agent.ts", // Thin wiring helper - tested via integration
        "src/runtime-context-cloudflare.ts", // 3-line adapter - tested via AgentDO
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
