/**
 * Pure helper functions for the sandbox container server.
 */
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { SENSITIVE_KEYS } from "./constants.ts";
import { injectedEnv, workspacePath } from "./state.ts";

export function buildSanitizedEnv(): Record<string, string> {
  const env = { ...process.env, ...injectedEnv } as Record<string, string>;
  for (const key of SENSITIVE_KEYS) {
    delete env[key];
  }
  return env;
}

function isUnderWorkspace(targetPath: string): boolean {
  if (!workspacePath) return false;
  const resolved = path.resolve(targetPath);
  try {
    const real = fs.realpathSync(resolved);
    return real === workspacePath || real.startsWith(`${workspacePath}/`);
  } catch {
    return resolved === workspacePath || resolved.startsWith(`${workspacePath}/`);
  }
}

function isUnderPersist(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  return resolved === "/opt/sandbox/persist" || resolved.startsWith("/opt/sandbox/persist/");
}

export function isAllowedPath(targetPath: string): boolean {
  return isUnderWorkspace(targetPath) || isUnderPersist(targetPath);
}

/**
 * Resolve the effective cwd for command execution.
 * Returns the resolved path or an error message.
 * Rejects disallowed paths explicitly rather than silently falling back.
 */
export function resolveExecCwd(
  cwd?: string,
): { ok: true; path: string } | { ok: false; error: string } {
  if (cwd && isAllowedPath(cwd)) return { ok: true, path: cwd };
  if (cwd)
    return {
      ok: false,
      error: `cwd "${cwd}" is outside the allowed paths (workspace or /opt/sandbox/persist)`,
    };
  if (workspacePath) return { ok: true, path: workspacePath };
  return { ok: false, error: "No workspace configured — call /init with a workspace first" };
}

/** Strip ANSI escape codes from PTY output. */
export function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escape sequences requires matching control chars
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1B\][^\x07]*\x07/g, "");
}

export async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

export function error(res: http.ServerResponse, message: string, status = 400) {
  json(res, { error: message }, status);
}
