import { expect, mock, test } from "bun:test";
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { createAttachedClient } from "@/cli/app/attached-client";
import { terminalSocket } from "@/cli/app/terminal-runtime-events";

test("direct Cloud uses the SDK Cloud transport and query authentication", async () => {
  const socket = terminalSocket(() => {});
  const credentials = async () => ({
    apiKey: "test-key",
    apiBaseUrl: "https://api.letta.com",
  });
  const create = mock(
    (options: ConstructorParameters<typeof LettaAgentClient>[0]) =>
      new LettaAgentClient(options),
  );
  const client = await createAttachedClient(
    "cloud",
    socket,
    credentials,
    create,
  );
  expect(create).toHaveBeenCalledTimes(1);
  expect(create.mock.calls[0]?.[0]).toEqual({
    backend: "cloud",
    apiKey: "test-key",
    apiBaseUrl: "https://api.letta.com",
    webSocketAuth: "query",
    WebSocket: socket,
  });
  await client.close();
});

test("missing Cloud credentials abort before constructing a client", async () => {
  const create = mock(() => {
    throw new Error("unexpected client");
  });
  await expect(
    createAttachedClient(
      "cloud",
      terminalSocket(() => {}),
      async () => ({ apiKey: "", apiBaseUrl: "https://api.letta.com" }),
      create,
    ),
  ).rejects.toThrow("LETTA_API_KEY");
  expect(create).not.toHaveBeenCalled();
});
