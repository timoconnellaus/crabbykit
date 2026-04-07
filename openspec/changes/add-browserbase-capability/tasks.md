## 1. Package Scaffolding

- [x] 1.1 Create `packages/browserbase/` with package.json, tsconfig.json, and barrel index.ts (follow r2-storage package as template for structure and dependencies)
- [x] 1.2 Add `packages/browserbase` to workspace in root package.json
- [x] 1.3 Create `packages/browserbase/src/types.ts` with all type definitions: `BrowserbaseOptions`, `BrowserState`, `Cookie`, `BrowserSession`, `ActiveSession`, CDP message types

## 2. Browserbase REST Client

- [x] 2.1 Implement `BrowserbaseClient` class in `browserbase-client.ts` with methods: `createSession`, `releaseSession`, `getDebugUrls`, `createContext` (plain fetch, Workers-compatible)
- [x] 2.2 Write tests for `BrowserbaseClient` — mock fetch responses for each endpoint, verify request shapes and headers

## 3. CDP Client

- [x] 3.1 Implement `CDPClient` class in `cdp-client.ts` — WebSocket connect, JSON-RPC send with promise tracking, event listener registration, connection state management
- [x] 3.2 Write tests for `CDPClient` — mock WebSocket, test send/receive, error handling on closed connection, event dispatch

## 4. Snapshot Engine

- [x] 4.1 Implement `snapshot.ts` — format `Accessibility.getFullAXTree` CDP response into indented ref-annotated text. Port role classification (INTERACTIVE_ROLES, CONTENT_ROLES, STRUCTURAL_ROLES) and ref generation from agent-browser
- [x] 4.2 Implement ref resolution — given a ref ID, return the corresponding AX node's backendDOMNodeId for use by click/type tools
- [x] 4.3 Write tests for snapshot formatting — test with sample AX tree data, verify ref assignment, interactive-only filtering, depth limiting

## 5. Cookie Merge

- [x] 5.1 Implement `cookie-merge.ts` — `mergeCookies(stored, incoming)` with domain+path+name keying, newer-expiry-wins, expired cookie pruning
- [x] 5.2 Write tests for cookie merge — new cookies added, updated cookies overwrite, stored cookies preserved, expired cookies pruned, session cookies (expiry -1) preserved

## 6. Session Manager

- [x] 6.1 Implement `SessionManager` class in `session-manager.ts` — orchestrates session lifecycle: open (create BB session, decide context usage, restore state), close (extract state, merge, release), active session tracking
- [x] 6.2 Implement Browserbase Context arbitration — check active session count, use BB Context for first session, skip for parallel sessions
- [x] 6.3 Implement state persistence — save/load `browser:state` from capability KV storage, inject cookies via CDP `Network.setCookies` on restore
- [x] 6.4 Write tests for SessionManager — mock BrowserbaseClient and CDPClient, test open/close lifecycle, parallel session detection, state save/restore, disconnect cleanup

## 7. Tools

- [x] 7.1 Implement `browser_open` tool — create session via SessionManager, fetch debug URLs, broadcast `browser_open` event, return confirmation with page info
- [x] 7.2 Implement `browser_navigate` tool — validate active session, send `Page.navigate` + wait for `Page.loadEventFired`, return new URL
- [x] 7.3 Implement `browser_snapshot` tool — call snapshot engine, return formatted tree as text content with URL/title in details
- [x] 7.4 Implement `browser_screenshot` tool — send `Page.captureScreenshot` via CDP, return base64 image, support fullPage option
- [x] 7.5 Implement `browser_click` tool — resolve ref to DOM node, get bounding box via `DOM.getContentQuads`, dispatch mouse events at center
- [x] 7.6 Implement `browser_type` tool — click ref to focus, dispatch `Input.insertText`, optional Enter key
- [x] 7.7 Implement `browser_close` tool — save state via SessionManager, emit cost, broadcast `browser_close`
- [x] 7.8 Implement `browser_clear_state` tool — delete or filter `browser:state` in KV, support optional domain filter
- [x] 7.9 Write tests for each tool — mock CDP responses, verify correct CDP commands sent, test error cases (no active session, invalid ref, etc.)

## 8. Capability Assembly

- [x] 8.1 Implement `capability.ts` — `browserbase(options)` factory returning Capability with tools, onConnect hook (restore browser panel on reconnect), close_browser command
- [x] 8.2 Wire up disconnect cleanup in onConnect/onDisconnect hooks
- [x] 8.3 Write integration test for capability — register capability, verify tool list, test hook behavior

## 9. Agent UI — Browser Panel

- [x] 9.1 Implement `useBrowser` hook in `packages/agent-ui/src/hooks/use-browser.ts` — track open state, debuggerFullscreenUrl, pageUrl from custom events
- [x] 9.2 Implement `BrowserPanel` component in `packages/agent-ui/src/components/browser-panel.tsx` — iframe embed, URL bar, close button, loading overlay (follow AppPreview patterns)
- [x] 9.3 Integrate `useBrowser` with `useAgentChat` — register `browser_open`/`browser_close` event handlers in onCustomEvent
- [x] 9.4 Add `data-agent-ui` attribute selectors and styles for BrowserPanel
- [x] 9.5 Export new components and hook from agent-ui barrel
- [x] 9.6 Write component tests for BrowserPanel — render states (open, closed, loading), close button behavior

## 10. Documentation & Integration

- [x] 10.1 Update CLAUDE.md — add browserbase to "What the SDK Provides Today" and "Project Structure"
- [x] 10.2 Update README.md — add browserbase to packages table
- [x] 10.3 Run full test suite (`bun run test`), typecheck (`bun run typecheck`), lint (`bun run lint`) and fix any issues
