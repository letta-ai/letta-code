import { expect, test } from "bun:test";
import type { InputCreateMessagePayload } from "@/types/protocol_v2";
import { ChannelGateway } from "./gateway-core";
import { buildGatewayInput } from "./gateway-input";
import {
  FakeClient,
  makeDelivery,
  makeHooks,
  makeTurnFinished,
  TEST_RUNTIME,
} from "./gateway-test-support";

test("legacy channel messages retain their user wrapper and image policy", () => {
  expect(
    buildGatewayInput({ content: "hello", clientMessageId: "cm-1" }),
  ).toEqual({
    kind: "create_message",
    messages: [{ role: "user", content: "hello", client_message_id: "cm-1" }],
    image_failure_mode: "drop",
  });
});

test("explicit payload preserves roles, parts, IDs and tool/image policies", () => {
  const payload: InputCreateMessagePayload = {
    kind: "create_message",
    messages: [
      { role: "user", content: "first", client_message_id: "cm-1" },
      { role: "assistant", content: "second", client_message_id: "cm-2" },
    ],
    image_failure_mode: "strict",
    client_tool_allowlist: ["Read"],
  };
  expect(
    buildGatewayInput({
      content: "unused",
      clientMessageId: "cm-1",
      inputPayload: payload,
    }),
  ).toBe(payload);
  expect(() =>
    buildGatewayInput({
      content: "",
      clientMessageId: "wrong",
      inputPayload: payload,
    }),
  ).toThrow("first input message");
});

test("caller input uses the same queue, progress and finish hooks exactly once", async () => {
  const client = new FakeClient();
  const { hooks, lifecycleEvents } = makeHooks();
  const gateway = new ChannelGateway(client, hooks);
  const inputPayload: InputCreateMessagePayload = {
    kind: "create_message",
    messages: [
      { role: "user", content: "worker brief", client_message_id: "cm-worker" },
    ],
    image_failure_mode: "strict",
  };
  const delivery = {
    ...makeDelivery({ clientMessageId: "cm-worker" }),
    inputPayload,
  };
  expect(await gateway.submitInput(delivery)).toMatchObject({
    accepted: true,
    disposition: "started",
  });
  expect(await gateway.submitInput(delivery)).toMatchObject({ accepted: true });
  expect(client.submittedInputs).toHaveLength(1);
  expect(client.submittedInputs[0]?.payload).toEqual(inputPayload);
  client.emit(makeTurnFinished("end_turn", TEST_RUNTIME));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(lifecycleEvents.map((event) => event.type)).toEqual([
    "queued",
    "processing",
    "finished",
  ]);
  gateway.close();
});
