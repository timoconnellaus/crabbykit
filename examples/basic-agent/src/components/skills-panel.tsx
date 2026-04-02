import type { SkillListEntry } from "@claw-for-cloudflare/agent-runtime";

interface SkillsPanelProps {
  skills: SkillListEntry[];
}

const styles = {
  container: {
    flex: 1,
    padding: "1.5rem",
    overflow: "auto",
    fontFamily: "SF Mono, Fira Code, JetBrains Mono, ui-monospace, monospace",
    fontSize: "0.8rem",
    color: "var(--agent-ui-text)",
  },
  header: {
    fontSize: "0.9rem",
    fontWeight: 600,
    marginBottom: "1rem",
    color: "var(--agent-ui-text)",
  },
  card: {
    border: "1px solid var(--agent-ui-border)",
    borderRadius: "8px",
    padding: "0.75rem 1rem",
    marginBottom: "0.5rem",
    background: "var(--agent-ui-bg-secondary, #1a1a1a)",
  },
  row: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "0.25rem",
  },
  name: {
    fontWeight: 600,
  },
  version: {
    color: "var(--agent-ui-text-muted)",
    fontSize: "0.7rem",
  },
  description: {
    color: "var(--agent-ui-text-muted)",
    fontSize: "0.75rem",
    marginTop: "0.25rem",
  },
  badge: {
    display: "inline-block",
    padding: "0.1rem 0.4rem",
    borderRadius: "4px",
    fontSize: "0.65rem",
    fontWeight: 500,
    marginLeft: "0.5rem",
  },
  enabled: {
    background: "rgba(74, 222, 128, 0.15)",
    color: "rgb(74, 222, 128)",
  },
  disabled: {
    background: "rgba(156, 163, 175, 0.15)",
    color: "rgb(156, 163, 175)",
  },
  stale: {
    background: "rgba(251, 191, 36, 0.15)",
    color: "rgb(251, 191, 36)",
  },
  empty: {
    color: "var(--agent-ui-text-muted)",
    textAlign: "center" as const,
    padding: "2rem",
  },
} as const;

export function SkillsPanel({ skills }: SkillsPanelProps) {
  if (skills.length === 0) {
    return (
      <div style={styles.container}>
        <div style={styles.empty}>No skills installed</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>Installed Skills</div>
      {skills.map((skill) => (
        <div key={skill.id} style={styles.card}>
          <div style={styles.row}>
            <span>
              <span style={styles.name}>{skill.name}</span>
              <span style={styles.version}> v{skill.version}</span>
            </span>
            <span>
              <span
                style={{
                  ...styles.badge,
                  ...(skill.enabled ? styles.enabled : styles.disabled),
                }}
              >
                {skill.enabled ? "Enabled" : "Disabled"}
              </span>
              {skill.stale && (
                <span style={{ ...styles.badge, ...styles.stale }}>Update available</span>
              )}
              {skill.autoUpdate && (
                <span style={{ ...styles.badge, ...styles.disabled }}>Auto-update</span>
              )}
            </span>
          </div>
          <div style={styles.description}>{skill.description}</div>
        </div>
      ))}
    </div>
  );
}
