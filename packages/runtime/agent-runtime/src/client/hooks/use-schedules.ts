import { useCallback } from "react";
import { useAgentConnection } from "../agent-connection-provider.js";

export interface ScheduleInfo {
  id: string;
  name: string;
  cron: string;
  enabled: boolean;
  status: string;
  nextFireAt: string | null;
  expiresAt: string | null;
  lastFiredAt: string | null;
}

export interface UseSchedulesReturn {
  schedules: ScheduleInfo[];
  toggleSchedule: (scheduleId: string, enabled: boolean) => void;
}

/**
 * Subscribes to the "schedules" capability state and exposes a toggle action.
 */
export function useSchedules(): UseSchedulesReturn {
  const { send, state } = useAgentConnection();

  const data = state.capabilityState.schedules as { schedules?: ScheduleInfo[] } | undefined;
  const schedules = data?.schedules ?? [];

  const toggleSchedule = useCallback(
    (scheduleId: string, enabled: boolean) => {
      if (!state.currentSessionId) return;
      send({
        type: "capability_action",
        capabilityId: "schedules",
        action: "toggle",
        data: { scheduleId, enabled },
        sessionId: state.currentSessionId,
      });
    },
    [send, state.currentSessionId],
  );

  return { schedules, toggleSchedule };
}
