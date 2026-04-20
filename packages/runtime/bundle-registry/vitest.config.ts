import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		globals: true,
		include: ["src/**/*.test.ts"],
		poolOptions: {
			workers: {
				wrangler: {
					configPath: "./wrangler.test.jsonc",
				},
			},
		},
		coverage: {
			// workerd lacks node:inspector, so the default v8 provider throws
			// on load. istanbul is the supported provider for pool-workers.
			provider: "istanbul",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.ts", "src/index.ts"],
		},
	},
});
