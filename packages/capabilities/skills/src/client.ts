/**
 * Bundle-side skills capability — thin RPC proxy to SkillsService.
 *
 * Reads the unified per-turn capability token from `env.__BUNDLE_TOKEN`
 * whose `scope` array includes `"skills"`. SkillsService verifies the
 * token with `requiredScope: "skills"`. No credentials held here, no
 * business logic beyond RPC marshaling.
 *
 * This client registers ONLY the `skill_load` tool. Lifecycle hooks,
 * `promptSections`, `httpHandlers`, `configNamespaces`, and `onAction`
 * remain on the static `skills(...)` capability host-side and fire against
 * bundle-originated events via the Phase 0 host-hook bridge.
 */

import type { Capability } from "@crabbykit/agent-runtime";
import { defineTool } from "@crabbykit/agent-runtime";
import {
  SCHEMA_CONTENT_HASH,
  SKILL_LOAD_TOOL_DESCRIPTION,
  SKILL_LOAD_TOOL_NAME,
  SkillLoadArgsSchema,
} from "./schemas.js";
import type { SkillsService } from "./service.js";

export interface SkillsClientOptions {
  service: Service<SkillsService>;
}

/**
 * Create a bundle-side skills capability that proxies `skill_load` to
 * SkillsService.
 */
export function skillsClient(options: SkillsClientOptions): Capability {
  return {
    id: "skills",
    name: "Skills (Bundle Client)",
    description:
      "On-demand procedural knowledge loaded by the agent when relevant (proxied through service binding)",

    tools: (context) => {
      const env = (context as unknown as { env: { __BUNDLE_TOKEN?: string } }).env;

      return [
        defineTool({
          name: SKILL_LOAD_TOOL_NAME,
          description: SKILL_LOAD_TOOL_DESCRIPTION,
          parameters: SkillLoadArgsSchema,
          execute: async (args) => {
            const token = env?.__BUNDLE_TOKEN;
            if (!token) throw new Error("Missing __BUNDLE_TOKEN");

            const result = await options.service.load(
              token,
              { name: args.name },
              SCHEMA_CONTENT_HASH,
            );

            return result.content;
          },
        }),
      ];
    },
  };
}
