import handler from "@tanstack/react-start/server-entry";

// Re-export DO classes for wrangler bindings
export {
  AiService,
  BackendStorage,
  BasicAgent,
  ContainerProxy,
  DbService,
  LlmService,
  SandboxContainer,
  SpineService,
} from "./worker";

export default {
  fetch: handler.fetch,
};
