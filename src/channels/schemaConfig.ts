import type {
  ChannelConfigBooleanField,
  ChannelConfigField,
  ChannelConfigSchema,
  ChannelConfigSecretField,
  ChannelConfigSelectField,
  ChannelConfigSelectOption,
  ChannelConfigTextField,
  ChannelProtocolConfig,
} from "./pluginTypes";

const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const FIELD_TYPES: ReadonlySet<ChannelConfigField["type"]> = new Set([
  "text",
  "secret",
  "select",
  "boolean",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseSelectOptions(
  value: unknown,
): ChannelConfigSelectOption[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const options: ChannelConfigSelectOption[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) {
      return null;
    }
    if (!isNonEmptyString(entry.value) || !isNonEmptyString(entry.label)) {
      return null;
    }
    if (seen.has(entry.value)) {
      return null;
    }
    seen.add(entry.value);
    options.push({ value: entry.value, label: entry.label });
  }
  return options;
}

function parseField(value: unknown): ChannelConfigField | null {
  if (!isRecord(value)) {
    return null;
  }

  const type = value.type;
  if (typeof type !== "string" || !FIELD_TYPES.has(type as never)) {
    return null;
  }
  if (!isNonEmptyString(value.key) || !FIELD_KEY_PATTERN.test(value.key)) {
    return null;
  }
  if (!isNonEmptyString(value.label)) {
    return null;
  }
  if (
    value.description !== undefined &&
    typeof value.description !== "string"
  ) {
    return null;
  }
  if (value.required !== undefined && typeof value.required !== "boolean") {
    return null;
  }

  const base = {
    key: value.key,
    label: value.label,
    description:
      typeof value.description === "string" ? value.description : undefined,
    required: typeof value.required === "boolean" ? value.required : undefined,
  };

  if (type === "text") {
    if (value.default !== undefined && typeof value.default !== "string") {
      return null;
    }
    if (
      value.placeholder !== undefined &&
      typeof value.placeholder !== "string"
    ) {
      return null;
    }
    const field: ChannelConfigTextField = {
      ...base,
      type: "text",
      default: typeof value.default === "string" ? value.default : undefined,
      placeholder:
        typeof value.placeholder === "string" ? value.placeholder : undefined,
    };
    return field;
  }

  if (type === "secret") {
    if (
      value.placeholder !== undefined &&
      typeof value.placeholder !== "string"
    ) {
      return null;
    }
    const field: ChannelConfigSecretField = {
      ...base,
      type: "secret",
      placeholder:
        typeof value.placeholder === "string" ? value.placeholder : undefined,
    };
    return field;
  }

  if (type === "select") {
    const options = parseSelectOptions(value.options);
    if (!options) {
      return null;
    }
    if (value.default !== undefined) {
      if (
        typeof value.default !== "string" ||
        !options.some((option) => option.value === value.default)
      ) {
        return null;
      }
    }
    const field: ChannelConfigSelectField = {
      ...base,
      type: "select",
      options,
      default: typeof value.default === "string" ? value.default : undefined,
    };
    return field;
  }

  if (type === "boolean") {
    if (value.default !== undefined && typeof value.default !== "boolean") {
      return null;
    }
    const field: ChannelConfigBooleanField = {
      ...base,
      type: "boolean",
      default: typeof value.default === "boolean" ? value.default : undefined,
    };
    return field;
  }

  return null;
}

/**
 * Parse a JSON-like value into a {@link ChannelConfigSchema}. Returns `null`
 * when the value violates the strict v1 contract, in which case callers should
 * silently drop the schema (the channel still loads, just without dynamic
 * config UI).
 */
export function parseChannelConfigSchema(
  value: unknown,
): ChannelConfigSchema | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.version !== 1) {
    return null;
  }
  if (!Array.isArray(value.fields)) {
    return null;
  }

  const fields: ChannelConfigField[] = [];
  const seenKeys = new Set<string>();
  for (const raw of value.fields) {
    const field = parseField(raw);
    if (!field) {
      return null;
    }
    if (seenKeys.has(field.key)) {
      return null;
    }
    seenKeys.add(field.key);
    fields.push(field);
  }

  return { version: 1, fields };
}

export type SchemaValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Strictly validate a plugin config payload against a declared schema.
 *
 * - Unknown keys are rejected.
 * - Each declared field's type must match the value type.
 * - Required string fields, when present in the patch, must be non-empty.
 * - Partial patches are allowed (omitted keys mean "no change").
 */
export function validateConfigAgainstSchema(
  schema: ChannelConfigSchema,
  config: ChannelProtocolConfig,
): SchemaValidationResult {
  const fieldsByKey = new Map(schema.fields.map((field) => [field.key, field]));
  for (const key of Object.keys(config)) {
    if (!fieldsByKey.has(key)) {
      return { ok: false, reason: `unknown field: ${key}` };
    }
  }

  for (const field of schema.fields) {
    const present = Object.hasOwn(config, field.key);
    if (!present) {
      continue;
    }
    const value = config[field.key];

    switch (field.type) {
      case "text":
      case "secret": {
        if (typeof value !== "string") {
          return {
            ok: false,
            reason: `field ${field.key} must be a string`,
          };
        }
        if (field.required && value.length === 0) {
          return {
            ok: false,
            reason: `field ${field.key} is required`,
          };
        }
        break;
      }
      case "select": {
        if (typeof value !== "string") {
          return {
            ok: false,
            reason: `field ${field.key} must be a string`,
          };
        }
        if (!field.options.some((option) => option.value === value)) {
          return {
            ok: false,
            reason: `field ${field.key} has invalid value`,
          };
        }
        break;
      }
      case "boolean": {
        if (typeof value !== "boolean") {
          return {
            ok: false,
            reason: `field ${field.key} must be a boolean`,
          };
        }
        break;
      }
    }
  }

  return { ok: true };
}

/**
 * Build a redacted, client-safe view of a stored plugin config.
 *
 * - `secret` fields collapse to `has_<key>: boolean` (Slack pattern).
 * - `text` / `select` / `boolean` fields fall through to their stored value,
 *   or the schema default when nothing is stored and a default exists.
 * - Stored keys not declared in the schema are omitted.
 */
export function redactConfigForSnapshot(
  schema: ChannelConfigSchema,
  storedConfig: Record<string, unknown>,
): ChannelProtocolConfig {
  const result: ChannelProtocolConfig = {};
  for (const field of schema.fields) {
    const stored = storedConfig[field.key];
    if (field.type === "secret") {
      result[`has_${field.key}`] =
        typeof stored === "string" && stored.trim().length > 0;
      continue;
    }

    if (field.type === "boolean") {
      if (typeof stored === "boolean") {
        result[field.key] = stored;
      } else if (typeof field.default === "boolean") {
        result[field.key] = field.default;
      }
      continue;
    }

    // text / select
    if (typeof stored === "string") {
      result[field.key] = stored;
    } else if (typeof field.default === "string") {
      result[field.key] = field.default;
    } else {
      result[field.key] = "";
    }
  }
  return result;
}
