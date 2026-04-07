import type { AgentContext, ScheduleCallbackContext } from "@claw-for-cloudflare/agent-runtime";

const IDLE_PREFIX = "browserbase:idle:";
const MAX_PREFIX = "browserbase:max:";

export function idleTimerId(sessionId: string): string {
  return `${IDLE_PREFIX}${sessionId}`;
}

export function maxTimerId(sessionId: string): string {
  return `${MAX_PREFIX}${sessionId}`;
}

/**
 * Set or reset the idle timer for a browser session.
 * On first call (from browser_open), pass the callback. On subsequent calls
 * (from other tools), the callback is preserved by setTimer internally.
 */
export async function resetIdleTimer(
  sessionId: string,
  context: AgentContext,
  timeoutSeconds: number,
  callback?: (ctx: ScheduleCallbackContext) => Promise<void>,
): Promise<void> {
  await context.schedules.setTimer(idleTimerId(sessionId), timeoutSeconds, callback);
}

/**
 * Set the max-duration timer for a browser session.
 * Called once from browser_open with the callback.
 */
export async function setMaxTimer(
  sessionId: string,
  context: AgentContext,
  timeoutSeconds: number,
  callback: (ctx: ScheduleCallbackContext) => Promise<void>,
): Promise<void> {
  await context.schedules.setTimer(maxTimerId(sessionId), timeoutSeconds, callback);
}

/** Cancel both idle and max timers for a browser session. */
export async function cancelTimers(sessionId: string, context: AgentContext): Promise<void> {
  await context.schedules.cancelTimer(idleTimerId(sessionId));
  await context.schedules.cancelTimer(maxTimerId(sessionId));
}
