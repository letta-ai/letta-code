import { expect, test } from "bun:test";
import type { RuntimeStartResponseMessage } from "@/types/app-server-protocol";
import { resolveGatewayModelStatus } from "./gateway-model-status";

test("named conversations keep their model override while default uses the agent", () => {
  const response = {
    success: true,
    agent: { model: "agent-model" },
    conversation: { model: "conversation-model" },
  } as unknown as RuntimeStartResponseMessage;
  expect(
    resolveGatewayModelStatus(
      { agent_id: "agent-1", conversation_id: "conv-1" },
      response,
    ),
  ).toEqual({ modelHandle: "conversation-model", scope: "conversation" });
  expect(
    resolveGatewayModelStatus(
      { agent_id: "agent-1", conversation_id: "default" },
      response,
    ),
  ).toEqual({ modelHandle: "agent-model", scope: "agent" });
});
