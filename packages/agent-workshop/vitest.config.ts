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
    // worker-bundler ships an embedded esbuild.wasm; vite-node tries to
    // transform the .wasm path as a JS module and fails with "Cannot
    // find package 'gojs'". Force vitest to load it via native import so
    // its internal wasm+esm glue resolves correctly.
    server: {
      deps: {
        external: [/@cloudflare\/worker-bundler/],
      },
    },
  },
});
