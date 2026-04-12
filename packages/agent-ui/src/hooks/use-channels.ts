import { useAgentConnection } from "@claw-for-cloudflare/agent-runtime/client";

/**
 * Summary info for a single channel type detected in `capabilityState`.
 * The UI uses this to render channel section headers without needing to
 * know the internal shape of each channel's state.
 */
export interface ChannelInfo {
  /** Capability id (e.g., `"telegram"`, `"slack"`). */
  id: string;
  /** Human-readable label derived from the id. */
  label: string;
  /** Number of configured accounts, or `null` if the state has no `accounts` array. */
  accountCount: number | null;
}

/**
 * Known channel capability ids. When we detect one of these keys in
 * `capabilityState`, we surface it as a channel section in the UI.
 * Add new channel types here as they are implemented.
 */
const KNOWN_CHANNELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "telegram", label: "Telegram" },
  // { id: "slack", label: "Slack" },
  // { id: "discord", label: "Discord" },
  // { id: "whatsapp", label: "WhatsApp" },
];

/**
 * Scans `capabilityState` for known channel types and returns summary
 * info for each that is present. Channels that are registered as
 * capabilities but haven't broadcast state yet won't appear — they show
 * up as soon as the first `capability_state` message lands.
 */
export function useChannels(): ChannelInfo[] {
  const { state } = useAgentConnection();
  const channels: ChannelInfo[] = [];

  for (const ch of KNOWN_CHANNELS) {
    const raw = state.capabilityState[ch.id] as { accounts?: unknown[] } | undefined;
    if (raw !== undefined) {
      channels.push({
        id: ch.id,
        label: ch.label,
        accountCount: Array.isArray(raw.accounts) ? raw.accounts.length : null,
      });
    }
  }

  return channels;
}
