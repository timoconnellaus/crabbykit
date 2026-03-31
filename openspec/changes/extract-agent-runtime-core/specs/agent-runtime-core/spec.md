## ADDED Requirements

### Requirement: AgentRuntime is a platform-agnostic abstract class
AgentRuntime SHALL be an abstract class that contains all agent business logic without any platform-specific imports. It SHALL receive SqlStore, KvStore, Scheduler, Transport, and RuntimeContext via constructor parameters.

#### Scenario: Constructor injection of platform adapters
- **WHEN** a platform adapter instantiates AgentRuntime with SqlStore, KvStore, Scheduler, Transport, and RuntimeContext
- **THEN** AgentRuntime SHALL initialize SessionStore, ScheduleStore, ConfigStore, McpManager, and TaskStore from the provided adapters

#### Scenario: No platform-specific imports
- **WHEN** the agent-runtime.ts module is loaded
- **THEN** it SHALL NOT import from "cloudflare:workers" or any Cloudflare-specific module

### Requirement: AgentRuntime exposes the same abstract method surface as AgentDO
AgentRuntime SHALL declare the same abstract and overridable methods that consumers currently implement on AgentDO: getConfig(), getTools(), buildSystemPrompt(), getCapabilities(), getCommands(), getPromptOptions(), getConfigNamespaces(), getA2AClientOptions(), getAgentOptions(), validateAuth().

#### Scenario: Consumer implements required abstract methods
- **WHEN** a consumer extends AgentRuntime
- **THEN** the consumer MUST implement getConfig() and getTools()
- **AND** the consumer MAY override buildSystemPrompt(), getCapabilities(), getCommands(), getPromptOptions(), getConfigNamespaces(), getA2AClientOptions(), getAgentOptions(), and validateAuth()

#### Scenario: Lifecycle hooks are available
- **WHEN** a consumer extends AgentRuntime
- **THEN** the consumer MAY override onTurnEnd(), onAgentEnd(), onSessionCreated(), and onScheduleFire()

### Requirement: RuntimeContext abstracts agent identity and background work
RuntimeContext SHALL be an interface with an agentId property and a waitUntil method.

#### Scenario: RuntimeContext provides agent identity
- **WHEN** AgentRuntime needs the agent's identity for A2A callback URLs
- **THEN** it SHALL use runtimeContext.agentId instead of ctx.id.toString()

#### Scenario: RuntimeContext tracks background work
- **WHEN** AgentRuntime starts a fire-and-forget async operation (e.g., A2A callback prompt)
- **THEN** it SHALL call runtimeContext.waitUntil(promise) to ensure the platform keeps the process alive

### Requirement: handleRequest replaces fetch as the HTTP entry point
AgentRuntime SHALL expose a public handleRequest(request: Request): Promise<Response> method that contains all HTTP routing logic: auth validation, WebSocket upgrade delegation, HTTP prompt, schedule CRUD API, MCP callback, A2A endpoints, and capability HTTP handlers.

#### Scenario: WebSocket upgrade
- **WHEN** handleRequest receives a request with upgrade: websocket header
- **THEN** it SHALL delegate to transport.handleUpgrade(request)

#### Scenario: HTTP prompt
- **WHEN** handleRequest receives POST /prompt
- **THEN** it SHALL parse the body and call the prompt handling logic

#### Scenario: A2A agent card
- **WHEN** handleRequest receives GET /.well-known/agent-card.json and A2A is discoverable
- **THEN** it SHALL return the agent card JSON

#### Scenario: Unknown route
- **WHEN** handleRequest receives a request that matches no route
- **THEN** it SHALL return 404 Not Found

### Requirement: handleAlarmFired is public on AgentRuntime
AgentRuntime SHALL expose handleAlarmFired() as a public async method so that non-CF platform adapters can call it from their own wake mechanism.

#### Scenario: Platform adapter triggers schedule processing
- **WHEN** a platform adapter's wake mechanism fires (e.g., setTimeout, node-cron)
- **THEN** it SHALL call agentRuntime.handleAlarmFired() to process due schedules

### Requirement: AgentDO becomes a thin Cloudflare shell
AgentDO SHALL continue to extend DurableObject and SHALL delegate all business logic to an internal AgentRuntime instance created via composition.

#### Scenario: AgentDO constructor creates adapters and runtime
- **WHEN** AgentDO is constructed with DurableObjectState and env
- **THEN** it SHALL create CF adapters (createCfSqlStore, createCfKvStore, createCfScheduler, CfWebSocketTransport) and a CF RuntimeContext
- **AND** it SHALL instantiate an AgentRuntime subclass that delegates abstract methods back to AgentDO

#### Scenario: fetch delegates to handleRequest
- **WHEN** AgentDO.fetch() is called
- **THEN** it SHALL call this.runtime.handleRequest(request) and return the result

#### Scenario: alarm delegates to handleAlarmFired
- **WHEN** AgentDO.alarm() is called
- **THEN** it SHALL call this.runtime.handleAlarmFired()

#### Scenario: webSocketMessage delegates to transport
- **WHEN** AgentDO.webSocketMessage() is called
- **THEN** it SHALL call the transport's handleMessage method (same as today)

#### Scenario: webSocketClose delegates to transport
- **WHEN** AgentDO.webSocketClose() is called
- **THEN** it SHALL call the transport's handleClose method (same as today)

### Requirement: Backwards compatibility for AgentDO consumers
Consumers extending AgentDO SHALL NOT need to change any code. All abstract methods, lifecycle hooks, protected properties (sessionStore, scheduleStore, configStore, mcpManager, taskStore, kvStore, scheduler, transport), and public types (AgentConfig, AgentContext, ScheduleManager, A2AConfig) SHALL remain accessible with the same signatures.

#### Scenario: Existing consumer code compiles without changes
- **WHEN** a consumer's AgentDO subclass is compiled against the new version
- **THEN** it SHALL compile successfully with no type errors

#### Scenario: Protected store access works through delegation
- **WHEN** a consumer accesses this.sessionStore in their AgentDO subclass
- **THEN** it SHALL return the same SessionStore instance used by the internal AgentRuntime

### Requirement: Consumer-facing types are exported from both files
AgentConfig, AgentContext, ScheduleManager, A2AConfig, and CompactionConfig types SHALL be importable from @claw-for-cloudflare/agent-runtime. They SHALL be defined in agent-runtime.ts and re-exported from agent-do.ts and the barrel index.ts.

#### Scenario: Import from package root
- **WHEN** a consumer imports AgentConfig from "@claw-for-cloudflare/agent-runtime"
- **THEN** the import SHALL resolve successfully

#### Scenario: Import from agent-do path
- **WHEN** existing code imports AgentConfig from the agent-do module
- **THEN** the import SHALL continue to resolve (re-export)

### Requirement: CfRuntimeContext adapter wraps DO context
A createCfRuntimeContext factory function SHALL create a RuntimeContext from DurableObjectState, mapping ctx.id.toString() to agentId and ctx.waitUntil() to waitUntil().

#### Scenario: Agent identity from DO context
- **WHEN** CfRuntimeContext is created from a DurableObjectState
- **THEN** agentId SHALL return ctx.id.toString()

#### Scenario: waitUntil delegates to DO context
- **WHEN** runtimeContext.waitUntil(promise) is called
- **THEN** it SHALL call ctx.waitUntil(promise) on the underlying DurableObjectState
