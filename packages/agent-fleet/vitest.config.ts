import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		globals: true,
		poolOptions: {
			workers: {
				wrangler: {
					configPath: "./wrangler.test.jsonc",
				},
			},
		},
		coverage: {
			provider: "istanbul",
			include: ["src/**/*.ts"],
			exclude: [
				"src/**/*.test.ts",
				"src/**/__tests__/**",
				"src/index.ts",
				"src/types.ts",
			],
			thresholds: {
				statements: 95,
				branches: 95,
				functions: 95,
				lines: 95,
			},
		},
	},
});
