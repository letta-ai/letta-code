# Extension provider recipes

Use provider extensions when the user wants Letta Code local agents to use a model provider that is not built into `/connect` and `/model`.

**Important scope:** custom provider extensions are for **local agents only**. They register local provider metadata used by the local backend/TUI/desktop listener. They do not add providers for Constellation/cloud agents.

For multi-capability extensions that combine a provider with commands, tools, UI, or state, also read `architecture.md`.

## Contents

- When to use
- Surface behavior and limitations
- Capability guard
- Basic API-key provider
- Config fields
- Dynamic model discovery
- Connect behavior
- Review checklist

## When to use

Use a provider extension when:

- the provider API is supported by the local pi-ai adapter stack; OpenAI-compatible providers usually use `api: "openai-completions"` or `api: "openai-responses"`
- the user wants the provider to appear in local `/connect` / desktop Connect model providers
- local `/model` should show static or dynamically listed models from that provider
- local turns should resolve model handles like `kilo/kilo-code`

Do **not** use a provider extension when the user is asking to configure a Constellation/cloud provider. For cloud agents, use the product's normal provider configuration path instead.

## Surface behavior and limitations

- TUI/headless local agents can load provider extensions along with other extension capabilities.
- The desktop listener loads provider extensions so desktop's local provider UI can list and connect them.
- Listener provider loading is provider-only. Do not rely on commands, tools, UI, events, or `letta.client` while registering a provider.
- Provider extensions should use local data, environment variables, local provider connections, and direct `fetch`/Node APIs. They should not use Constellation-specific APIs to make a local provider work.

## Capability guard

Always guard provider registration:

```ts
export default function activate(letta) {
  if (!letta.capabilities.providers) return;

  return letta.providers.register("kilo", {
    // provider config
  });
}
```

`letta.registerProvider(id, config)` is also supported, but prefer `letta.providers.register(...)` so the capability being used is explicit.

## Basic API-key provider

```ts
// ~/.letta/extensions/kilo.ts
export default function activate(letta) {
  if (!letta.capabilities.providers) return;

  return letta.providers.register("kilo", {
    name: "Kilo",
    description: "Connect to Kilo's OpenAI-compatible API",
    api: "openai-completions",
    baseUrl: "https://api.kilo.example/v1",
    apiKey: "KILO_API_KEY",
    models: [
      {
        id: "kilo-code",
        name: "Kilo Code",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ],
    connect: {
      fields: [
        { key: "apiKey", label: "Kilo API Key", secret: true },
      ],
    },
  });
}
```

After `/reload`, this provider appears in local `/connect` and in the desktop local provider page. The model handle is `<provider-id>/<model-id>`, for example `kilo/kilo-code`.

## Config fields

Common provider config fields:

```ts
{
  name?: string;
  description?: string;
  api?: string;             // common: "openai-completions", "openai-responses", "anthropic-messages", "bedrock-converse-stream"
  baseUrl?: string;
  apiKey?: string;          // env var name to resolve, e.g. "KILO_API_KEY"
  headers?: Record<string, string>; // values resolve through process.env when present
  authHeader?: boolean;     // add Authorization: Bearer <apiKey>
  models?: Array<model>;
  listModels?: (connection) => Promise<Array<model>> | Array<model>;
  connect?: boolean | { fields?: Array<field> };
}
```

Check `src/backend/dev/pi-provider-extension-types.ts` and pi-ai model types before documenting or using an uncommon `api` value.

Model entries must include useful local runtime metadata:

```ts
{
  id: "model-id-without-provider-prefix",
  name: "Display Name",
  api?: "openai-completions",
  reasoning: false,
  input: ["text"],          // or ["text", "image"]
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
  headers?: {},
}
```

Do not set `model.baseUrl` when all models use the provider-level URL. Model-level `baseUrl` overrides the connected provider base URL, so `/connect` base URL overrides will be ignored. Use it only when a specific model intentionally needs a different endpoint.

## Dynamic model discovery

Use `listModels(connection)` when the provider exposes a models endpoint or the model list depends on connected credentials:

```ts
export default function activate(letta) {
  if (!letta.capabilities.providers) return;

  return letta.providers.register("kilo", {
    name: "Kilo",
    api: "openai-completions",
    baseUrl: "https://api.kilo.example/v1",
    apiKey: "KILO_API_KEY",
    async listModels(connection) {
      const response = await fetch(`${connection.baseUrl}/models`, {
        headers: {
          Authorization: `Bearer ${connection.apiKey}`,
          ...connection.headers,
        },
      });
      if (!response.ok) {
        throw new Error(`Kilo model list failed: ${response.status}`);
      }
      const body = await response.json();
      return body.data.map((model) => ({
        id: model.id,
        name: model.id,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      }));
    },
  });
}
```

`connection` contains the provider id/name plus resolved local connection details:

```ts
{
  id: string;
  providerName: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}
```

Keep dynamic listing lightweight and fail with short actionable errors. If listing is flaky, provide a static `models` fallback instead.

## Connect behavior

- `connect: undefined` or `connect: true` uses default API key + base URL fields.
- `connect: { fields: [...] }` customizes local `/connect` / desktop fields.
- `connect: false` hides the provider from `/connect`; use only when credentials come entirely from environment variables or local code.
- `apiKey: "ENV_VAR_NAME"` resolves from `process.env.ENV_VAR_NAME` when available. Do not hardcode real secrets.
- Custom fields are currently required. `placeholder` is display-only, not a default value.
- If the provider has a normal fixed `baseUrl`, set provider-level `baseUrl` and omit `baseUrl` from `connect.fields`; the local runtime will use the provider-level URL after the API key is saved.
- Include `{ key: "baseUrl", ... }` only when the user must enter or override the endpoint during connect.

Default custom fields use these keys when possible because the local provider store understands them:

```ts
{ key: "apiKey", label: "API Key", secret: true }
{ key: "baseUrl", label: "Base URL" }
```

## Review checklist

- The extension says or implies the provider is local-agent only when reporting back to the user.
- `letta.capabilities.providers` is checked before registration.
- Provider id is stable, lowercase, and suitable as the model-handle prefix.
- Model ids are unprefixed; Letta Code exposes them as `<provider-id>/<model-id>`.
- `contextWindow`, `maxTokens`, `input`, and `reasoning` metadata are accurate enough for local selection and context display.
- Model-level `baseUrl` is omitted unless the model intentionally needs a different endpoint from the provider/connection.
- `connect.fields` contains only fields the user must type; placeholders are not treated as defaults.
- Secrets are read from environment/local provider connections, not hardcoded.
- Provider registration does not depend on commands/tools/UI/events or `letta.client`.
- The user is told to run `/reload`, then configure the provider through local `/connect` or desktop Connect model providers.
