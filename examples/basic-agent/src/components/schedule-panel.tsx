import { useCallback, useState } from "react";
import { useCountdown } from "../hooks/use-countdown";
import { useScheduleApi } from "../hooks/use-schedule-api";
import { scheduleStyles } from "../styles/schedule";
import type { ScheduleFormData } from "./schedule-form";
import { ScheduleForm } from "./schedule-form";

interface ScheduleSummary {
  id: string;
  name: string;
  cron: string;
  enabled: boolean;
  status: string;
  nextFireAt: string | null;
  expiresAt: string | null;
  lastFiredAt: string | null;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function ScheduleCard({
  schedule,
  onToggle,
  onEdit,
  onDelete,
}: {
  schedule: ScheduleSummary;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const countdown = useCountdown(schedule.enabled ? schedule.nextFireAt : null);

  return (
    <div data-agent-ui="schedule-card" data-disabled={!schedule.enabled || undefined}>
      <span
        data-agent-ui="schedule-status-dot"
        data-status={schedule.enabled ? schedule.status : "idle"}
        title={schedule.status}
      />
      <div data-agent-ui="schedule-card-info">
        <div data-agent-ui="schedule-card-name">{schedule.name}</div>
        <div data-agent-ui="schedule-card-meta">
          <span>{schedule.cron}</span>
          {countdown && <span>{countdown}</span>}
          {schedule.lastFiredAt && <span>last: {relativeTime(schedule.lastFiredAt)}</span>}
        </div>
      </div>
      <div data-agent-ui="schedule-card-actions">
        <button type="button" data-agent-ui="schedule-action-btn" title="Edit" onClick={onEdit}>
          &#9998;
        </button>
        <button
          type="button"
          data-agent-ui="schedule-action-btn"
          data-danger=""
          title="Delete"
          onClick={onDelete}
        >
          &times;
        </button>
        <button
          type="button"
          data-agent-ui="schedule-toggle"
          data-on={schedule.enabled || undefined}
          role="switch"
          aria-checked={schedule.enabled}
          onClick={onToggle}
          title={schedule.enabled ? "Disable" : "Enable"}
        >
          <span data-agent-ui="schedule-toggle-knob" />
        </button>
      </div>
    </div>
  );
}

export function SchedulePanel({
  agentId,
  schedules,
  toggleSchedule,
}: {
  agentId: string;
  schedules: ScheduleSummary[];
  toggleSchedule: (id: string, enabled: boolean) => void;
}) {
  const api = useScheduleApi(agentId);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editData, setEditData] = useState<ScheduleFormData | undefined>();

  const handleCreate = useCallback(
    async (data: ScheduleFormData) => {
      const result = await api.createSchedule({
        name: data.name,
        cron: data.cron,
        prompt: data.prompt,
        timezone: data.timezone,
        retention: data.retention,
      });
      if (result) {
        setShowForm(false);
      }
    },
    [api],
  );

  const handleEdit = useCallback(
    async (scheduleId: string) => {
      const full = await api.getSchedule(scheduleId);
      if (full) {
        setEditData({
          name: full.name,
          cron: full.cron,
          prompt: full.prompt ?? "",
          timezone: full.timezone ?? undefined,
          retention: full.retention,
        });
        setEditingId(scheduleId);
        setShowForm(false);
      }
    },
    [api],
  );

  const handleUpdate = useCallback(
    async (data: ScheduleFormData) => {
      if (!editingId) return;
      const result = await api.updateSchedule(editingId, {
        name: data.name,
        cron: data.cron,
        prompt: data.prompt,
        timezone: data.timezone,
        retention: data.retention,
      });
      if (result) {
        setEditingId(null);
        setEditData(undefined);
      }
    },
    [api, editingId],
  );

  const handleDelete = useCallback(
    async (scheduleId: string) => {
      if (!confirm("Delete this schedule?")) return;
      await api.deleteSchedule(scheduleId);
    },
    [api],
  );

  const handleCancelForm = useCallback(() => {
    setShowForm(false);
    setEditingId(null);
    setEditData(undefined);
    api.clearError();
  }, [api]);

  return (
    <>
      <style>{scheduleStyles}</style>
      <div data-agent-ui="schedule-panel">
        <div data-agent-ui="schedule-panel-header">
          <span data-agent-ui="schedule-panel-title">Schedules</span>
          <button
            type="button"
            data-agent-ui="schedule-panel-add"
            onClick={() => {
              setEditingId(null);
              setEditData(undefined);
              setShowForm(true);
            }}
          >
            + New
          </button>
        </div>

        {showForm && (
          <ScheduleForm
            onSave={handleCreate}
            onCancel={handleCancelForm}
            loading={api.loading}
            error={api.error}
          />
        )}

        {editingId && (
          <ScheduleForm
            initialData={editData}
            onSave={handleUpdate}
            onCancel={handleCancelForm}
            loading={api.loading}
            error={api.error}
          />
        )}

        {schedules.length === 0 && !showForm ? (
          <div data-agent-ui="schedule-empty">
            <div data-agent-ui="schedule-empty-title">No schedules yet</div>
            <div>Create a schedule to run prompts automatically</div>
          </div>
        ) : (
          <div data-agent-ui="schedule-panel-list">
            {schedules.map((s) => (
              <ScheduleCard
                key={s.id}
                schedule={s}
                onToggle={() => toggleSchedule(s.id, !s.enabled)}
                onEdit={() => handleEdit(s.id)}
                onDelete={() => handleDelete(s.id)}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
