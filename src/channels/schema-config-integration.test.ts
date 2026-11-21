import { describe, expect, test } from "bun:test";
import {
  parseChannelConfigSchema,
  redactConfigForSnapshot,
  validateConfigAgainstSchema,
} from "@/channels/schema-config";

// Reserved keys that redactConfigForSnapshot always emits, regardless of
// whether the schema declares them.
const RESERVED_BASE = {
  accounts_json: "",
  configs_json: "",
  metadata_json: "",
  agent_id: null as string | null,
};

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
    expect(parsed?.fields).toHaveLength(11);
    const fieldKeys = parsed?.fields.map((f) => f.key);
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
    const alertPoll = parsed?.fields.find(
      (f) => f.key === "alert_poll_interval_ms",
    );
    expect(alertPoll?.restartRequired).toBe(true);
  });

  test("validates a realistic config", () => {
    const parsed = parseChannelConfigSchema(BLUESKY_SCHEMA_JSON);
    if (!parsed) throw new Error("Failed to parse BLUESKY_SCHEMA_JSON");
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
    const parsed = parseChannelConfigSchema(BLUESKY_SCHEMA_JSON);
    if (!parsed) throw new Error("Failed to parse BLUESKY_SCHEMA_JSON");
    const snapshot = redactConfigForSnapshot(parsed, {});
    expect(snapshot).toEqual({
      ...RESERVED_BASE,
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
    const parsed = parseChannelConfigSchema(BLUESKY_SCHEMA_JSON);
    if (!parsed) throw new Error("Failed to parse BLUESKY_SCHEMA_JSON");
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
