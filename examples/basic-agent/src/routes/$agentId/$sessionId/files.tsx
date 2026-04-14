import { createFileRoute } from "@tanstack/react-router";

// FilesPanel is rendered by the parent session layout with a display
// toggle so tree state + open file persist across tab switches. This
// route file only exists so the `/files` URL matches and the parent
// layout's `activeTab` memo resolves to "files".
export const Route = createFileRoute("/$agentId/$sessionId/files")({
  component: () => null,
});
