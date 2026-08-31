import { describe, expect, test } from "bun:test";
import {
  assignMcpServerAliases,
  formatServerMcpToolName,
  uniqueMcpName,
} from "./mcp-tool-names";

describe("MCP CLI tool names", () => {
  test("assigns server aliases before client aliases", () => {
    expect(
      Object.fromEntries(
        assignMcpServerAliases([
          { key: "client:foo bar", name: "foo bar", kind: "client" },
          { key: "server:1", name: "foo_bar", kind: "server" },
        ]),
      ),
    ).toEqual({ "server:1": "foo_bar", "client:foo bar": "foo_bar_2" });
  });

  test("avoids aliases that already contain numeric suffixes", () => {
    const aliases = assignMcpServerAliases([
      { key: "server:1", name: "foo", kind: "server" },
      { key: "server:2", name: "foo_2", kind: "server" },
      { key: "server:3", name: "foo", kind: "server" },
    ]);
    expect([...aliases.values()]).toEqual(["foo", "foo_2", "foo_3"]);
  });

  test("keeps the tool-name separator out of server aliases", () => {
    expect(
      assignMcpServerAliases([
        { key: "server:1", name: "foo bar", kind: "server" },
        { key: "client:1", name: "foo__bar", kind: "client" },
      ]),
    ).toEqual(
      new Map([
        ["server:1", "foo_bar"],
        ["client:1", "foo_bar_2"],
      ]),
    );
  });

  test("rewrites server-generated names with the assigned alias", () => {
    expect(
      formatServerMcpToolName(
        "foo bar",
        "foo_bar_2",
        "mcp__foo_bar__search/exact",
      ),
    ).toBe("mcp__foo_bar_2__search_exact");
    expect(uniqueMcpName("echo", new Set(["echo", "echo_2"]))).toBe("echo_3");
  });
});
