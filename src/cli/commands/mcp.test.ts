import { describe, expect, test } from "bun:test";
import { ANYSEARCH_API_KEY_ENV } from "@/mcp-presets";
import { buildMcpServerConfig, resolveMcpAddArgs } from "./mcp";

describe("resolveMcpAddArgs", () => {
  test("bare preset name resolves the built-in anysearch preset", () => {
    const originalKey = process.env[ANYSEARCH_API_KEY_ENV];
    delete process.env[ANYSEARCH_API_KEY_ENV];
    try {
      const result = resolveMcpAddArgs(["anysearch"]);

      expect(result.kind).toBe("args");
      if (result.kind !== "args") throw new Error("expected args");
      expect(result.args.transport).toBe("http");
      expect(result.args.name).toBe("anysearch");
      expect(result.args.url).toBe("https://api.anysearch.com/mcp");
      expect(result.args.headers["X-Anysearch-Client"]).toMatch(
        /^letta-code\//,
      );
      expect(result.args.headers.Authorization).toBeUndefined();
      expect(result.args.authTokenEnv).toBeNull();
    } finally {
      if (originalKey === undefined) delete process.env[ANYSEARCH_API_KEY_ENV];
      else process.env[ANYSEARCH_API_KEY_ENV] = originalKey;
    }
  });

  test("configured ANYSEARCH_API_KEY produces a placeholder Authorization header", () => {
    const originalKey = process.env[ANYSEARCH_API_KEY_ENV];
    process.env[ANYSEARCH_API_KEY_ENV] = "sk-should-not-leak";
    try {
      const result = resolveMcpAddArgs(["anysearch"]);

      expect(result.kind).toBe("args");
      if (result.kind !== "args") throw new Error("expected args");
      expect(result.args.headers.Authorization).toBe(
        `Bearer \${${ANYSEARCH_API_KEY_ENV}}`,
      );
      expect(JSON.stringify(result.args)).not.toContain("sk-should-not-leak");
    } finally {
      if (originalKey === undefined) delete process.env[ANYSEARCH_API_KEY_ENV];
      else process.env[ANYSEARCH_API_KEY_ENV] = originalKey;
    }
  });

  test("explicit --transport still wins even if the name matches a preset id", () => {
    const result = resolveMcpAddArgs([
      "--transport",
      "http",
      "anysearch",
      "https://example.com/mcp",
    ]);

    expect(result.kind).toBe("args");
    if (result.kind !== "args") throw new Error("expected args");
    expect(result.args.url).toBe("https://example.com/mcp");
    expect(result.args.headers).toEqual({});
    expect(result.args.oauth).toBeUndefined();
  });

  test("regression: existing explicit --transport/url syntax is unaffected", () => {
    const result = resolveMcpAddArgs([
      "--transport",
      "http",
      "notion",
      "https://mcp.notion.com/mcp",
    ]);

    expect(result.kind).toBe("args");
    if (result.kind !== "args") throw new Error("expected args");
    expect(result.args).toEqual({
      transport: "http",
      name: "notion",
      url: "https://mcp.notion.com/mcp",
      command: null,
      args: [],
      cwd: null,
      env: {},
      headers: {},
      authTokenEnv: null,
    });
  });

  test("regression: a bare single word that is not a known preset still falls through to the old usage error", () => {
    const result = resolveMcpAddArgs(["some-random-name"]);

    expect(result).toEqual({ kind: "invalid" });
  });

  test("regression: missing required args still reports invalid", () => {
    expect(resolveMcpAddArgs([])).toEqual({ kind: "invalid" });
    expect(resolveMcpAddArgs(["--transport", "http"])).toEqual({
      kind: "invalid",
    });
  });
});

/**
 * The preset registry reserves no token. Only a single bare registered
 * name is a preset request; every other argument list goes to the
 * pre-existing manual parser exactly as it did before presets existed. In
 * particular a stdio child command's own arguments — including a literal
 * `--preset` — must keep passing through untouched.
 */
