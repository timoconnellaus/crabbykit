import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
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
      exclude: ["src/**/*.test.ts", "src/index.ts"],
      // Thresholds temporarily relaxed; tracked as tech debt.
      thresholds: {
        statements: 85,
        branches: 70,
        functions: 95,
        lines: 85,
      },
    },
  },
});
