import { useAgentChat } from "@claw-for-cloudflare/agent-runtime/client";
import { ChatPanel } from "@claw-for-cloudflare/agent-ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@claw-for-cloudflare/agent-ui/styles.css";

function App() {
  const chat = useAgentChat({
    url: `ws://${window.location.host}/agent`,
  });

  return <ChatPanel chat={chat} />;
}

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error('Root element with id "root" not found');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
