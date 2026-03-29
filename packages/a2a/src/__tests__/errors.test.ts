import { describe, expect, it } from "vitest";
import {
  httpStatusForError,
  internalError,
  invalidParamsError,
  methodNotFoundError,
  taskNotCancelableError,
  taskNotFoundError,
  versionNotSupportedError,
} from "../errors.js";

describe("Error factories", () => {
  it("creates taskNotFoundError with correct structure", () => {
    const err = taskNotFoundError(1, "task-abc");
    expect(err.jsonrpc).toBe("2.0");
    expect(err.id).toBe(1);
    expect(err.error.code).toBe(-32001);
    expect(err.error.message).toContain("task-abc");
    expect(err.error.data).toHaveLength(1);
    expect((err.error.data![0] as any).reason).toBe("TASK_NOT_FOUND");
    expect((err.error.data![0] as any).domain).toBe("a2a");
    expect((err.error.data![0] as any).metadata.taskId).toBe("task-abc");
  });

  it("creates taskNotCancelableError", () => {
    const err = taskNotCancelableError("req-1", "task-xyz");
    expect(err.error.code).toBe(-32002);
    expect((err.error.data![0] as any).reason).toBe("TASK_NOT_CANCELABLE");
  });

  it("creates versionNotSupportedError", () => {
    const err = versionNotSupportedError(null, "0.5");
    expect(err.error.code).toBe(-32009);
    expect(err.id).toBe(0); // null requestId defaults to 0
    expect((err.error.data![0] as any).metadata.requestedVersion).toBe("0.5");
  });

  it("creates methodNotFoundError", () => {
    const err = methodNotFoundError(2, "unknown/method");
    expect(err.error.code).toBe(-32601);
    expect(err.error.message).toContain("unknown/method");
  });

  it("creates invalidParamsError with custom detail", () => {
    const err = invalidParamsError(3, "Missing field: message");
    expect(err.error.code).toBe(-32602);
    expect(err.error.message).toBe("Missing field: message");
  });

  it("creates internalError", () => {
    const err = internalError(4, "Something broke");
    expect(err.error.code).toBe(-32603);
    expect(err.error.message).toBe("Something broke");
  });
});

describe("httpStatusForError", () => {
  it("maps task not found to 404", () => {
    expect(httpStatusForError(-32001)).toBe(404);
  });

  it("maps task not cancelable to 409", () => {
    expect(httpStatusForError(-32002)).toBe(409);
  });

  it("maps version not supported to 400", () => {
    expect(httpStatusForError(-32009)).toBe(400);
  });

  it("maps internal error to 500", () => {
    expect(httpStatusForError(-32603)).toBe(500);
  });

  it("defaults unknown codes to 500", () => {
    expect(httpStatusForError(-99999)).toBe(500);
  });
});
