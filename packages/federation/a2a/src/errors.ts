import type { JsonRpcErrorResponse } from "./types.js";

// ============================================================================
// A2A Error Codes
// ============================================================================

/** A2A-specific JSON-RPC error codes. */
export const A2A_ERROR_CODES = {
  // Standard JSON-RPC codes
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  // A2A-specific codes
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOTIFICATION_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
  CONTENT_TYPE_NOT_SUPPORTED: -32005,
  INVALID_AGENT_RESPONSE: -32006,
  VERSION_NOT_SUPPORTED: -32009,
} as const;

export type A2AErrorCode = (typeof A2A_ERROR_CODES)[keyof typeof A2A_ERROR_CODES];

// ============================================================================
// Error Response Factories
// ============================================================================

function createErrorResponse(
  requestId: string | number | null,
  code: number,
  message: string,
  reason: string,
  metadata?: Record<string, unknown>,
): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id: requestId ?? 0,
    error: {
      code,
      message,
      data: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason,
          domain: "a2a",
          ...(metadata ? { metadata } : {}),
        },
      ],
    },
  };
}

export function parseError(requestId: string | number | null): JsonRpcErrorResponse {
  return createErrorResponse(requestId, A2A_ERROR_CODES.PARSE_ERROR, "Parse error", "PARSE_ERROR");
}

export function invalidRequestError(
  requestId: string | number | null,
  detail?: string,
): JsonRpcErrorResponse {
  return createErrorResponse(
    requestId,
    A2A_ERROR_CODES.INVALID_REQUEST,
    detail ?? "Invalid request",
    "INVALID_REQUEST",
  );
}

export function methodNotFoundError(
  requestId: string | number | null,
  method: string,
): JsonRpcErrorResponse {
  return createErrorResponse(
    requestId,
    A2A_ERROR_CODES.METHOD_NOT_FOUND,
    `Method not found: ${method}`,
    "METHOD_NOT_FOUND",
    { method },
  );
}

export function invalidParamsError(
  requestId: string | number | null,
  detail?: string,
): JsonRpcErrorResponse {
  return createErrorResponse(
    requestId,
    A2A_ERROR_CODES.INVALID_PARAMS,
    detail ?? "Invalid params",
    "INVALID_PARAMS",
  );
}

export function internalError(
  requestId: string | number | null,
  detail?: string,
): JsonRpcErrorResponse {
  return createErrorResponse(
    requestId,
    A2A_ERROR_CODES.INTERNAL_ERROR,
    detail ?? "Internal error",
    "INTERNAL_ERROR",
  );
}

export function taskNotFoundError(
  requestId: string | number | null,
  taskId: string,
): JsonRpcErrorResponse {
  return createErrorResponse(
    requestId,
    A2A_ERROR_CODES.TASK_NOT_FOUND,
    `Task not found: ${taskId}`,
    "TASK_NOT_FOUND",
    { taskId },
  );
}

export function taskNotCancelableError(
  requestId: string | number | null,
  taskId: string,
): JsonRpcErrorResponse {
  return createErrorResponse(
    requestId,
    A2A_ERROR_CODES.TASK_NOT_CANCELABLE,
    `Task is not cancelable: ${taskId}`,
    "TASK_NOT_CANCELABLE",
    { taskId },
  );
}

export function unsupportedOperationError(
  requestId: string | number | null,
  detail?: string,
): JsonRpcErrorResponse {
  return createErrorResponse(
    requestId,
    A2A_ERROR_CODES.UNSUPPORTED_OPERATION,
    detail ?? "Unsupported operation",
    "UNSUPPORTED_OPERATION",
  );
}

export function versionNotSupportedError(
  requestId: string | number | null,
  version: string,
): JsonRpcErrorResponse {
  return createErrorResponse(
    requestId,
    A2A_ERROR_CODES.VERSION_NOT_SUPPORTED,
    `A2A version not supported: ${version}`,
    "VERSION_NOT_SUPPORTED",
    { requestedVersion: version },
  );
}

// ============================================================================
// Error code → HTTP status mapping
// ============================================================================

const ERROR_HTTP_STATUS: Record<number, number> = {
  [A2A_ERROR_CODES.PARSE_ERROR]: 400,
  [A2A_ERROR_CODES.INVALID_REQUEST]: 400,
  [A2A_ERROR_CODES.METHOD_NOT_FOUND]: 404,
  [A2A_ERROR_CODES.INVALID_PARAMS]: 400,
  [A2A_ERROR_CODES.INTERNAL_ERROR]: 500,
  [A2A_ERROR_CODES.TASK_NOT_FOUND]: 404,
  [A2A_ERROR_CODES.TASK_NOT_CANCELABLE]: 409,
  [A2A_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED]: 400,
  [A2A_ERROR_CODES.UNSUPPORTED_OPERATION]: 400,
  [A2A_ERROR_CODES.CONTENT_TYPE_NOT_SUPPORTED]: 415,
  [A2A_ERROR_CODES.INVALID_AGENT_RESPONSE]: 502,
  [A2A_ERROR_CODES.VERSION_NOT_SUPPORTED]: 400,
};

export function httpStatusForError(errorCode: number): number {
  return ERROR_HTTP_STATUS[errorCode] ?? 500;
}
