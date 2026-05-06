import { describe, expect, test } from "bun:test";
import {
  isOperatorDestinationDeleteCommand,
  isOperatorDestinationGetCommand,
  isOperatorDestinationSetCommand,
} from "../../websocket/listener/protocol-inbound";

describe("operator destination protocol validators", () => {
  test("accept valid operator destination commands", () => {
    expect(
      isOperatorDestinationGetCommand({
        type: "operator_destination_get",
        request_id: "req-1",
        agent_id: "agent-1",
        conversation_id: null,
      }),
    ).toBe(true);

    expect(
      isOperatorDestinationSetCommand({
        type: "operator_destination_set",
        request_id: "req-2",
        destination: {
          agent_id: "agent-1",
          channel_id: "telegram",
          account_id: "account-1",
          chat_id: "515978553",
          notify_on_errors: true,
          notify_on_retries: false,
          use_as_message_channel_default: true,
        },
      }),
    ).toBe(true);

    expect(
      isOperatorDestinationDeleteCommand({
        type: "operator_destination_delete",
        request_id: "req-3",
        id: "operator-1",
      }),
    ).toBe(true);
  });

  test("rejects invalid operator destination payloads", () => {
    expect(
      isOperatorDestinationSetCommand({
        type: "operator_destination_set",
        request_id: "req-1",
        destination: {
          agent_id: "agent-1",
          channel_id: "missing-channel",
          account_id: "account-1",
          chat_id: "515978553",
        },
      }),
    ).toBe(false);

    expect(
      isOperatorDestinationSetCommand({
        type: "operator_destination_set",
        request_id: "req-1",
        destination: {
          agent_id: "agent-1",
          channel_id: "telegram",
          account_id: "account-1",
          chat_id: "515978553",
          surprise: true,
        },
      }),
    ).toBe(false);
  });
});
