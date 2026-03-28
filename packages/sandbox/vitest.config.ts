import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
  },
  resolve: {
    alias: {
      // Stub cloudflare:workers for unit tests (not using actual Workers runtime)
      "cloudflare:workers": new URL("./src/__tests__/stubs/cloudflare-workers.ts", import.meta.url)
        .pathname,
    },
  },
});
