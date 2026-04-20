import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { validateConfigNamespaces } from "../validate.js";

const ns = (id: string, extras?: Record<string, unknown>) => ({
  id,
  description: `desc ${id}`,
  schema: Type.Object({}),
  ...extras,
});

describe("validateConfigNamespaces", () => {
  it("accepts well-formed namespaces", () => {
    expect(() =>
      validateConfigNamespaces([ns("telegram-accounts"), ns("other")], [], []),
    ).not.toThrow();
  });

  for (const reserved of ["session", "agent-config", "schedules", "queue"]) {
    it(`rejects reserved token "${reserved}"`, () => {
      expect(() => validateConfigNamespaces([ns(reserved)], [], [])).toThrow(new RegExp(reserved));
    });
  }

  it("rejects pattern field", () => {
    expect(() =>
      validateConfigNamespaces([ns("prefix", { pattern: /^prefix:/ })], [], []),
    ).toThrow(/pattern.*deferred/);
  });

  it("rejects collision with agent-config namespace", () => {
    expect(() => validateConfigNamespaces([ns("botConfig")], ["botConfig"], [])).toThrow(
      /botConfig.*agent-config/,
    );
  });

  it("rejects collision with capability id", () => {
    expect(() => validateConfigNamespaces([ns("my-cap")], [], ["my-cap"])).toThrow(
      /my-cap.*capability/,
    );
  });

  it("rejects duplicate ids", () => {
    expect(() => validateConfigNamespaces([ns("x"), ns("x")], [], [])).toThrow(
      /"x".*declared twice/,
    );
  });

  it("rejects empty id", () => {
    expect(() => validateConfigNamespaces([ns("")], [], [])).toThrow(/non-empty string id/);
  });
});
