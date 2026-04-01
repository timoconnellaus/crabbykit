/**
 * E2E tests for the sandbox capability with a real container.
 * Runs against wrangler dev (started by global-setup.ts).
 */

import { describe, expect, it, beforeAll } from "vitest";

const BASE_URL = "http://localhost:8787";
const AGENT_ID = "e2e-sandbox";

function agentUrl(path: string): string {
  return `${BASE_URL}/agent/${AGENT_ID}${path}`;
}

async function executeTool(
  toolName: string,
  args: Record<string, unknown> = {},
  sessionId?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload: Record<string, unknown> = { toolName, args };
  if (sessionId) payload.sessionId = sessionId;

  const res = await fetch(agentUrl("/execute-tool"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

async function getSessions(): Promise<{ sessions: Array<{ id: string }> }> {
  const res = await fetch(agentUrl("/sessions"));
  return (await res.json()) as { sessions: Array<{ id: string }> };
}

describe("Sandbox E2E", () => {
  let sessionId: string;

  beforeAll(async () => {
    // Create a session by listing (the agent will auto-create on first tool exec)
    const { sessions } = await getSessions();
    sessionId = sessions[0]?.id;
  });

  it("exec without elevation returns not-elevated error", async () => {
    const { body } = await executeTool("exec", { command: "ls" });
    const result = body.result as { content: Array<{ text: string }>; details: { error: string } };
    expect(result.details.error).toBe("not_elevated");
    expect(result.content[0].text).toContain("elevate");

    // Capture the session ID for subsequent tests
    sessionId = body.sessionId as string;
  });

  it("elevate starts the container", async () => {
    const { body } = await executeTool(
      "elevate",
      { reason: "e2e test" },
      sessionId,
    );
    const result = body.result as { content: Array<{ text: string }> };
    expect(result.content[0].text).toContain("activated");
  }, 120_000); // container startup can be slow

  it("exec ls returns directory listing", async () => {
    const { body } = await executeTool(
      "exec",
      { command: "ls /" },
      sessionId,
    );
    const result = body.result as {
      content: Array<{ text: string }>;
      details: { exitCode: number; stdout: string };
    };
    expect(result.details.exitCode).toBe(0);
    // Root filesystem should have standard Linux directories
    expect(result.details.stdout).toContain("bin");
    expect(result.details.stdout).toContain("etc");
    expect(result.details.stdout).toContain("tmp");
  });

  it("exec can run commands and capture output", async () => {
    const { body } = await executeTool(
      "exec",
      { command: "echo hello-from-e2e" },
      sessionId,
    );
    const result = body.result as {
      content: Array<{ text: string }>;
      details: { exitCode: number; stdout: string };
    };
    expect(result.details.exitCode).toBe(0);
    expect(result.details.stdout).toContain("hello-from-e2e");
  });

  it("exec captures non-zero exit codes", async () => {
    const { body } = await executeTool(
      "exec",
      { command: "ls /nonexistent-path-e2e" },
      sessionId,
    );
    const result = body.result as {
      content: Array<{ text: string }>;
      details: { exitCode: number; stderr: string };
    };
    expect(result.details.exitCode).not.toBe(0);
  });

  it("exec can write and read files in the container", async () => {
    // Write a file
    await executeTool(
      "exec",
      { command: "echo 'e2e-content' > /tmp/e2e-test.txt" },
      sessionId,
    );

    // Read it back
    const { body } = await executeTool(
      "exec",
      { command: "cat /tmp/e2e-test.txt" },
      sessionId,
    );
    const result = body.result as {
      details: { exitCode: number; stdout: string };
    };
    expect(result.details.exitCode).toBe(0);
    expect(result.details.stdout).toContain("e2e-content");
  });

  it("de_elevate stops the container", async () => {
    const { body } = await executeTool("de_elevate", {}, sessionId);
    const result = body.result as { content: Array<{ text: string }> };
    expect(result.content[0].text).toContain("deactivated");
  });

  it("exec after de-elevation returns not-elevated error", async () => {
    const { body } = await executeTool("exec", { command: "ls" }, sessionId);
    const result = body.result as { details: { error: string } };
    expect(result.details.error).toBe("not_elevated");
  });
});
