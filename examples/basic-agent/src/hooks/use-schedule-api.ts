import { useCallback, useState } from "react";

export interface ScheduleCreateInput {
  name: string;
  cron: string;
  prompt: string;
  enabled?: boolean;
  timezone?: string;
  maxDuration?: string;
  retention?: number;
}

export interface ScheduleUpdateInput {
  name?: string;
  cron?: string;
  prompt?: string;
  enabled?: boolean;
  timezone?: string;
  retention?: number;
}

export interface FullSchedule {
  id: string;
  name: string;
  cron: string;
  enabled: boolean;
  handlerType: string;
  prompt: string | null;
  sessionPrefix: string | null;
  ownerId: string | null;
  nextFireAt: string | null;
  lastFiredAt: string | null;
  timezone: string | null;
  expiresAt: string | null;
  status: string;
  lastError: string | null;
  retention: number;
  createdAt: string;
  updatedAt: string;
}

function baseUrl(agentId: string) {
  return `/agent/${agentId}/schedules`;
}

export function useScheduleApi(agentId: string | null) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createSchedule = useCallback(
    async (data: ScheduleCreateInput): Promise<FullSchedule | null> => {
      if (!agentId) return null;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(baseUrl(agentId), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
        }
        return (await res.json()) as FullSchedule;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [agentId],
  );

  const updateSchedule = useCallback(
    async (scheduleId: string, data: ScheduleUpdateInput): Promise<FullSchedule | null> => {
      if (!agentId) return null;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${baseUrl(agentId)}/${scheduleId}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
        }
        return (await res.json()) as FullSchedule;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [agentId],
  );

  const deleteSchedule = useCallback(
    async (scheduleId: string): Promise<boolean> => {
      if (!agentId) return false;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${baseUrl(agentId)}/${scheduleId}`, {
          method: "DELETE",
        });
        if (!res.ok && res.status !== 204) {
          throw new Error(`HTTP ${res.status}`);
        }
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        return false;
      } finally {
        setLoading(false);
      }
    },
    [agentId],
  );

  const getSchedule = useCallback(
    async (scheduleId: string): Promise<FullSchedule | null> => {
      if (!agentId) return null;
      setError(null);
      try {
        const res = await fetch(`${baseUrl(agentId)}/${scheduleId}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
        }
        return (await res.json()) as FullSchedule;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        return null;
      }
    },
    [agentId],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    createSchedule,
    updateSchedule,
    deleteSchedule,
    getSchedule,
    loading,
    error,
    clearError,
  };
}
