# Mod provider recipes

Use provider mods when the user wants a **local agent** to use a model provider that is not built into `/connect` and `/model`.

Important: provider mods are local-backend/local-agent only. They register local provider metadata for the TUI, headless local runtime, and desktop listener. They do not add providers for agents managed through the Letta API.

For multi-capability mods that combine a provider with commands, tools, UI, or state, also read `architecture.md`.

## Quick pattern

```ts
// ~/.letta/mods/kilo.ts
export default function activate(letta) {
  if (!letta.capabilities.providers) return;

  return letta.providers.register("kilo", {
    name: "Kilo",
    description: "Connect to Kilo's OpenAI-compatible API",
    api: "openai-completions",
    baseUrl: "https://api.kilo.example/v1",
    apiKey: "KILO_API_KEY", // env var name, not the raw secret
    authHeader: true,
    models: [
      {
        id: "kilo-code",
        name: "Kilo Code",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
        },
      },
    ],
    connect: {
      fields: [{ key: "apiKey", label: "Kilo API Key", secret: true }],
    },
  });
}
```

After `/reload`, the provider appears in local `/connect` and desktop Connect model providers. Model handles are `<provider-id>/<model-id>`, for example `kilo/kilo-code`.

## Key rules

- Always guard with `letta.capabilities.providers`.
- Prefer `letta.providers.register(...)` over legacy `letta.registerProvider(...)`.
- Keep provider registration independent from commands/tools/UI/events and `letta.client`; the desktop listener loads provider-only mods.
- Do not hardcode real secrets. `apiKey: "ENV_VAR"` resolves `process.env.ENV_VAR` when present, or lets `/connect` save a local key.
- Use stable lowercase provider ids. Model ids must be unprefixed and must not contain `/`.
- Set `api` at provider or model level. Common values include `"openai-completions"`, `"openai-responses"`, `"anthropic-messages"`, and `"bedrock-converse-stream"`; check `src/backend/dev/pi-provider-mod-types.ts` and pi-ai model types before using uncommon values.

## Model metadata

Each model needs enough local runtime metadata for selection and context display:

```ts
{
  id: "model-id-without-provider-prefix",
  name: "Display Name",
  reasoning: false,
  input: ["text"], // or ["text", "image"]
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
  // Optional: compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }
}
```

Do not set `model.baseUrl` when all models use the provider-level URL. Model-level `baseUrl` overrides the connected provider base URL, so `/connect` base URL overrides are ignored. Use it only when a specific model intentionally needs a different endpoint.

## Connect fields

- `connect: undefined` / `true` uses default API key + base URL fields.
- `connect: { fields: [...] }` customizes local `/connect` / desktop fields.
- `connect: false` hides the provider from `/connect`; use only when credentials come entirely from env/local code.
- Custom fields are currently required. TUI pre-fills non-secret placeholders for convenience, but placeholders are not backend/protocol defaults.
- If the provider has a normal fixed `baseUrl`, set provider-level `baseUrl` and omit `baseUrl` from `connect.fields`; the local runtime uses the provider-level URL after the API key is saved.
- Include `{ key: "baseUrl", ... }` only when the user must enter or review/override the endpoint during connect.

## Dynamic model discovery

Use `listModels(connection)` only when the provider exposes a models endpoint or the model list depends on credentials:

```ts
async listModels(connection) {
  const response = await fetch(`${connection.baseUrl}/models`, {
    headers: {
      Authorization: `Bearer ${connection.apiKey}`,
      ...connection.headers,
    },
  });
  if (!response.ok) throw new Error(`Model list failed: ${response.status}`);
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
}
```

`connection` has `{ id, providerName, baseUrl?, apiKey?, headers? }`. Keep dynamic listing lightweight; if it is flaky, prefer static `models`.
