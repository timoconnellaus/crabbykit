import type { TaskStatusUpdateEvent } from "../types.js";
import type { TaskStore } from "./task-store.js";

/**
 * Deliver a push notification to a registered webhook URL.
 * Best-effort — returns true on success, false on failure.
 *
 * @param fetchFn - Custom fetch function (e.g., DO stub fetch for same-platform delivery).
 *                  Defaults to global fetch.
 */
export async function deliverPushNotification(
  url: string,
  token: string | undefined,
  event: TaskStatusUpdateEvent,
  fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch,
): Promise<boolean> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    console.log(`[a2a:push] delivering to ${url}, token=${token ? "yes" : "no"}, fetchFn=${fetchFn === fetch ? "global" : "custom"}`);
    const response = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(event),
    });

    console.log(`[a2a:push] response: ${response.status} ${response.statusText}`);
    if (!response.ok) {
      const body = await response.text().catch(() => "(no body)");
      console.error(`[a2a:push] delivery failed: ${response.status} — ${body}`);
    }
    return response.ok;
  } catch (err) {
    console.error(`[a2a:push] delivery error:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Look up push notification config for a task and deliver if configured.
 * Called by the executor when a task reaches a terminal state.
 *
 * @param fetchFn - Custom fetch function for delivery (e.g., stub-based fetch).
 */
export async function firePushNotificationsForTask(
  taskStore: TaskStore,
  taskId: string,
  event: TaskStatusUpdateEvent,
  fetchFn?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): Promise<void> {
  const config = taskStore.getPushConfig(taskId);
  if (!config) return;

  await deliverPushNotification(config.url, config.token, event, fetchFn);
}
