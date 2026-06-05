import type {
  PiProviderModelRegistration,
  PiProviderRegistration,
} from "./pi-provider-extension-types";

function cloneHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  return headers ? { ...headers } : undefined;
}

export function resolvePiProviderRegistrationHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    resolved[key] = process.env[value] ?? value;
  }
  return resolved;
}

function cloneModel(
  model: PiProviderModelRegistration,
): PiProviderModelRegistration {
  return {
    ...model,
    input: [...model.input],
    cost: { ...model.cost },
    ...(model.headers ? { headers: { ...model.headers } } : {}),
    ...(model.compat ? { compat: { ...model.compat } } : {}),
    ...(model.thinkingLevelMap
      ? { thinkingLevelMap: { ...model.thinkingLevelMap } }
      : {}),
  };
}

export function clonePiProviderRegistration(
  config: PiProviderRegistration,
): PiProviderRegistration {
  return {
    ...config,
    ...(config.headers ? { headers: cloneHeaders(config.headers) } : {}),
    ...(config.models ? { models: config.models.map(cloneModel) } : {}),
  };
}

function validateProviderName(providerName: string): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(providerName)) {
    throw new Error(
      "Provider name must start with a lowercase letter or number and contain only lowercase letters, numbers, dots, underscores, or hyphens",
    );
  }
}

function validateFiniteNonNegative(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
}

function validatePositiveInteger(value: unknown, label: string): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    !Number.isInteger(value)
  ) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function validateInput(input: unknown, label: string): void {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error(`${label}.input must be a non-empty array`);
  }
  for (const item of input) {
    if (item !== "text" && item !== "image") {
      throw new Error(`${label}.input can only contain "text" or "image"`);
    }
  }
}

function validateHeaders(headers: unknown, label: string): void {
  if (headers === undefined) return;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    throw new Error(`${label} must be an object of string headers`);
  }
  for (const [key, value] of Object.entries(headers)) {
    if (!key || typeof value !== "string") {
      throw new Error(`${label} must be an object of string headers`);
    }
  }
}

function validateModel(
  providerName: string,
  config: PiProviderRegistration,
  model: PiProviderModelRegistration,
): void {
  const label = `Provider ${providerName}, model ${model.id || "<unknown>"}`;
  if (!model.id || typeof model.id !== "string") {
    throw new Error(`${label}: id is required`);
  }
  if (model.id.includes("/")) {
    throw new Error(`${label}: id must be unprefixed and cannot contain "/"`);
  }
  if (!model.name || typeof model.name !== "string") {
    throw new Error(`${label}: name is required`);
  }
  if (!model.api && !config.api) {
    throw new Error(`${label}: api is required at provider or model level`);
  }
  if (typeof model.reasoning !== "boolean") {
    throw new Error(`${label}: reasoning must be boolean`);
  }
  validateInput(model.input, label);
  validateFiniteNonNegative(model.cost?.input, `${label}.cost.input`);
  validateFiniteNonNegative(model.cost?.output, `${label}.cost.output`);
  validateFiniteNonNegative(model.cost?.cacheRead, `${label}.cost.cacheRead`);
  validateFiniteNonNegative(model.cost?.cacheWrite, `${label}.cost.cacheWrite`);
  validatePositiveInteger(model.contextWindow, `${label}.contextWindow`);
  validatePositiveInteger(model.maxTokens, `${label}.maxTokens`);
  validateHeaders(model.headers, `${label}.headers`);
}

function validateConnectConfig(
  providerName: string,
  connect: PiProviderRegistration["connect"],
): void {
  if (connect === undefined || connect === true || connect === false) return;
  if (!connect || typeof connect !== "object" || Array.isArray(connect)) {
    throw new Error(
      `Provider ${providerName}.connect must be boolean or object`,
    );
  }
  if (connect.fields !== undefined) {
    if (!Array.isArray(connect.fields)) {
      throw new Error(
        `Provider ${providerName}.connect.fields must be an array`,
      );
    }
    for (const field of connect.fields) {
      if (!field || typeof field !== "object") {
        throw new Error(
          `Provider ${providerName}.connect.fields entries must be objects`,
        );
      }
      if (typeof field.key !== "string" || field.key.length === 0) {
        throw new Error(
          `Provider ${providerName}.connect.fields entries need a key`,
        );
      }
      if (typeof field.label !== "string" || field.label.length === 0) {
        throw new Error(
          `Provider ${providerName}.connect.fields entries need a label`,
        );
      }
      if (
        field.placeholder !== undefined &&
        typeof field.placeholder !== "string"
      ) {
        throw new Error(
          `Provider ${providerName}.connect.fields placeholder must be a string`,
        );
      }
      if (field.secret !== undefined && typeof field.secret !== "boolean") {
        throw new Error(
          `Provider ${providerName}.connect.fields secret must be boolean`,
        );
      }
    }
  }
}

function validateOAuthConfig(
  providerName: string,
  oauth: PiProviderRegistration["oauth"],
): void {
  if (oauth === undefined) return;
  if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) {
    throw new Error(`Provider ${providerName}.oauth must be an object`);
  }
  if (oauth.name !== undefined && typeof oauth.name !== "string") {
    throw new Error(`Provider ${providerName}.oauth.name must be a string`);
  }
  for (const key of ["login", "refreshToken", "getApiKey"] as const) {
    if (typeof oauth[key] !== "function") {
      throw new Error(
        `Provider ${providerName}.oauth.${key} must be a function`,
      );
    }
  }
  if (
    oauth.modifyModels !== undefined &&
    typeof oauth.modifyModels !== "function"
  ) {
    throw new Error(
      `Provider ${providerName}.oauth.modifyModels must be a function`,
    );
  }
}

export function validatePiProviderRegistration(
  providerName: string,
  config: PiProviderRegistration,
): void {
  validateProviderName(providerName);
  validateHeaders(config.headers, `Provider ${providerName}.headers`);
  validateConnectConfig(providerName, config.connect);
  validateOAuthConfig(providerName, config.oauth);
  if (
    config.listModels !== undefined &&
    typeof config.listModels !== "function"
  ) {
    throw new Error(`Provider ${providerName}.listModels must be a function`);
  }
  if (
    config.authHeader !== undefined &&
    typeof config.authHeader !== "boolean"
  ) {
    throw new Error(`Provider ${providerName}.authHeader must be boolean`);
  }
  if (config.models !== undefined) {
    if (!Array.isArray(config.models)) {
      throw new Error(`Provider ${providerName}.models must be an array`);
    }
    const ids = new Set<string>();
    for (const model of config.models) {
      validateModel(providerName, config, model);
      if (ids.has(model.id)) {
        throw new Error(
          `Provider ${providerName}: duplicate model id "${model.id}"`,
        );
      }
      ids.add(model.id);
    }
  }
}
