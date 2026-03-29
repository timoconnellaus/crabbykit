import type { TaskStatusUpdateEvent } from "../types.js";
import type { TaskStore } from "./task-store.js";

/**
 * Deliver a push notification to a registered webhook URL.
 * Best-effort — returns true on success, false on failure.
 */
export async function deliverPushNotification(
  url: string,
  token: string | undefined,
  event: TaskStatusUpdateEvent,
): Promise<boolean> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(event),
    });

    return response.ok;
  } catch {
    // Silent failure — best-effort delivery
    return false;
  }
}

/**
 * Look up push notification config for a task and deliver if configured.
 * Called by the executor when a task reaches a terminal state.
 */
export async function firePushNotificationsForTask(
  taskStore: TaskStore,
  taskId: string,
  event: TaskStatusUpdateEvent,
): Promise<void> {
  const config = taskStore.getPushConfig(taskId);
  if (!config) return;

  await deliverPushNotification(config.url, config.token, event);
}
