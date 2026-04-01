/**
 * Mutable singleton state shared across modules.
 */
import type { ManagedProcess, Session } from "./types.ts";

export let workspacePath = process.env.AGENT_ID ? "/mnt/r2" : "";
export let injectedEnv: Record<string, string> = {};
export let lastActivityAt = Date.now();
export let containerMode = process.env.CONTAINER_MODE ?? "normal";
export let lastSyncAt = 0;
export const cleanupPrefixes: string[] = [];
export let devServerPort: number | null = null;
export let devServerBasePath: string | null = null;

export const processes = new Map<string, ManagedProcess>();
export const sessions = new Map<string, Session>();
export let logDirCreated = false;

// --- Setters for mutable state ---

export function setWorkspacePath(v: string) {
  workspacePath = v;
}
export function setInjectedEnv(v: Record<string, string>) {
  injectedEnv = v;
}
export function touchActivity() {
  lastActivityAt = Date.now();
}
export function setContainerMode(v: string) {
  containerMode = v;
}
export function setLastSyncAt(v: number) {
  lastSyncAt = v;
}
export function setDevServerPort(v: number | null) {
  devServerPort = v;
}
export function setDevServerBasePath(v: string | null) {
  devServerBasePath = v;
}
export function setLogDirCreated(v: boolean) {
  logDirCreated = v;
}
