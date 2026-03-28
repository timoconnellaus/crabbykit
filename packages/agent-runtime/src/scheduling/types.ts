import type { CostEvent } from "../costs/types.js";
import type { SessionStore } from "../session/session-store.js";

/** Persisted schedule record. */
export interface Schedule {
  id: string;
  name: string;
  cron: string;
  enabled: boolean;
  handlerType: "prompt" | "callback" | "timer";
  prompt: string | null;
  sessionPrefix: string | null;
  ownerId: string | null;
  nextFireAt: string | null;
  lastFiredAt: string | null;
  timezone: string | null;
  expiresAt: string | null;
  status: "idle" | "running" | "failed";
  lastError: string | null;
  retention: number;
  createdAt: string;
  updatedAt: string;
}

/** Configuration for a prompt-based schedule. */
export interface PromptScheduleConfig {
  id: string;
  name: string;
  /** 5-field cron expression or interval shorthand ("30m", "2h"). */
  cron: string;
  enabled?: boolean;
  /** IANA timezone for cron evaluation (e.g., "America/New_York"). Defaults to UTC. */
  timezone?: string;
  /** Auto-delete after this duration (e.g., "15m", "3d", "1h"). Omit for no expiry. */
  maxDuration?: string;
  prompt: string;
  sessionPrefix?: string;
  retention?: number;
}

/** Configuration for a callback-based schedule. */
export interface CallbackScheduleConfig {
  id: string;
  name: string;
  /** 5-field cron expression or interval shorthand ("30m", "2h"). */
  cron: string;
  enabled?: boolean;
  /** IANA timezone for cron evaluation (e.g., "America/New_York"). Defaults to UTC. */
  timezone?: string;
  /** Auto-delete after this duration (e.g., "15m", "3d", "1h"). Omit for no expiry. */
  maxDuration?: string;
  callback: (ctx: ScheduleCallbackContext) => Promise<void>;
  retention?: number;
}

/** Configuration for a one-shot timer that fires once and self-deletes. */
export interface TimerScheduleConfig {
  id: string;
  name: string;
  /** Delay in seconds before the timer fires. */
  delaySeconds: number;
  callback: (ctx: ScheduleCallbackContext) => Promise<void>;
}

export type ScheduleConfig = PromptScheduleConfig | CallbackScheduleConfig | TimerScheduleConfig;

/** Context passed to callback-based schedule handlers. */
export interface ScheduleCallbackContext {
  schedule: Schedule;
  sessionStore: SessionStore;
  emitCost: (cost: CostEvent) => void;
}

/** A schedule declaration with its owning capability tagged. */
export interface ResolvedScheduleDeclaration {
  config: ScheduleConfig;
  ownerId: string;
}
