/**
 * Platform-agnostic scheduler interface.
 * Abstracts the wake-time mechanism so the scheduling subsystem
 * is not coupled to Cloudflare Durable Object alarms.
 */
export interface Scheduler {
  /** Set the time at which the agent should be woken to process due schedules. */
  setWakeTime(time: Date): Promise<void>;
  /** Cancel any pending wake time. */
  cancelWakeTime(): Promise<void>;
  /** Return the currently set wake time, or null if none is pending. */
  getWakeTime(): Promise<Date | null>;
}
