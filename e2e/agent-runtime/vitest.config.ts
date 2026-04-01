import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    exclude: ["test/dev/**"],
    poolOptions: {
      workers: {
        isolatedStorage: false,
        wrangler: {
          configPath: "./wrangler.jsonc",
        },
      },
    },
  },
});
