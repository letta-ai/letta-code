import { describe, expect, test } from "bun:test";
import type {
  ChannelConfigSelectField,
  ChannelConfigTextField,
} from "@/channels/plugin-types";
import { parseChannelConfigSchema } from "@/channels/schema-config";

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
    expect(result?.fields).toHaveLength(4);
    expect(result?.fields[0]).toEqual({
      type: "text",
      key: "name",
      label: "Name",
    });
    expect(result?.fields[1]).toEqual({
      type: "secret",
      key: "token",
      label: "Token",
    });
    expect(result?.fields[2]?.type).toBe("select");
    expect(
      (result?.fields[2] as ChannelConfigSelectField).options,
    ).toHaveLength(2);
    expect(result?.fields[3]).toEqual({
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
    expect(result?.fields[0]?.description).toBe("The endpoint URL");
    expect(result?.fields[0]?.required).toBe(true);
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
    expect((result?.fields[0] as ChannelConfigTextField).placeholder).toBe(
      "Enter name",
    );
    expect((result?.fields[1] as ChannelConfigTextField).placeholder).toBe(
      "Enter key",
    );
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
    expect(parsed?.fields[0]).toEqual({
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
    expect(parsed?.fields[0]).toMatchObject({
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
    expect(parsed?.fields[0]).toMatchObject({
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
    expect(parsed?.fields[0]?.restartRequired).toBe(true);
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
