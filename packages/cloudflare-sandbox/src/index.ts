// Re-exported so consumers can bind ContainerProxy from their worker entrypoint.
// The @cloudflare/containers 0.2.x runtime requires `ctx.exports.ContainerProxy`
// to be available when outboundByHost is used — without this, the container
// throws "ctx.exports is undefined" at startup.
export { ContainerProxy } from "@cloudflare/containers";
export type { SandboxContainerEnv } from "./container-do.js";
export { SandboxContainer } from "./container-do.js";
export type { PreviewProxyOptions } from "./preview-proxy.js";
export { handlePreviewRequest } from "./preview-proxy.js";
export type { CloudflareSandboxOptions } from "./provider.js";
export { CloudflareSandboxProvider } from "./provider.js";
