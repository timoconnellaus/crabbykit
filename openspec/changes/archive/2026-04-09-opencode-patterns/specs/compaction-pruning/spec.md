## ADDED Requirements

### Requirement: Prune old tool outputs before LLM summarization
The compaction system SHALL run a pruning pass before LLM-based summarization. The pruning pass SHALL walk tool result messages from oldest to newest, replacing the content of tool results older than a configurable token budget (default: 40,000 tokens from the tail of the conversation) with a `[pruned]` marker.

#### Scenario: Tool outputs exceed prune budget
- **WHEN** the conversation contains 80,000 tokens of tool results and the prune budget is 40,000
- **THEN** the pruning pass SHALL erase the oldest tool results until only 40,000 tokens of tool output remain, replacing erased content with `[pruned]`

#### Scenario: Tool outputs are within prune budget
- **WHEN** the conversation contains 30,000 tokens of tool results and the prune budget is 40,000
- **THEN** the pruning pass SHALL make no changes

### Requirement: Pruning preserves non-tool messages
The pruning pass SHALL only modify tool result content blocks. User messages, assistant messages, and system messages SHALL NOT be modified by pruning.

#### Scenario: Mixed message types in conversation
- **WHEN** the conversation contains user messages, assistant messages, and tool results exceeding the prune budget
- **THEN** only tool result content SHALL be replaced with `[pruned]`; all other messages remain intact

### Requirement: Pruning may skip LLM summarization
If the pruning pass reduces the context size below the compaction trigger threshold, the system SHALL skip the LLM summarization step entirely and return the pruned messages as the compacted context.

#### Scenario: Pruning alone brings context under threshold
- **WHEN** pruning reduces the context from 120,000 tokens to 80,000 tokens and the compaction threshold is 100,000
- **THEN** the system SHALL skip LLM summarization and use the pruned context directly

#### Scenario: Pruning is insufficient
- **WHEN** pruning reduces the context from 150,000 tokens to 110,000 tokens and the compaction threshold is 100,000
- **THEN** the system SHALL proceed with LLM summarization on the pruned (smaller) context

### Requirement: Prune budget is configurable
The token budget for preserved tool outputs MUST be configurable. The default SHALL be 40,000 tokens.

#### Scenario: Custom prune budget of 20,000
- **WHEN** the compaction capability is configured with `{ pruneBudget: 20000 }`
- **THEN** the pruning pass SHALL preserve only the most recent 20,000 tokens of tool outputs
