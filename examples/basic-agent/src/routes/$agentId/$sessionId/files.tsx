import { FilesPanel } from "@claw-for-cloudflare/agent-ui";
import { createFileRoute } from "@tanstack/react-router";
import { filesStyles } from "../../../styles/files";

export const Route = createFileRoute("/$agentId/$sessionId/files")({
  component: FilesRoute,
});

function FilesRoute() {
  return (
    <>
      <style>{filesStyles}</style>
      <FilesPanel />
    </>
  );
}
