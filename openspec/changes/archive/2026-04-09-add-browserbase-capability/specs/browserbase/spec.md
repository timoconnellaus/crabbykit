## ADDED Requirements

### Requirement: Capability registration
The `browserbase()` factory SHALL return a `Capability` conforming to the CLAW capability interface with id `"browserbase"`, providing tools, hooks, and commands.

#### Scenario: Capability provides tools
- **WHEN** `tools(context)` is called
- **THEN** it SHALL return the tools: `browser_open`, `browser_navigate`, `browser_snapshot`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_close`

#### Scenario: Capability provides onConnect hook
- **WHEN** a client reconnects to a session with an active browser
- **THEN** the capability SHALL broadcast `browser_open` with the current live view URL

#### Scenario: Capability provides close command
- **WHEN** the user clicks the close button on the browser panel
- **THEN** the capability SHALL execute the `close_browser` command, saving state and releasing the session

### Requirement: Browserbase REST client
The `BrowserbaseClient` SHALL communicate with the Browserbase API at `https://api.browserbase.com` using the `X-BB-API-Key` header.

#### Scenario: Create session
- **WHEN** `createSession(params)` is called
- **THEN** it SHALL POST to `/v1/sessions` and return the session object including `id`, `connectUrl`, and context metadata

#### Scenario: Get debug URLs
- **WHEN** `getDebugUrls(sessionId)` is called
- **THEN** it SHALL GET `/v1/sessions/{id}/debug` and return `debuggerFullscreenUrl` and page metadata

#### Scenario: Release session
- **WHEN** `releaseSession(sessionId)` is called
- **THEN** it SHALL POST to `/v1/sessions/{id}` with `{ status: "REQUEST_RELEASE" }`

#### Scenario: Create context
- **WHEN** `createContext(projectId?)` is called
- **THEN** it SHALL POST to `/v1/contexts` and return the context `id`

### Requirement: CDP client
The `CDPClient` SHALL communicate with a remote browser over WebSocket using the Chrome DevTools Protocol JSON-RPC format.

#### Scenario: Connect to browser
- **WHEN** `connect(connectUrl)` is called
- **THEN** it SHALL open a WebSocket connection to the given URL

#### Scenario: Send CDP command
- **WHEN** `send(method, params)` is called
- **THEN** it SHALL send a JSON-RPC message with an incrementing `id` and resolve the promise when the matching response arrives

#### Scenario: Handle connection failure
- **WHEN** the WebSocket connection fails or closes unexpectedly
- **THEN** subsequent `send()` calls SHALL reject with a descriptive error

#### Scenario: Receive CDP events
- **WHEN** the browser sends an event (message without `id`)
- **THEN** registered event listeners SHALL be invoked with the event params

### Requirement: browser_open tool
The `browser_open` tool SHALL create or reconnect a Browserbase session, restore saved state, optionally navigate to a URL, and broadcast the live view to the UI.

#### Scenario: Open with URL
- **WHEN** `browser_open` is called with `{ url: "https://example.com" }`
- **THEN** it SHALL create a Browserbase session, restore cookies from storage, navigate to the URL, fetch the debug URLs, and broadcast `browser_open` with `{ debuggerFullscreenUrl, pageUrl }`

#### Scenario: Open without URL
- **WHEN** `browser_open` is called with no arguments
- **THEN** it SHALL create a session, restore cookies, and navigate to the last known URL from saved state (or `about:blank` if none)

#### Scenario: Single session uses Browserbase Context
- **WHEN** no other chat session has an active browser
- **THEN** the Browserbase session SHALL be created with `browserSettings.context.id` and `persist: true`

#### Scenario: Parallel session skips Browserbase Context
- **WHEN** another chat session already has an active browser
- **THEN** the Browserbase session SHALL be created without context persistence, and cookies SHALL be injected manually via CDP

#### Scenario: Reject if session already has browser open
- **WHEN** `browser_open` is called but the current chat session already has an active browser
- **THEN** it SHALL return an error indicating the browser is already open

### Requirement: browser_navigate tool
The `browser_navigate` tool SHALL navigate the active browser to a given URL.

#### Scenario: Navigate to URL
- **WHEN** `browser_navigate` is called with `{ url: "https://example.com" }`
- **THEN** it SHALL send `Page.navigate` via CDP and wait for the page to load

#### Scenario: No active browser
- **WHEN** `browser_navigate` is called but no browser session is active for this chat session
- **THEN** it SHALL return an error indicating no browser is open

### Requirement: browser_snapshot tool
The `browser_snapshot` tool SHALL return an accessibility tree representation of the current page with ref-annotated interactive elements.

#### Scenario: Full snapshot
- **WHEN** `browser_snapshot` is called with no arguments
- **THEN** it SHALL call `Accessibility.getFullAXTree` via CDP, format the tree with indented roles and names, assign refs (e1, e2, ...) to interactive elements, and return the formatted text plus the ref map

#### Scenario: Interactive-only snapshot
- **WHEN** `browser_snapshot` is called with `{ interactive: true }`
- **THEN** it SHALL return only interactive elements (buttons, links, inputs, etc.) with refs, omitting structural/content nodes

#### Scenario: Snapshot includes current URL
- **WHEN** a snapshot is returned
- **THEN** it SHALL include the current page URL and title as metadata in the tool result details

### Requirement: browser_screenshot tool
The `browser_screenshot` tool SHALL capture a PNG screenshot of the current page.

