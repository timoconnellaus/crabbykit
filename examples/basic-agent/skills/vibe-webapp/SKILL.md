---
name: Vibe Webapp
description: Fullstack Bun web app development with database via container-db, React frontend, Tailwind styling, live preview, and deployment. Load when building web apps in the sandbox.
version: 1.4.0
requiresCapabilities: [vibe-coder, sandbox]
---

# Vibe Webapp Development

Build fullstack web apps using Bun inside the sandbox container. Apps run on Bun.serve() with React frontends, persistent databases via container-db, and Tailwind styling.

## Project Structure

Create apps on `/workspace/` so files persist. Typical layout:

```
/workspace/my-app/
  package.json
  bunfig.toml        # (optional, for Tailwind plugin)
  server.ts          # Bun.serve() entry point
  index.html         # HTML entry with React mount
  app.tsx            # React frontend
  styles.css         # (optional) CSS/Tailwind
```

## Server Pattern (server.ts)

Use Bun.serve() with HTML imports and route-based API handlers.

Use `@crabbykit/container-db` for database access. Add it to package.json and run `bun install` — the package is pre-installed in the container.

```typescript
import { createDB } from "@crabbykit/container-db";
import homepage from "./index.html";

const db = createDB();

// Initialize schema
await db.exec(`CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
)`);

Bun.serve({
  hostname: "0.0.0.0",
  port: 3000,
  routes: {
    "/": homepage,
    "/api/items": {
      async GET() {
        const { rows, columns } = await db.exec("SELECT * FROM items ORDER BY id DESC");
        const items = rows.map(row =>
          Object.fromEntries(columns.map((col, i) => [col, row[i]]))
        );
        return Response.json(items);
      },
      async POST(req) {
        const { name } = await req.json();
        await db.exec("INSERT INTO items (name) VALUES (?)", [name]);
        return Response.json({ ok: true });
      },
    },
  },
  development: true,
});
```

## HTML Entry (index.html)

```html
<!DOCTYPE html>
<html>
<head>
  <title>My App</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./app.tsx"></script>
</body>
</html>
```

## React Frontend (app.tsx)

```tsx
import { createRoot } from "react-dom/client";
import { useState, useEffect } from "react";

function App() {
  const [items, setItems] = useState([]);

  useEffect(() => {
    fetch("/api/items").then(r => r.json()).then(setItems);
  }, []);

  return (
    <div>
      <h1>Items</h1>
      <ul>{items.map(item => <li key={item.id}>{item.name}</li>)}</ul>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
```

## Database (container-db)

Use `@crabbykit/container-db` for database access. Add it to package.json and run `bun install`. It works identically in dev (container) and deploy (worker).

```typescript
import { createDB } from "@crabbykit/container-db";
const db = createDB();

// Query returns { columns: string[], rows: unknown[][] }
const { columns, rows } = await db.exec("SELECT * FROM users WHERE active = ?", [true]);

// Batch multiple statements
await db.batch([
  { sql: "INSERT INTO items (name) VALUES (?)", params: ["A"] },
  { sql: "INSERT INTO items (name) VALUES (?)", params: ["B"] },
]);
```

Always use parameterized queries (`?` placeholders) — never interpolate values into SQL strings.

`@crabbykit/container-db` is pre-installed in the container and resolves automatically via `bun install`.

## AI Access

Apps can call AI models via the OpenAI SDK using the `ai.internal` virtual host:

```typescript
import OpenAI from "openai";
const ai = new OpenAI({
  baseURL: "http://ai.internal/v1",
  apiKey: "internal",
});

const response = await ai.chat.completions.create({
  model: "anthropic/claude-sonnet-4",
  messages: [{ role: "user", content: "Hello" }],
});
```

Both streaming and non-streaming are supported. Costs are tracked automatically.

## Styling with Tailwind

Install the Bun Tailwind plugin:

```bash
bun add bun-plugin-tailwind
```

Create bunfig.toml:

```toml
[serve.static]
plugins = ["bun-plugin-tailwind"]
```

Then use Tailwind classes in your components and import the CSS file in index.html.

## Dev Workflow

1. Create the project directory on /workspace/
2. Write all source files
3. `cd /workspace/my-app && bun install`
4. Start the server: `exec` with `background=true`: `cd /workspace/my-app && bun run server.ts`
5. Call `show_preview` with the server port (default 3000)
6. Iterate: edit files, the server auto-reloads with HMR
7. Use `get_console_logs` to check for frontend errors
8. Call `hide_preview` when done

When making changes after the server is running, just edit the files — Bun's dev mode handles HMR.
If the server crashes, restart it with exec.

## Deployment

Build and deploy using the deploy_app tool:

1. Build: `bun build --target=bun --production --outdir=dist server.ts`
2. Deploy with `deploy_app`:
   - `entryPoint`: path to the built server entry
   - `name`: app slug for the URL

Deployed apps are accessible at `/apps/{slug}/`.

For apps with backends, use `start_backend` first to bundle and load the backend worker.

## Common Mistakes

- **Not binding to 0.0.0.0**: The server MUST use `hostname: "0.0.0.0"` — localhost won't be reachable from outside the container
- **Using bun:sqlite instead of container-db**: Always use `@crabbykit/container-db` — bun:sqlite data doesn't persist across deploys
- **Absolute fetch paths**: Frontend fetch calls must use relative paths (`fetch("/api/items")`), not absolute URLs
- **Missing development: true**: Without `development: true` in Bun.serve(), HMR and console output won't work
- **Forgetting to restart after changes**: If you change server.ts structure (new routes, etc.), restart the server process
- **Missing container-db dependency**: Add `@crabbykit/container-db` to package.json — it's pre-installed in the container and resolves via `bun install`
