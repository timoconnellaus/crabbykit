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
	},
});
