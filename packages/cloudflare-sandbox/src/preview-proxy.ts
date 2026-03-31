/** Options for the preview proxy helper. */
export interface PreviewProxyOptions {
  /** The incoming request from the worker fetch handler. */
  request: Request;
  /** The agent Durable Object namespace (used to normalize UUIDs to hex IDs). */
  agentNamespace: DurableObjectNamespace;
  /** The sandbox container Durable Object namespace. */
  containerNamespace: DurableObjectNamespace;
}

/**
 * Handle preview proxy requests matching `/preview/:id[/...]`.
 *
 * The ID in the URL may be a registry UUID (with dashes) or an agent DO hex ID.
 * UUIDs are normalized to hex IDs via the agent namespace so the path matches
 * the Vite `base` config.
 *
 * Returns a Promise<Response> if the request matches, or `null` if it does not.
 */
export function handlePreviewRequest(opts: PreviewProxyOptions): Promise<Response> | null {
  const url = new URL(opts.request.url);
  const match = url.pathname.match(/^\/preview\/([^/]+)(\/.*)?$/);
  if (!match) return null;

  const rawId = match[1];
  // If it looks like a UUID (has dashes), resolve to DO hex ID; otherwise pass through
  const agentDoId = rawId.includes("-") ? opts.agentNamespace.idFromName(rawId).toString() : rawId;

  const containerId = opts.containerNamespace.idFromName(agentDoId);
  const stub = opts.containerNamespace.get(containerId);

  const subPath = match[2] || "/";
  const containerUrl = `http://container/preview/${agentDoId}${subPath}${url.search}`;
  return stub.fetch(new Request(containerUrl, opts.request));
}
