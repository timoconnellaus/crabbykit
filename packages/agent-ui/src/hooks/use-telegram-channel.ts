import { useAgentConnection } from "@claw-for-cloudflare/agent-runtime/client";
import { useCallback } from "react";

/**
 * UI-facing type for a stored Telegram account. Mirrors the
 * `TelegramAccountView` exported by `@claw-for-cloudflare/channel-telegram`
 * — redacted for broadcast, safe to render.
 *
 * Duplicated here (rather than imported) so `agent-ui` does not take a
 * hard dependency on `channel-telegram`. The shape is structural; the
 * server-side type is the source of truth, and any divergence shows up
 * as a runtime JSON mismatch that a consumer would notice immediately.
 */
export interface TelegramAccountView {
  id: string;
  tokenPreview: string;
  webhookUrl: string | null;
  webhookActive: boolean;
  lastError?: string;
  addedAt: string;
}

/** Payload submitted by the add-account form. */
export interface AddTelegramAccountInput {
  id: string;
  token: string;
  webhookSecret: string;
  /** Optional override for the default public URL. */
  publicUrl?: string;
}

/**
 * Thin hook exposing everything the Telegram channel UI components
 * need:
 *
 * - `accounts` — the redacted list broadcast by the capability via
 *   `capability_state`. `null` until the first sync lands.
 * - `addAccount(input)` — send a `capability_action { action: "add" }`.
 * - `removeAccount(id)` — send a `capability_action { action: "remove" }`.
 * - `refresh()` — send a `capability_action { action: "list" }` which
 *   triggers a server-side re-broadcast. Useful for pull-to-refresh
 *   gestures or recovering from a missed update.
 *
 * Every helper is a no-op when there is no current session id — the
 * `capability_action` transport envelope requires one, even for
 * agent-wide actions.
 */
export function useTelegramChannel() {
  const { send, state, currentSessionId } = useAgentConnection();

  const telegramState = state.capabilityState.telegram as
    | { accounts?: TelegramAccountView[] }
    | undefined;
  const accounts = telegramState?.accounts ?? null;

  const addAccount = useCallback(
    (input: AddTelegramAccountInput) => {
      if (!currentSessionId) return;
      send({
        type: "capability_action",
        capabilityId: "telegram",
        action: "add",
        data: input as unknown as Record<string, unknown>,
        sessionId: currentSessionId,
      });
    },
    [currentSessionId, send],
  );

  const removeAccount = useCallback(
    (id: string) => {
      if (!currentSessionId) return;
      send({
        type: "capability_action",
        capabilityId: "telegram",
        action: "remove",
        data: { id },
        sessionId: currentSessionId,
      });
    },
    [currentSessionId, send],
  );

  const refresh = useCallback(() => {
    if (!currentSessionId) return;
    send({
      type: "capability_action",
      capabilityId: "telegram",
      action: "list",
      data: {},
      sessionId: currentSessionId,
    });
  }, [currentSessionId, send]);

  return { accounts, addAccount, removeAccount, refresh };
}
