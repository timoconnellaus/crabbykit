import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

export interface AgentRecord {
  id: string;
  name: string;
  status: string;
  createdAt: string;
}

export function AgentPicker({
  agents,
  selectedId,
  onCreateAgent,
}: {
  agents: AgentRecord[];
  selectedId: string | null;
  onCreateAgent: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selected = agents.find((a) => a.id === selectedId) ?? null;

  const handleSelect = useCallback(
    (id: string) => {
      setOpen(false);
      if (id === selectedId) return;
      navigate({
        to: "/$agentId/$sessionId/chat",
        params: { agentId: id, sessionId: "latest" },
      });
    },
    [navigate, selectedId],
  );

  const handleCreate = useCallback(() => {
    setOpen(false);
    onCreateAgent();
  }, [onCreateAgent]);

  return (
    <div ref={rootRef} data-agent-ui="agent-picker">
      <button
        type="button"
        data-agent-ui="agent-picker-trigger"
        data-open={open || undefined}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span data-agent-ui="agent-picker-label">agent</span>
        <span data-agent-ui="agent-picker-dot" />
        <span data-agent-ui="agent-picker-name">{selected?.name ?? "—"}</span>
        <svg
          data-agent-ui="agent-picker-chevron"
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M2 3.5L5 6.5L8 3.5"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div data-agent-ui="agent-picker-menu" role="listbox">
          <div data-agent-ui="agent-picker-menu-header">
            <span>all agents</span>
            <span data-agent-ui="agent-picker-count">
              {agents.length.toString().padStart(2, "0")}
            </span>
          </div>
          <div data-agent-ui="agent-picker-menu-list">
            {agents.length === 0 && <div data-agent-ui="agent-picker-empty">no agents yet</div>}
            {agents.map((a) => (
              <button
                key={a.id}
                type="button"
                role="option"
                aria-selected={a.id === selectedId}
                data-agent-ui="agent-picker-item"
                data-active={a.id === selectedId || undefined}
                onClick={() => handleSelect(a.id)}
              >
                <span data-agent-ui="agent-picker-item-dot" />
                <span data-agent-ui="agent-picker-item-name">{a.name}</span>
                {a.id === selectedId && <span data-agent-ui="agent-picker-item-mark">active</span>}
              </button>
            ))}
          </div>
          <button type="button" data-agent-ui="agent-picker-create" onClick={handleCreate}>
            <span data-agent-ui="agent-picker-plus">+</span>
            <span>new agent</span>
          </button>
        </div>
      )}
    </div>
  );
}
