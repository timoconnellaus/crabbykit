import { describe, expect, it } from "vitest";
import { ErrorCodes } from "../../transport/error-codes.js";
import {
  agentBusy,
  compactionOverflow,
  doomLoopDetected,
  isRuntimeError,
  RuntimeError,
  sessionNotFound,
  toolExecutionFailed,
  toolNotFound,
  toolTimeout,
} from "../runtime-error.js";

describe("RuntimeError", () => {
  describe("happy path — each variant constructs correctly", () => {
    it("sessionNotFound", () => {
      const err = sessionNotFound("s123");
      expect(err.type).toBe("session_not_found");
      expect(err.message).toContain("s123");
      expect(err.errorCode).toBe(ErrorCodes.SESSION_NOT_FOUND);
      expect(err.details.sessionId).toBe("s123");
    });

    it("toolNotFound", () => {
      const err = toolNotFound("my_tool", ["a", "b"]);
      expect(err.type).toBe("tool_not_found");
      expect(err.message).toContain("my_tool");
      expect(err.errorCode).toBe(ErrorCodes.TOOL_ERROR);
      expect(err.details.toolName).toBe("my_tool");
      expect(err.details.available).toEqual(["a", "b"]);
    });

    it("toolExecutionFailed", () => {
      const err = toolExecutionFailed("my_tool", new Error("boom"));
      expect(err.type).toBe("tool_execution_failed");
      expect(err.message).toContain("boom");
      expect(err.errorCode).toBe(ErrorCodes.TOOL_ERROR);
      expect(err.details.toolName).toBe("my_tool");
    });

    it("toolExecutionFailed with string cause", () => {
      const err = toolExecutionFailed("my_tool", "string error");
      expect(err.type).toBe("tool_execution_failed");
      expect(err.message).toContain("string error");
      expect(err.details.cause).toBe("string error");
    });

    it("toolTimeout", () => {
      const err = toolTimeout("slow_tool", 5000);
      expect(err.type).toBe("tool_timeout");
      expect(err.message).toContain("5000ms");
      expect(err.errorCode).toBe(ErrorCodes.TOOL_ERROR);
      expect(err.details.timeoutMs).toBe(5000);
    });

    it("agentBusy", () => {
      const err = agentBusy("s1");
      expect(err.type).toBe("agent_busy");
      expect(err.errorCode).toBe(ErrorCodes.AGENT_BUSY);
      expect(err.details.sessionId).toBe("s1");
    });

    it("compactionOverflow", () => {
      const err = compactionOverflow("s1");
      expect(err.type).toBe("compaction_overflow");
      expect(err.errorCode).toBe(ErrorCodes.INTERNAL_ERROR);
    });

    it("doomLoopDetected", () => {
      const err = doomLoopDetected("search", 3);
      expect(err.type).toBe("doom_loop_detected");
      expect(err.errorCode).toBe(ErrorCodes.TOOL_ERROR);
      expect(err.details.toolName).toBe("search");
      expect(err.details.count).toBe(3);
    });
  });

  describe("negative — isRuntimeError rejects non-errors", () => {
    it("returns false for plain Error", () => {
      expect(isRuntimeError(new Error("plain"))).toBe(false);
    });

    it("returns false for non-object", () => {
      expect(isRuntimeError("string")).toBe(false);
      expect(isRuntimeError(42)).toBe(false);
    });

    it("returns false for null", () => {
      expect(isRuntimeError(null)).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isRuntimeError(undefined)).toBe(false);
    });

    it("returns false for plain object with type field", () => {
      expect(isRuntimeError({ type: "session_not_found" })).toBe(false);
    });
  });

  describe("boundary — minimal and maximal payloads", () => {
    it("constructs with minimal details (empty object)", () => {
      const err = new RuntimeError("agent_busy", "busy");
      expect(err.details).toEqual({});
      expect(err.type).toBe("agent_busy");
    });

    it("constructs with full details", () => {
      const err = new RuntimeError("tool_not_found", "not found", {
        toolName: "x",
        available: ["a", "b", "c"],
        extra: true,
      });
      expect(err.details.extra).toBe(true);
    });
  });

  describe("state — error code mapping", () => {
    it("each variant maps to a unique or appropriate transport error code", () => {
      const variants = [
        sessionNotFound("s"),
        toolNotFound("t", []),
        toolExecutionFailed("t", "e"),
        toolTimeout("t", 1),
        agentBusy("s"),
        compactionOverflow("s"),
        doomLoopDetected("t", 1),
      ];

      // Every error has a valid ErrorCode
      const validCodes = Object.values(ErrorCodes);
      for (const err of variants) {
        expect(validCodes).toContain(err.errorCode);
      }

      // session_not_found -> SESSION_NOT_FOUND
      expect(variants[0].errorCode).toBe(ErrorCodes.SESSION_NOT_FOUND);
      // agent_busy -> AGENT_BUSY
      expect(variants[4].errorCode).toBe(ErrorCodes.AGENT_BUSY);
      // compaction_overflow -> INTERNAL_ERROR
      expect(variants[5].errorCode).toBe(ErrorCodes.INTERNAL_ERROR);
    });
  });

  describe("invariants", () => {
    it("RuntimeError extends Error", () => {
      const err = sessionNotFound("s1");
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(RuntimeError);
    });

    it("isRuntimeError guard enables switch on type", () => {
      const err: unknown = sessionNotFound("s1");
      if (isRuntimeError(err)) {
        // TypeScript should narrow this
        switch (err.type) {
          case "session_not_found":
            expect(err.details.sessionId).toBe("s1");
            break;
          default:
            throw new Error("Should not reach default");
        }
      } else {
        throw new Error("Should be a RuntimeError");
      }
    });

    it("name property is 'RuntimeError'", () => {
      expect(sessionNotFound("s").name).toBe("RuntimeError");
    });

    it("can be caught in a standard try/catch", () => {
      try {
        throw sessionNotFound("s1");
      } catch (e) {
        expect(isRuntimeError(e)).toBe(true);
        if (isRuntimeError(e)) {
          expect(e.type).toBe("session_not_found");
        }
      }
    });
  });
});
