import type { AgentMessage, AgentTool } from "@claw-for-cloudflare/agent-core";
import {
  type AgentContext,
  type Capability,
  type CapabilityStorage,
  type ConfigNamespace,
  defineTool,
  toolResult,
} from "@claw-for-cloudflare/agent-runtime";
import { Type } from "@sinclair/typebox";
import {
  deleteSkillFromR2,
  hashSkillContent,
  readSkillFromR2,
  skillIdFromR2Path,
  writeSkillToR2,
} from "./r2.js";
import {
  clearPendingMerge,
  deleteInstalledSkill,
  getInstalledSkill,
  getPendingMerges,
  listInstalledSkills,
  putInstalledSkill,
} from "./storage.js";
import { syncSkills } from "./sync.js";
import type { InstalledSkill, SkillsOptions } from "./types.js";

/** Strip YAML frontmatter from SKILL.md content. */
function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return match ? match[1] : content;
}

/** Build the skill list array for transport messages. */
function buildSkillList(skills: Map<string, InstalledSkill>) {
  const list: Array<{
    id: string;
    name: string;
    description: string;
    version: string;
    enabled: boolean;
    autoUpdate: boolean;
    stale: boolean;
    builtIn?: boolean;
  }> = [];

  for (const [key, skill] of skills) {
    const id = key.startsWith("installed:") ? key.slice("installed:".length) : key;
    list.push({
      id,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      enabled: skill.enabled,
      autoUpdate: skill.autoUpdate,
      stale: skill.stale,
      builtIn: skill.builtIn,
    });
  }
  return list;
}

/** Extract skill ID from storage key. */
function storageKeyToId(key: string): string {
  return key.startsWith("installed:") ? key.slice("installed:".length) : key;
}

function createSkillLoadTool(
  agentStorage: SkillsOptions["storage"],
  cachedSkills: Map<string, InstalledSkill> | null,
  context: AgentContext,
// biome-ignore lint/suspicious/noExplicitAny: AgentTool generic contravariance requires widening at the defineTool boundary
): AgentTool<any> {
  return defineTool({
    name: "skill_load",
    description:
      "Load a skill's instructions into context. Use when the skill's description matches your current task.",
    guidance:
      "Load a skill's procedural instructions into context. Use this when a skill's description matches your current task — the loaded content provides step-by-step guidance for that specific workflow.",
    parameters: Type.Object({
      name: Type.String({ description: "The skill ID to load" }),
    }),
    execute: async (args) => {
      const skillRecord = cachedSkills
        ? findSkillById(cachedSkills, args.name)
        : await getInstalledSkill(context.storage!, args.name);

      if (!skillRecord) {
        return toolResult.text(`Skill '${args.name}' not found`);
      }
      if (!skillRecord.enabled) {
        return toolResult.text(`Skill '${args.name}' is not enabled`);
      }

      const bucket = agentStorage.bucket();
      const namespace = agentStorage.namespace();
      const content = await readSkillFromR2(bucket, namespace, args.name);

      if (!content) {
        return toolResult.text(`Skill '${args.name}' content not found in storage`);
      }

      return toolResult.text(stripFrontmatter(content));
    },
  });
}

