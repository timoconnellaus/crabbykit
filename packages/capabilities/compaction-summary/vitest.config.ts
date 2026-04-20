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
      exclude: [
        "src/**/*.test.ts",
        "src/index.ts", // Barrel export
      ],
      // Thresholds temporarily relaxed; tracked as tech debt.
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 100,
        lines: 95,
      },
    },
  },
});
