import { expect, test } from "bun:test";
import { buildGatewayMessageChannelTool } from "./message-channel-gateway-tool";

test("does not build MessageChannel without an eligible route", async () => {
  expect(await buildGatewayMessageChannelTool([])).toBeNull();
});
