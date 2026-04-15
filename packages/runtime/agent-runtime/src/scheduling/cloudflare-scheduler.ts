/**
 * Cloudflare adapter that wraps DO alarm APIs behind the Scheduler interface.
 */

import type { Scheduler } from "./scheduler-types.js";

/**
 * Create a Scheduler backed by Cloudflare Durable Object alarms.
 * Converts between the DO alarm API (epoch milliseconds) and the
 * Scheduler interface (Date objects).
 */
export function createCfScheduler(storage: DurableObjectStorage): Scheduler {
  return {
    setWakeTime: (time: Date) => storage.setAlarm(time.getTime()),
    cancelWakeTime: () => storage.deleteAlarm(),
    getWakeTime: async () => {
      const epoch = await storage.getAlarm();
      return epoch !== null ? new Date(epoch) : null;
    },
  };
}
