import { afterEach, describe, expect, test } from "bun:test";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseManagedEventArgs,
  runManagedEventCommand,
} from "@/skills/builtin/using-mcp-tools/scripts/manage-managed-events.mjs";

const temporaryFiles: string[] = [];
const env = {
  AGENT_ID: "agent-1",
  LETTA_API_KEY: "secret-api-key",
  LETTA_BASE_URL: "https://api.example.test",
};

afterEach(async () => {
  await Promise.all(
    temporaryFiles.splice(0).map((path) => unlink(path).catch(() => undefined)),
  );
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("using-mcp-tools managed event helper", () => {
  test("discovers only agent connections with MCP server identifiers", async () => {
    let authorization = "";
    let requestedUrl = "";
    const result = await runManagedEventCommand(
      parseManagedEventArgs(["connections"]),
      {
        env,
        fetch: async (
          input: Parameters<typeof fetch>[0],
          init?: RequestInit,
        ) => {
          requestedUrl = String(input);
          authorization = String(
            init?.headers &&
              Object.fromEntries(new Headers(init.headers)).authorization,
          );
          return jsonResponse({
            connections: [
              {
                display_name: "Work Zoom",
                mcp_server_id: "mcp-zoom",
                service: "zoom_composio",
              },
              { display_name: "Slack", mcp_server_id: null, service: "slack" },
            ],
          });
        },
      },
    );

    expect(requestedUrl).toBe(
      "https://api.example.test/v1/agents/agent-1/connections",
    );
    expect(authorization).toBe("Bearer secret-api-key");
    expect(result).toEqual({
      connections: [
        {
          display_name: "Work Zoom",
          mcp_server_id: "mcp-zoom",
          service_id: "zoom_composio",
        },
      ],
    });
  });

  test("reads trigger configuration from a file and targets one agent attachment", async () => {
    const configPath = join(
      tmpdir(),
      `managed-event-${process.pid}-${Date.now()}.json`,
    );
    temporaryFiles.push(configPath);
    await writeFile(configPath, JSON.stringify({ channel: "alerts" }), {
      mode: 0o600,
    });
    let requestBody: unknown;
    let requestedUrl = "";

    const result = await runManagedEventCommand(
      parseManagedEventArgs([
        "subscribe",
        "--service-id",
        "zoom/composio",
        "--server-id",
        "mcp server",
        "--trigger-slug",
        "ZOOM_RECORDING_READY",
        "--webhook-id",
        "webhook-1",
        "--config-file",
        configPath,
        "--confirm",
      ]),
      {
        env,
        fetch: async (
          input: Parameters<typeof fetch>[0],
          init?: RequestInit,
        ) => {
          requestedUrl = String(input);
          requestBody = JSON.parse(String(init?.body));
          return jsonResponse({
            subscription: {
              id: "trigger-1",
              trigger_config: { channel: "alerts" },
              trigger_slug: "ZOOM_RECORDING_READY",
              webhook_id: "webhook-1",
            },
          });
        },
      },
    );

    expect(requestedUrl).toBe(
      "https://api.example.test/v1/agents/agent-1/managed-mcp-connections/zoom%2Fcomposio/mcp%20server/trigger-subscriptions",
    );
    expect(requestBody).toEqual({
      trigger_config: { channel: "alerts" },
      trigger_slug: "ZOOM_RECORDING_READY",
      webhook_id: "webhook-1",
    });
    expect(result).toEqual({
      subscription: {
        id: "trigger-1",
        trigger_config: { channel: "alerts" },
        trigger_slug: "ZOOM_RECORDING_READY",
        webhook_id: "webhook-1",
      },
    });
  });

  test("reports a non-definitive provider failure without inviting a blind retry", async () => {
    const result = await runManagedEventCommand(
      parseManagedEventArgs([
        "subscribe",
        "--service-id",
        "zoom_composio",
        "--server-id",
        "mcp-1",
        "--trigger-slug",
        "ZOOM_RECORDING_READY",
        "--webhook-id",
        "webhook-1",
        "--confirm",
      ]),
      {
        env,
        fetch: async () =>
          jsonResponse(
            { error_code: "triggerSubscriptionFailed", message: "upstream" },
            502,
          ),
      },
    );

    expect(result).toEqual({
      guidance:
        "List subscriptions and reconcile the trigger slug, configuration, and webhook before retrying.",
      http_status: 502,
      operation: "subscribe",
      reason: "provider result is unknown",
      status: "accepted_unconfirmed",
    });
  });

  test("documents that managed triggers are not the draft MCP Events protocol", async () => {
    const skill = await readFile(
      new URL("./builtin/using-mcp-tools/SKILL.md", import.meta.url),
      "utf8",
    );
    expect(skill).toContain("not the MCP Events protocol");
    expect(skill).toContain("MCP Events is still a draft MCP");
    expect(skill).toContain("provider-backed trigger subscriptions");
  });
});
