import { expect, test } from "bun:test";
import {
  getChannelAccountAgentId,
  shouldRestoreChannelAccountForAgentScope,
} from "@/channels/restore-scope";
import type { CustomChannelAccount } from "@/channels/types";

function createPluginAccount(agentId: string): CustomChannelAccount {
  return {
    channel: "linear",
    accountId: "linear-account",
    enabled: true,
    dmPolicy: "open",
    allowedUsers: [],
    config: { agent_id: agentId },
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
  };
}

test("reads the agent binding from generic plugin config", () => {
  expect(getChannelAccountAgentId(createPluginAccount(" agent-cloud "))).toBe(
    "agent-cloud",
  );
});

test("scopes generic plugin restoration by its configured agent", () => {
  expect(
    shouldRestoreChannelAccountForAgentScope(
      createPluginAccount("agent-local-linear"),
      "local",
    ),
  ).toBe(true);
  expect(
    shouldRestoreChannelAccountForAgentScope(
      createPluginAccount("agent-local-linear"),
      "cloud",
    ),
  ).toBe(false);
  expect(
    shouldRestoreChannelAccountForAgentScope(
      createPluginAccount("agent-cloud"),
      "cloud",
    ),
  ).toBe(true);
});
