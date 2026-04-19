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
