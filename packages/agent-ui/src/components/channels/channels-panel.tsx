import type { ComponentPropsWithoutRef } from "react";
import { useState } from "react";
import { useTelegramChannel } from "../../hooks/use-telegram-channel.js";
import { AccountListItem } from "./account-list-item.js";
import { AddTelegramAccountForm } from "./add-telegram-account-form.js";

export interface ChannelsPanelProps extends ComponentPropsWithoutRef<"div"> {}

/**
 * Top-level panel listing the agent's configured Telegram bot accounts
 * with affordances to add and remove them. Intended to be mounted at
 * an agent-level route (e.g. `$agentId/channels`) — Telegram accounts
 * are agent-wide configuration, not session state.
 *
 * State flow:
 *   1. Mount → `useTelegramChannel` reads `capabilityState.telegram`
 *      (populated by the server's `broadcastState` on onConnect).
 *   2. User clicks "+ Add account" → inline form appears.
 *   3. Submit → `capability_action { action: "add" }` sent over WS →
 *      server persists, calls `setWebhook`, re-broadcasts state →
 *      `accounts` updates in place → form closes.
 *   4. User clicks Remove on a row → confirmation → `capability_action
 *      { action: "remove" }` → server deletes + `deleteWebhook` →
 *      re-broadcast.
 */
export function ChannelsPanel(props: ChannelsPanelProps) {
  const { accounts, addAccount, removeAccount } = useTelegramChannel();
  const [showAddForm, setShowAddForm] = useState(false);

  return (
    <div data-agent-ui="channels-panel" {...props}>
      <div data-agent-ui="channels-panel-header">
        <div>
          <h2 data-agent-ui="channels-panel-title">Telegram</h2>
          <p data-agent-ui="channels-panel-description">
            Bot accounts that can DM this agent. Adding an account registers the webhook with
            Telegram immediately.
          </p>
        </div>
        {!showAddForm && (
          <button
            type="button"
            data-agent-ui="channels-panel-add"
            onClick={() => setShowAddForm(true)}
          >
            + Add account
          </button>
        )}
      </div>

      {showAddForm && (
        <AddTelegramAccountForm
          onSubmit={(input) => {
            addAccount(input);
            setShowAddForm(false);
          }}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      <div data-agent-ui="channels-panel-body">
        {accounts === null ? (
          <div data-agent-ui="channels-panel-loading">Loading accounts…</div>
        ) : accounts.length === 0 ? (
          <div data-agent-ui="channels-panel-empty">
            No Telegram accounts configured yet. Click <strong>+ Add account</strong> to connect
            your first bot.
          </div>
        ) : (
          <ul data-agent-ui="channels-account-list">
            {accounts.map((account) => (
              <li key={account.id}>
                <AccountListItem account={account} onRemove={() => removeAccount(account.id)} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
