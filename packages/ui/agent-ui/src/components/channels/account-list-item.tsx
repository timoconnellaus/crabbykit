import { useState } from "react";
import type { TelegramAccountView } from "../../hooks/use-telegram-channel.js";

export interface AccountListItemProps {
  account: TelegramAccountView;
  onRemove: () => void;
}

/**
 * One row in the Telegram accounts list. Shows the account id, the
 * redacted token preview, the current webhook status, and a Remove
 * button that confirms before dispatching.
 *
 * Confirmation uses an inline two-step toggle (not a modal) so the
 * component stays dependency-free and keyboard-navigable.
 */
export function AccountListItem({ account, onRemove }: AccountListItemProps) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div
      data-agent-ui="telegram-account-item"
      data-active={account.webhookActive || undefined}
      data-error={account.lastError ? "" : undefined}
    >
      <div data-agent-ui="telegram-account-item-main">
        <div data-agent-ui="telegram-account-item-id">{account.id}</div>
        <div data-agent-ui="telegram-account-item-token">{account.tokenPreview}</div>
        <div data-agent-ui="telegram-account-item-status">
          {account.webhookActive ? "Webhook active" : "Webhook inactive"}
        </div>
      </div>

      {account.webhookUrl && (
        <div data-agent-ui="telegram-account-item-webhook-url">{account.webhookUrl}</div>
      )}

      {account.lastError && (
        <div data-agent-ui="telegram-account-item-error" role="alert">
          {account.lastError}
        </div>
      )}

      <div data-agent-ui="telegram-account-item-actions">
        {confirming ? (
          <>
            <span data-agent-ui="telegram-account-item-confirm-label">Remove this account?</span>
            <button
              type="button"
              data-agent-ui="telegram-account-item-confirm-yes"
              onClick={() => {
                onRemove();
                setConfirming(false);
              }}
            >
              Yes, remove
            </button>
            <button
              type="button"
              data-agent-ui="telegram-account-item-confirm-no"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            data-agent-ui="telegram-account-item-remove"
            onClick={() => setConfirming(true)}
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
