import { useChatSession, useQueue } from "@claw-for-cloudflare/agent-runtime/client";

/**
 * Renders queued messages that will be processed after the current agent turn.
 * Hidden when the queue is empty.
 */
export function QueuedMessages() {
  const { queuedMessages, deleteQueuedMessage, steerQueuedMessage } = useQueue();
  const { agentStatus } = useChatSession();

  if (queuedMessages.length === 0) return null;

  const isRunning = agentStatus !== "idle";

  return (
    <div data-agent-ui="queued-messages">
      {queuedMessages.map((item) => (
        <div key={item.id} data-agent-ui="queued-message">
          <span data-agent-ui="queued-message-text">{item.text}</span>
          <div data-agent-ui="queued-message-actions">
            {isRunning && (
              <button
                data-agent-ui="queued-message-steer"
                type="button"
                onClick={() => steerQueuedMessage(item.id)}
                title="Steer: inject into running inference"
              >
                Steer
              </button>
            )}
            <button
              data-agent-ui="queued-message-delete"
              type="button"
              onClick={() => deleteQueuedMessage(item.id)}
              title="Remove from queue"
            >
              &times;
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
