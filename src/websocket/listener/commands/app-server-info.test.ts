import { describe, expect, test } from "bun:test";
import { APP_SERVER_PROTOCOL_VERSION } from "@/types/app-server-info";
import { parseServerMessage } from "@/websocket/listener/protocol-inbound";
import { buildAppServerInfoResponse } from "./app-server-info";

describe("app-server info protocol", () => {
  test("parses a pre-runtime info request", () => {
    expect(
      parseServerMessage(
        Buffer.from(
          JSON.stringify({
            type: "app_server_info",
            request_id: "info-1",
          }),
        ),
      ),
    ).toEqual({
      type: "app_server_info",
      request_id: "info-1",
    });
  });

  test("rejects info requests without a correlation id", () => {
    expect(
      parseServerMessage(
        Buffer.from(JSON.stringify({ type: "app_server_info" })),
      ),
    ).toBeNull();
  });

  test("reports backend, version, and required client capabilities", () => {
    expect(
      buildAppServerInfoResponse(
        { type: "app_server_info", request_id: "info-2" },
        { backend: "local", version: "0.29.1" },
      ),
    ).toEqual({
      type: "app_server_info_response",
      request_id: "info-2",
      success: true,
      backend: "local",
      letta_code_version: "0.29.1",
      protocol_version: APP_SERVER_PROTOCOL_VERSION,
      capabilities: {
        agent_management: true,
        conversation_management: true,
        memory_management: true,
        runtime_start: true,
        runtime_workspace_sandbox: true,
        runtime_external_tools_update: true,
        split_channels: false,
      },
    });
  });
});
