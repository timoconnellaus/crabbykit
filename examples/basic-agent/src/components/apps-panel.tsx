import { appsStyles } from "../styles/apps";

interface AppSummary {
  id: string;
  name: string;
  slug: string;
  currentVersion: number;
  hasBackend: boolean;
  lastDeployedAt: string;
  commitHash: string;
  commitMessage: string | null;
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

function AppCard({ app }: { app: AppSummary }) {
  const appUrl = `/api/apps/${app.slug}/`;

  return (
    <div data-agent-ui="app-card">
      <div data-agent-ui="app-card-info">
        <div data-agent-ui="app-card-name">
          {app.name}
          {app.hasBackend && (
            <>
              {" "}
              <span data-agent-ui="app-backend-badge">full-stack</span>
            </>
          )}
        </div>
        <div data-agent-ui="app-card-meta">
          <span data-agent-ui="app-card-version">v{app.currentVersion}</span>
          {app.commitHash && (
            <span data-agent-ui="app-card-commit">
              {app.commitHash.slice(0, 7)}
              {app.commitMessage ? ` — ${app.commitMessage}` : ""}
            </span>
          )}
          <span>{relativeTime(app.lastDeployedAt)}</span>
        </div>
      </div>
      <div data-agent-ui="app-card-actions">
        <a href={appUrl} target="_blank" rel="noopener noreferrer" data-agent-ui="app-action-btn">
          Open
        </a>
      </div>
    </div>
  );
}

export function AppsPanel({ apps }: { apps: AppSummary[] }) {
  return (
    <>
      <style>{appsStyles}</style>
      <div data-agent-ui="apps-panel">
        <div data-agent-ui="apps-panel-header">
          <span data-agent-ui="apps-panel-title">Deployed Apps</span>
        </div>

        {apps.length === 0 ? (
          <div data-agent-ui="apps-empty">
            <div data-agent-ui="apps-empty-title">No apps deployed yet</div>
            <div>Ask the agent to build and deploy an app</div>
          </div>
        ) : (
          <div data-agent-ui="apps-panel-list">
            {apps.map((app) => (
              <AppCard key={app.id} app={app} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
