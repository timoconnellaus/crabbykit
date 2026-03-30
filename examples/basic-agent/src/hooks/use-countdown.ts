import { useEffect, useState } from "react";

function formatCountdown(ms: number): string {
  if (ms <= 0) return "overdue";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `in ${hours}h ${minutes}m`;
  if (minutes > 0) return `in ${minutes}m ${seconds}s`;
  return `in ${seconds}s`;
}

export function useCountdown(targetIso: string | null): string | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!targetIso) return;
    const targetMs = new Date(targetIso).getTime();
    const remaining = targetMs - Date.now();

    // Update frequency: every second when < 1 hour, every minute otherwise
    const intervalMs = remaining < 3600_000 ? 1000 : 60_000;

    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [targetIso]);

  if (!targetIso) return null;
  const remaining = new Date(targetIso).getTime() - now;
  return formatCountdown(remaining);
}
