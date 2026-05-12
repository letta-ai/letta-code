import type {
  ChannelConfigBooleanField,
  ChannelConfigField,
  ChannelConfigKeyValueMapField,
  ChannelConfigNumberField,
  ChannelConfigSchema,
  ChannelConfigSecretField,
  ChannelConfigSelectField,
  ChannelConfigSelectOption,
  ChannelConfigStringArrayField,
  ChannelConfigTextField,
  ChannelProtocolConfig,
} from "./pluginTypes";

const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const FIELD_TYPES: ReadonlySet<ChannelConfigField["type"]> = new Set([
  "text",
  "secret",
  "select",
  "boolean",
  "number",
  "string-array",
  "key-value-map",
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
  if (
    value.restartRequired !== undefined &&
    typeof value.restartRequired !== "boolean"
  ) {
    return null;
  }
  if (
    value.scope !== undefined &&
    value.scope !== "app" &&
    value.scope !== "account"
  ) {
    return null;
  }

  const base = {
    key: value.key,
    label: value.label,
    description:
      typeof value.description === "string" ? value.description : undefined,
    required: typeof value.required === "boolean" ? value.required : undefined,
    restartRequired:
      typeof value.restartRequired === "boolean"
        ? value.restartRequired
        : undefined,
    scope: (value.scope === "app" || value.scope === "account"
      ? value.scope
      : undefined) as "app" | "account" | undefined,
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

  if (type === "number") {
    if (value.default !== undefined && !isFiniteNumber(value.default)) {
      return null;
    }
    if (value.min !== undefined && !isFiniteNumber(value.min)) {
      return null;
    }
    if (value.max !== undefined && !isFiniteNumber(value.max)) {
      return null;
    }
    if (value.step !== undefined && !isFiniteNumber(value.step)) {
      return null;
    }
    if (
      value.min !== undefined &&
      value.max !== undefined &&
      (value.min as number) > (value.max as number)
    ) {
      return null;
    }
    if (
      value.default !== undefined &&
      !numberWithinBounds(
        value.default as number,
        value.min as number | undefined,
        value.max as number | undefined,
      )
    ) {
      return null;
    }
    if (value.suffix !== undefined && typeof value.suffix !== "string") {
      return null;
    }
    if (
      value.placeholder !== undefined &&
      typeof value.placeholder !== "string"
    ) {
      return null;
    }
    const field: ChannelConfigNumberField = {
      ...base,
      type: "number",
      default: isFiniteNumber(value.default)
        ? (value.default as number)
        : undefined,
      min: isFiniteNumber(value.min) ? (value.min as number) : undefined,
      max: isFiniteNumber(value.max) ? (value.max as number) : undefined,
      step: isFiniteNumber(value.step) ? (value.step as number) : undefined,
      suffix: typeof value.suffix === "string" ? value.suffix : undefined,
      placeholder:
        typeof value.placeholder === "string" ? value.placeholder : undefined,
    };
    return field;
  }

  if (type === "string-array") {
    if (value.default !== undefined) {
      if (!Array.isArray(value.default)) {
        return null;
      }
      if (!value.default.every((entry) => typeof entry === "string")) {
        return null;
      }
    }
    if (
      value.placeholder !== undefined &&
      typeof value.placeholder !== "string"
    ) {
      return null;
    }
    const field: ChannelConfigStringArrayField = {
      ...base,
      type: "string-array",
      default: Array.isArray(value.default)
        ? (value.default as string[]).slice()
        : undefined,
      placeholder:
        typeof value.placeholder === "string" ? value.placeholder : undefined,
    };
    return field;
  }

  if (type === "key-value-map") {
    if (value.valueType !== "string" && value.valueType !== "number") {
      return null;
    }
    const valueType = value.valueType;
    if (value.default !== undefined) {
      if (!isRecord(value.default)) {
        return null;
      }
      for (const entry of Object.values(value.default)) {
        if (valueType === "string" && typeof entry !== "string") {
          return null;
        }
        if (valueType === "number" && !isFiniteNumber(entry)) {
          return null;
        }
      }
    }
    for (const key of [
      "keyLabel",
      "valueLabel",
      "keyPlaceholder",
      "valuePlaceholder",
    ] as const) {
      if (value[key] !== undefined && typeof value[key] !== "string") {
        return null;
      }
    }
    const field: ChannelConfigKeyValueMapField = {
      ...base,
      type: "key-value-map",
      valueType,
      default: isRecord(value.default)
        ? ({ ...value.default } as Record<string, string | number>)
        : undefined,
      keyLabel: typeof value.keyLabel === "string" ? value.keyLabel : undefined,
      valueLabel:
        typeof value.valueLabel === "string" ? value.valueLabel : undefined,
      keyPlaceholder:
        typeof value.keyPlaceholder === "string"
          ? value.keyPlaceholder
          : undefined,
      valuePlaceholder:
        typeof value.valuePlaceholder === "string"
          ? value.valuePlaceholder
          : undefined,
    };
    return field;
  }

  return null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function numberWithinBounds(
  value: number,
  min: number | undefined,
  max: number | undefined,
): boolean {
  if (min !== undefined && value < min) return false;
  if (max !== undefined && value > max) return false;
  return true;
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
  // Reserved JSON-bucket keys are always permitted regardless of whether
  // the plugin's schema declares them — they back the dedicated Accounts /
  // Config / Metadata tabs and are stored as opaque strings.
  const reservedKeys = new Set([
    "accounts_json",
    "configs_json",
    "metadata_json",
  ]);
  for (const key of Object.keys(config)) {
    if (fieldsByKey.has(key)) continue;
    if (reservedKeys.has(key)) {
      const value = config[key];
      if (value !== undefined && typeof value !== "string") {
        return {
          ok: false,
          reason: `reserved field ${key} must be a string`,
        };
      }
      continue;
    }
    return { ok: false, reason: `unknown field: ${key}` };
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
      case "number": {
        if (!isFiniteNumber(value)) {
          return {
            ok: false,
            reason: `field ${field.key} must be a finite number`,
          };
        }
        if (!numberWithinBounds(value, field.min, field.max)) {
          return {
            ok: false,
            reason: `field ${field.key} is out of bounds`,
          };
        }
        break;
      }
      case "string-array": {
        if (!Array.isArray(value)) {
          return {
            ok: false,
            reason: `field ${field.key} must be an array of strings`,
          };
        }
        for (const entry of value) {
          if (typeof entry !== "string") {
            return {
              ok: false,
              reason: `field ${field.key} must contain only strings`,
            };
          }
        }
        if (field.required && value.length === 0) {
          return {
            ok: false,
            reason: `field ${field.key} is required`,
          };
        }
        break;
      }
      case "key-value-map": {
        if (!isRecord(value)) {
          return {
            ok: false,
            reason: `field ${field.key} must be an object`,
          };
        }
        for (const entry of Object.values(value)) {
          if (field.valueType === "string" && typeof entry !== "string") {
            return {
              ok: false,
              reason: `field ${field.key} values must be strings`,
            };
          }
          if (field.valueType === "number" && !isFiniteNumber(entry)) {
            return {
              ok: false,
              reason: `field ${field.key} values must be finite numbers`,
            };
          }
        }
        if (field.required && Object.keys(value).length === 0) {
          return {
            ok: false,
            reason: `field ${field.key} is required`,
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

    if (field.type === "number") {
      if (isFiniteNumber(stored)) {
        result[field.key] = stored;
      } else if (isFiniteNumber(field.default)) {
        result[field.key] = field.default;
      } else {
        result[field.key] = 0;
      }
      continue;
    }

    if (field.type === "string-array") {
      if (
        Array.isArray(stored) &&
        stored.every((entry) => typeof entry === "string")
      ) {
        result[field.key] = stored.slice();
      } else if (Array.isArray(field.default)) {
        result[field.key] = field.default.slice();
      } else {
        result[field.key] = [];
      }
      continue;
    }

    if (field.type === "key-value-map") {
      if (isRecord(stored)) {
        const filtered: Record<string, string | number> = {};
        for (const [k, v] of Object.entries(stored)) {
          if (field.valueType === "string" && typeof v === "string") {
            filtered[k] = v;
          } else if (field.valueType === "number" && isFiniteNumber(v)) {
            filtered[k] = v;
          }
        }
        result[field.key] = filtered;
      } else if (isRecord(field.default)) {
        result[field.key] = { ...field.default };
      } else {
        result[field.key] = {};
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

  // Always pass through Letta's reserved JSON-bucket keys regardless of
  // whether the plugin declared them in its schema. These power the
  // dedicated Accounts / Config / Metadata tabs in the desktop dialog
  // and round-trip as opaque strings on the snapshot.
  for (const reservedKey of [
    "accounts_json",
    "configs_json",
    "metadata_json",
  ]) {
    if (result[reservedKey] !== undefined) continue;
    const stored = storedConfig[reservedKey];
    result[reservedKey] = typeof stored === "string" ? stored : "";
  }

  return result;
}
