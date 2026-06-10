---
name: image-generation
description: Generate images from text prompts (and optionally edit/remix input images). Use when the user asks to create, generate, draw, render, or edit an image, illustration, logo, icon, diagram, or photo.
---

# Image Generation

Generate images via Letta's hosted endpoint `POST /v1/images/generations`. The API
usually returns base64 image bytes, so save the response to a local image file
before replying.

## Example

Generate the image, save it locally, then show it inline:

```bash
base_url="${LETTA_BASE_URL%/}"

curl -sS -X POST "$base_url/v1/images/generations" \
  -H "Authorization: Bearer $LETTA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"provider":"gemini","prompt":"a friendly robot mascot waving, flat vector logo, mint green background","n":1}' \
  > image-response.json

python3 - <<'PY'
import base64, json

with open("image-response.json") as f:
    response = json.load(f)

with open("robot-mascot.png", "wb") as f:
    f.write(base64.b64decode(response["images"][0]["b64_json"]))

print("saved robot-mascot.png; credits:", response["billing"]["credits_charged"])
PY
```

In Bash tools launched by Letta Code, the current Letta API host and credential
are available as `$LETTA_BASE_URL` and `$LETTA_API_KEY`. Use them as a pair. Do
not hardcode `https://api.letta.com`: Desktop OAuth and some remote runtimes route
the token through a local/proxied base URL. If either variable is missing, the
user needs to authenticate with Letta Cloud (or provide a Letta API key); do
**not** ask for an OpenAI/Gemini provider key. This endpoint also does not use
`/connect` BYOK providers — the only `provider` values supported here are
`gemini` and `openai`.

Then **show the image to the user** by embedding the saved file in your reply:

```markdown
Here's the mascot:

![a friendly robot mascot waving, flat vector logo](./robot-mascot.png)
```

The Letta Code UI renders local file paths in markdown image tags, so the image
appears inline. **Always display generated images this way** — don't just report
the path, and never paste the raw base64 / a `data:` URI. The markdown path must
match where you saved the file. For `n > 1`, save each image to its own file and
embed each on its own line. Also tell the user the `credits_charged`.

## Request body

| Field | Type | Notes |
|-------|------|-------|
| `provider` | `"gemini"` \| `"openai"` | Required. |
| `prompt` | string | Required, 1–32000 chars. |
| `model` | string | Optional; defaults per provider (below). |
| `n` | int 1–4 | Optional, default 1. Request variations in one call. |
| `size` | string | Optional, e.g. `"1024x1024"` (OpenAI). |
| `quality` | `low`\|`medium`\|`high`\|`auto` | Optional (OpenAI; higher = more credits). |
| `output_format` | `png`\|`jpeg`\|`webp` | Optional (OpenAI). |
| `input_images` | string[] (max 14) | Optional. Base64 **data URLs** for edit/remix. |
| `seed` | int | Optional. |

| Provider | Default model | Use for |
|----------|---------------|---------|
| `gemini` | `gemini-3-pro-image` | Default. Strong prompt adherence, image editing/remix. |
| `openai` | `gpt-image-2` | Photoreal output, explicit `size`/`quality`/`output_format`. |

Default to `gemini` unless the user wants photoreal or a specific size/quality.

## Response

```json
{
  "provider": "gemini",
  "model": "gemini-3-pro-image",
  "images": [{ "b64_json": "<base64>", "mime_type": "image/png" }],
  "billing": { "credits_charged": 12, "...": "..." }
}
```

Each `images[]` entry has either `b64_json` or `url`, plus `mime_type`. Gemini
always returns `b64_json`. If OpenAI returns a `url`, download that URL to your
local image file instead of base64-decoding.

## Editing / remixing images

Pass source images in `input_images` as base64 **data URLs**
(`data:<mime>;base64,<data>`) and describe the edit in `prompt`. Gemini handles
multi-image edits well. To build a data URL from a local file:

```bash
DATA_URL="data:image/png;base64,$(base64 < input.png | tr -d '\n')"
```

## Notes

- **Billing**: every success charges credits; don't loop needlessly, and report
  `credits_charged`.
- **Errors**: `402` = insufficient credits (`credits_required` in body); `400`/`500`
  return `{ "message": "..." }` — surface it to the user.
- Only `gemini` and `openai` are supported here.
