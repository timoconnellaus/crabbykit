# loader-agent

Minimal example: a Durable Object agent whose "brain" lives in R2 and is loaded
at runtime via Worker Loader. Edit the brain, rerun `/chat`, and the new logic
runs without redeploying the worker.

This example deliberately does NOT use any `@crabbykit/*` packages.
It isolates the loader pattern in the smallest possible artifact.

## Architecture

- `src/server.ts` — top-level worker. Exposes `/seed`, `GET /runtime`,
  `PUT /runtime` for managing the brain in R2. Everything else routes to the
  singleton Durable Object.
- `src/loader-agent.ts` — the DO. Holds persistent chat history in its storage.
  On each `/chat` turn it `HEAD`s the R2 object, uses the etag as the loader
  cache key, `LOADER.get()`s the dynamically-loaded worker, and calls into it
  with `{ prompt, history }`. The brain calls `env.AI.run()` and returns text.
- The brain itself is a tiny ES module stored at `agents/main/runtime.js` in R2.
  Its default seed lives as a string constant in `server.ts`.

Because the loader cache key is the R2 etag, updating the object in R2
invalidates the cache automatically — the next turn recompiles the new source.

## Run locally

```
cd examples/loader-agent
bun run dev
```

## Demo loop

Seed the default brain into R2:

```
curl -X POST http://localhost:8787/seed
```

Chat once (response includes the current `runtimeEtag`):

```
curl -X POST http://localhost:8787/chat \
  -H 'content-type: application/json' \
  -d '{"prompt":"hello, who are you?"}'
```

Replace the brain with a new version that changes the system prompt:

```
curl -X PUT http://localhost:8787/runtime \
  -H 'content-type: application/javascript' \
  --data-binary $'export default {\n  async fetch(request, env) {\n    const { prompt, history } = await request.json();\n    const messages = [\n      { role: "system", content: "You are a grumpy pirate. Keep replies under 20 words." },\n      ...history,\n      { role: "user", content: prompt },\n    ];\n    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", { messages });\n    return Response.json({ response: result.response });\n  },\n};\n'
```

Chat again — the etag in the response will have changed and the assistant will
now talk like a pirate without a redeploy:

```
curl -X POST http://localhost:8787/chat \
  -H 'content-type: application/json' \
  -d '{"prompt":"hello, who are you?"}'
```

Inspect history or reset:

```
curl http://localhost:8787/history
curl -X POST http://localhost:8787/reset
```
