import { useCallback, useState } from "react";

export interface RegistrySkill {
  id: string;
  name: string;
  description: string;
  version: string;
  requiresCapabilities: string[];
}

function baseUrl(agentId: string) {
  return `/agent/${agentId}`;
}

export function useSkillsApi(agentId: string | null) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState<RegistrySkill[]>([]);

  const fetchAvailable = useCallback(async () => {
    if (!agentId) return;
    try {
      const res = await fetch(`${baseUrl(agentId)}/skills/registry`);
      if (!res.ok) return;
      const data = (await res.json()) as RegistrySkill[];
      setAvailable(data);
    } catch {
      // Silently fail — registry browse is optional
    }
  }, [agentId]);

  const installSkill = useCallback(
    async (skillId: string): Promise<boolean> => {
      if (!agentId) return false;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${baseUrl(agentId)}/skills/install`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: skillId }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
        }
        // Refresh available list
        await fetchAvailable();
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        return false;
      } finally {
        setLoading(false);
      }
    },
    [agentId, fetchAvailable],
  );

  const uninstallSkill = useCallback(
    async (skillId: string): Promise<boolean> => {
      if (!agentId) return false;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${baseUrl(agentId)}/skills/uninstall`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: skillId }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
        }
        await fetchAvailable();
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        return false;
      } finally {
        setLoading(false);
      }
    },
    [agentId, fetchAvailable],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    available,
    fetchAvailable,
    installSkill,
    uninstallSkill,
    loading,
    error,
    clearError,
  };
}
