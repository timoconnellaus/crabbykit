import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deliverPushNotification,
  firePushNotificationsForTask,
} from "../server/push-notifications.js";
import type { TaskStatusUpdateEvent } from "../types.js";

const mockEvent: TaskStatusUpdateEvent = {
  taskId: "task-1",
  contextId: "ctx-1",
  status: { state: "completed", timestamp: "2025-01-01T00:00:00Z" },
  final: true,
};

describe("deliverPushNotification", () => {
  it("calls fetchFn with correct URL, method, headers, and body", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));

    const result = await deliverPushNotification(
      "https://agent/a2a-callback",
      undefined,
      mockEvent,
      mockFetch,
    );

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://agent/a2a-callback");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual(mockEvent);
  });

  it("includes Bearer token when provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));

    await deliverPushNotification("https://agent/cb", "my-token", mockEvent, mockFetch);

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer my-token");
  });

  it("omits Authorization header when no token", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));

    await deliverPushNotification("https://agent/cb", undefined, mockEvent, mockFetch);

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("returns false on non-ok response", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("error", { status: 500 }));

    const result = await deliverPushNotification(
      "https://agent/cb",
      undefined,
      mockEvent,
      mockFetch,
    );

    expect(result).toBe(false);
  });

  it("returns false on fetch error (silent failure)", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const result = await deliverPushNotification(
      "https://agent/cb",
      undefined,
      mockEvent,
      mockFetch,
    );

    expect(result).toBe(false);
  });

  it("uses custom fetchFn when provided", async () => {
    const stubFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));

    await deliverPushNotification("https://stub-url/callback", "tok", mockEvent, stubFetch);

    expect(stubFetch).toHaveBeenCalledOnce();
    expect(stubFetch.mock.calls[0][0]).toBe("https://stub-url/callback");
  });
});

describe("firePushNotificationsForTask", () => {
  it("skips when no push config exists", async () => {
    const mockFetch = vi.fn();
    const taskStore = {
      getPushConfig: vi.fn().mockReturnValue(null),
    };

    // biome-ignore lint/suspicious/noExplicitAny: mock
    await firePushNotificationsForTask(taskStore as any, "task-1", mockEvent, mockFetch);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("delivers notification when push config exists", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const taskStore = {
      getPushConfig: vi.fn().mockReturnValue({
        url: "https://agent/a2a-callback/caller-id",
        token: "webhook-token",
      }),
    };

    // biome-ignore lint/suspicious/noExplicitAny: mock
    await firePushNotificationsForTask(taskStore as any, "task-1", mockEvent, mockFetch);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://agent/a2a-callback/caller-id");
    expect(init.headers.Authorization).toBe("Bearer webhook-token");
  });

  it("passes fetchFn through to delivery", async () => {
    const customFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const taskStore = {
      getPushConfig: vi.fn().mockReturnValue({ url: "https://test/cb" }),
    };

    // biome-ignore lint/suspicious/noExplicitAny: mock
    await firePushNotificationsForTask(taskStore as any, "task-1", mockEvent, customFetch);

    expect(customFetch).toHaveBeenCalledOnce();
  });
});
