/**
 * Global Bun plugin that resolves @claw-for-cloudflare/* packages
 * to pre-installed copies in the container. Preloaded via ~/.bunfig.toml
 * so apps can `import { createDB } from "@claw-for-cloudflare/container-db"`
 * without running `bun install` for claw packages.
 */
import { plugin } from "bun";

const CLAW_LIB = "/usr/local/lib";

plugin({
	name: "claw-for-cloudflare",
	setup(build) {
		build.onResolve(
			{ filter: /^@claw-for-cloudflare\// },
			(args) => {
				// @claw-for-cloudflare/container-db -> /usr/local/lib/claw-container-db/index.ts
				const pkg = args.path.replace("@claw-for-cloudflare/", "");
				return { path: `${CLAW_LIB}/claw-${pkg}/index.ts` };
			},
		);
	},
});
