/**
 * Wrangler dev entry point. Extends E2EAgent with sandbox capability.
 * Separate from test-agent.ts to avoid importing @cloudflare/containers
 * in pool-workers (which doesn't support it).
 */

import type { Capability } from "@crabbykit/agent-runtime";
import type { AgentStorage } from "@crabbykit/agent-storage";
import { CloudflareSandboxProvider, SandboxContainer } from "@crabbykit/cloudflare-sandbox";
import { sandboxCapability } from "@crabbykit/sandbox";
import { E2EAgent } from "./test-agent";

interface DevEnv {
  AGENT: DurableObjectNamespace;
  SANDBOX_CONTAINER: DurableObjectNamespace;
  STORAGE_BUCKET: R2Bucket;
}

export class E2EAgentDev extends E2EAgent {
  protected getExtraCapabilities(storage: AgentStorage): Capability[] {
    const devEnv = this.env as unknown as DevEnv;
    if (!devEnv.SANDBOX_CONTAINER) return [];

    return [
      sandboxCapability({
        provider: new CloudflareSandboxProvider({
          storage,
          getStub: () => {
            const id = devEnv.SANDBOX_CONTAINER.idFromName(this.ctx.id.toString());
            return devEnv.SANDBOX_CONTAINER.get(id);
          },
        }),
        config: {
          idleTimeout: 60,
          defaultCwd: "/tmp",
        },
      }),
    ];
  }
}

export { SandboxContainer };

export default {
  async fetch(request: Request, env: DevEnv): Promise<Response> {
    const url = new URL(request.url);

    const agentMatch = url.pathname.match(/^\/agent\/([^/]+)(\/.*)?$/);
    if (agentMatch) {
      const agentId = agentMatch[1];
      const id = env.AGENT.idFromName(agentId);
      const stub = env.AGENT.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = agentMatch[2] || "/";
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    return new Response("E2E Agent Runtime (dev)");
  },
};
