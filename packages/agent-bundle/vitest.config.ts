import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		include: ["src/**/*.test.ts"],
	},
	resolve: {
		alias: {
			"cloudflare:workers": resolve(
				__dirname,
				"src/host/__tests__/__stubs__/cloudflare-workers.ts",
			),
		},
	},
});
