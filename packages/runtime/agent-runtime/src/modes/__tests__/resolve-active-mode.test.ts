import { describe, expect, it } from "vitest";
import { SessionStore } from "../../session/session-store.js";
import { createMockSqlStore } from "../../test-helpers/mock-sql-storage.js";
import type { Mode } from "../define-mode.js";
import { resolveActiveMode } from "../resolve-active-mode.js";

const planMode: Mode = { id: "plan", name: "Planning", description: "p" };
const researchMode: Mode = { id: "research", name: "Research", description: "r" };
const modes = [planMode, researchMode];

function freshStore(): SessionStore {
  return new SessionStore(createMockSqlStore());
}

describe("resolveActiveMode", () => {
  it("returns null for an empty session", () => {
    const store = freshStore();
    const session = store.create();
    expect(resolveActiveMode(store, session.id, modes)).toBeNull();
  });

  it("returns the mode for the most recent enter entry", () => {
    const store = freshStore();
    const session = store.create();
    store.appendEntry(session.id, { type: "mode_change", data: { enter: "plan" } });
    expect(resolveActiveMode(store, session.id, modes)).toBe(planMode);
  });

  it("returns null after an exit entry", () => {
    const store = freshStore();
    const session = store.create();
    store.appendEntry(session.id, { type: "mode_change", data: { enter: "plan" } });
    store.appendEntry(session.id, { type: "mode_change", data: { exit: "plan" } });
    expect(resolveActiveMode(store, session.id, modes)).toBeNull();
  });

  it("returns null when the most recent change references an unknown id", () => {
    const store = freshStore();
    const session = store.create();
    store.appendEntry(session.id, { type: "mode_change", data: { enter: "ghost" } });
    expect(resolveActiveMode(store, session.id, modes)).toBeNull();
  });

  it("walks parent chain across messages and other entries", () => {
    const store = freshStore();
    const session = store.create();
    store.appendEntry(session.id, { type: "mode_change", data: { enter: "research" } });
    store.appendEntry(session.id, {
      type: "message",
      data: { role: "user", content: "hi" },
    });
    store.appendEntry(session.id, {
      type: "message",
      data: { role: "assistant", content: "hello" },
    });
    expect(resolveActiveMode(store, session.id, modes)).toBe(researchMode);
  });
});
