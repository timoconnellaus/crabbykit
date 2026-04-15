import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: false,
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
				branches: 90,
				functions: 100,
				lines: 95,
			},
		},
	},
});