#### Scenario: Take screenshot
- **WHEN** `browser_screenshot` is called
- **THEN** it SHALL send `Page.captureScreenshot` via CDP and return the base64-encoded image as tool result content

#### Scenario: Full page screenshot
- **WHEN** `browser_screenshot` is called with `{ fullPage: true }`
- **THEN** it SHALL capture the full scrollable page, not just the viewport

### Requirement: browser_click tool
The `browser_click` tool SHALL click an element identified by a snapshot ref.

#### Scenario: Click by ref
- **WHEN** `browser_click` is called with `{ ref: "e3" }`
- **THEN** it SHALL resolve the ref to a DOM node, get its bounding box via CDP, compute the center point, and dispatch `Input.dispatchMouseEvent` (mousePressed + mouseReleased) at those coordinates

#### Scenario: Invalid ref
- **WHEN** `browser_click` is called with a ref that is not in the current snapshot's ref map
- **THEN** it SHALL return an error suggesting the user take a new snapshot

### Requirement: browser_type tool
The `browser_type` tool SHALL type text into a focused element or an element identified by ref.

#### Scenario: Type into ref
- **WHEN** `browser_type` is called with `{ ref: "e5", text: "hello" }`
- **THEN** it SHALL click the element (to focus it), then dispatch `Input.insertText` via CDP

#### Scenario: Type with keyboard events
- **WHEN** `browser_type` is called with `{ ref: "e5", text: "hello", pressEnter: true }`
- **THEN** it SHALL type the text and then dispatch a keyDown/keyUp for the Enter key

### Requirement: browser_close tool
The `browser_close` tool SHALL save browser state, release the Browserbase session, and hide the browser panel.

#### Scenario: Close and save state
- **WHEN** `browser_close` is called
- **THEN** it SHALL extract cookies via `Network.getCookies`, merge them into the shared cookie jar in KV storage, close the CDP connection, release the Browserbase session, broadcast `browser_close`, and emit a cost event based on session duration

#### Scenario: Close parallel session merges cookies
- **WHEN** a parallel session (one that didn't use BB Context) calls `browser_close`
- **THEN** it SHALL extract cookies, load the current shared state from KV, merge using `(domain, path, name)` as key with newer-expiry-wins, and write back

#### Scenario: Close primary session persists via BB Context
- **WHEN** the primary session (one using BB Context with persist=true) calls `browser_close`
- **THEN** BB SHALL auto-persist state, AND the capability SHALL also extract cookies and update the KV copy

### Requirement: Session manager
The `SessionManager` SHALL manage Browserbase session lifecycle, active session tracking, and state persistence.

#### Scenario: Track active sessions
- **WHEN** a browser is opened
- **THEN** the session manager SHALL store `browser:active:{sessionId}` in capability KV with the Browserbase session ID, whether BB Context was used, and the start time

#### Scenario: Count active sessions
- **WHEN** `browser_open` checks for parallel sessions
- **THEN** the session manager SHALL count entries matching `browser:active:*` pattern

#### Scenario: Clean up on disconnect
- **WHEN** a chat session disconnects while a browser is active
- **THEN** the session manager SHALL save state and release the Browserbase session (same as `browser_close`)

### Requirement: Cookie merge
The cookie merge function SHALL combine cookies from a closing browser session with the shared cookie jar.

#### Scenario: New cookies are added
- **WHEN** the incoming cookies contain a cookie not present in storage (by domain+path+name)
- **THEN** it SHALL be added to the merged result

#### Scenario: Updated cookies overwrite
- **WHEN** the incoming cookies contain a cookie with the same key but a newer expiry
- **THEN** it SHALL overwrite the stored version

#### Scenario: Stored cookies from other sessions are preserved
- **WHEN** the stored cookie jar contains cookies not present in the incoming set
- **THEN** they SHALL be preserved in the merged result

#### Scenario: Expired cookies are pruned
- **WHEN** any cookie in the merged result has an expiry in the past
- **THEN** it SHALL be removed (unless it's a session cookie with expiry -1)

### Requirement: Cost tracking
The capability SHALL emit costs via `context.emitCost()` for Browserbase session usage.

#### Scenario: Emit cost on session close
- **WHEN** `browser_close` is called
- **THEN** it SHALL calculate duration in minutes (rounded up) and emit cost at the per-minute rate with `capabilityId: "browserbase"` and `toolName: "browser_close"`

### Requirement: State persistence
The capability SHALL persist browser state (cookies) in agent-scoped KV storage under key `browser:state`.

#### Scenario: Save state
- **WHEN** state is saved (on browser_close or disconnect)
- **THEN** it SHALL store `{ cookies, lastUrl, savedAt }` at key `browser:state`

#### Scenario: Restore state
- **WHEN** `browser_open` creates a new session
- **THEN** it SHALL load `browser:state` from KV and inject cookies via `Network.setCookies`

#### Scenario: State persists across agent restarts
- **WHEN** the agent DO is evicted and recreated
- **THEN** the cookie jar SHALL be available from KV storage on next `browser_open`

### Requirement: browser_clear_state tool
The `browser_clear_state` tool SHALL allow explicit removal of saved credentials.

#### Scenario: Clear all state
- **WHEN** `browser_clear_state` is called with no arguments
- **THEN** it SHALL delete `browser:state` from KV storage

#### Scenario: Clear state for specific domain
- **WHEN** `browser_clear_state` is called with `{ domain: "github.com" }`
- **THEN** it SHALL remove only cookies matching that domain from the stored state
