import { describe, expect, test } from "bun:test";
import type { ChannelConfigSchema } from "../../channels/pluginTypes";
import {
  parseChannelConfigSchema,
  redactConfigForSnapshot,
  validateConfigAgainstSchema,
} from "../../channels/schemaConfig";

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

describe("parseChannelConfigSchema", () => {
  test("parses a valid full schema", () => {
    const result = parseChannelConfigSchema({
      version: 1,
      fields: [
        { type: "text", key: "name", label: "Name" },
        { type: "secret", key: "token", label: "Token" },
        {
          type: "select",
          key: "region",
          label: "Region",
          options: [
            { value: "us", label: "US" },
            { value: "eu", label: "EU" },
          ],
        },
        { type: "boolean", key: "enabled", label: "Enabled" },
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.fields).toHaveLength(4);
    expect(result!.fields[0]).toEqual({
      type: "text",
      key: "name",
      label: "Name",
    });
    expect(result!.fields[1]).toEqual({
      type: "secret",
      key: "token",
      label: "Token",
    });
    expect(result!.fields[2]!.type).toBe("select");
    expect((result!.fields[2] as any).options).toHaveLength(2);
    expect(result!.fields[3]).toEqual({
      type: "boolean",
      key: "enabled",
      label: "Enabled",
    });
  });

  test("returns null for non-object input", () => {
    expect(parseChannelConfigSchema(null)).toBeNull();
    expect(parseChannelConfigSchema("string")).toBeNull();
    expect(parseChannelConfigSchema(42)).toBeNull();
  });

  test("returns null for wrong version", () => {
    expect(parseChannelConfigSchema({ version: 2, fields: [] })).toBeNull();
    expect(parseChannelConfigSchema({ version: "1", fields: [] })).toBeNull();
  });

  test("returns null for missing fields array", () => {
    expect(parseChannelConfigSchema({ version: 1 })).toBeNull();
    expect(parseChannelConfigSchema({ version: 1, fields: {} })).toBeNull();
  });

  test("returns null for unknown field type", () => {
    expect(
      parseChannelConfigSchema({
        version: 1,
        fields: [{ type: "number", key: "count", label: "Count" }],
      }),
    ).toBeNull();
  });

  test("returns null for invalid field key", () => {
    expect(
      parseChannelConfigSchema({
        version: 1,
        fields: [{ type: "text", key: "UPPER", label: "Upper" }],
      }),
    ).toBeNull();
    expect(
      parseChannelConfigSchema({
        version: 1,
        fields: [{ type: "text", key: "1starts_with_digit", label: "Bad" }],
      }),
    ).toBeNull();
  });

  test("returns null for missing label", () => {
    expect(
      parseChannelConfigSchema({
        version: 1,
        fields: [{ type: "text", key: "name" }],
      }),
    ).toBeNull();
  });

  test("returns null for duplicate keys", () => {
    expect(
      parseChannelConfigSchema({
        version: 1,
        fields: [
          { type: "text", key: "name", label: "Name 1" },
          { type: "text", key: "name", label: "Name 2" },
        ],
      }),
    ).toBeNull();
  });

  test("returns null for select with empty options", () => {
    expect(
      parseChannelConfigSchema({
        version: 1,
        fields: [{ type: "select", key: "mode", label: "Mode", options: [] }],
      }),
    ).toBeNull();
  });

  test("returns null for select with invalid option shape", () => {
    expect(
      parseChannelConfigSchema({
        version: 1,
        fields: [
          {
            type: "select",
            key: "mode",
            label: "Mode",
            options: [{ value: 1, label: "One" }],
          },
        ],
      }),
    ).toBeNull();
  });

  test("returns null for select with duplicate option values", () => {
    expect(
      parseChannelConfigSchema({
        version: 1,
        fields: [
          {
            type: "select",
            key: "mode",
            label: "Mode",
            options: [
              { value: "a", label: "A" },
              { value: "a", label: "A2" },
            ],
          },
        ],
      }),
    ).toBeNull();
  });

  test("returns null for select default not in options", () => {
    expect(
      parseChannelConfigSchema({
        version: 1,
        fields: [
          {
            type: "select",
            key: "mode",
            label: "Mode",
            options: [{ value: "a", label: "A" }],
            default: "b",
          },
        ],
      }),
    ).toBeNull();
  });

  test("returns null for wrong default type", () => {
    expect(
      parseChannelConfigSchema({
        version: 1,
        fields: [{ type: "text", key: "name", label: "Name", default: 42 }],
      }),
    ).toBeNull();
    expect(
      parseChannelConfigSchema({
        version: 1,
        fields: [
          { type: "boolean", key: "flag", label: "Flag", default: "yes" },
        ],
      }),
    ).toBeNull();
  });

  test("accepts optional description and required", () => {
    const result = parseChannelConfigSchema({
      version: 1,
      fields: [
        {
          type: "text",
          key: "url",
          label: "URL",
          description: "The endpoint URL",
          required: true,
        },
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.fields[0]!.description).toBe("The endpoint URL");
    expect(result!.fields[0]!.required).toBe(true);
  });

  test("accepts placeholder for text and secret", () => {
    const result = parseChannelConfigSchema({
      version: 1,
      fields: [
        { type: "text", key: "name", label: "Name", placeholder: "Enter name" },
        {
          type: "secret",
          key: "key",
          label: "Key",
          placeholder: "Enter key",
        },
      ],
    });
    expect(result).not.toBeNull();
    expect((result!.fields[0] as any).placeholder).toBe("Enter name");
    expect((result!.fields[1] as any).placeholder).toBe("Enter key");
  });
});

describe("validateConfigAgainstSchema", () => {
  test("accepts valid config matching schema", () => {
    const result = validateConfigAgainstSchema(SIMPLE_SCHEMA, {
      url: "https://example.com",
      api_key: "secret123",
      mode: "fast",
      debug: true,
    });
    expect(result).toEqual({ ok: true });
  });

  test("accepts partial config (omitted keys are no-change)", () => {
    const result = validateConfigAgainstSchema(SIMPLE_SCHEMA, {
      url: "https://example.com",
    });
    expect(result).toEqual({ ok: true });
  });

  test("rejects unknown keys", () => {
    const result = validateConfigAgainstSchema(SIMPLE_SCHEMA, {
      url: "https://example.com",
      unknown_field: "oops",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("unknown field");
    }
  });

  test("rejects wrong type for text field", () => {
    const result = validateConfigAgainstSchema(SIMPLE_SCHEMA, {
      url: 42,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("must be a string");
    }
  });

  test("rejects wrong type for boolean field", () => {
    const result = validateConfigAgainstSchema(SIMPLE_SCHEMA, {
      debug: "yes",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("must be a boolean");
    }
  });

  test("rejects invalid select value", () => {
    const result = validateConfigAgainstSchema(SIMPLE_SCHEMA, {
      mode: "invalid",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("invalid value");
    }
  });

  test("rejects empty required string", () => {
    const result = validateConfigAgainstSchema(SIMPLE_SCHEMA, {
      url: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("required");
    }
  });

  test("allows empty non-required string", () => {
    const result = validateConfigAgainstSchema(SIMPLE_SCHEMA, {
      api_key: "",
    });
    expect(result).toEqual({ ok: true });
  });
});

describe("redactConfigForSnapshot", () => {
  test("redacts secret fields to has_<key> booleans", () => {
    const result = redactConfigForSnapshot(SIMPLE_SCHEMA, {
      url: "https://example.com",
      api_key: "secret123",
      mode: "fast",
      debug: true,
    });
    expect(result).toEqual({
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
    expect(result).toEqual({ name: "" });
  });

  test("uses schema default for boolean when no stored value", () => {
    const schema: ChannelConfigSchema = {
      version: 1,
      fields: [{ type: "boolean", key: "flag", label: "Flag", default: true }],
    };
    const result = redactConfigForSnapshot(schema, {});
    expect(result).toEqual({ flag: true });
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
    expect(result).toEqual({ name: "hello" });
  });
});
