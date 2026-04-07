import { describe, expect, it } from "vitest";
import type { AgentContext, PromptScheduleConfig } from "@claw-for-cloudflare/agent-runtime";
import { heartbeat } from "../capability.js";

// Heartbeat ignores context — a dummy value satisfies the type signature.
const ctx = {} as AgentContext;

/** Helper to get the single prompt schedule from the capability. */
function getSchedule(cap: ReturnType<typeof heartbeat>): PromptScheduleConfig {
  const schedules = cap.schedules!(ctx);
  expect(schedules).toHaveLength(1);
  return schedules[0] as PromptScheduleConfig;
}

describe("heartbeat capability", () => {
  describe("metadata", () => {
    it("returns correct id, name, and description", () => {
      const cap = heartbeat({ every: "30m" });
      expect(cap.id).toBe("heartbeat");
      expect(cap.name).toBe("Heartbeat");
      expect(cap.description).toBe("Recurring autonomous check-ins on a configurable schedule.");
    });
  });

  describe("schedules()", () => {
    it("returns a single schedule with the given cron expression", () => {
      const s = getSchedule(heartbeat({ every: "*/30 * * * *" }));
      expect(s.cron).toBe("*/30 * * * *");
    });

    it("uses interval shorthand as cron value", () => {
      const s = getSchedule(heartbeat({ every: "2h" }));
      expect(s.cron).toBe("2h");
    });

    it("defaults enabled to false", () => {
      const s = getSchedule(heartbeat({ every: "1h" }));
      expect(s.enabled).toBe(false);
    });

    it("respects enabled: true", () => {
      const s = getSchedule(heartbeat({ every: "1h", enabled: true }));
      expect(s.enabled).toBe(true);
    });

    it("uses default prompt when none provided", () => {
      const s = getSchedule(heartbeat({ every: "1h" }));
      expect(s.prompt).toContain("Read HEARTBEAT.md");
      expect(s.prompt).toContain("HEARTBEAT_OK");
    });

    it("uses custom prompt when provided", () => {
      const s = getSchedule(heartbeat({ every: "1h", prompt: "Check the metrics." }));
      expect(s.prompt).toBe("Check the metrics.");
    });

    it("defaults sessionPrefix to 'Heartbeat'", () => {
      const s = getSchedule(heartbeat({ every: "1h" }));
      expect(s.sessionPrefix).toBe("Heartbeat");
    });

    it("uses custom sessionPrefix", () => {
      const s = getSchedule(heartbeat({ every: "1h", sessionPrefix: "Monitor" }));
      expect(s.sessionPrefix).toBe("Monitor");
    });

    it("defaults retention to 50", () => {
      const s = getSchedule(heartbeat({ every: "1h" }));
      expect(s.retention).toBe(50);
    });

    it("uses custom retention", () => {
      const s = getSchedule(heartbeat({ every: "1h", retention: 10 }));
      expect(s.retention).toBe(10);
    });

    it("passes timezone through", () => {
      const s = getSchedule(heartbeat({ every: "1h", timezone: "America/New_York" }));
      expect(s.timezone).toBe("America/New_York");
    });

    it("leaves timezone undefined when not set", () => {
      const s = getSchedule(heartbeat({ every: "1h" }));
      expect(s.timezone).toBeUndefined();
    });

    it("schedule id and name are 'heartbeat' / 'Heartbeat'", () => {
      const s = getSchedule(heartbeat({ every: "1h" }));
      expect(s.id).toBe("heartbeat");
      expect(s.name).toBe("Heartbeat");
    });

    it("applies all options together", () => {
      const s = getSchedule(
        heartbeat({
          every: "0 */6 * * *",
          timezone: "Europe/London",
          sessionPrefix: "Cron",
          retention: 5,
          prompt: "Custom check",
          enabled: true,
        }),
      );
      expect(s).toMatchObject({
        id: "heartbeat",
        name: "Heartbeat",
        cron: "0 */6 * * *",
        enabled: true,
        prompt: "Custom check",
        timezone: "Europe/London",
        sessionPrefix: "Cron",
        retention: 5,
      });
    });
  });

  describe("promptSections()", () => {
    it("returns a single prompt section", () => {
      const sections = heartbeat({ every: "1h" }).promptSections!(ctx);
      expect(sections).toHaveLength(1);
    });

    it("mentions HEARTBEAT.md", () => {
      const section = heartbeat({ every: "1h" }).promptSections!(ctx)[0];
      expect(section).toContain("HEARTBEAT.md");
    });

    it("mentions HEARTBEAT_OK", () => {
      const section = heartbeat({ every: "1h" }).promptSections!(ctx)[0];
      expect(section).toContain("HEARTBEAT_OK");
    });

    it("instructs not to repeat completed tasks", () => {
      const section = heartbeat({ every: "1h" }).promptSections!(ctx)[0];
      expect(section).toContain("Do not repeat tasks");
    });
  });

  describe("absent optional members", () => {
    it("does not define tools", () => {
      const cap = heartbeat({ every: "1h" });
      expect(cap.tools).toBeUndefined();
    });

    it("does not define hooks", () => {
      const cap = heartbeat({ every: "1h" });
      expect(cap.hooks).toBeUndefined();
    });
  });
});
