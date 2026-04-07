/// <reference types="vite/client" />
import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import "@claw-for-cloudflare/agent-ui/styles.css";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1.0" },
      { title: "Basic Agent" },
    ],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        <style>{`* { margin: 0; padding: 0; box-sizing: border-box; } html, body { height: 100%; color-scheme: light dark; } a { color: inherit; text-decoration: none; }`}</style>
      </head>
      <body>
        <div style={{ display: "flex", height: "100vh", width: "100vw" }}>
          {children}
        </div>
        <Scripts />
      </body>
    </html>
  );
}
