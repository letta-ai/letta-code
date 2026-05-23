import { describe, expect, test } from "bun:test";
import { buildLegacyMcpServerRepair } from "@/cli/helpers/mcp-server-repair";

describe("buildLegacyMcpServerRepair", () => {
  test("builds a nested config repair for authless streamable HTTP servers", () => {
    expect(
      buildLegacyMcpServerRepair({
        id: "mcp_server-test",
        server_name: "dragonnet",
        mcp_server_type: "streamable_http",
        server_url: "https://example.com/mcp",
        custom_headers: null,
      }),
    ).toEqual({
      server_name: "dragonnet",
      config: {
        mcp_server_type: "streamable_http",
        server_url: "https://example.com/mcp",
      },
    });
  });

  test("builds a nested config repair for authless SSE servers", () => {
    expect(
      buildLegacyMcpServerRepair({
        id: "mcp_server-test",
        server_name: "legacy-sse",
        mcp_server_type: "sse",
        server_url: "https://example.com/sse",
      }),
    ).toEqual({
      server_name: "legacy-sse",
      config: {
        mcp_server_type: "sse",
        server_url: "https://example.com/sse",
      },
    });
  });

  test("skips repairs when visible auth could be dropped", () => {
    expect(
      buildLegacyMcpServerRepair({
        server_name: "secure",
        mcp_server_type: "streamable_http",
        server_url: "https://example.com/mcp",
        auth_header: "Authorization",
      }),
    ).toBeNull();

    expect(
      buildLegacyMcpServerRepair({
        server_name: "secure",
        mcp_server_type: "streamable_http",
        server_url: "https://example.com/mcp",
        auth_token: "redacted-token",
      }),
    ).toBeNull();

    expect(
      buildLegacyMcpServerRepair({
        server_name: "secure",
        mcp_server_type: "streamable_http",
        server_url: "https://example.com/mcp",
        custom_headers: { Authorization: "Bearer redacted" },
      }),
    ).toBeNull();
  });

  test("allows empty custom headers", () => {
    expect(
      buildLegacyMcpServerRepair({
        server_name: "empty-headers",
        mcp_server_type: "streamable_http",
        server_url: "https://example.com/mcp",
        custom_headers: {},
      }),
    ).toEqual({
      server_name: "empty-headers",
      config: {
        mcp_server_type: "streamable_http",
        server_url: "https://example.com/mcp",
      },
    });
  });

  test("skips repairs without a usable URL", () => {
    expect(
      buildLegacyMcpServerRepair({
        server_name: "missing-url",
        mcp_server_type: "streamable_http",
        server_url: "",
      }),
    ).toBeNull();

    expect(
      buildLegacyMcpServerRepair({
        server_name: "blank-url",
        mcp_server_type: "streamable_http",
        server_url: "   ",
      }),
    ).toBeNull();
  });

  test("skips stdio servers", () => {
    expect(
      buildLegacyMcpServerRepair({
        server_name: "stdio-server",
        mcp_server_type: "stdio",
        command: "node",
        args: ["server.js"],
      }),
    ).toBeNull();
  });
});
