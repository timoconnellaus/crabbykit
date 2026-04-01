import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/dev/**/*.test.ts"],
    globalSetup: "./src/global-setup.ts",
    testTimeout: 60_000,
  },
});
