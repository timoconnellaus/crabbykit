import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": path.resolve(__dirname, "src/__tests__/cf-stub.ts"),
      "cloudflare:sockets": path.resolve(__dirname, "src/__tests__/cf-stub.ts"),
    },
  },
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
  },
});
