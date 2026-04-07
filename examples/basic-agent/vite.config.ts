import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart(),
    react(),
  ],
});
