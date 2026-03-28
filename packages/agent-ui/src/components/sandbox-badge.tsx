import { useEffect, useState } from "react";

export interface SandboxBadgeProps {
  /** Whether the sandbox is currently elevated. */
  elevated: boolean;
  /** Unix timestamp (ms) when auto-de-elevation will fire. */
  expiresAt?: number | null;
  /** Total timeout duration in seconds (for progress calculation). */
  timeoutSeconds?: number | null;
}

/**
 * Displays sandbox elevation status with a countdown progress indicator.
 * Uses `data-agent-ui="sandbox-badge"` for styling.
 */
export function SandboxBadge({ elevated, expiresAt, timeoutSeconds }: SandboxBadgeProps) {
  const [now, setNow] = useState(Date.now());

  // Tick every second for countdown
  useEffect(() => {
    if (!elevated || !expiresAt) return;

    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [elevated, expiresAt]);

  if (!elevated) return null;

  const remainingMs = expiresAt ? Math.max(0, expiresAt - now) : 0;
  const totalMs = (timeoutSeconds ?? 0) * 1000;
  const pct = totalMs > 0 ? (remainingMs / totalMs) * 100 : 100;
  const remainingSec = Math.ceil(remainingMs / 1000);

  const formatTime = (sec: number) => {
    if (sec >= 60) {
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return s > 0 ? `${m}m ${s}s` : `${m}m`;
    }
    return `${sec}s`;
  };

  return (
    <span
      data-agent-ui="sandbox-badge"
      data-elevated={elevated}
      style={{
        background: totalMs
          ? `linear-gradient(90deg, rgba(16,185,129,0.15) ${pct}%, rgba(16,185,129,0.05) ${pct}%)`
          : "rgba(16,185,129,0.15)",
      }}
    >
      <span data-agent-ui="sandbox-badge-dot" />
      <span data-agent-ui="sandbox-badge-label">Sandbox</span>
      {expiresAt && remainingSec > 0 && (
        <span data-agent-ui="sandbox-badge-timer">{formatTime(remainingSec)}</span>
      )}
    </span>
  );
}
