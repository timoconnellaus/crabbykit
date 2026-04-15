import { useEffect, useState } from "react";
import type { BrowserState } from "../hooks/use-browser";

export interface BrowserBadgeProps {
  /** Browser panel state from useBrowser() hook. */
  browserState: BrowserState;
}

/**
 * Displays browser session status with idle timeout countdown.
 * Uses `data-agent-ui="browser-badge"` for styling.
 */
export function BrowserBadge({ browserState }: BrowserBadgeProps) {
  const [now, setNow] = useState(Date.now());

  const { open, expiresAt, timeoutSeconds } = browserState;

  // Tick every second for countdown
  useEffect(() => {
    if (!open || !expiresAt) return;

    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [open, expiresAt]);

  if (!open) return null;

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
      data-agent-ui="browser-badge"
      style={{
        background: totalMs
          ? `linear-gradient(90deg, rgba(6,182,212,0.15) ${pct}%, rgba(6,182,212,0.04) ${pct}%)`
          : "rgba(6,182,212,0.12)",
      }}
    >
      <span data-agent-ui="browser-badge-dot" />
      <span data-agent-ui="browser-badge-label">Browser</span>
      {expiresAt && remainingSec > 0 && (
        <span data-agent-ui="browser-badge-timer">{formatTime(remainingSec)}</span>
      )}
    </span>
  );
}
