import { describe, expect, it } from "vitest";
import {
  INTERRUPTED_STATES,
  isDataPart,
  isFilePart,
  isInterruptedState,
  isJsonRpcError,
  isTerminalState,
  isTextPart,
  TERMINAL_STATES,
} from "../types.js";

describe("Part type guards", () => {
  it("identifies TextPart", () => {
    expect(isTextPart({ text: "hello" })).toBe(true);
    expect(isTextPart({ file: { name: "a.txt" } })).toBe(false);
    expect(isTextPart({ data: { key: "val" } })).toBe(false);
  });

  it("identifies FilePart", () => {
    expect(isFilePart({ file: { name: "a.txt" } })).toBe(true);
    expect(isFilePart({ text: "hello" })).toBe(false);
  });

  it("identifies DataPart", () => {
    expect(isDataPart({ data: { key: "val" } })).toBe(true);
    expect(isDataPart({ text: "hello" })).toBe(false);
    // An object with both text and data should not be DataPart
    expect(isDataPart({ text: "hello", data: { key: "val" } })).toBe(false);
  });
});

describe("TaskState helpers", () => {
  it("identifies terminal states", () => {
    expect(isTerminalState("completed")).toBe(true);
    expect(isTerminalState("failed")).toBe(true);
    expect(isTerminalState("canceled")).toBe(true);
    expect(isTerminalState("rejected")).toBe(true);
    expect(isTerminalState("working")).toBe(false);
    expect(isTerminalState("submitted")).toBe(false);
    expect(isTerminalState("input-required")).toBe(false);
  });

  it("identifies interrupted states", () => {
    expect(isInterruptedState("input-required")).toBe(true);
    expect(isInterruptedState("auth-required")).toBe(true);
    expect(isInterruptedState("working")).toBe(false);
    expect(isInterruptedState("completed")).toBe(false);
  });

  it("has correct terminal state set", () => {
    expect(TERMINAL_STATES.size).toBe(4);
  });

  it("has correct interrupted state set", () => {
    expect(INTERRUPTED_STATES.size).toBe(2);
  });
});

describe("JSON-RPC helpers", () => {
  it("identifies error responses", () => {
    const error = {
      jsonrpc: "2.0" as const,
      id: 1,
      error: { code: -32001, message: "Task not found" },
    };
    expect(isJsonRpcError(error)).toBe(true);
  });

  it("identifies success responses", () => {
    const success = {
      jsonrpc: "2.0" as const,
      id: 1,
      result: { id: "task-1" },
    };
    expect(isJsonRpcError(success)).toBe(false);
  });
});
