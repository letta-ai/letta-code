import { describe, expect, test } from "bun:test";
import { ACTING_USER_ID_HEADER } from "@/agent/acting-user";
import type { apiRequest } from "@/backend/api/request";
import {
  buildPermissionsReport,
  resolvePermissionsAgentId,
  runPermissionsSubcommand,
} from "@/cli/subcommands/permissions";

const OWNER = {
  id: "user-owner",
  name: "Owner",
  email: "owner@example.com",
  image_url: "https://example.com/owner.png",
};

function captureOutput(): {
  logs: string[];
  errors: string[];
  restore: () => void;
} {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

function makeRequest() {
  const calls: Array<{
    method: string;
    path: string;
    options: {
      headers?: Record<string, string>;
      query?: Record<string, string>;
    };
  }> = [];
  const request = async (
    method: string,
    path: string,
    _body?: Record<string, unknown>,
    options: {
      headers?: Record<string, string>;
      query?: Record<string, string>;
    } = {},
  ): Promise<unknown> => {
    calls.push({ method, path, options });
    if (path.endsWith("/owner")) return { owner: OWNER };
    if (path.endsWith("/sharing-settings")) {
      return {
        level: "organization",
        sharedWithOrganization: true,
        defaultRole: "analyst",
      };
    }
    if (path.endsWith("/shared-users")) {
      return {
        users: [{ user_id: "user-editor", role: "editor", user: null }],
      };
    }
    if (options.query?.relationship === "shared_with_agent") {
      return {
        sandbox_api_key_exists: true,
        peers: [
          { agent_id: "agent-source", role: "agent_peer" },
          { agent_id: "agent-hidden", role: "agent_peer" },
          { agent_id: "agent-missing", role: "agent_peer" },
        ],
      };
    }
    if (options.query?.relationship === "accessible_by_agent") {
      return {
        sandbox_api_key_exists: true,
        peers: [
          { agent_id: "agent-target", role: "agent_peer" },
          { agent_id: "agent-hidden", role: "agent_peer" },
        ],
      };
    }
    if (path.endsWith("/agent-source")) {
      return { name: "Research agent", hidden: false };
    }
    if (path.endsWith("/agent-target")) return { name: "Release agent" };
    if (path.endsWith("/agent-hidden")) {
      return { name: "Internal subagent", hidden: true };
    }
    if (path.endsWith("/agent-missing")) throw new Error("Agent not found");
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  return { request: request as typeof apiRequest, calls };
}

describe("permissions subcommand", () => {
  test("resolves target precedence from flag, LETTA_AGENT_ID, then AGENT_ID", () => {
    expect(
      resolvePermissionsAgentId(" agent-flag ", {
        LETTA_AGENT_ID: "agent-letta",
        AGENT_ID: "agent-runtime",
      }),
    ).toBe("agent-flag");
    expect(
      resolvePermissionsAgentId(undefined, {
        LETTA_AGENT_ID: "agent-letta",
        AGENT_ID: "agent-runtime",
      }),
    ).toBe("agent-letta");
    expect(
      resolvePermissionsAgentId(undefined, { AGENT_ID: "agent-runtime" }),
    ).toBe("agent-runtime");
    expect(resolvePermissionsAgentId(undefined, {})).toBe("");
  });

  test("filters hidden and unresolved peers while forwarding acting-user attribution", async () => {
    const { request, calls } = makeRequest();

    const report = await buildPermissionsReport(
      "agent/a",
      request,
      "user-acting",
    );

    expect(calls).toHaveLength(9);
    expect(calls.map(({ method }) => method)).toEqual(Array(9).fill("GET"));
    expect(calls.map(({ path }) => path)).toEqual([
      "/v1/agents/agent%2Fa/owner",
      "/v1/agents/agent%2Fa/sharing-settings",
      "/v1/agents/agent%2Fa/shared-users",
      "/v1/agents/agent%2Fa/peers",
      "/v1/agents/agent%2Fa/peers",
      "/v1/agents/agent-source",
      "/v1/agents/agent-hidden",
      "/v1/agents/agent-missing",
      "/v1/agents/agent-target",
    ]);
    expect(calls.map(({ options }) => options.query?.relationship)).toEqual([
      undefined,
      undefined,
      undefined,
      "shared_with_agent",
      "accessible_by_agent",
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    for (const call of calls) {
      expect(call.options.headers).toEqual({
        [ACTING_USER_ID_HEADER]: "user-acting",
      });
    }
    expect(report.direct_incoming_peer_grants).toEqual([
      {
        agent_id: "agent-source",
        role: "agent_peer",
        name: "Research agent",
      },
    ]);
    expect(report.direct_outgoing_peer_grants).toEqual([
      {
        agent_id: "agent-target",
        role: "agent_peer",
        name: "Release agent",
      },
    ]);
    expect(JSON.stringify(report)).not.toContain("agent-hidden");
    expect(JSON.stringify(report)).not.toContain("agent-missing");
  });

  test("prints an explicit configured/direct-only JSON report", async () => {
    const out = captureOutput();
    const { request } = makeRequest();
    try {
      const code = await runPermissionsSubcommand(["--agent", "agent-1"], {
        initializeSettings: async () => {},
        request,
        isLocalBackend: () => false,
        getActingUserId: () => "user-acting",
      });

      expect(code).toBe(0);
      expect(out.errors).toEqual([]);
      expect(JSON.parse(out.logs.join("\n"))).toEqual({
        agent_id: "agent-1",
        report_scope: "configured_direct_access_only",
        exhaustive_effective_access: false,
        owner: OWNER,
        organization_sharing: {
          level: "organization",
          shared_with_organization: true,
          default_role: "analyst",
        },
        explicit_shared_users: [
          { user_id: "user-editor", role: "editor", user: null },
        ],
        direct_incoming_peer_grants: [
          {
            agent_id: "agent-source",
            role: "agent_peer",
            name: "Research agent",
          },
        ],
        direct_outgoing_peer_grants: [
          {
            agent_id: "agent-target",
            role: "agent_peer",
            name: "Release agent",
          },
        ],
      });
    } finally {
      out.restore();
    }
  });

  test("returns a JSON error when no target is available", async () => {
    const out = captureOutput();
    const previousLettaAgentId = process.env.LETTA_AGENT_ID;
    const previousAgentId = process.env.AGENT_ID;
    delete process.env.LETTA_AGENT_ID;
    delete process.env.AGENT_ID;
    try {
      expect(
        await runPermissionsSubcommand([], { isLocalBackend: () => false }),
      ).toBe(1);
      expect(JSON.parse(out.errors[0] ?? "{}").error).toContain(
        "Agent id required",
      );
      expect(out.logs).toEqual([]);
    } finally {
      if (previousLettaAgentId === undefined) delete process.env.LETTA_AGENT_ID;
      else process.env.LETTA_AGENT_ID = previousLettaAgentId;
      if (previousAgentId === undefined) delete process.env.AGENT_ID;
      else process.env.AGENT_ID = previousAgentId;
      out.restore();
    }
  });

  test("rejects local backend and local agents without making requests", async () => {
    for (const testCase of [
      { agentId: "agent-1", isLocalBackend: true },
      { agentId: "agent-local-1", isLocalBackend: false },
    ]) {
      const out = captureOutput();
      let requested = false;
      try {
        const code = await runPermissionsSubcommand(
          ["--agent", testCase.agentId],
          {
            initializeSettings: async () => {},
            request: (async () => {
              requested = true;
              return {};
            }) as typeof apiRequest,
            isLocalBackend: () => testCase.isLocalBackend,
          },
        );
        expect(code).toBe(1);
        expect(requested).toBe(false);
        expect(JSON.parse(out.errors[0] ?? "{}").error).toContain(
          "only available for Letta Cloud agents",
        );
      } finally {
        out.restore();
      }
    }
  });

  test("returns an API failure as JSON", async () => {
    const out = captureOutput();
    try {
      const code = await runPermissionsSubcommand(["--agent", "agent-1"], {
        initializeSettings: async () => {},
        request: (async () => {
          throw new Error("permission denied");
        }) as typeof apiRequest,
        isLocalBackend: () => false,
      });
      expect(code).toBe(1);
      expect(JSON.parse(out.errors[0] ?? "{}")).toEqual({
        error: "permission denied",
      });
      expect(out.logs).toEqual([]);
    } finally {
      out.restore();
    }
  });
});
