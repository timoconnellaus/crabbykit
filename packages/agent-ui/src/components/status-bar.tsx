import { type ComponentPropsWithoutRef, useMemo } from "react";
import { useChat } from "./chat-provider";
import type { SandboxBadgeProps } from "./sandbox-badge";
import { SandboxBadge } from "./sandbox-badge";

export interface StatusBarProps extends ComponentPropsWithoutRef<"div"> {
  /** Sandbox state. Renders SandboxBadge when provided and elevated. */
  sandboxState?: SandboxBadgeProps;
}

export function StatusBar({ sandboxState, ...props }: StatusBarProps) {
  const { connectionStatus, agentStatus, thinking, costs } = useChat();

  const totalCost = useMemo(() => {
    if (costs.length === 0) return null;
    const byCurrency = new Map<string, number>();
    for (const c of costs) {
      byCurrency.set(c.currency, (byCurrency.get(c.currency) ?? 0) + c.amount);
    }
    return Array.from(byCurrency.entries())
      .map(([currency, amount]) => `${amount.toFixed(4)} ${currency}`)
      .join(", ");
  }, [costs]);

  return (
    <div
      data-agent-ui="status-bar"
      data-connection={connectionStatus}
      data-agent-status={agentStatus}
      {...props}
    >
      <span data-agent-ui="status-connection">{connectionStatus}</span>

      {agentStatus !== "idle" && (
        <span data-agent-ui="status-agent">{agentStatus.replace("_", " ")}</span>
      )}

      {thinking && <span data-agent-ui="status-thinking">Thinking...</span>}

      {totalCost && <span data-agent-ui="status-cost">{totalCost}</span>}

      {sandboxState && <SandboxBadge {...sandboxState} />}
    </div>
  );
}
