---
name: adding-models
description: Guide for adding new LLM models to Letta Code. Use when the user wants to add support for a new model, needs to know valid model handles, or wants to update model-specific compatibility behavior. Covers runtime catalog sources, CI test matrices, and handle validation.
---

# Adding Models

This skill guides you through adding a new LLM model to Letta Code.

## Quick Reference

**Key files**:
- `src/agent/remote-model-catalog.ts` - Runtime catalog loading and projection
- `src/agent/model-catalog.ts` - Model lookup and compatibility aliases
- `.github/workflows/ci.yml` - CI test matrix (optional)
- `src/tools/manager.ts` - Toolset detection logic (rarely needed)

## Workflow

### Step 1: Find Valid Model Handles

First identify the agent source. These inputs are deliberately different:

| Agent source | Rows shown | Labels, presets, and capabilities |
|---|---|---|
| Cloud hosted | `GET /v1/models/catalog` only | `GET /v1/models/catalog` |
| Cloud organization BYOK | BYOK rows from `GET /v1/models` | Match to catalog metadata using provider metadata and model name; retain the BYOK handle for selection |
| Local | pi-ai inventory | pi-ai metadata |
| Custom App Server | Server runtime inventory | Server runtime metadata |

In Cloud mode, never use base/hosted rows from `GET /v1/models` to filter,
supplement, delay, or provide a fallback for the hosted catalog. This once made
GPT-4o appear in a selector even though the Cloud catalog deliberately omitted
it. `GET /v1/models` remains necessary for organization-specific BYOK rows.

Query the Cloud hosted catalog to see hosted preset IDs, handles, and
capabilities:

```bash
curl -s https://api.letta.com/v1/models/catalog | jq '.models[] | [.id, .handle]'
```

To inspect organization BYOK rows from a Cloud backend, query its model
inventory and filter by `provider_category`:

```bash
curl -s https://api.letta.com/v1/models/ \
  | jq '.[] | select(.provider_category == "byok") | [.handle, .provider_type]'
```

Do not use this response as a second hosted catalog.

Common provider prefixes:
- `anthropic/` - Claude models
- `openai/` - GPT models  
- `google_ai/` - Gemini models
- `google_vertex/` - Vertex AI
- `openrouter/` - Various providers

### Step 2: Update the Owning Catalog

Letta Code does not bundle a model catalog:

- Cloud hosted rows and presets come from the server's
  `GET /v1/models/catalog` response.
- Cloud `GET /v1/models` contributes only organization BYOK rows to selectors.
- Local model inventory comes from pi-ai and the active provider runtimes.

Add the model at the source that owns it. A hosted preset belongs in the server catalog. A local provider model belongs in pi-ai or that provider's discovery runtime.

Only change this repository when the model needs Letta Code-specific compatibility behavior, such as preserving an established CLI alias or recognizing a new provider for toolset selection. Keep that logic narrow and derive the handle and metadata from the runtime catalog rather than copying model definitions here.

### Step 3: Test the Model

Test with headless mode:

```bash
bun run src/index.ts --new --model <model-id> -p "hi, what model are you?"
```

Example:
```bash
bun run src/index.ts --new --model gemini-3-flash -p "hi, what model are you?"
```

### Step 4: Add to CI Test Matrix (Optional)

To include the model in automated testing, add it to `.github/workflows/ci.yml`:

```yaml
# Find the headless job matrix around line 122
model: [gpt-5-minimal, gpt-4.1, sonnet-4.5, gemini-pro, your-new-model, glm-4.6, haiku]
```

## Toolset Detection

Models are automatically assigned toolsets based on provider:
- `openai/*` → `codex` toolset
- `google_ai/*` or `google_vertex/*` → `gemini` toolset
- Others → `default` toolset

This is handled by `isGeminiModel()` and `isOpenAIModel()` in `src/tools/manager.ts`. You typically don't need to modify this unless adding a new provider.

## Common Issues

**"Handle not found" error**: The model handle is incorrect. Run the validation script to see valid handles.

**Model works but wrong toolset**: Check `src/tools/manager.ts` to ensure the provider prefix is recognized.
