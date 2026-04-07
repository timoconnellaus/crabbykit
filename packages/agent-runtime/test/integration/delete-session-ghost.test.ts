/**
 * Tests for delete_session ghost-state fix.
 *
 * Previously, only the connection that sent delete_session was redirected.
 * Other connections on the same session remained pointed at the deleted
 * session (ghost state) — they could send messages to a non-existent
 * session and get SESSION_NOT_FOUND errors.
 *
 * The fix redirects ALL connections on the deleted session.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { clearMockResponses, setMockResponses } from "../../src/test-helpers/test-agent-do.js";
import type { ServerMessage } from "../../src/transport/types.js";
import { connectAndGetSession, getStub, openSocket, prompt } from "../helpers/ws-client.js";

type SessionSyncMsg = Extract<ServerMessage, { type: "session_sync" }>;
type AgentEventMsg = Extract<ServerMessage, { type: "agent_event" }>;

describe("delete_session — ghost-state prevention", () => {
  beforeEach(() => {
    clearMockResponses();
  });

  it("other connection on deleted session gets redirected", async () => {
    const stub = getStub("ghost-1");

    setMockResponses([{ text: "Hello" }]);
    await prompt(stub, "Setup");

    // Two clients connect — both land on the same session
    const { client: client1, sessionId } = await connectAndGetSession(stub);
    const { client: client2, sessionId: sessionId2 } = await connectAndGetSession(stub);
    expect(sessionId).toBe(sessionId2);

    // Create a second session so we can delete the first
    client1.send({ type: "new_session", name: "Backup" });
    const newSync = await client1.waitForMessage(
      (m) => m.type === "session_sync" && (m as SessionSyncMsg).sessionId !== sessionId,
    );
    const backupId = (newSync as SessionSyncMsg).sessionId;

    // Switch client1 to the backup session
    client1.send({ type: "switch_session", sessionId: backupId });
    await client1.waitForMessage(
      (m) => m.type === "session_sync" && (m as SessionSyncMsg).sessionId === backupId,
    );

    // Wait for broadcasts to settle, then clear client2 messages
    await new Promise((r) => setTimeout(r, 100));
    client2.messages.length = 0;

    // Client1 deletes the original session — client2 is still on it
    client1.send({ type: "delete_session", sessionId });

    // Client2 should be redirected to the backup session
    const redirect = await client2.waitForMessage(
      (m) => m.type === "session_sync" && (m as SessionSyncMsg).sessionId !== sessionId,
    );
    expect((redirect as SessionSyncMsg).sessionId).toBe(backupId);

    client1.close();
    client2.close();
  });

  it("multiple connections on deleted session all get redirected", async () => {
    const stub = getStub("ghost-2");

    setMockResponses([{ text: "Data" }]);
    await prompt(stub, "Setup");

    // Three clients on the same session
    const { client: client1, sessionId } = await connectAndGetSession(stub);
    const { client: client2 } = await connectAndGetSession(stub);
    const { client: client3 } = await connectAndGetSession(stub);

    // Create a backup session
    client1.send({ type: "new_session", name: "Backup" });
    const newSync = await client1.waitForMessage(
      (m) => m.type === "session_sync" && (m as SessionSyncMsg).sessionId !== sessionId,
    );
    const backupId = (newSync as SessionSyncMsg).sessionId;

    // Switch client1 to backup
    client1.send({ type: "switch_session", sessionId: backupId });
    await client1.waitForMessage(
      (m) => m.type === "session_sync" && (m as SessionSyncMsg).sessionId === backupId,
    );

    await new Promise((r) => setTimeout(r, 100));
    client2.messages.length = 0;
    client3.messages.length = 0;

    // Delete the original session
    client1.send({ type: "delete_session", sessionId });

    // Both client2 and client3 should receive redirects
    const redirect2 = await client2.waitForMessage(
      (m) => m.type === "session_sync" && (m as SessionSyncMsg).sessionId !== sessionId,
    );
    const redirect3 = await client3.waitForMessage(
      (m) => m.type === "session_sync" && (m as SessionSyncMsg).sessionId !== sessionId,
    );

    expect((redirect2 as SessionSyncMsg).sessionId).toBe(backupId);
    expect((redirect3 as SessionSyncMsg).sessionId).toBe(backupId);

    client1.close();
    client2.close();
    client3.close();
  });

  it("redirected connection can send messages on the new session", async () => {
    const stub = getStub("ghost-3");

    setMockResponses([{ text: "Setup" }]);
    await prompt(stub, "Setup");

    const { client: client1, sessionId } = await connectAndGetSession(stub);
    const { client: client2 } = await connectAndGetSession(stub);

    // Create backup session
    client1.send({ type: "new_session", name: "Backup" });
    const newSync = await client1.waitForMessage(
      (m) => m.type === "session_sync" && (m as SessionSyncMsg).sessionId !== sessionId,
    );
    const backupId = (newSync as SessionSyncMsg).sessionId;

    // Switch client1 to backup and delete original
    client1.send({ type: "switch_session", sessionId: backupId });
    await client1.waitForMessage(
      (m) => m.type === "session_sync" && (m as SessionSyncMsg).sessionId === backupId,
    );

    await new Promise((r) => setTimeout(r, 100));
    client2.messages.length = 0;

    client1.send({ type: "delete_session", sessionId });

    // Wait for client2 redirect
    const redirect = await client2.waitForMessage(
      (m) => m.type === "session_sync" && (m as SessionSyncMsg).sessionId === backupId,
    );
    expect(redirect).toBeTruthy();

    // Client2 should now be able to prompt on the new session without errors
    setMockResponses([{ text: "Works on backup!" }]);
    client2.send({ type: "prompt", sessionId: backupId, text: "Am I on the right session?" });

    const end = await client2.waitForMessage(
      (m) => m.type === "agent_event" && (m as AgentEventMsg).event.type === "agent_end",
    );
    expect(end).toBeTruthy();

    // No errors should have occurred
    const errors = client2.messages.filter((m) => m.type === "error");
    expect(errors.length).toBe(0);

    client1.close();
    client2.close();
  });

  it("sending client on deleted session also gets redirected", async () => {
    // Regression: the original fix redirected only the sender.
    // After the ghost-state fix, the sender should STILL be redirected.
    const stub = getStub("ghost-4");

    setMockResponses([{ text: "Setup" }]);
    await prompt(stub, "Setup");

    const { client, sessionId } = await connectAndGetSession(stub);

    // Create backup
    client.send({ type: "new_session", name: "Backup" });
    const newSync = await client.waitForMessage(
      (m) => m.type === "session_sync" && (m as SessionSyncMsg).sessionId !== sessionId,
    );
    const backupId = (newSync as SessionSyncMsg).sessionId;

    // Switch back to original
    client.send({ type: "switch_session", sessionId });
    await client.waitForMessage(
      (m) => m.type === "session_sync" && (m as SessionSyncMsg).sessionId === sessionId,
    );

    await new Promise((r) => setTimeout(r, 100));
    client.messages.length = 0;

    // Delete the session the client is on
    client.send({ type: "delete_session", sessionId });

    // Should be redirected
    const redirect = await client.waitForMessage(
      (m) => m.type === "session_sync" && (m as SessionSyncMsg).sessionId === backupId,
    );
    expect((redirect as SessionSyncMsg).sessionId).toBe(backupId);

    client.close();
  });

  it("connection on different session is unaffected by deletion", async () => {
    const stub = getStub("ghost-5");

    setMockResponses([{ text: "Setup" }]);
    await prompt(stub, "Setup");

    const { client: client1, sessionId: sessionA } = await connectAndGetSession(stub);

    // Create second session
    client1.send({ type: "new_session", name: "Session B" });
    const newSync = await client1.waitForMessage(
      (m) => m.type === "session_sync" && (m as SessionSyncMsg).sessionId !== sessionA,
    );
    const sessionB = (newSync as SessionSyncMsg).sessionId;

    // Client2 connects — will be on session A (default/first)
    const client2 = await openSocket(stub);
    await client2.waitForMessage((m) => m.type === "session_sync");

    // Switch client2 to session B
    client2.send({ type: "switch_session", sessionId: sessionB });
    await client2.waitForMessage(
      (m) => m.type === "session_sync" && (m as SessionSyncMsg).sessionId === sessionB,
    );

    await new Promise((r) => setTimeout(r, 100));
    client2.messages.length = 0;

    // Client1 deletes session A — client2 is on session B, should be unaffected
    client1.send({ type: "delete_session", sessionId: sessionA });

    // Wait a bit and check client2 got session_list but NOT a session_sync redirect
    await new Promise((r) => setTimeout(r, 200));

    const syncs = client2.messages.filter((m) => m.type === "session_sync");
    expect(syncs.length).toBe(0);

    // Client2 should still get updated session list
    const lists = client2.messages.filter((m) => m.type === "session_list");
    expect(lists.length).toBeGreaterThan(0);

    client1.close();
    client2.close();
  });
});
