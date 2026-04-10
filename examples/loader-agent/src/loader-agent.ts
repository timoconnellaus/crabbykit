import { DurableObject } from "cloudflare:workers";
import type { Env } from "./server";

const RUNTIME_KEY = "agents/main/runtime.js";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export class LoaderAgent extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/chat" && req.method === "POST") {
      const { prompt } = (await req.json()) as { prompt: string };
      if (!prompt) return new Response("missing prompt\n", { status: 400 });
      return this.runTurn(prompt);
    }

    if (url.pathname === "/history" && req.method === "GET") {
      return Response.json(await this.loadHistory());
    }

    if (url.pathname === "/reset" && req.method === "POST") {
      await this.ctx.storage.deleteAll();
      return new Response("reset\n");
    }

    return new Response("not found\n", { status: 404 });
  }

  private async runTurn(prompt: string): Promise<Response> {
    // Etag-based cache key — auto-invalidates when the file is edited.
    const head = await this.env.STORAGE_BUCKET.head(RUNTIME_KEY);
    if (!head) {
      return new Response("no runtime in R2 — POST /seed first\n", { status: 503 });
    }
    const cacheKey = `runtime:${head.etag}`;

    const worker = this.env.LOADER.get(cacheKey, async () => {
      const obj = await this.env.STORAGE_BUCKET.get(RUNTIME_KEY);
      if (!obj) throw new Error("runtime disappeared between head and get");
      const source = await obj.text();
      return {
        compatibilityDate: "2025-12-01",
        mainModule: "runtime.js",
        modules: { "runtime.js": source },
        // Pass the AI service binding (not the raw Ai binding) — service
        // bindings can cross isolate boundaries; Ai bindings can't.
        env: { AI: this.env.AI_SERVICE },
      };
    });

    const history = await this.loadHistory();
    const res = await worker.getEntrypoint().fetch(
      new Request("https://runtime/turn", {
        method: "POST",
        body: JSON.stringify({ prompt, history }),
      }),
    );

    if (!res.ok) {
      const text = await res.text();
      return new Response(`runtime error: ${text}\n`, { status: 500 });
    }

    const { response } = (await res.json()) as { response: string };

    history.push({ role: "user", content: prompt });
    history.push({ role: "assistant", content: response });
    await this.ctx.storage.put<ChatMessage[]>("history", history);

    return Response.json({ response, runtimeEtag: head.etag });
  }

  private async loadHistory(): Promise<ChatMessage[]> {
    return (await this.ctx.storage.get<ChatMessage[]>("history")) ?? [];
  }
}
