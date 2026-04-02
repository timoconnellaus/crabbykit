## ADDED Requirements

### Requirement: Truncate oversized tool results before inference
The system SHALL truncate tool result content that exceeds a configurable token threshold (default: 30,000 tokens) before the messages are sent to LLM inference. Truncation SHALL preserve the first and last portions of the content, replacing the middle with a marker: `[... truncated {removed} tokens, {kept} of {total} kept ...]`.

#### Scenario: Tool result exceeds token limit
- **WHEN** a tool result contains more than 30,000 tokens of text content
- **THEN** the system SHALL truncate the content, preserving the first 40% and last 40% of the allowed tokens, replacing the middle with a truncation marker

#### Scenario: Tool result is within limit
- **WHEN** a tool result contains fewer than 30,000 tokens of text content
- **THEN** the system SHALL pass the content through unchanged

### Requirement: Per-tool truncation opt-out
Tools that return large outputs intentionally (e.g., file read tools) SHALL be able to opt out of truncation by setting `skipTruncation: true` in their result metadata.

#### Scenario: Tool opts out of truncation
- **WHEN** a tool result includes `details: { skipTruncation: true }` and the content exceeds the token limit
- **THEN** the system SHALL NOT truncate the content

### Requirement: Configurable token threshold
The truncation token limit MUST be configurable per-agent via the capability config system.

#### Scenario: Custom threshold of 50,000 tokens
- **WHEN** the truncation capability is configured with `{ maxTokens: 50000 }`
- **THEN** truncation SHALL only apply to tool results exceeding 50,000 tokens

### Requirement: Multiple content blocks
When a tool result contains multiple content blocks, the system SHALL evaluate and truncate each text block independently.

#### Scenario: Multi-block tool result with one oversized block
- **WHEN** a tool result has two text content blocks, one under the limit and one over
- **THEN** the system SHALL only truncate the oversized block, leaving the other unchanged
