import { expect, mock, test } from "bun:test";
import { registerChannelRuntimeToolsForTurn } from "./channel-runtime-tools";

const runtime = {
  agent_id: "agent-1",
  conversation_id: "conv-schedule-1",
};

test("registers a runtime before channel tools are prepared", async () => {
  const serviceCommandHandler = mock(async () => ({
    kind: "runtime_registered" as const,
  }));

  await expect(
    registerChannelRuntimeToolsForTurn({ serviceCommandHandler }, runtime),
  ).resolves.toBe(true);
  expect(serviceCommandHandler).toHaveBeenCalledWith({
    kind: "register_runtime",
    runtime,
  });
});

test("does not block turns when the channel gateway is absent or fails", async () => {
  await expect(
    registerChannelRuntimeToolsForTurn(
      { serviceCommandHandler: null },
      runtime,
    ),
  ).resolves.toBe(false);

  await expect(
    registerChannelRuntimeToolsForTurn(
      {
        serviceCommandHandler: async () => {
          throw new Error("gateway unavailable");
        },
      },
      runtime,
    ),
  ).resolves.toBe(false);
});
