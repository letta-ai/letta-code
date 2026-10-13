import { describe, expect, test } from "bun:test";
import { ApiRequestError } from "@/backend/api/request";
import {
  type BrowserDeviceMcpOAuthRequest,
  BrowserDeviceMcpOAuthSiteMismatchError,
} from "@/browser-device-mcp-oauth";
import { type McpSubcommandDependencies, runMcpSubcommand } from "./mcp";

const HANDOFF_KEY = "k".repeat(43);

function harness(overrides: Partial<McpSubcommandDependencies> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const mints: Array<{ agentId: string; service: string; serverUrl: string }> =
    [];
  const connects: BrowserDeviceMcpOAuthRequest[] = [];
  const deps: McpSubcommandDependencies = {
    env: {},
    initializeSettings: async () => {},
    mintMcpOAuthHandoff: async (agentId, service, serverUrl) => {
      mints.push({ agentId, service, serverUrl });
      return { handoff_key: HANDOFF_KEY, expires_in: 600 };
    },
    connectMcpOAuth: async (request) => {
      connects.push(request);
    },
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
    ...overrides,
  };
  return { deps, stdout, stderr, mints, connects };
}

function parseError(stderr: string[]) {
  return JSON.parse(stderr.at(-1) ?? "{}").error as {
    code: string;
    message: string;
    hint?: string;
  };
}

