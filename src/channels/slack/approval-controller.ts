import type SlackApp from "@slack/bolt";
import type {
  ChannelAdapter,
  ChannelControlRequestEvent,
  SlackChannelAccount,
} from "@/channels/types";
import type {
  SlackApprovalPromptState,
  SlackWriteClient,
} from "./internal-types";
import {
  buildSlackApprovalDecisionBlocks,
  parseSlackApprovalActionPayload,
  SLACK_APPROVAL_ACTION_ID,
} from "./presentation";
import {
  getSlackActionRecord,
  resolveSlackActionChannelId,
  resolveSlackActionMessageId,
  resolveSlackActionThreadId,
  resolveSlackActionUser,
} from "./utils";

export type SlackApprovalController = {
  register: (app: SlackApp) => void;
  rememberPrompt: (
    event: ChannelControlRequestEvent,
    messageTs: string,
  ) => void;
  clear: () => void;
};

export function createSlackApprovalController(params: {
  config: Pick<SlackChannelAccount, "accountId">;
  getAdapter: () => ChannelAdapter;
  ensureWriteClient: () => Promise<SlackWriteClient>;
}): SlackApprovalController {
  const promptsByRequestId = new Map<string, SlackApprovalPromptState>();

  return {
    register(app): void {
      const actionRegistrar = app as unknown as {
        action?: (
          actionId: string,
          handler: (args: {
            body: unknown;
            action: unknown;
            ack: () => Promise<void>;
          }) => Promise<void>,
        ) => void;
      };
      actionRegistrar.action?.(
        SLACK_APPROVAL_ACTION_ID,
        async ({ body, action, ack }) => {
          await ack();
          const actionRecord = getSlackActionRecord(action, body);
          const payload = parseSlackApprovalActionPayload(actionRecord?.value);
          const user = resolveSlackActionUser(body);
          const adapter = params.getAdapter();
          if (!payload || !user.id || !adapter.onControlResponse) return;

          const prompt = promptsByRequestId.get(payload.requestId);
          const clickedChannelId = resolveSlackActionChannelId(body);
          const clickedMessageTs = resolveSlackActionMessageId(body);
          const responseChatId = clickedChannelId ?? prompt?.source.chatId;
          if (!responseChatId) return;

          const result = await adapter.onControlResponse({
            requestId: payload.requestId,
            senderId: user.id,
            channel: "slack",
            accountId: params.config.accountId,
            chatId: responseChatId,
            threadId:
              resolveSlackActionThreadId(body) ??
              prompt?.source.threadId ??
              null,
            response: {
              request_id: payload.requestId,
              decision:
                payload.decision === "allow"
                  ? { behavior: "allow" }
                  : { behavior: "deny", message: "Denied in Slack." },
            },
          });
          if (result === "unavailable" || result === "forbidden") return;

          const text =
            result === "expired"
              ? "Approval is no longer available."
              : payload.decision === "allow"
                ? `Approved by <@${user.id}>.`
                : `Denied by <@${user.id}>.`;
          const updateTargets = new Map<
            string,
            { channel: string; messageTs: string }
          >();
          if (prompt) {
            updateTargets.set(`${prompt.source.chatId}:${prompt.messageTs}`, {
              channel: prompt.source.chatId,
              messageTs: prompt.messageTs,
            });
          }
          if (clickedMessageTs) {
            updateTargets.set(`${responseChatId}:${clickedMessageTs}`, {
              channel: responseChatId,
              messageTs: clickedMessageTs,
            });
          }

          try {
            const slackClient = await params.ensureWriteClient();
            await Promise.all(
              Array.from(updateTargets.values()).map((target) =>
                slackClient.chat.update({
                  channel: target.channel,
                  ts: target.messageTs,
                  text,
                  blocks: buildSlackApprovalDecisionBlocks(text),
                }),
              ),
            );
            promptsByRequestId.delete(payload.requestId);
          } catch (error) {
            console.warn(
              "[Slack] Failed to update approval prompt:",
              error instanceof Error ? error.message : error,
            );
          }
        },
      );
    },
    rememberPrompt(event, messageTs): void {
      promptsByRequestId.set(event.requestId, {
        source: event.source,
        messageTs,
      });
    },
    clear(): void {
      promptsByRequestId.clear();
    },
  };
}
