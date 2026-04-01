/**
 * Shared test helpers for capability and tool tests.
 *
 * Import directly from this file in test code — these are NOT part of the
 * public API and are not re-exported from the package barrel.
 *
 * @example
 * ```ts
 * import { createMockStorage, textOf, TOOL_CTX } from "@claw-for-cloudflare/agent-runtime/test-utils";
 * ```
 */

import type { CapabilityStorage } from "./capabilities/storage.js";
import type { ToolExecuteContext } from "@claw-for-cloudflare/agent-core";

// ---------------------------------------------------------------------------
// Mock storage
// ---------------------------------------------------------------------------

/**
 * In-memory implementation of CapabilityStorage for unit testing.
 * Supports get, put, delete, and prefix-filtered list.
 */
export function createMockStorage(): CapabilityStorage {
	const data = new Map<string, unknown>();
	return {
		async get<T = unknown>(key: string): Promise<T | undefined> {
			return data.get(key) as T | undefined;
		},
		async put(key: string, value: unknown): Promise<void> {
			data.set(key, value);
		},
		async delete(key: string): Promise<boolean> {
			return data.delete(key);
		},
		async list<T = unknown>(prefix?: string): Promise<Map<string, T>> {
			const result = new Map<string, T>();
			for (const [k, v] of data) {
				if (!prefix || k.startsWith(prefix)) {
					result.set(k, v as T);
				}
			}
			return result;
		},
	};
}

// ---------------------------------------------------------------------------
// Tool result helpers
// ---------------------------------------------------------------------------

/** Extract the text string from the first content block of a tool result. */
export function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return (result.content[0] as { text: string }).text;
}

// ---------------------------------------------------------------------------
// Tool execution context
// ---------------------------------------------------------------------------

/** Minimal ToolExecuteContext for test tool.execute() calls. */
export const TOOL_CTX: ToolExecuteContext = { toolCallId: "test" };
