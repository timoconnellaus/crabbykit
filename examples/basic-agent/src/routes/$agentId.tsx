import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/$agentId")({
  ssr: false,
  component: () => <Outlet />,
});
