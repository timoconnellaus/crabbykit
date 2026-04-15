import type { ComponentPropsWithoutRef } from "react";
import { useState } from "react";
import { useChannels } from "../../hooks/use-channels.js";
import { TelegramChannelSection } from "./telegram-channel-section.js";

export interface ChannelsPanelProps extends ComponentPropsWithoutRef<"div"> {}

/** Map of channel id → inline SVG path for the section header icon. */
const CHANNEL_ICONS: Record<string, string> = {
  telegram:
    "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.2-.08-.06-.19-.04-.28-.02-.12.03-2.07 1.32-5.84 3.87-.55.38-1.05.56-1.5.55-.49-.01-1.44-.28-2.15-.51-.86-.28-1.55-.43-1.49-.91.03-.25.38-.51 1.05-.78 4.12-1.79 6.87-2.97 8.26-3.54 3.93-1.62 4.75-1.9 5.28-1.91.12 0 .37.03.54.17.14.12.18.28.2.46-.01.06.01.24 0 .38z",
};

/** Render the channel-specific content for a given channel id. */
function ChannelSectionContent({ channelId }: { channelId: string }) {
  switch (channelId) {
    case "telegram":
      return <TelegramChannelSection />;
    default:
      return (
        <div data-agent-ui="channel-section-empty">
          Configuration not yet available for this channel.
        </div>
      );
  }
}

/**
 * Multi-channel hub listing every channel type the agent has registered.
 * Each channel renders as a collapsible section with its own account
 * management UI.
 *
 * Channel types are detected from `capabilityState` — a channel appears
 * here once its capability broadcasts state for the first time. The
 * sections are rendered in the order defined by `KNOWN_CHANNELS` in
 * `useChannels`.
 */
export function ChannelsPanel(props: ChannelsPanelProps) {
  const channels = useChannels();

  return (
    <div data-agent-ui="channels-panel" {...props}>
      <div data-agent-ui="channels-panel-header">
        <h2 data-agent-ui="channels-panel-title">Channels</h2>
        {channels.length > 0 && (
          <span data-agent-ui="channels-panel-count">
            {channels.length} {channels.length === 1 ? "type" : "types"}
          </span>
        )}
      </div>

      {channels.length === 0 ? (
        <div data-agent-ui="channels-panel-empty-hub">
          <div data-agent-ui="channels-panel-empty-icon">
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              role="img"
              aria-label="Channels"
            >
              <path
                d="M8.5 14.5A2.5 2.5 0 0011 12c0-1.38-.5-2-1-3-1.07-2.14 0-5.5 3-5.5 1.5 0 3 .5 3.5 2 .5 1.5 0 2.5-.5 3.5s-1 2.12-1 3.5a2.5 2.5 0 005 0"
                strokeLinecap="round"
              />
              <path
                d="M2 21l3.5-2L9 21l3.5-2L16 21l3.5-2L23 21"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <span data-agent-ui="channels-panel-empty-title">No channels detected</span>
          <span data-agent-ui="channels-panel-empty-description">
            Channels appear here when a channel capability (Telegram, Slack, etc.) is registered and
            broadcasts its state.
          </span>
        </div>
      ) : (
        <div data-agent-ui="channels-panel-sections">
          {channels.map((ch) => (
            <ChannelSection
              key={ch.id}
              channelId={ch.id}
              label={ch.label}
              accountCount={ch.accountCount}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ChannelSection({
  channelId,
  label,
  accountCount,
}: {
  channelId: string;
  label: string;
  accountCount: number | null;
}) {
  const [expanded, setExpanded] = useState(true);
  const iconPath = CHANNEL_ICONS[channelId];

  return (
    <div
      data-agent-ui="channel-section"
      data-channel={channelId}
      data-expanded={expanded || undefined}
    >
      <button
        type="button"
        data-agent-ui="channel-section-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span data-agent-ui="channel-section-header-left">
          {iconPath && (
            <svg
              data-agent-ui="channel-section-icon"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="currentColor"
              role="img"
              aria-label={label}
            >
              <path d={iconPath} />
            </svg>
          )}
          <span data-agent-ui="channel-section-label">{label}</span>
          {accountCount !== null && (
            <span data-agent-ui="channel-section-count">
              {accountCount} {accountCount === 1 ? "account" : "accounts"}
            </span>
          )}
        </span>
        <svg
          data-agent-ui="channel-section-chevron"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="3 4.5 6 7.5 9 4.5" />
        </svg>
      </button>

      {expanded && <ChannelSectionContent channelId={channelId} />}
    </div>
  );
}
