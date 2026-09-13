import { expect, mock, test } from "bun:test";
import {
  publishChannelRuntimeToolsForTurn,
  releaseChannelRuntimeToolsForTurn,
} from "./channel-runtime-tools";

const runtime = {
  agent_id: "agent-1",
  conversation_id: "conv-schedule-1",
};

test("publishes runtime tools before channel tools are prepared", async () => {
  const serviceCommandHandler = mock(async () => ({
    kind: "runtime_tools_published" as const,
    transient: true,
  }));

  await expect(
    publishChannelRuntimeToolsForTurn({ serviceCommandHandler }, runtime),
  ).resolves.toBe(true);
  expect(serviceCommandHandler).toHaveBeenCalledWith({
    kind: "publish_runtime_tools",
    runtime,
  });
});

test("releases tools that were published only for one turn", async () => {
  const serviceCommandHandler = mock(async () => ({
    kind: "runtime_tools_released" as const,
  }));

  await releaseChannelRuntimeToolsForTurn({ serviceCommandHandler }, runtime);
  expect(serviceCommandHandler).toHaveBeenCalledWith({
    kind: "release_runtime_tools",
    runtime,
  });
});

test("does not block turns when the channel gateway is absent or fails", async () => {
  await expect(
    publishChannelRuntimeToolsForTurn({ serviceCommandHandler: null }, runtime),
  ).resolves.toBe(false);

  await expect(
    publishChannelRuntimeToolsForTurn(
      {
        serviceCommandHandler: async () => {
          throw new Error("gateway unavailable");
        },
      },
      runtime,
    ),
  ).resolves.toBe(false);
});
