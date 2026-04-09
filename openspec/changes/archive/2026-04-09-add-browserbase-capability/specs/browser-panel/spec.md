## ADDED Requirements

### Requirement: BrowserPanel component
The `BrowserPanel` component SHALL render an iframe embedding the Browserbase live debug viewer when the browser is open.

#### Scenario: Browser open
- **WHEN** a `browser_open` custom event is received with `{ debuggerFullscreenUrl, pageUrl }`
- **THEN** the BrowserPanel SHALL render an iframe with `src` set to `debuggerFullscreenUrl`

#### Scenario: Browser closed
- **WHEN** a `browser_close` custom event is received
- **THEN** the BrowserPanel SHALL hide the iframe

#### Scenario: Display current URL
- **WHEN** the browser panel is visible
- **THEN** it SHALL display the `pageUrl` in a read-only URL bar above the iframe

#### Scenario: Close button
- **WHEN** the user clicks the close button on the browser panel
- **THEN** it SHALL send a `close_browser` command to the server and hide the panel

#### Scenario: Loading state
- **WHEN** the iframe is loading
- **THEN** the BrowserPanel SHALL show a loading overlay (same pattern as AppPreview)

#### Scenario: Reconnection restores panel
- **WHEN** the WebSocket reconnects and the server broadcasts `browser_open`
- **THEN** the BrowserPanel SHALL re-render with the fresh `debuggerFullscreenUrl`

### Requirement: useBrowser hook
The `useBrowser` hook SHALL manage browser panel state for the agent UI.

#### Scenario: Track browser state
- **WHEN** a `browser_open` event is received
- **THEN** the hook SHALL update state to `{ open: true, debuggerFullscreenUrl, pageUrl }`

#### Scenario: Track browser close
- **WHEN** a `browser_close` event is received
- **THEN** the hook SHALL update state to `{ open: false }`

#### Scenario: Integrate with useAgentChat
- **WHEN** the hook is used alongside `useAgentChat`
- **THEN** it SHALL register custom event handlers for `browser_open` and `browser_close` via the `onCustomEvent` callback

### Requirement: Styling isolation
The BrowserPanel SHALL use `data-agent-ui` attribute selectors for styling, consistent with all other agent-ui components.

#### Scenario: No inline styles
- **WHEN** the BrowserPanel is rendered
- **THEN** all styling SHALL use `data-agent-ui` attribute selectors, not inline styles or CSS modules
