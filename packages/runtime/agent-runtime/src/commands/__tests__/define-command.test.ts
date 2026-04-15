import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { defineCommand } from "../define-command.js";

describe("defineCommand", () => {
  it("creates a command with name, description, and execute", () => {
    const cmd = defineCommand({
      name: "help",
      description: "Show available commands",
      execute: () => ({ text: "Commands: /help" }),
    });

    expect(cmd.name).toBe("help");
    expect(cmd.description).toBe("Show available commands");
    expect(cmd.parameters).toBeUndefined();
  });

  it("creates a command with TypeBox parameters", () => {
    const cmd = defineCommand({
      name: "search",
      description: "Search sessions",
      parameters: Type.Object({
        query: Type.String(),
      }),
      execute: (args) => ({ text: `Searching: ${args.query}` }),
    });

    expect(cmd.name).toBe("search");
    expect(cmd.parameters).toBeDefined();
    expect(cmd.parameters!.properties).toHaveProperty("query");
  });

  it("executes and returns a CommandResult", async () => {
    const cmd = defineCommand({
      name: "status",
      description: "Show status",
      execute: () => ({ text: "All systems go", data: { healthy: true } }),
    });

    const result = await cmd.execute(undefined as any, {
      sessionId: "s1",
      sessionStore: {} as any,
      schedules: {} as any,
    });

    expect(result.text).toBe("All systems go");
    expect(result.data).toEqual({ healthy: true });
  });

  it("executes async commands", async () => {
    const cmd = defineCommand({
      name: "async-cmd",
      description: "Async command",
      execute: async () => {
        return { text: "done" };
      },
    });

    const result = await cmd.execute(undefined as any, {
      sessionId: "s1",
      sessionStore: {} as any,
      schedules: {} as any,
    });

    expect(result.text).toBe("done");
  });
});
