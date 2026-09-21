import { describe, expect, test } from "bun:test";
import { loadMcpToolArgs, resolveMcpAgentId } from "./mcp-io";

describe("MCP command input", () => {
  test("resolves agent ids in flag and environment precedence", () => {
    const env = { LETTA_AGENT_ID: "agent-letta", AGENT_ID: "agent-generic" };
    expect(resolveMcpAgentId("agent-flag", undefined, env)).toBe("agent-flag");
    expect(resolveMcpAgentId(undefined, "agent-alias", env)).toBe(
      "agent-alias",
    );
    expect(resolveMcpAgentId(undefined, undefined, env)).toBe("agent-letta");
    expect(
      resolveMcpAgentId(undefined, undefined, { AGENT_ID: " agent-2 " }),
    ).toBe("agent-2");
  });

  test("loads inline, file, and stdin JSON objects", async () => {
    await expect(
      loadMcpToolArgs('{"query":"letta"}', undefined, {}),
    ).resolves.toEqual({ query: "letta" });
    await expect(
      loadMcpToolArgs(undefined, "args.json", {
        readFile: async () => '{"limit":3}',
      }),
    ).resolves.toEqual({ limit: 3 });
    await expect(
      loadMcpToolArgs(undefined, "-", {
        readStdin: async () => '{"from":"stdin"}',
      }),
    ).resolves.toEqual({ from: "stdin" });
  });

  test("rejects conflicting and non-object arguments", async () => {
    await expect(loadMcpToolArgs("{}", "args.json", {})).rejects.toThrow(
      "either --args or --args-file",
    );
    await expect(loadMcpToolArgs("[]", undefined, {})).rejects.toThrow(
      "expected a JSON object",
    );
  });
});