describe("resolveMcpAddArgs: no reserved token, stdio passthrough preserved", () => {
  test("historical stdio passthrough: a literal --preset foo reaches the child command unchanged", () => {
    const result = resolveMcpAddArgs([
      "--transport",
      "stdio",
      "example",
      "some-cli",
      "--preset",
      "foo",
    ]);

    expect(result.kind).toBe("args");
    if (result.kind !== "args") throw new Error("expected args");
    expect(result.args.transport).toBe("stdio");
    expect(result.args.name).toBe("example");
    expect(result.args.command).toBe("some-cli");
    expect(result.args.args).toEqual(["--preset", "foo"]);
  });

  test("arbitrary stdio child --preset values pass through in position, alongside other child args", () => {
    const result = resolveMcpAddArgs([
      "--transport",
      "stdio",
      "example",
      "some-cli",
      "serve",
      "--preset=bar",
      "--verbose",
      "--preset",
      "baz",
    ]);

    expect(result.kind).toBe("args");
    if (result.kind !== "args") throw new Error("expected args");
    expect(result.args.command).toBe("some-cli");
    expect(result.args.args).toEqual([
      "serve",
      "--preset=bar",
      "--verbose",
      "--preset",
      "baz",
    ]);
  });

  test("stdio passthrough survives all the way into the persisted config", () => {
    const resolved = resolveMcpAddArgs([
      "--transport",
      "stdio",
      "example",
      "some-cli",
      "--preset",
      "foo",
    ]);
    expect(resolved.kind).toBe("args");
    if (resolved.kind !== "args") throw new Error("expected args");

    const config = buildMcpServerConfig(resolved.args);

    expect(config.transport).toBe("stdio");
    expect(config).toMatchObject({
      name: "example",
      command: "some-cli",
      args: ["--preset", "foo"],
    });
    expect("oauth" in config).toBe(false);
  });

  test("regression: a manual SSE config is parsed exactly as before", () => {
    const result = resolveMcpAddArgs([
      "--transport",
      "sse",
      "events",
      "https://example.com/sse",
      "--header",
      "X-Custom: 1",
    ]);

    expect(result.kind).toBe("args");
    if (result.kind !== "args") throw new Error("expected args");
    expect(result.args.transport).toBe("sse");
    expect(result.args.url).toBe("https://example.com/sse");
    expect(result.args.headers).toEqual({ "X-Custom": "1" });
    expect(result.args.oauth).toBeUndefined();
  });

  test("a bare word that merely resembles a preset name is not a preset", () => {
    expect(resolveMcpAddArgs(["anysearch2"])).toEqual({ kind: "invalid" });
    expect(resolveMcpAddArgs(["AnySearch"])).toEqual({ kind: "invalid" });
  });

  test("a registered preset name is only a preset request when it is the sole token", () => {
    const result = resolveMcpAddArgs(["anysearch", "extra"]);
    // Two tokens is not the preset form, so this is the ordinary manual
    // path — which rejects it for lacking --transport/url, as it always did.
    expect(result).toEqual({ kind: "invalid" });
  });
});

/**
 * Object.prototype pollution guard: MCP_SERVER_PRESETS is an ordinary
 * object, so bracket lookup by an inherited property name (toString,
 * constructor, hasOwnProperty, __proto__, ...) would otherwise be truthy
 * even though nothing registered that name as a preset.
 */
describe("resolveMcpAddArgs: preset lookup is not fooled by Object.prototype", () => {
  const inheritedNames = [
    "toString",
    "constructor",
    "hasOwnProperty",
    "__proto__",
    "proto",
  ];

  for (const name of inheritedNames) {
    test(`bare "${name}" is not recognized as a known preset (falls through to the normal invalid path)`, () => {
      const result = resolveMcpAddArgs([name]);
      // Not a registered preset, so this must take the ordinary bare-word
      // path: parseMcpAddArgs rejects it (no --transport/url), never the
      // preset branch via prototype leakage.
      expect(result).toEqual({ kind: "invalid" });
    });
  }
});

