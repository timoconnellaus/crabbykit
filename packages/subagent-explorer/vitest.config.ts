import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/**/*.test.ts", "src/__tests__/**"],
      thresholds: {
        statements: 95,
        branches: 85,
        functions: 100,
        lines: 95,
      },
    },
  },
});
