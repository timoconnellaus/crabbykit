import { useState } from "react";
import { useTelegramChannel } from "../../hooks/use-telegram-channel.js";
import { AccountListItem } from "./account-list-item.js";
import { AddTelegramAccountForm } from "./add-telegram-account-form.js";

/**
 * Self-contained section for the Telegram channel within the generic
 * channels hub. Renders the account list, add form, and empty/loading
 * states — everything that was previously in the top-level ChannelsPanel.
 *
 * Expects to be rendered inside a `<details>` or similar expandable
 * container; it does NOT render its own outer chrome.
 */
export function TelegramChannelSection() {
  const { accounts, addAccount, removeAccount } = useTelegramChannel();
  const [showAddForm, setShowAddForm] = useState(false);

  return (
    <div data-agent-ui="channel-section-body">
      {!showAddForm && (
        <div data-agent-ui="channel-section-toolbar">
          <span data-agent-ui="channel-section-hint">
            Bot accounts that forward messages to this agent.
          </span>
          <button
            type="button"
            data-agent-ui="channel-section-add-btn"
            onClick={() => setShowAddForm(true)}
          >
            + Add account
          </button>
        </div>
      )}

      {showAddForm && (
        <AddTelegramAccountForm
          onSubmit={(input) => {
            addAccount(input);
            setShowAddForm(false);
          }}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      {accounts === null ? (
        <div data-agent-ui="channel-section-loading">Loading accounts…</div>
      ) : accounts.length === 0 ? (
        <div data-agent-ui="channel-section-empty">
          No accounts configured. Click <strong>+ Add account</strong> to connect a bot.
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
  );
}
