import { describe, expect, test } from "bun:test";
import { getVersion } from "@/version";
import {
  ANYSEARCH_API_KEY_ENV,
  ANYSEARCH_CLIENT_HEADER,
  ANYSEARCH_MCP_URL,
  listMcpPresets,
  MCP_SERVER_PRESETS,
  resolveMcpPreset,
} from "./mcp-presets";

describe("MCP built-in presets", () => {
  test("registers anysearch as a discoverable preset", () => {
    expect(MCP_SERVER_PRESETS.anysearch).toBeDefined();
    expect(listMcpPresets().map((preset) => preset.id)).toContain("anysearch");
  });

  test("resolveMcpPreset returns undefined for an unknown id", () => {
    expect(resolveMcpPreset("not-a-real-preset", {})).toBeUndefined();
  });

  test.each([
    "toString",
    "constructor",
    "hasOwnProperty",
    "__proto__",
    "proto",
  ])(
    "resolveMcpPreset is not fooled by the inherited Object.prototype name %p",
    (name) => {
      expect(resolveMcpPreset(name, {})).toBeUndefined();
    },
  );

  test("anonymous config: no key configured produces no Authorization header", () => {
    const config = resolveMcpPreset("anysearch", {});

    expect(config).toBeDefined();
    expect(config?.transport).toBe("http");
    expect(config?.url).toBe(ANYSEARCH_MCP_URL);
    expect(config?.headers?.Authorization).toBeUndefined();
    expect("Authorization" in (config?.headers ?? {})).toBe(false);
  });

  test("anonymous config: a blank/whitespace-only key is treated as absent", () => {
    const config = resolveMcpPreset("anysearch", {
      [ANYSEARCH_API_KEY_ENV]: "   ",
    });

    expect(config?.headers?.Authorization).toBeUndefined();
  });

  test("always sends the X-Anysearch-Client header, anonymous or authenticated", () => {
    const anonymous = resolveMcpPreset("anysearch", {});
    const authenticated = resolveMcpPreset("anysearch", {
      [ANYSEARCH_API_KEY_ENV]: "sk-super-secret-value",
    });

    expect(anonymous?.headers?.[ANYSEARCH_CLIENT_HEADER]).toBe(
      `letta-code/${getVersion()}`,
    );
    expect(authenticated?.headers?.[ANYSEARCH_CLIENT_HEADER]).toBe(
      `letta-code/${getVersion()}`,
    );
  });

  test("authenticated config stores an env placeholder, never the plaintext key", () => {
    const secret = "sk-super-secret-value-should-never-be-persisted";
    const config = resolveMcpPreset("anysearch", {
      [ANYSEARCH_API_KEY_ENV]: secret,
    });

    expect(config?.headers?.Authorization).toBe(
      `Bearer \${${ANYSEARCH_API_KEY_ENV}}`,
    );
    // The resolved config is exactly what gets persisted to settings; make
    // sure the raw secret value can never appear anywhere in it.
    expect(JSON.stringify(config)).not.toContain(secret);
  });
});
