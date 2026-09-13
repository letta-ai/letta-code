import { describe, expect, test } from "bun:test";
import type { ChannelConfigSchema } from "@/channels/plugin-types";
import { redactConfigForSnapshot } from "@/channels/schema-config";

const SIMPLE_SCHEMA: ChannelConfigSchema = {
  version: 1,
  fields: [
    { type: "text", key: "url", label: "URL", required: true },
    { type: "secret", key: "api_key", label: "API Key" },
    {
      type: "select",
      key: "mode",
      label: "Mode",
      options: [
        { value: "fast", label: "Fast" },
        { value: "slow", label: "Slow" },
      ],
      default: "fast",
    },
    { type: "boolean", key: "debug", label: "Debug", default: false },
  ],
};

// Reserved keys that redactConfigForSnapshot always emits, regardless of
// whether the schema declares them.
const RESERVED_BASE = {
  accounts_json: "",
  configs_json: "",
  metadata_json: "",
  agent_id: null as string | null,
};

describe("redactConfigForSnapshot", () => {
  test("redacts secret fields to has_<key> booleans", () => {
    const result = redactConfigForSnapshot(SIMPLE_SCHEMA, {
      url: "https://example.com",
      api_key: "secret123",
      mode: "fast",
      debug: true,
    });
    expect(result).toEqual({
      ...RESERVED_BASE,
      url: "https://example.com",
      has_api_key: true,
      mode: "fast",
      debug: true,
    });
  });

  test("emits has_<key>: false for empty secret", () => {
    const result = redactConfigForSnapshot(SIMPLE_SCHEMA, {
      url: "https://example.com",
      api_key: "",
      mode: "slow",
      debug: false,
    });
    expect(result).toEqual({
      ...RESERVED_BASE,
      url: "https://example.com",
      has_api_key: false,
      mode: "slow",
      debug: false,
    });
  });

  test("emits has_<key>: false for missing secret", () => {
    const result = redactConfigForSnapshot(SIMPLE_SCHEMA, {
      url: "https://example.com",
    });
    expect(result).toEqual({
      ...RESERVED_BASE,
      url: "https://example.com",
      has_api_key: false,
      mode: "fast", // default
      debug: false, // default
    });
  });

  test("falls through to empty string for text with no stored value and no default", () => {
    const schema: ChannelConfigSchema = {
      version: 1,
      fields: [{ type: "text", key: "name", label: "Name" }],
    };
    const result = redactConfigForSnapshot(schema, {});
    expect(result).toEqual({ ...RESERVED_BASE, name: "" });
  });

  test("uses schema default for boolean when no stored value", () => {
    const schema: ChannelConfigSchema = {
      version: 1,
      fields: [{ type: "boolean", key: "flag", label: "Flag", default: true }],
    };
    const result = redactConfigForSnapshot(schema, {});
    expect(result).toEqual({ ...RESERVED_BASE, flag: true });
  });

  test("omits undeclared stored keys", () => {
    const schema: ChannelConfigSchema = {
      version: 1,
      fields: [{ type: "text", key: "name", label: "Name" }],
    };
    const result = redactConfigForSnapshot(schema, {
      name: "hello",
      secret_backdoor: "oops",
    });
    expect(result).toEqual({ ...RESERVED_BASE, name: "hello" });
  });
});

describe("redactConfigForSnapshot > new field types", () => {
  test("number falls through to stored, default, then 0", () => {
    const schema: ChannelConfigSchema = {
      version: 1,
      fields: [
        { type: "number", key: "a", label: "A" },
        { type: "number", key: "b", label: "B", default: 7 },
        { type: "number", key: "c", label: "C" },
      ],
    };
    const result = redactConfigForSnapshot(schema, { a: 42 });
    expect(result).toEqual({ ...RESERVED_BASE, a: 42, b: 7, c: 0 });
  });

  test("string-array falls through to stored, default, then []", () => {
    const schema: ChannelConfigSchema = {
      version: 1,
      fields: [
        { type: "string-array", key: "a", label: "A" },
        { type: "string-array", key: "b", label: "B", default: ["en"] },
        { type: "string-array", key: "c", label: "C" },
      ],
    };
    const result = redactConfigForSnapshot(schema, { a: ["x", "y"] });
    expect(result).toEqual({
      ...RESERVED_BASE,
      a: ["x", "y"],
      b: ["en"],
      c: [],
    });
  });

  test("string-array ignores stored value with non-string members", () => {
    const schema: ChannelConfigSchema = {
      version: 1,
      fields: [
        { type: "string-array", key: "a", label: "A", default: ["fallback"] },
      ],
    };
    const result = redactConfigForSnapshot(schema, { a: ["x", 1] });
    expect(result).toEqual({ ...RESERVED_BASE, a: ["fallback"] });
  });

  test("key-value-map filters stored entries by valueType", () => {
    const schema: ChannelConfigSchema = {
      version: 1,
      fields: [
        {
          type: "key-value-map",
          key: "tiers",
          label: "Tiers",
          valueType: "number",
        },
      ],
    };
    const result = redactConfigForSnapshot(schema, {
      tiers: { good: 1, bad: "two", nan: Number.NaN, ok: 3 },
    });
    expect(result).toEqual({ ...RESERVED_BASE, tiers: { good: 1, ok: 3 } });
  });

  test("key-value-map falls through to default then {}", () => {
    const schema: ChannelConfigSchema = {
      version: 1,
      fields: [
        {
          type: "key-value-map",
          key: "a",
          label: "A",
          valueType: "string",
        },
        {
          type: "key-value-map",
          key: "b",
          label: "B",
          valueType: "string",
          default: { x: "1" },
        },
      ],
    };
    const result = redactConfigForSnapshot(schema, {});
    expect(result).toEqual({ ...RESERVED_BASE, a: {}, b: { x: "1" } });
  });
});