/**
 * These tests exercise the REAL boundary `/mcp add` runs before it ever
 * touches settingsManager/replaceClientMcpServers:
 *   resolveMcpAddArgs(parts) -> buildMcpServerConfig(args)
 * A bug where the AnySearch preset's `oauth: false` was computed correctly
 * by resolveMcpPreset() but silently dropped between resolveMcpAddArgs and
 * the McpServerConfig handleMcpAdd actually persists was only catchable by
 * testing this full chain, not resolveMcpPreset()/resolveMcpAddArgs() in
 * isolation.
 */
describe("buildMcpServerConfig (the real /mcp add config construction)", () => {
  test("bare `/mcp add anysearch` produces a persisted/runtime config with oauth: false", () => {
    const originalKey = process.env[ANYSEARCH_API_KEY_ENV];
    delete process.env[ANYSEARCH_API_KEY_ENV];
    try {
      const resolved = resolveMcpAddArgs(["anysearch"]);
      expect(resolved.kind).toBe("args");
      if (resolved.kind !== "args") throw new Error("expected args");

      const config = buildMcpServerConfig(resolved.args);

      expect(config.transport).toBe("http");
      expect(config).toMatchObject({ name: "anysearch", oauth: false });
    } finally {
      if (originalKey === undefined) delete process.env[ANYSEARCH_API_KEY_ENV];
      else process.env[ANYSEARCH_API_KEY_ENV] = originalKey;
    }
  });

  test("authenticated AnySearch: oauth: false and the Authorization placeholder both survive to the final config", () => {
    const originalKey = process.env[ANYSEARCH_API_KEY_ENV];
    process.env[ANYSEARCH_API_KEY_ENV] = "sk-should-not-leak";
    try {
      const resolved = resolveMcpAddArgs(["anysearch"]);
      expect(resolved.kind).toBe("args");
      if (resolved.kind !== "args") throw new Error("expected args");

      const config = buildMcpServerConfig(resolved.args);

      expect(config.transport === "http" || config.transport === "sse").toBe(
        true,
      );
      expect(config).toMatchObject({
        name: "anysearch",
        oauth: false,
      });
      expect(
        config.transport === "http" || config.transport === "sse"
          ? config.headers?.Authorization
          : undefined,
      ).toBe(`Bearer \${${ANYSEARCH_API_KEY_ENV}}`);
      expect(JSON.stringify(config)).not.toContain("sk-should-not-leak");
    } finally {
      if (originalKey === undefined) delete process.env[ANYSEARCH_API_KEY_ENV];
      else process.env[ANYSEARCH_API_KEY_ENV] = originalKey;
    }
  });

  test("regression: an existing manual --transport config has no oauth field at all", () => {
    const resolved = resolveMcpAddArgs([
      "--transport",
      "http",
      "notion",
      "https://mcp.notion.com/mcp",
    ]);
    expect(resolved.kind).toBe("args");
    if (resolved.kind !== "args") throw new Error("expected args");

    const config = buildMcpServerConfig(resolved.args);

    expect(config).toEqual({
      name: "notion",
      transport: "http",
      url: "https://mcp.notion.com/mcp",
    });
    expect("oauth" in config).toBe(false);
  });

  test("regression: a manual stdio config is unaffected by the oauth field", () => {
    const resolved = resolveMcpAddArgs([
      "--transport",
      "stdio",
      "filesystem",
      "npx",
      "-y",
      "@modelcontextprotocol/server-filesystem",
      ".",
    ]);
    expect(resolved.kind).toBe("args");
    if (resolved.kind !== "args") throw new Error("expected args");

    const config = buildMcpServerConfig(resolved.args);

    expect(config.transport).toBe("stdio");
    expect("oauth" in config).toBe(false);
  });
});
