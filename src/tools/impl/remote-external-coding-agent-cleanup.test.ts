import { expect, test } from "bun:test";
import type { AppServerClient } from "@/app-server-client";
import type { EnvironmentConnection } from "@/backend/api/environments";
import type { SubagentStopCommand } from "@/types/subagent-protocol";
import { stopRemoteExternalCodingAgent } from "./remote-external-coding-agent";

const environment: EnvironmentConnection = {
  id: "env-test",
  connectionId: "conn-test",
  deviceId: "device-test",
  connectionName: "worker",
  organizationId: "org-test",
  podId: "pod-test",
  connectedAt: 1,
  lastHeartbeat: 1,
  lastSeenAt: 1,
  firstSeenAt: 1,
  metadata: { subagent_message: true },
};

test.each([undefined, false])(
  "rejects remote stops without confirmed process cleanup (%s)",
  async (confirmed) => {
    let closed = false;
    const client = {
      stopSubagent: async (command: SubagentStopCommand) => ({
        ...command,
        type: "subagent_stop_response",
        success: true,
        stopped: true,
        cleanup_confirmed: confirmed,
      }),
      close: () => {
        closed = true;
      },
    } as unknown as AppServerClient;
    await expect(
      stopRemoteExternalCodingAgent(
        {
          agentId: "claude_11111111-1111-4111-8111-111111111111@device-test",
          parentScope: {
            agentId: "agent-parent",
            conversationId: "conv-parent",
          },
        },
        {
          resolveComputer: async () => ({
            connectionId: "conn-test",
            environment,
          }),
          connect: async () => client,
        },
      ),
    ).rejects.toThrow("did not confirm process cleanup");
    expect(closed).toBe(true);
  },
);
