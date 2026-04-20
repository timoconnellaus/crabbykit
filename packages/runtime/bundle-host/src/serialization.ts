/**
 * Host-side request/response serialization helpers for the bundle
 * `/http` dispatch path (`bundle-http-and-ui-surface`).
 *
 * Both ends of the cross-isolate boundary speak a JSON envelope so the
 * Worker Loader fetch boundary stays well-defined regardless of header
 * shape, body type, or response status. v1 buffers the whole body
 * (streaming is a documented Non-Goal).
 */

/** Outgoing host → bundle envelope shape served at POST /http. */
export interface HostHttpEnvelope {
  capabilityId: string;
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  bodyBase64: string | null;
  sessionId: string | null;
}

/** Incoming bundle → host envelope shape returned from POST /http. */
export interface BundleHttpResponseEnvelope {
  status: number;
  headers?: Record<string, string>;
  bodyBase64?: string | null;
}

/** Outgoing host → bundle envelope shape served at POST /action. */
export interface HostActionEnvelope {
  capabilityId: string;
  action: string;
  data: unknown;
  sessionId: string;
}

/** Incoming bundle → host envelope shape returned from POST /action. */
export interface BundleActionResponseEnvelope {
  status: "ok" | "noop" | "error";
  message?: string;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToUint8Array(b64: string): Uint8Array {
  const padded = b64.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Serialize a `Request` for forwarding into the bundle isolate.
 *
 * `bodyBytes` is the buffered body (or `null` when no body was sent /
 * the request was a GET). The host buffers the body itself and enforces
 * the body cap before calling this helper — no streaming.
 */
export function serializeRequestForBundle(args: {
  request: Request;
  capabilityId: string;
  declaredPath: string;
  sessionId: string | null;
  bodyBytes: Uint8Array | null;
}): HostHttpEnvelope {
  const url = new URL(args.request.url);
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) query[k] = v;
  const headers: Record<string, string> = {};
  for (const [k, v] of args.request.headers.entries()) headers[k.toLowerCase()] = v;
  return {
    capabilityId: args.capabilityId,
    method: args.request.method,
    path: args.declaredPath,
    query,
    headers,
    bodyBase64:
      args.bodyBytes && args.bodyBytes.byteLength > 0 ? uint8ArrayToBase64(args.bodyBytes) : null,
    sessionId: args.sessionId,
  };
}

/**
 * Deserialize a bundle response envelope into a `Response` the host can
 * return to the original caller.
 */
export function deserializeResponseFromBundle(envelope: BundleHttpResponseEnvelope): Response {
  const body: BodyInit | null =
    typeof envelope.bodyBase64 === "string" && envelope.bodyBase64.length > 0
      ? (base64ToUint8Array(envelope.bodyBase64).buffer as ArrayBuffer)
      : null;
  return new Response(body, {
    status: envelope.status,
    headers: envelope.headers ?? {},
  });
}

/**
 * Build the action-dispatch envelope. Trivial today (data is forwarded
 * verbatim) but kept as a helper so the call sites can evolve in lockstep
 * with `dispatchAction`.
 */
export function serializeActionForBundle(args: {
  capabilityId: string;
  action: string;
  data: unknown;
  sessionId: string;
}): HostActionEnvelope {
  return {
    capabilityId: args.capabilityId,
    action: args.action,
    data: args.data,
    sessionId: args.sessionId,
  };
}

// --- Bundle lifecycle hook payload projection (bundle-lifecycle-hooks) ---

/**
 * Structurally-clonable projection of an agent-core tool-execution
 * result. Duplicated from `@crabbykit/bundle-sdk`'s `BundleToolResult`
 * — kept local to keep `bundle-host` free of a value import edge to the
 * SDK.
 */
export interface BundleToolResultProjection {
  toolName: string;
  args: unknown;
  content: string;
  isError: boolean;
}

const PROJECTION_FAILED_SENTINEL: BundleToolResultProjection = {
  toolName: "unknown",
  args: null,
  content: "<projection failed>",
  isError: true,
};

/**
 * Reduce each raw `event.toolResults` entry emitted by agent-core to a
 * structured-clone-safe {@link BundleToolResultProjection}. Entries
 * containing functions, class instances, stream readers, or other
 * non-clonable values are replaced with a sentinel and a structured
 * `[BundleDispatch] kind: "lifecycle_on_turn_end" outcome:
 * "tool_result_projection_failed"` log is emitted per entry (callers
 * supply the logger; this helper stays pure-functional).
 *
 * The current agent-core tool-result shape carries `{ toolName, args,
 * content, isError }` — `content` may be a string or a structured
 * block list. We stringify via JSON for the structured case to keep
 * the bundle-side type simple (`content: string`). Shapes that can't
 * be JSON-stringified (circular refs, BigInt, etc.) fall through to
 * the sentinel.
 */
export function projectToolResultsForBundle(
  toolResults: unknown[],
  onProjectionFailure?: (entryIndex: number, reason: string) => void,
): BundleToolResultProjection[] {
  if (!Array.isArray(toolResults)) return [];
  const out: BundleToolResultProjection[] = [];
  for (let i = 0; i < toolResults.length; i++) {
    const raw = toolResults[i];
    const projected = projectOne(raw);
    if (projected === null) {
      onProjectionFailure?.(i, "non-projectable entry");
      out.push(PROJECTION_FAILED_SENTINEL);
      continue;
    }
    out.push(projected);
  }
  return out;
}

function projectOne(raw: unknown): BundleToolResultProjection | null {
  if (raw === null || typeof raw !== "object") return null;
  if (typeof (raw as { then?: unknown }).then === "function") return null;
  const record = raw as Record<string, unknown>;
  const toolName = typeof record.toolName === "string" ? record.toolName : null;
  if (toolName === null) return null;
  const isError = typeof record.isError === "boolean" ? record.isError : false;
  const content = normalizeContent(record.content);
  if (content === null) return null;
  // Non-clonable args (class instances, functions, stream readers) mean
  // the whole entry is non-projectable — return null so the caller
  // substitutes the sentinel. Undefined/null args are acceptable.
  if (record.args !== undefined && record.args !== null && !isClonableValue(record.args)) {
    return null;
  }
  const args = record.args ?? null;
  return { toolName, args, content, isError };
}

function normalizeContent(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    // agent-core renders content blocks as `{ type: "text", text }` —
    // concat the text parts; reject arrays containing function refs.
    const parts: string[] = [];
    for (const block of value) {
      if (typeof block === "string") {
        parts.push(block);
        continue;
      }
      if (typeof block === "object" && block !== null) {
        const r = block as Record<string, unknown>;
        if (r.type === "text" && typeof r.text === "string") {
          parts.push(r.text);
          continue;
        }
      }
      if (typeof block === "function") return null;
    }
    return parts.join("");
  }
  if (value === null || value === undefined) return "";
  if (typeof value === "function") return null;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return null;
  }
}

function isClonableValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return true;
  if (t === "function") return false;
  if (Array.isArray(value)) return value.every(isClonableValue);
  if (t === "object") {
    // Reject known non-clonable shapes (streams, readers, class instances).
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) return false;
    for (const v of Object.values(value as Record<string, unknown>)) {
      if (!isClonableValue(v)) return false;
    }
    return true;
  }
  return false;
}
