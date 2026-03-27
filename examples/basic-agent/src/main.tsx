import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { useAgentChat } from "@claw-for-cloudflare/agent-runtime/client";
import { ChatPanel } from "@claw-for-cloudflare/agent-ui";
import "@claw-for-cloudflare/agent-ui/styles.css";

function App() {
  const chat = useAgentChat({
    url: `ws://${window.location.host}/agent`,
  });

  return <ChatPanel chat={chat} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
