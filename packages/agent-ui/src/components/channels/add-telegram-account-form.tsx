import { type FormEvent, useState } from "react";
import type { AddTelegramAccountInput } from "../../hooks/use-telegram-channel.js";

export interface AddTelegramAccountFormProps {
  onSubmit: (input: AddTelegramAccountInput) => void;
  onCancel: () => void;
}

/**
 * Inline form for pasting a Telegram bot token + webhook secret.
 *
 * **Secrets never persist in React state beyond the form's lifetime.**
 * On submit, the values are sent to `onSubmit` and the component
 * unmounts (the parent's `showAddForm` flips to false). The form does
 * NOT echo submitted credentials back from state broadcasts — the
 * server returns only the redacted `tokenPreview`.
 *
 * `webhookSecret` has a "Generate" button that fills it with 32 bytes
 * of crypto-random hex. Users who want to type their own can clear the
 * field and paste whatever they like; the server validates length at
 * Bot API call time via Telegram's own rejection.
 */
export function AddTelegramAccountForm({ onSubmit, onCancel }: AddTelegramAccountFormProps) {
  const [id, setId] = useState("");
  const [token, setToken] = useState("");
  const [webhookSecret, setWebhookSecret] = useState(() => generateSecret());
  const [publicUrl, setPublicUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [secretVisible, setSecretVisible] = useState(false);
  const [secretCopied, setSecretCopied] = useState(false);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!id.trim() || !token.trim() || !webhookSecret.trim()) {
      setError("All fields except 'Public URL' are required.");
      return;
    }
    onSubmit({
      id: id.trim(),
      token: token.trim(),
      webhookSecret: webhookSecret.trim(),
      publicUrl: publicUrl.trim() || undefined,
    });
    // Best-effort: clear state before unmount so the values don't sit
    // in React's fiber tree longer than necessary. The component is
    // about to unmount anyway, but this is defense in depth.
    setId("");
    setToken("");
    setWebhookSecret("");
    setPublicUrl("");
    setError(null);
  }

  return (
    <form data-agent-ui="add-telegram-account-form" onSubmit={handleSubmit}>
      <div data-agent-ui="add-telegram-account-form-row">
        <label data-agent-ui="add-telegram-account-form-label" htmlFor="tg-id">
          Account id
        </label>
        <input
          id="tg-id"
          data-agent-ui="add-telegram-account-form-input"
          type="text"
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="e.g. support"
          autoComplete="off"
          required
        />
      </div>

      <div data-agent-ui="add-telegram-account-form-row">
        <label data-agent-ui="add-telegram-account-form-label" htmlFor="tg-token">
          Bot token
        </label>
        <input
          id="tg-token"
          data-agent-ui="add-telegram-account-form-input"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="123456789:AAE…"
          autoComplete="new-password"
          spellCheck={false}
          required
        />
        <small data-agent-ui="add-telegram-account-form-hint">
          From{" "}
          <a
            href="https://t.me/BotFather"
            target="_blank"
            rel="noreferrer noopener"
            data-agent-ui="add-telegram-account-form-link"
          >
            @BotFather
          </a>
          . Stored encrypted-at-rest in this agent's Durable Object storage.
        </small>
      </div>

      <div data-agent-ui="add-telegram-account-form-row">
        <label data-agent-ui="add-telegram-account-form-label" htmlFor="tg-secret">
          Webhook secret
        </label>
        <div data-agent-ui="add-telegram-account-form-secret-group">
          <input
            id="tg-secret"
            data-agent-ui="add-telegram-account-form-input"
            type={secretVisible ? "text" : "password"}
            value={webhookSecret}
            onChange={(e) => setWebhookSecret(e.target.value)}
            autoComplete="new-password"
            spellCheck={false}
            required
          />
          <button
            type="button"
            data-agent-ui="add-telegram-account-form-secret-toggle"
            onClick={() => setSecretVisible((v) => !v)}
            aria-pressed={secretVisible}
            title={secretVisible ? "Hide secret" : "Show secret"}
          >
            {secretVisible ? "Hide" : "Show"}
          </button>
          <button
            type="button"
            data-agent-ui="add-telegram-account-form-secret-copy"
            data-copied={secretCopied || undefined}
            onClick={async () => {
              if (!webhookSecret) return;
              try {
                await navigator.clipboard.writeText(webhookSecret);
                setSecretCopied(true);
                setTimeout(() => setSecretCopied(false), 1500);
              } catch {
                // Clipboard APIs can reject in insecure contexts or when the
                // document isn't focused. Silently give up — the Show button
                // still lets the user grab the value manually.
              }
            }}
            title="Copy secret to clipboard"
          >
            {secretCopied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            data-agent-ui="add-telegram-account-form-generate"
            onClick={() => setWebhookSecret(generateSecret())}
          >
            Generate
          </button>
        </div>
        <small data-agent-ui="add-telegram-account-form-hint">
          Sent to Telegram's <code>setWebhook</code> as <code>secret_token</code> and verified on
          every inbound.
        </small>
      </div>

      <div data-agent-ui="add-telegram-account-form-row">
        <label data-agent-ui="add-telegram-account-form-label" htmlFor="tg-public-url">
          Public URL <span data-agent-ui="add-telegram-account-form-optional">(optional)</span>
        </label>
        <input
          id="tg-public-url"
          data-agent-ui="add-telegram-account-form-input"
          type="url"
          value={publicUrl}
          onChange={(e) => setPublicUrl(e.target.value)}
          placeholder="https://agent.example.com"
        />
        <small data-agent-ui="add-telegram-account-form-hint">
          The HTTPS origin Telegram will POST webhooks to. Leave empty to use the server's default.
        </small>
      </div>

      {error && (
        <div data-agent-ui="add-telegram-account-form-error" role="alert">
          {error}
        </div>
      )}

      <div data-agent-ui="add-telegram-account-form-actions">
        <button
          type="button"
          data-agent-ui="add-telegram-account-form-cancel"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button type="submit" data-agent-ui="add-telegram-account-form-submit">
          Add account
        </button>
      </div>
    </form>
  );
}

/**
 * Return 32 bytes of crypto-random hex — a sensible default webhook
 * secret. Telegram caps `secret_token` at 256 characters but rejects
 * control characters; 64 hex chars is well within the safe range and
 * carries ~256 bits of entropy.
 */
function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
