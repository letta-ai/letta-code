# Local ChatGPT Fast model selector plan

## Problem

Local mode ChatGPT OAuth uses pi-ai's `openai-codex` provider and exposes backend handles like:

- `openai-codex/gpt-5.5`

Our app-level model registry (`src/models.json`) has ChatGPT subscription display/reasoning entries under:

- `chatgpt-plus-pro/gpt-5.5`
- `chatgpt-plus-pro/gpt-5.5-fast`

Pi/Pi-AI does **not** treat `gpt-5.5-fast` as a real Codex model id. Pi removed non-working Codex fast model variants. Codex fast mode is instead implemented by passing:

```ts
serviceTier: "priority"
```

to `streamOpenAICodexResponses`, which pi-ai serializes as:

```json
{ "service_tier": "priority" }
```

Therefore we must not send `openai-codex/gpt-5.5-fast` or `gpt-5.5-fast` to pi-ai.

## Desired UX

In `/model`, local ChatGPT OAuth models should use readable labels from `models.json`, not raw backend handles, when a known mapping exists:

```text
GPT-5.5 (ChatGPT)
GPT-5.5 Fast (ChatGPT)
```

Avoid inconsistent rows like:

```text
openai-codex/gpt-5.5
GPT-5.5 Fast (ChatGPT)
```

Avoid pretending the backend has a real model handle:

```text
openai-codex/gpt-5.5-fast
```

## Semantics

Normal row:

```ts
actual model handle: "openai-codex/gpt-5.5"
registry/display handle: "chatgpt-plus-pro/gpt-5.5"
service_tier: null/default/cleared
```

Fast row:

```ts
actual model handle: "openai-codex/gpt-5.5"
registry/display handle: "chatgpt-plus-pro/gpt-5.5-fast"
service_tier: "priority"
```

Persist actual model identity separately from service tier:

```json
{
  "model": "openai-codex/gpt-5.5",
  "model_settings": {
    "provider_type": "chatgpt_oauth",
    "service_tier": "priority"
  }
}
```

Selecting the non-Fast row must clear any previous priority service tier.

## Implementation approach

1. Centralize model-selector display resolution:
   - Given a backend handle, resolve matching `models.json` metadata.
   - Exact matches keep existing behavior.
   - Alias local ChatGPT OAuth `openai-codex/<model>` to registry handle `chatgpt-plus-pro/<model>` for display/reasoning metadata.
   - Preserve raw/minimally cleaned labels for unknown/custom/local endpoint handles.

2. Model selector should pass a selection object, not only a string id:
   - It needs to preserve actual handle, display label, updateArgs, and service-tier metadata.
   - Keep backwards compatibility if practical by allowing callers to handle strings or objects.

3. Add local Fast selector rows only for supported ChatGPT/Codex models:
   - Start with allowlist for `openai-codex/gpt-5.5` (and any exact future handles if deliberately added).
   - Row label comes from `chatgpt-plus-pro/gpt-5.5-fast` metadata.
   - Row handle remains `openai-codex/gpt-5.5`.
   - Row updateArgs includes `service_tier: "priority"`.

4. Runtime support:
   - Store `service_tier` in model_settings.
   - Local pi stream adapter maps model_settings.service_tier to pi-ai option `serviceTier`.
   - Only pass supported values (initially `priority`).

5. Display/current state:
   - Statusline/model display should show Fast when current handle is `openai-codex/gpt-5.5` and model_settings.service_tier is `priority`.
   - Current row highlighting should distinguish Fast vs normal, not mark both as current.

6. Reasoning prompt:
   - If selecting Fast opens reasoning tier prompt, the final selection must preserve `service_tier: "priority"`.
   - Normal row should preserve/clear service tier appropriately when selecting reasoning tiers.

## Non-goals

- Do not modify pi-ai generated model metadata.
- Do not add fake local catalog handle `openai-codex/gpt-5.5-fast`.
- Do not require user JSON edits or extensions.
- Do not broaden service tier to all OpenAI-compatible providers without explicit support.
