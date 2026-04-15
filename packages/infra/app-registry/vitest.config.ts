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
        "src/**/__tests__/**",
        "src/index.ts",
        "src/app-server.ts",  // Worker-level serving (requires R2/WorkerLoader integration)
        "src/tools/deploy-app.ts",  // Heavy sandbox integration (git, filesystem, bundler)
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
