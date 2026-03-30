// Re-export from agent-storage for convenience
export type { AgentStorage, AgentStorageOptions } from "@claw-for-cloudflare/agent-storage";
export { agentStorage } from "@claw-for-cloudflare/agent-storage";
export type { R2StorageOptions } from "./capability.js";
export { r2Storage } from "./capability.js";
export type { PathValidation, PathValidationError, PathValidationResult } from "./paths.js";
export { globToRegex, toR2Key, validatePath } from "./paths.js";
