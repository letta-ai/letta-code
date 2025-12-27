---
name: adding-models
description: Guide for adding new LLM models to Letta Code. Use when the user wants to add support for a new model, needs to know valid model handles, or wants to update the model configuration. Covers models.json configuration, CI test matrix, and handle validation.
---

# Adding Models

This skill guides you through adding a new LLM model to Letta Code.

## Quick Reference

**Key files**:
- `src/models.json` - Model definitions (required)
- `.github/workflows/ci.yml` - CI test matrix (optional)
- `src/tools/manager.ts` - Toolset detection logic (rarely needed)

## Workflow

### Step 1: Find Valid Model Handles

Query the Letta API to see available models:

```bash
curl -s https://api.letta.com/v1/models/ | jq '.[] | .handle'
```

Or filter by provider:
```bash
curl -s https://api.letta.com/v1/models/ | jq '.[] | select(.handle | startswith("google_ai/")) | .handle'
```

Common provider prefixes:
- `anthropic/` - Claude models
- `openai/` - GPT models  
- `google_ai/` - Gemini models
- `google_vertex/` - Vertex AI
- `openrouter/` - Various providers

### Step 2: Add to models.json

Add an entry to `src/models.json`:

```json
{
  "id": "model-shortname",
  "handle": "provider/model-name",
  "label": "Human Readable Name",
  "description": "Brief description of the model",
  "isFeatured": true,  // Optional: shows in featured list
  "updateArgs": {
    "context_window": 180000,
    "temperature": 1.0  // Optional: provider-specific settings
  }
}
```

**Field reference**:
- `id`: Short identifier used with `--model` flag (e.g., `gemini-3-flash`)
- `handle`: Full provider/model path from the API (e.g., `google_ai/gemini-3-flash-preview`)
- `label`: Display name in model selector
- `description`: Brief description shown in selector
- `isFeatured`: If true, appears in featured models section
- `updateArgs`: Model-specific configuration (context window, temperature, reasoning settings, etc.)

**Provider prefixes**:
- `anthropic/` - Anthropic (Claude models)
- `openai/` - OpenAI (GPT models)
- `google_ai/` - Google AI (Gemini models)
- `google_vertex/` - Google Vertex AI
- `openrouter/` - OpenRouter (various providers)

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
