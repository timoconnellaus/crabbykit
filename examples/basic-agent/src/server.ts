import handler from "@tanstack/react-start/server-entry";

// Re-export DO classes for wrangler bindings
export {
  BasicAgent,
  AiService,
  BackendStorage,
  ContainerProxy,
  DbService,
  SandboxContainer,
} from "./worker";

export default {
  fetch: handler.fetch,
};