export function skills(options: SkillsOptions): Capability {
  const { storage: agentStorage, registry, skills: declarations } = options;

  // Cache for installed skills, populated on connect, used by promptSections
  let cachedSkills: Map<string, InstalledSkill> | null = null;

  async function refreshCache(capStorage: CapabilityStorage): Promise<Map<string, InstalledSkill>> {
    cachedSkills = await listInstalledSkills(capStorage);
    return cachedSkills;
  }

  return {
    id: "skills",
    name: "Skills",
    description: "On-demand procedural knowledge loaded by the agent when relevant",

    tools: (context) => [
      createSkillLoadTool(agentStorage, cachedSkills, context),
    ],

    promptSections: () => {
      if (!cachedSkills) return [];

      const enabledSkills: Array<{ id: string; name: string; description: string }> = [];
      for (const [key, skill] of cachedSkills) {
        if (!skill.enabled) continue;
        const id = key.startsWith("installed:") ? key.slice("installed:".length) : key;
        enabledSkills.push({ id, name: skill.name, description: skill.description });
      }

      if (enabledSkills.length === 0) return [];

      const lines = [
        "## Available Skills",
        "",
        "Load a skill with the `skill_load` tool when its description matches your current task.",
        "",
      ];

      for (const skill of enabledSkills) {
        lines.push(`- **${skill.id}**: ${skill.description}`);
      }

      return [lines.join("\n")];
    },

    hooks: {
      onConnect: async (ctx) => {
        const capStorage = ctx.storage;
        const bucket = agentStorage.bucket();
        const namespace = agentStorage.namespace();

        // Use capability IDs from the hook context for dependency validation.
        // The runtime populates this with all registered capability IDs.
        const capabilityIds = ctx.capabilityIds;

        try {
          await syncSkills({
            storage: capStorage,
            registry,
            bucket,
            namespace,
            declarations,
            capabilityIds,
          });
        } catch (err) {
          console.warn(
            "[skills] Sync failed:",
            err instanceof Error ? err.message : String(err),
          );
        }

        const installed = await refreshCache(capStorage);
        const skillList = buildSkillList(installed);

        ctx.broadcast?.("skill_list_update", { skills: skillList });
      },

      beforeInference: async (messages, ctx) => {
        const merges = await getPendingMerges(ctx.storage);
        if (merges.size === 0) return messages;

        const injections: AgentMessage[] = [];

        for (const [key, merge] of merges) {
          const skillId = key.startsWith("merge:") ? key.slice("merge:".length) : key;
          injections.push({
            role: "user",
            content: [
              `[SKILL UPDATE] The skill "${skillId}" has a new version (${merge.newVersion}) available.`,
              "Your current version has been customized. Please merge the changes:",
              "",
              "Load your current version with: skill_load({ name: \"" + skillId + "\" })",
              "",
              "NEW VERSION (upstream):",
              "```",
              merge.newContent,
              "```",
              "",
              `Write the merged result to skills/${skillId}/SKILL.md using file_write, preserving your customizations while incorporating the upstream changes.`,
            ].join("\n"),
            timestamp: Date.now(),
            metadata: { hidden: true },
          } as AgentMessage);
        }

        return [...injections, ...messages];
      },

      afterToolExecution: async (event, ctx) => {
        if (event.toolName !== "file_write") return;

        const args = event.args as Record<string, unknown> | undefined;
        const path = typeof args?.path === "string" ? args.path : undefined;
        if (!path) return;

        const skillId = skillIdFromR2Path(path);
        if (!skillId) return;

        // Check if there's a pending merge for this skill
        const merges = await getPendingMerges(ctx.storage);
        const mergeKey = `merge:${skillId}`;
        const merge = merges.get(mergeKey);
        if (!merge) return;

        // Merge completed — update originalHash and clear pending merge
        const bucket = agentStorage.bucket();
        const namespace = agentStorage.namespace();
        const newContent = await readSkillFromR2(bucket, namespace, skillId);
        if (!newContent) return;

        const newHash = await hashSkillContent(newContent);
        const existing = await getInstalledSkill(ctx.storage, skillId);
        if (existing) {
          await putInstalledSkill(ctx.storage, skillId, {
            ...existing,
            version: merge.newVersion,
            originalHash: newHash,
            stale: false,
          });
        }

        await clearPendingMerge(ctx.storage, skillId);
        cachedSkills = await listInstalledSkills(ctx.storage);
      },

      onConfigChange: async (_oldConfig, newConfig, ctx) => {
        const skillConfigs = newConfig.skills as
          | Array<{ id: string; enabled?: boolean; autoUpdate?: boolean }>
          | undefined;
        if (!skillConfigs) return;

        const bucket = agentStorage.bucket();
        const namespace = agentStorage.namespace();

        for (const config of skillConfigs) {
          const existing = await getInstalledSkill(ctx.storage, config.id);
          if (!existing) continue;

          const enabled = config.enabled ?? existing.enabled;
          const autoUpdate = config.autoUpdate ?? existing.autoUpdate;

          if (enabled && !existing.enabled) {
            // Enabling — write to R2
            const registryRecord = await registry.get(config.id);
            if (registryRecord) {
              await writeSkillToR2(bucket, namespace, config.id, registryRecord.skillMd);
            }
          } else if (!enabled && existing.enabled) {
            // Disabling — delete from R2
            await deleteSkillFromR2(bucket, namespace, config.id);
          }

          await putInstalledSkill(ctx.storage, config.id, {
            ...existing,
            enabled,
            autoUpdate,
            r2Key: enabled ? `skills/${config.id}/SKILL.md` : undefined,
          });
        }

        cachedSkills = await listInstalledSkills(ctx.storage);
        const skillList = buildSkillList(cachedSkills);
        ctx.broadcast?.("skill_list_update", { skills: skillList });
      },
    },

    httpHandlers: (context) => [
      {
        method: "GET" as const,
        path: "/skills/registry",
        handler: async (_request: Request, ctx) => {
          try {
            const allRegistry = await registry.list();
            const installed = cachedSkills ?? await listInstalledSkills(ctx.storage);
            const installedIds = new Set<string>();
            for (const key of installed.keys()) {
              installedIds.add(storageKeyToId(key));
            }
            const available = allRegistry
              .filter((r) => !installedIds.has(r.id))
              .map((r) => ({
                id: r.id,
                name: r.name,
                description: r.description,
                version: r.version,
                requiresCapabilities: r.requiresCapabilities,
              }));
            return new Response(JSON.stringify(available), {
              headers: { "content-type": "application/json" },
            });
          } catch (err) {
            return new Response(
              JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
              { status: 500, headers: { "content-type": "application/json" } },
            );
          }
        },
      },
      {
        method: "POST" as const,
        path: "/skills/install",
        handler: async (request: Request, ctx) => {
          try {
            const body = (await request.json()) as { id: string; enabled?: boolean; autoUpdate?: boolean };
            if (!body.id) {
              return new Response(JSON.stringify({ error: "Missing skill id" }), {
                status: 400,
                headers: { "content-type": "application/json" },
              });
            }

            const existing = await getInstalledSkill(ctx.storage, body.id);
            if (existing) {
              return new Response(JSON.stringify({ error: "Skill already installed" }), {
                status: 409,
                headers: { "content-type": "application/json" },
              });
            }

            const registryRecord = await registry.get(body.id);
            if (!registryRecord) {
              return new Response(JSON.stringify({ error: "Skill not found in registry" }), {
                status: 404,
                headers: { "content-type": "application/json" },
              });
            }

            const enabled = body.enabled ?? true;
            const autoUpdate = body.autoUpdate ?? true;
            const bucket = agentStorage.bucket();
            const namespace = agentStorage.namespace();

            const installed: InstalledSkill = {
              name: registryRecord.name,
              description: registryRecord.description,
              version: registryRecord.version,
              enabled,
              autoUpdate,
              stale: false,
              originalHash: registryRecord.contentHash,
              requiresCapabilities: registryRecord.requiresCapabilities,
              builtIn: false,
            };

            if (enabled) {
              await writeSkillToR2(bucket, namespace, body.id, registryRecord.skillMd);
              installed.r2Key = `skills/${body.id}/SKILL.md`;
            }

            await putInstalledSkill(ctx.storage, body.id, installed);
            cachedSkills = await listInstalledSkills(ctx.storage);
            const skillList = buildSkillList(cachedSkills);
            ctx.broadcastToAll("skill_list_update", { skills: skillList });

            return new Response(JSON.stringify({ ok: true, skill: { id: body.id, ...installed } }), {
              headers: { "content-type": "application/json" },
            });
          } catch (err) {
            return new Response(
              JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
              { status: 500, headers: { "content-type": "application/json" } },
            );
          }
        },
      },
      {
        method: "POST" as const,
        path: "/skills/uninstall",
        handler: async (request: Request, ctx) => {
          try {
            const body = (await request.json()) as { id: string };
            if (!body.id) {
              return new Response(JSON.stringify({ error: "Missing skill id" }), {
                status: 400,
                headers: { "content-type": "application/json" },
              });
            }

            const existing = await getInstalledSkill(ctx.storage, body.id);
            if (!existing) {
              return new Response(JSON.stringify({ error: "Skill not installed" }), {
                status: 404,
                headers: { "content-type": "application/json" },
              });
            }
            if (existing.builtIn) {
              return new Response(JSON.stringify({ error: "Cannot uninstall built-in skill" }), {
                status: 403,
                headers: { "content-type": "application/json" },
              });
            }

            // Remove from R2 if enabled
            if (existing.enabled && existing.r2Key) {
              const bucket = agentStorage.bucket();
              const namespace = agentStorage.namespace();
              await deleteSkillFromR2(bucket, namespace, body.id);
            }

            await deleteInstalledSkill(ctx.storage, body.id);
            cachedSkills = await listInstalledSkills(ctx.storage);
            const skillList = buildSkillList(cachedSkills);
            ctx.broadcastToAll("skill_list_update", { skills: skillList });

            return new Response(JSON.stringify({ ok: true }), {
              headers: { "content-type": "application/json" },
            });
          } catch (err) {
            return new Response(
              JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
              { status: 500, headers: { "content-type": "application/json" } },
            );
          }
        },
      },
    ],

    configNamespaces: (context: AgentContext): ConfigNamespace[] => [
      {
        id: "skills",
        description: "Manage installed skills — toggle enabled/autoUpdate per skill",
        schema: Type.Object({
          skills: Type.Array(
            Type.Object({
              id: Type.String(),
              enabled: Type.Optional(Type.Boolean()),
              autoUpdate: Type.Optional(Type.Boolean()),
            }),
          ),
        }),
        get: async () => {
          const installed = cachedSkills ?? await listInstalledSkills(context.storage!);
          const result: Array<{ id: string; enabled: boolean; autoUpdate: boolean }> = [];
          for (const [key, skill] of installed) {
            const id = key.startsWith("installed:") ? key.slice("installed:".length) : key;
            result.push({ id, enabled: skill.enabled, autoUpdate: skill.autoUpdate });
          }
          return { skills: result };
        },
        set: async (_namespace, value) => {
          // The actual state changes are handled by onConfigChange hook
          // This set function just needs to exist for the config system
          const cfg = value as { skills?: Array<{ id: string; enabled?: boolean; autoUpdate?: boolean }> };
          if (!cfg.skills) return;
          return `Updated ${cfg.skills.length} skill(s)`;
        },
      },
    ],
  };
}

function findSkillById(
  skills: Map<string, InstalledSkill>,
  id: string,
): InstalledSkill | undefined {
  // Keys are prefixed with "installed:" from storage.list
  return skills.get(`installed:${id}`) ?? skills.get(id);
}
