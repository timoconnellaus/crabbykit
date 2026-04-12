## MODIFIED Requirements

### Requirement: defineAgent accepts config field
The `defineAgent` options type SHALL accept an optional `config` field of type `Record<string, TObject>`. The field SHALL support either a literal value or a function of `(env, setup)` that returns the config record, consistent with other `defineAgent` fields that need env access.

#### Scenario: Literal config field
- **WHEN** consumer calls `defineAgent({ config: { search: SearchSchema }, ... })`
- **THEN** the agent's config schema is `{ search: SearchSchema }`

#### Scenario: Config field as function of env
- **WHEN** consumer calls `defineAgent({ config: (env) => ({ search: SearchSchema }), ... })`
- **THEN** the agent's config schema is resolved at setup time using the env

#### Scenario: Config field omitted
- **WHEN** consumer calls `defineAgent({ ... })` without `config`
- **THEN** the agent has no agent-level config namespaces and behaviour is unchanged

### Requirement: Capability factory config mapping parameter
Capability factory functions used within `defineAgent`'s `capabilities` array SHALL accept an optional `config` parameter. The parameter is a function `(agentConfig: Record<string, unknown>) => T` that maps the full agent config to the capability's expected config slice. The runtime SHALL call this function during capability resolution.

#### Scenario: Capability factory with config mapping
- **WHEN** consumer declares `tavilyWebSearch({ apiKey: "...", config: (c) => c.search })`
- **THEN** the capability receives the `search` slice of agent config in its context

#### Scenario: Capability factory without config mapping
- **WHEN** consumer declares `tavilyWebSearch({ apiKey: "..." })` with no `config`
- **THEN** the capability behaves as it does today with no agent config injection
