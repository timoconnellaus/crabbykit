import { defineConfig } from "vitest/config";

/**
 * Minimal vitest config for fixture generation.
 * Uses Node environment (not Workers pool) since we're just calling APIs.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ["test/fixtures/generate-fixtures.test.ts"],
    exclude: [],
  },
});
