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
        fields: [{ type: "rainbow", key: "color", label: "Color" }],
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

// ─────────────────────────────────────────────────────────────────────
// Phase 1 extension: number, string-array, key-value-map
// ─────────────────────────────────────────────────────────────────────

describe("parseChannelConfigSchema > number field", () => {
  test("accepts a valid number field with bounds, default, suffix", () => {
    const parsed = parseChannelConfigSchema({
      version: 1,
      fields: [
        {
          type: "number",
          key: "threshold",
          label: "Threshold",
          default: 0.35,
          min: 0,
          max: 1,
          step: 0.05,
          suffix: "%",
          placeholder: "0.35",
          restartRequired: false,
        },
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.fields[0]).toEqual({
      type: "number",
      key: "threshold",
      label: "Threshold",
      default: 0.35,
      min: 0,
      max: 1,
      step: 0.05,
      suffix: "%",
      placeholder: "0.35",
      description: undefined,
      required: undefined,
      restartRequired: false,
    });
  });

  test("rejects non-numeric default", () => {
    expect(
      parseChannelConfigSchema({
        version: 1,
        fields: [
          {
            type: "number",
            key: "threshold",
            label: "Threshold",
            default: "0.35",
          },
        ],
      }),
    ).toBeNull();
  });

  test("rejects NaN / Infinity bounds", () => {
    expect(
      parseChannelConfigSchema({
        version: 1,
        fields: [
          {
            type: "number",
            key: "threshold",
            label: "Threshold",
            min: Number.NaN,
          },
        ],
      }),
    ).toBeNull();
    expect(
      parseChannelConfigSchema({
        version: 1,
        fields: [
          {
            type: "number",
            key: "threshold",
            label: "Threshold",
            max: Number.POSITIVE_INFINITY,
          },
        ],
      }),
    ).toBeNull();
  });

  test("rejects inverted min/max", () => {
    expect(
      parseChannelConfigSchema({
        version: 1,
        fields: [
          {
            type: "number",
            key: "threshold",
            label: "Threshold",
            min: 10,
            max: 5,
          },
        ],
      }),
    ).toBeNull();
  });

  test("rejects default outside declared bounds", () => {
    expect(
      parseChannelConfigSchema({
        version: 1,
        fields: [
          {
            type: "number",
            key: "threshold",
            label: "Threshold",
            min: 0,
            max: 1,
            default: 2,
          },
        ],
      }),
    ).toBeNull();
  });
});

describe("parseChannelConfigSchema > string-array field", () => {
  test("accepts a valid string-array with default", () => {
    const parsed = parseChannelConfigSchema({
      version: 1,
      fields: [
        {
          type: "string-array",
          key: "langs",
          label: "Languages",
          default: ["en"],
          placeholder: "ISO-639 code",
        },
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.fields[0]).toMatchObject({
      type: "string-array",
      key: "langs",
      default: ["en"],
      placeholder: "ISO-639 code",
    });
  });

  test("rejects non-array default", () => {
    expect(
      parseChannelConfigSchema({
        version: 1,
        fields: [
          {
            type: "string-array",
            key: "langs",
            label: "Languages",
            default: "en",
          },
        ],
      }),
    ).toBeNull();
  });

  test("rejects mixed-type default", () => {
    expect(
      parseChannelConfigSchema({
        version: 1,
        fields: [
          {
            type: "string-array",
            key: "langs",
            label: "Languages",
            default: ["en", 2],
          },
        ],
      }),
    ).toBeNull();
  });
});

describe("parseChannelConfigSchema > key-value-map field", () => {
  test("accepts a numeric-valued map with default", () => {
    const parsed = parseChannelConfigSchema({
      version: 1,
      fields: [
        {
          type: "key-value-map",
          key: "entity_tiers",
          label: "Entity tiers",
          valueType: "number",
          default: { "did:plc:abc": 1 },
          keyLabel: "DID",
          valueLabel: "Tier",
        },
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.fields[0]).toMatchObject({
      type: "key-value-map",
      valueType: "number",
      default: { "did:plc:abc": 1 },
      keyLabel: "DID",
      valueLabel: "Tier",
    });
  });

  test("rejects missing valueType", () => {
    expect(
      parseChannelConfigSchema({
        version: 1,
        fields: [
          {
            type: "key-value-map",
            key: "entity_tiers",
            label: "Entity tiers",
          },
        ],
      }),
    ).toBeNull();
  });

  test("rejects default whose values don't match valueType", () => {
    expect(
      parseChannelConfigSchema({
        version: 1,
        fields: [
          {
            type: "key-value-map",
            key: "tiers",
            label: "Tiers",
            valueType: "number",
            default: { abc: "one" },
          },
        ],
      }),
    ).toBeNull();
    expect(
      parseChannelConfigSchema({
        version: 1,
        fields: [
          {
            type: "key-value-map",
            key: "tiers",
            label: "Tiers",
            valueType: "string",
            default: { abc: 1 },
          },
        ],
      }),
    ).toBeNull();
  });

  test("rejects non-object default", () => {
    expect(
      parseChannelConfigSchema({
        version: 1,
        fields: [
          {
            type: "key-value-map",
            key: "tiers",
            label: "Tiers",
            valueType: "number",
            default: ["nope"],
          },
        ],
      }),
    ).toBeNull();
  });
});

describe("parseField > restartRequired metadata", () => {
  test("accepts boolean restartRequired", () => {
    const parsed = parseChannelConfigSchema({
      version: 1,
      fields: [
        {
          type: "number",
          key: "interval_ms",
          label: "Interval",
          restartRequired: true,
        },
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.fields[0]?.restartRequired).toBe(true);
  });

  test("rejects non-boolean restartRequired", () => {
    expect(
      parseChannelConfigSchema({
        version: 1,
        fields: [
          {
            type: "text",
            key: "name",
            label: "Name",
            restartRequired: "yes",
          },
        ],
      }),
    ).toBeNull();
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
    expect(result).toEqual({ a: 42, b: 7, c: 0 });
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
    expect(result).toEqual({ a: ["x", "y"], b: ["en"], c: [] });
  });

  test("string-array ignores stored value with non-string members", () => {
    const schema: ChannelConfigSchema = {
      version: 1,
      fields: [
        { type: "string-array", key: "a", label: "A", default: ["fallback"] },
      ],
    };
    const result = redactConfigForSnapshot(schema, { a: ["x", 1] });
    expect(result).toEqual({ a: ["fallback"] });
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
    expect(result).toEqual({ tiers: { good: 1, ok: 3 } });
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
    expect(result).toEqual({ a: {}, b: { x: "1" } });
  });
});

describe("bluesky-shape schema (integration)", () => {
  // Mirrors what bluesky-channel will declare in channel.json.
  // Exercises parse → validate → redact together to catch field-type
  // interaction bugs that single-type tests might miss.
  const BLUESKY_SCHEMA_JSON = {
    version: 1,
    fields: [
      {
        type: "text",
        key: "identifier",
        label: "Bluesky handle or DID",
        required: true,
      },
      {
        type: "secret",
        key: "password",
        label: "App password",
        required: true,
      },
      {
        type: "text",
        key: "pds",
        label: "PDS URL",
        default: "https://bsky.social",
      },
      {
        type: "number",
        key: "salience_threshold",
        label: "Salience threshold",
        default: 0.35,
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        type: "number",
        key: "alert_poll_interval_ms",
        label: "Alert poll interval",
        default: 120000,
        min: 30000,
        suffix: "ms",
        restartRequired: true,
      },
      {
        type: "number",
        key: "digest_interval_ms",
        label: "Digest interval",
        default: 3600000,
        min: 60000,
        suffix: "ms",
        restartRequired: true,
      },
      {
        type: "string-array",
        key: "langs",
        label: "Languages",
        default: ["en"],
      },
      { type: "string-array", key: "keywords", label: "Keywords" },
      { type: "string-array", key: "hot_topics", label: "Hot topics" },
      {
        type: "string-array",
        key: "batch_types",
        label: "Digest reasons",
        default: ["like", "repost", "follow", "starterpack-joined"],
      },
      {
        type: "key-value-map",
        key: "entity_tiers",
        label: "Entity tiers",
        valueType: "number",
        keyLabel: "DID",
        valueLabel: "Tier",
      },
    ],
  };

  test("parses cleanly", () => {
    const parsed = parseChannelConfigSchema(BLUESKY_SCHEMA_JSON);
    expect(parsed).not.toBeNull();
    expect(parsed!.fields).toHaveLength(11);
    const fieldKeys = parsed!.fields.map((f) => f.key);
    expect(fieldKeys).toEqual([
      "identifier",
      "password",
      "pds",
      "salience_threshold",
      "alert_poll_interval_ms",
      "digest_interval_ms",
      "langs",
      "keywords",
      "hot_topics",
      "batch_types",
      "entity_tiers",
    ]);
    const alertPoll = parsed!.fields.find(
      (f) => f.key === "alert_poll_interval_ms",
    );
    expect(alertPoll?.restartRequired).toBe(true);
  });

  test("validates a realistic config", () => {
    const parsed = parseChannelConfigSchema(BLUESKY_SCHEMA_JSON)!;
    const result = validateConfigAgainstSchema(parsed, {
      identifier: "shelley.bsky.social",
      password: "abcd-efgh-ijkl-mnop",
      pds: "https://bsky.social",
      salience_threshold: 0.5,
      alert_poll_interval_ms: 120000,
      digest_interval_ms: 3600000,
      langs: ["en"],
      keywords: ["letta"],
      hot_topics: [],
      batch_types: ["like", "repost"],
      entity_tiers: { "did:plc:abc": 1, "did:plc:xyz": 2 },
    });
    expect(result).toEqual({ ok: true });
  });

  test("redacts an empty stored config to schema defaults", () => {
    const parsed = parseChannelConfigSchema(BLUESKY_SCHEMA_JSON)!;
    const snapshot = redactConfigForSnapshot(parsed, {});
    expect(snapshot).toEqual({
      identifier: "",
      has_password: false,
      pds: "https://bsky.social",
      salience_threshold: 0.35,
      alert_poll_interval_ms: 120000,
      digest_interval_ms: 3600000,
      langs: ["en"],
      keywords: [],
      hot_topics: [],
      batch_types: ["like", "repost", "follow", "starterpack-joined"],
      entity_tiers: {},
    });
  });

  test("redacts a populated stored config (with secret) correctly", () => {
    const parsed = parseChannelConfigSchema(BLUESKY_SCHEMA_JSON)!;
    const snapshot = redactConfigForSnapshot(parsed, {
      identifier: "shelley.bsky.social",
      password: "secret-value",
      pds: "https://bsky.social",
      salience_threshold: 0.5,
      alert_poll_interval_ms: 90000,
      digest_interval_ms: 1800000,
      langs: ["en", "fr"],
      keywords: ["letta", "ai"],
      hot_topics: ["release"],
      batch_types: ["like"],
      entity_tiers: { "did:plc:abc": 1, "did:plc:xyz": 2 },
    });
    expect(snapshot).toMatchObject({
      identifier: "shelley.bsky.social",
      has_password: true,
      keywords: ["letta", "ai"],
      entity_tiers: { "did:plc:abc": 1, "did:plc:xyz": 2 },
    });
    // Secret must not leak through.
    expect((snapshot as Record<string, unknown>).password).toBeUndefined();
  });
});
