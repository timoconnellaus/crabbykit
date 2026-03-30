import { describe, expect, it } from "vitest";
import { r2Storage } from "../capability.js";
import { createMockR2Bucket } from "./mock-r2.js";

function mockStorage(bucket?: R2Bucket) {
  return {
    bucket: () => bucket ?? createMockR2Bucket(),
    namespace: () => "test",
  };
}

describe("r2Storage", () => {
  it("returns a valid Capability with correct shape", () => {
    const cap = r2Storage({ storage: mockStorage() });

    expect(cap.id).toBe("r2-storage");
    expect(cap.name).toBe("R2 File Storage");
    expect(cap.description).toBeTruthy();
    expect(cap.tools).toBeInstanceOf(Function);
    expect(cap.promptSections).toBeInstanceOf(Function);
  });

  it("provides seven file tools", () => {
    const cap = r2Storage({ storage: mockStorage() });

    const context = {
      sessionId: "s1",
      stepNumber: 0,
      emitCost: () => {},
      broadcast: () => {},
      broadcastToAll: () => {},
      requestFromClient: () => Promise.reject(new Error("Not available")),
      schedules: {} as any,
    };
    const tools = cap.tools!(context);

    expect(tools).toHaveLength(9);
    const names = tools.map((t) => t.name);
    expect(names).toContain("file_read");
    expect(names).toContain("file_write");
    expect(names).toContain("file_edit");
    expect(names).toContain("file_delete");
    expect(names).toContain("file_copy");
    expect(names).toContain("file_move");
    expect(names).toContain("file_list");
    expect(names).toContain("file_tree");
    expect(names).toContain("file_find");
  });

  it("returns prompt sections", () => {
    const cap = r2Storage({ storage: mockStorage() });

    const sections = cap.promptSections!({
      sessionId: "s1",
      stepNumber: 0,
      emitCost: () => {},
      broadcast: () => {},
      broadcastToAll: () => {},
      requestFromClient: () => Promise.reject(new Error("Not available")),
      schedules: {} as any,
    });
    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain("file storage");
  });

  it("has no lifecycle hooks", () => {
    const cap = r2Storage({ storage: mockStorage() });
    expect(cap.hooks).toBeUndefined();
  });
});
