// Re-export from agent-storage for convenience
export type { AgentStorage, AgentStorageOptions } from "@crabbykit/agent-storage";
export { agentStorage } from "@crabbykit/agent-storage";
export type { FileToolsOptions } from "./capability.js";
export { fileTools } from "./capability.js";
export type { PathValidation, PathValidationError, PathValidationResult } from "./paths.js";
export { globToRegex, toR2Key, validatePath } from "./paths.js";
export type {
  DirEntry,
  DirListing,
  FileChanged,
  FileConflict,
  FileContent,
  FileError,
  FileSaved,
} from "./ui-bridge.js";
export { broadcastAgentMutation, dispatchUiAction } from "./ui-bridge.js";
