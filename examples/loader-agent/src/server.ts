import { WorkerEntrypoint } from "cloudflare:workers";

export { LoaderAgent } from "./loader-agent";

// The default brain. Embedded here as a string so the example has zero build
// complexity — no Vite text imports, no wrangler text rules, just a literal.
// Edit this constant to change the seed; edit via `PUT /runtime` at runtime to
// hot-swap without redeploying. Note: inside the loaded isolate, `env.AI` is a
// service-binding stub to AiService (below), not the raw Ai binding — Ai
// bindings aren't cloneable across loader boundaries.
const DEFAULT_RUNTIME_SOURCE = `export default {
  async fetch(request, env) {
    const { prompt, history } = await request.json();
    const messages = [
      { role: "system", content: "You are a friendly, concise assistant." },
      ...history,
      { role: "user", content: prompt },
    ];
    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", { messages });
    return Response.json({ response: result.response });
  },
};
`;

const RUNTIME_KEY = "agents/main/runtime.js";

export interface Env {
  AGENT: DurableObjectNamespace;
  AI: Ai;
  AI_SERVICE: Service<AiService>;
  STORAGE_BUCKET: R2Bucket;
  LOADER: WorkerLoader;
}

// AI proxy entrypoint. The loader isolate can't receive the raw `Ai` binding
// (not structured-cloneable), so we expose it via a service binding back to
// this same worker. The loaded brain calls `env.AI.run(...)` which RPCs here.
export class AiService extends WorkerEntrypoint<Env> {
  async run(model: string, inputs: unknown, options?: unknown): Promise<unknown> {
    const ai = this.env.AI as unknown as {
      run: (model: string, inputs: unknown, options?: unknown) => Promise<unknown>;
    };
    return ai.run(model, inputs, options);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/seed" && req.method === "POST") {
      await env.STORAGE_BUCKET.put(RUNTIME_KEY, DEFAULT_RUNTIME_SOURCE);
      return new Response("seeded\n");
    }

    if (url.pathname === "/runtime" && req.method === "PUT") {
      const body = await req.text();
      if (!body) return new Response("empty body\n", { status: 400 });
      await env.STORAGE_BUCKET.put(RUNTIME_KEY, body);
      return new Response("updated\n");
    }

    if (url.pathname === "/runtime" && req.method === "GET") {
      const obj = await env.STORAGE_BUCKET.get(RUNTIME_KEY);
      if (!obj) return new Response("not seeded\n", { status: 404 });
      return new Response(obj.body, {
        headers: { "content-type": "application/javascript; charset=utf-8" },
      });
    }

    const id = env.AGENT.idFromName("default");
    return env.AGENT.get(id).fetch(req);
  },
} satisfies ExportedHandler<Env>;
