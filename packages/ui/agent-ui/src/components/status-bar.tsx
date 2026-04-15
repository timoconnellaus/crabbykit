import {
  useActiveMode,
  useAgentConnection,
  useChatSession,
} from "@claw-for-cloudflare/agent-runtime/client";
import { type ComponentPropsWithoutRef, type ReactNode, useMemo } from "react";
import type { BrowserState } from "../hooks/use-browser";
import { BrowserBadge } from "./browser-badge";
import type { SandboxBadgeProps } from "./sandbox-badge";
import { SandboxBadge } from "./sandbox-badge";

export interface StatusBarProps extends ComponentPropsWithoutRef<"div"> {
  /** Sandbox state. Renders SandboxBadge when provided and elevated. */
  sandboxState?: SandboxBadgeProps;
  /** Browser state. Renders BrowserBadge when provided and open. */
  browserState?: BrowserState;
  /** Extra elements rendered after the default status indicators. */
  children?: ReactNode;
}

export function StatusBar({ sandboxState, browserState, children, ...props }: StatusBarProps) {
  const { connectionStatus } = useAgentConnection();
  const { agentStatus, costs } = useChatSession();
  const activeMode = useActiveMode();

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
      <span data-agent-ui="status-dot" title={connectionStatus} />

      {activeMode && (
        <span data-agent-ui="status-mode" data-mode-id={activeMode.id} title={activeMode.name}>
          Mode: {activeMode.name}
        </span>
      )}

      {sandboxState && <SandboxBadge {...sandboxState} />}

      {browserState && <BrowserBadge browserState={browserState} />}

      <span data-agent-ui="status-spacer" />

      {totalCost && <span data-agent-ui="status-cost">{totalCost}</span>}

      {children}
    </div>
  );
}