describe("letta mcp connect", () => {
  test("mints a handoff, runs the OAuth, and prints the connection", async () => {
    const h = harness();
    const code = await runMcpSubcommand(
      [
        "connect",
        "datadog",
        "--server-url",
        "https://mcp.datadoghq.eu/v1/mcp/",
        "--agent",
        "agent-1",
      ],
      h.deps,
    );
    expect(code).toBe(0);
    expect(h.mints).toEqual([
      {
        agentId: "agent-1",
        service: "datadog",
        serverUrl: "https://mcp.datadoghq.eu/v1/mcp",
      },
    ]);
    expect(h.connects).toEqual([
      {
        handoffKey: HANDOFF_KEY,
        service: "datadog",
        serverUrl: "https://mcp.datadoghq.eu/v1/mcp",
      },
    ]);
    expect(JSON.parse(h.stdout.join(""))).toEqual({
      connected: true,
      service: "datadog",
      server_url: "https://mcp.datadoghq.eu/v1/mcp",
    });
  });

  test("keeps the process alive while waiting for the OAuth callback", async () => {
    // The real callback server is unref'd, so without a ref'd handle the
    // one-shot CLI would exit before the browser redirect arrives.
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const live = new Set<unknown>();
    globalThis.setInterval = ((fn: () => void, ms?: number) => {
      const handle = originalSetInterval(fn, ms);
      live.add(handle);
      return handle;
    }) as typeof setInterval;
    globalThis.clearInterval = ((handle: unknown) => {
      live.delete(handle);
      originalClearInterval(handle as ReturnType<typeof setInterval>);
    }) as typeof clearInterval;
    let liveDuringConnect = 0;
    try {
      const { deps } = harness({
        connectMcpOAuth: async () => {
          liveDuringConnect = live.size;
        },
      });
      expect(
        await runMcpSubcommand(
          ["connect", "comfy", "--agent", "agent-1"],
          deps,
        ),
      ).toBe(0);
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
    expect(liveDuringConnect).toBeGreaterThan(0);
    expect(live.size).toBe(0);
  });

  test("defaults to the service's first server URL and LETTA_AGENT_ID", async () => {
    const h = harness({ env: { LETTA_AGENT_ID: "agent-env" } });
    expect(await runMcpSubcommand(["connect", "comfy"], h.deps)).toBe(0);
    expect(h.mints).toEqual([
      {
        agentId: "agent-env",
        service: "comfy",
        serverUrl: "https://cloud.comfy.org/mcp",
      },
    ]);
  });

  test("rejects an unknown service and lists valid ones", async () => {
    const h = harness();
    const code = await runMcpSubcommand(
      ["connect", "github", "--agent", "agent-1"],
      h.deps,
    );
    expect(code).toBe(1);
    const error = parseError(h.stderr);
    expect(error.code).toBe("unsupported_service");
    expect(error.hint).toContain("comfy, datadog");
    expect(h.mints).toEqual([]);
  });

  test("rejects a server URL outside the service's definitions", async () => {
    const h = harness();
    const code = await runMcpSubcommand(
      [
        "connect",
        "datadog",
        "--server-url",
        "https://evil.example.com/v1/mcp",
        "--agent",
        "agent-1",
      ],
      h.deps,
    );
    expect(code).toBe(1);
    const error = parseError(h.stderr);
    expect(error.code).toBe("unsupported_server_url");
    expect(error.hint).toContain("https://mcp.us5.datadoghq.com/v1/mcp");
    expect(h.mints).toEqual([]);
  });

  test("explains a 403 mint as an inaccessible agent", async () => {
    const h = harness({
      mintMcpOAuthHandoff: async () => {
        throw new ApiRequestError("API error (403): forbidden", 403, "");
      },
    });
    const code = await runMcpSubcommand(
      ["connect", "comfy", "--agent", "agent-1"],
      h.deps,
    );
    expect(code).toBe(1);
    const error = parseError(h.stderr);
    expect(error.code).toBe("agent_not_accessible");
    expect(error.hint).toContain("different organization");
    expect(error.hint).toContain("letta server --org <org>");
    expect(h.connects).toEqual([]);
  });

  test("reports an authorization timeout", async () => {
    const h = harness({
      connectMcpOAuth: async () => {
        throw new DOMException("timed out", "TimeoutError");
      },
    });
    const code = await runMcpSubcommand(
      ["connect", "comfy", "--agent", "agent-1"],
      h.deps,
    );
    expect(code).toBe(1);
    expect(parseError(h.stderr).code).toBe("authorization_timeout");
    expect(h.stdout).toEqual([]);
  });

  test("reports a failed credential submission", async () => {
    const h = harness({
      connectMcpOAuth: async (_request, onSubmissionStarted) => {
        onSubmissionStarted();
        throw new DOMException("timed out", "TimeoutError");
      },
    });
    const code = await runMcpSubcommand(
      ["connect", "comfy", "--agent", "agent-1"],
      h.deps,
    );
    expect(code).toBe(1);
    expect(parseError(h.stderr).code).toBe("handoff_submit_failed");
  });

  test("restarts Datadog against the site named by the callback domain", async () => {
    const connects: BrowserDeviceMcpOAuthRequest[] = [];
    const h = harness({
      connectMcpOAuth: async (request) => {
        connects.push(request);
        if (request.serverUrl === "https://mcp.datadoghq.com/v1/mcp") {
          throw new BrowserDeviceMcpOAuthSiteMismatchError(
            "us5.datadoghq.com",
            "https://mcp.us5.datadoghq.com/v1/mcp",
          );
        }
      },
    });
    const code = await runMcpSubcommand(
      ["connect", "datadog", "--agent", "agent-1"],
      h.deps,
    );
    expect(code).toBe(0);
    expect(h.mints.map((mint) => mint.serverUrl)).toEqual([
      "https://mcp.datadoghq.com/v1/mcp",
      "https://mcp.us5.datadoghq.com/v1/mcp",
    ]);
    expect(connects.map((request) => request.serverUrl)).toEqual([
      "https://mcp.datadoghq.com/v1/mcp",
      "https://mcp.us5.datadoghq.com/v1/mcp",
    ]);
    expect(h.stderr.join("\n")).toContain("org is on us5.datadoghq.com");
    expect(JSON.parse(h.stdout.join(""))).toEqual({
      connected: true,
      service: "datadog",
      server_url: "https://mcp.us5.datadoghq.com/v1/mcp",
    });
  });

  test("fails with datadog_site_mismatch if the restart mismatches again", async () => {
    const h = harness({
      connectMcpOAuth: async () => {
        throw new BrowserDeviceMcpOAuthSiteMismatchError(
          "us5.datadoghq.com",
          "https://mcp.us5.datadoghq.com/v1/mcp",
        );
      },
    });
    const code = await runMcpSubcommand(
      ["connect", "datadog", "--agent", "agent-1"],
      h.deps,
    );
    expect(code).toBe(1);
    expect(h.mints).toHaveLength(2);
    expect(parseError(h.stderr)).toMatchObject({
      code: "datadog_site_mismatch",
      message:
        "Your Datadog org is on us5.datadoghq.com. Re-run: letta mcp connect datadog --server-url https://mcp.us5.datadoghq.com/v1/mcp",
    });
    expect(h.stdout).toEqual([]);
  });
});
