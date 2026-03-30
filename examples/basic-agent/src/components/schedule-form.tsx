import { useState } from "react";

const CRON_PRESETS = [
  { label: "Custom", value: "" },
  { label: "Every 15 minutes", value: "*/15 * * * *" },
  { label: "Every 30 minutes", value: "*/30 * * * *" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every 4 hours", value: "0 */4 * * *" },
  { label: "Daily at 9 AM", value: "0 9 * * *" },
  { label: "Daily at 6 PM", value: "0 18 * * *" },
  { label: "Twice daily (9 AM & 6 PM)", value: "0 9,18 * * *" },
  { label: "Daily at midnight", value: "0 0 * * *" },
  { label: "Weekday mornings", value: "0 9 * * MON-FRI" },
  { label: "Monday & Friday", value: "0 9 * * MON,FRI" },
  { label: "Weekends", value: "0 10 * * SAT,SUN" },
];

let timezones: string[] | null = null;
function getTimezones(): string[] {
  if (!timezones) {
    timezones = Intl.supportedValuesOf("timeZone");
  }
  return timezones;
}

export interface ScheduleFormData {
  name: string;
  cron: string;
  prompt: string;
  timezone?: string;
  retention?: number;
}

export function ScheduleForm({
  initialData,
  onSave,
  onCancel,
  loading,
  error,
}: {
  initialData?: ScheduleFormData;
  onSave: (data: ScheduleFormData) => void;
  onCancel: () => void;
  loading: boolean;
  error: string | null;
}) {
  const [name, setName] = useState(initialData?.name ?? "");
  const [cron, setCron] = useState(initialData?.cron ?? "");
  const [prompt, setPrompt] = useState(initialData?.prompt ?? "");
  const [timezone, setTimezone] = useState(initialData?.timezone ?? "");
  const [retention, setRetention] = useState(initialData?.retention?.toString() ?? "");
  const [selectedPreset, setSelectedPreset] = useState(() => {
    const match = CRON_PRESETS.find((p) => p.value === (initialData?.cron ?? ""));
    return match?.value ?? "";
  });

  const isEdit = !!initialData;
  const canSave = name.trim() !== "" && cron.trim() !== "" && prompt.trim() !== "";

  function handlePresetChange(value: string) {
    setSelectedPreset(value);
    if (value) setCron(value);
  }

  function handleCronInput(value: string) {
    setCron(value);
    const match = CRON_PRESETS.find((p) => p.value === value);
    setSelectedPreset(match?.value ?? "");
  }

  function handleSubmit() {
    if (!canSave) return;
    onSave({
      name: name.trim(),
      cron: cron.trim(),
      prompt: prompt.trim(),
      timezone: timezone || undefined,
      retention: retention ? Number.parseInt(retention, 10) : undefined,
    });
  }

  return (
    <div data-agent-ui="schedule-form">
      <div data-agent-ui="schedule-form-title">{isEdit ? "Edit Schedule" : "New Schedule"}</div>

      <div data-agent-ui="schedule-form-field">
        <label data-agent-ui="schedule-form-label" htmlFor="sched-name">
          Name
        </label>
        <input
          id="sched-name"
          data-agent-ui="schedule-form-input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Morning summary"
        />
      </div>

      <div data-agent-ui="schedule-form-field">
        <label data-agent-ui="schedule-form-label" htmlFor="sched-prompt">
          Prompt
        </label>
        <textarea
          id="sched-prompt"
          data-agent-ui="schedule-form-textarea"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What should the agent do on this schedule?"
          rows={3}
        />
      </div>

      <div data-agent-ui="schedule-form-field">
        <label data-agent-ui="schedule-form-label" htmlFor="sched-cron-preset">
          Schedule
        </label>
        <div data-agent-ui="schedule-form-row">
          <select
            id="sched-cron-preset"
            data-agent-ui="schedule-form-select"
            value={selectedPreset}
            onChange={(e) => handlePresetChange(e.target.value)}
            style={{ flex: 1 }}
          >
            {CRON_PRESETS.map((p) => (
              <option key={p.label} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <input
          data-agent-ui="schedule-form-input"
          type="text"
          value={cron}
          onChange={(e) => handleCronInput(e.target.value)}
          placeholder="*/15 * * * *"
          aria-label="Cron expression"
        />
        <div data-agent-ui="schedule-form-hint">5-field cron: minute hour day month weekday</div>
      </div>

      <div data-agent-ui="schedule-form-row">
        <div data-agent-ui="schedule-form-field" style={{ flex: 1 }}>
          <label data-agent-ui="schedule-form-label" htmlFor="sched-tz">
            Timezone (optional)
          </label>
          <select
            id="sched-tz"
            data-agent-ui="schedule-form-select"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          >
            <option value="">Agent default</option>
            {getTimezones().map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </div>
        <div data-agent-ui="schedule-form-field" style={{ width: 80 }}>
          <label data-agent-ui="schedule-form-label" htmlFor="sched-retention">
            Retention
          </label>
          <input
            id="sched-retention"
            data-agent-ui="schedule-form-input"
            type="number"
            value={retention}
            onChange={(e) => setRetention(e.target.value)}
            placeholder="10"
            min={1}
          />
        </div>
      </div>

      {error && <div data-agent-ui="schedule-form-error">{error}</div>}

      <div data-agent-ui="schedule-form-actions">
        <button
          type="button"
          data-agent-ui="schedule-form-btn"
          onClick={onCancel}
          disabled={loading}
        >
          Cancel
        </button>
        <button
          type="button"
          data-agent-ui="schedule-form-btn"
          data-primary=""
          onClick={handleSubmit}
          disabled={!canSave || loading}
        >
          {loading ? "Saving..." : isEdit ? "Update" : "Create"}
        </button>
      </div>
    </div>
  );
}
