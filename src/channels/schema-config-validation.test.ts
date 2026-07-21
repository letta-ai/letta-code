import { describe, expect, test } from "bun:test";
import type { ChannelConfigSchema } from "@/channels/plugin-types";
import { validateConfigAgainstSchema } from "@/channels/schema-config";

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

describe("validateConfigAgainstSchema > new field types", () => {
  const schema: ChannelConfigSchema = {
    version: 1,
    fields: [
      {
        type: "number",
        key: "threshold",
        label: "Threshold",
        min: 0,
        max: 1,
      },
      {
        type: "string-array",
        key: "tags",
        label: "Tags",
        required: true,
      },
      {
        type: "key-value-map",
        key: "tiers",
        label: "Tiers",
        valueType: "number",
      },
    ],
  };

  test("accepts a fully-valid config", () => {
    expect(
      validateConfigAgainstSchema(schema, {
        threshold: 0.5,
        tags: ["a", "b"],
        tiers: { "did:abc": 1, "did:def": 2 },
      }),
    ).toEqual({ ok: true });
  });

  test("rejects non-finite number", () => {
    const result = validateConfigAgainstSchema(schema, {
      threshold: Number.NaN,
    });
    expect(result.ok).toBe(false);
  });

  test("rejects number outside bounds", () => {
    const result = validateConfigAgainstSchema(schema, { threshold: 2 });
    expect(result.ok).toBe(false);
  });

  test("rejects string-array with non-string members", () => {
    const result = validateConfigAgainstSchema(schema, { tags: ["a", 1] });
    expect(result.ok).toBe(false);
  });

  test("rejects empty array when required", () => {
    const result = validateConfigAgainstSchema(schema, { tags: [] });
    expect(result.ok).toBe(false);
  });

  test("rejects key-value-map with wrong value type", () => {
    const result = validateConfigAgainstSchema(schema, {
      tiers: { abc: "high" },
    });
    expect(result.ok).toBe(false);
  });

  test("rejects key-value-map that isn't an object", () => {
    const result = validateConfigAgainstSchema(schema, {
      tiers: [["abc", 1]],
    });
    expect(result.ok).toBe(false);
  });
});
