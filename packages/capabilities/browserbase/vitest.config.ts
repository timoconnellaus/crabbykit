import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    alias: {
      "cloudflare:workers": new URL("./src/__tests__/mocks/cloudflare-workers.ts", import.meta.url)
        .pathname,
    },
  },
});
