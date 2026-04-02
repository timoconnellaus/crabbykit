/**
 * Tests for the claw-bun-plugin Bun resolver.
 *
 * Verifies that the plugin intercepts @claw-for-cloudflare/* imports
 * and maps them to /usr/local/lib/claw-<pkg>/index.ts.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The plugin registers with Bun's native plugin() API which isn't available
 * in vitest. Instead, we extract and test the resolution logic directly.
 */

const CLAW_LIB = "/usr/local/lib";

/** Mirrors the onResolve callback from claw-bun-plugin.ts */
function resolveClawImport(importPath: string): string | null {
	const match = importPath.match(/^@claw-for-cloudflare\/(.+)$/);
	if (!match) return null;
	return `${CLAW_LIB}/claw-${match[1]}/index.ts`;
}

describe("claw-bun-plugin resolution", () => {
	it("resolves @claw-for-cloudflare/container-db", () => {
		expect(resolveClawImport("@claw-for-cloudflare/container-db")).toBe(
			"/usr/local/lib/claw-container-db/index.ts",
		);
	});

	it("resolves @claw-for-cloudflare/vite-plugin", () => {
		expect(resolveClawImport("@claw-for-cloudflare/vite-plugin")).toBe(
			"/usr/local/lib/claw-vite-plugin/index.ts",
		);
	});

	it("does not resolve non-claw packages", () => {
		expect(resolveClawImport("react")).toBeNull();
		expect(resolveClawImport("@other/package")).toBeNull();
	});

	it("handles arbitrary package names", () => {
		expect(resolveClawImport("@claw-for-cloudflare/some-future-pkg")).toBe(
			"/usr/local/lib/claw-some-future-pkg/index.ts",
		);
	});
});

describe("claw-container-db source copy", () => {
	it("container copy matches source package", async () => {
		const containerCopy = await Bun.file(
			path.resolve(__dirname, "..", "claw-container-db", "index.ts"),
		).text();
		const sourceFile = await Bun.file(
			path.resolve(__dirname, "..", "..", "..", "container-db", "src", "index.ts"),
		).text();

		expect(containerCopy).toBe(sourceFile);
	});
});
