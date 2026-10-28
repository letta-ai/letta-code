---
name: video-generation
description: Generate videos from text prompts (and optional reference or frame images) using Letta's asynchronous video generation API. Use when the user asks to create, generate, or make a video or animation from a description, animate an existing image, or turn a prompt into a short video clip.
---

# Video Generation

Generate videos via Letta's async `POST /v1/videos` using `curl` + `jq`. Requires `LETTA_BASE_URL` and `LETTA_API_KEY`, which the runtime provides. If either is unset, stop and ask the user to authenticate with Letta Cloud; do not ask for a video provider key.

This skill is adapted from OpenRouter's `openrouter-video` skill
([OpenRouterTeam/skills](https://github.com/OpenRouterTeam/skills/blob/83827c3f3b1200bc3b609f4ab4ec3241c0cfb7ad/skills/openrouter-video/SKILL.md)).
Letta's endpoint forwards the request with Letta's key and charges the
organization's Letta credits for the cost of each completed video.

Build every URL relative to `${LETTA_BASE_URL%/}` and send `Authorization: Bearer $LETTA_API_KEY`. Do not hardcode `https://api.letta.com`: Desktop and remote runtimes may provide a proxy base URL, and the credential may only be valid through that URL.

## The three steps

Video generation is async: submit → poll → download. A single request can't return the video because generation takes 30s–a few minutes. Tell the user the job was submitted so they know the delay is expected.

1. `POST /v1/videos` → `{ id, polling_url, status: "pending" }` (`polling_url` is the absolute URL of step 2)
2. `GET /v1/videos/{id}` every ~30s until `status` is `completed` (terminal failures: `failed`, `cancelled`, `expired` — surface the `error` field verbatim)
3. `GET /v1/videos/{id}/content?index=0` **with the auth header** → MP4 bytes

A completed job also has `urls`: signed downloads that need no API key until `expires_at` (Unix seconds); anyone holding one can download the video, so prefer step 3.

## Pick parameters from the models endpoint, don't guess

`resolution`, `aspect_ratio`, `duration`, and `frame_images[].frame_type` are per-model. Before the first submit for a new model (or whenever the user asks for something specific), fetch the model's capabilities and only send values from the returned sets:

```bash
curl -sS "${LETTA_BASE_URL%/}/v1/videos/models" \
  -H "Authorization: Bearer $LETTA_API_KEY" \
  | jq '.data[] | select(.id == "MODEL_ID")'
```

Fields on each model worth knowing: `supported_resolutions`, `supported_aspect_ratios`, `supported_sizes`, `supported_durations` (often discrete like `[4,6,8]`, not a range), `supported_frame_images` (which `frame_type` values are accepted), `generate_audio` and `seed` (capability bools), `pricing_skus`, and `allowed_passthrough_parameters`. An out-of-set value returns a 400, so validate client-side.

Models include `google/veo-3.1`, `bytedance/seedance-2.5`, `kwaivgi/kling-v3.0-pro`, `minimax/hailuo-3`, `minimax/hailuo-3-max`, and `heygen/avatar-iv` (a talking head from one photo); the models endpoint has the full list.

## Full workflow (drop-in)

```bash
#!/usr/bin/env bash
set -euo pipefail

PROMPT="a golden retriever playing fetch on a sunny beach"
MODEL="google/veo-3.1"
OUTPUT="video-$(date +%Y%m%d-%H%M%S).mp4"
base_url="${LETTA_BASE_URL%/}"

# Build payload — extend with resolution/aspect_ratio/duration/etc. as needed.
payload=$(jq -n --arg model "$MODEL" --arg prompt "$PROMPT" \
  '{model: $model, prompt: $prompt}')

submit=$(curl -sS -X POST "$base_url/v1/videos" \
  -H "Authorization: Bearer $LETTA_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$payload")

job_id=$(echo "$submit" | jq -r '.id // empty')
if [ -z "$job_id" ]; then
  echo "Submit failed: $(echo "$submit" | jq -r '.message // .')" >&2
  exit 1
fi
echo "Submitted $job_id" >&2

while :; do
  sleep 30
  resp=$(curl -sS "$base_url/v1/videos/$job_id" -H "Authorization: Bearer $LETTA_API_KEY")
  # Avoid the name `status` — zsh treats it as read-only.
  st=$(echo "$resp" | jq -r '.status')
  echo "Status: $st" >&2
  case "$st" in
    completed) break ;;
    failed|cancelled|expired)
      echo "Generation $st: $(echo "$resp" | jq -r '.error // "unknown"')" >&2
      exit 1 ;;
  esac
done

curl -sS -f "$base_url/v1/videos/$job_id/content?index=0" \
  -H "Authorization: Bearer $LETTA_API_KEY" \
  --output "$OUTPUT"

echo "$resp" | jq --arg out "$(realpath "$OUTPUT")" \
  '{job_id: .id, video_saved: $out, billing}'
```

Share the saved file the way your current surface supports: attach or upload it to the conversation or channel you are replying in. Keep credit amounts out of replies unless the user asks about cost; `billing.credits_charged` on the completed job has them.

## Parameters

Required: `model`. `prompt` is required by every model except those that can generate from image input alone. Common optional fields:

- `duration` (int) — must be one of the model's `supported_durations`.
- `resolution` (string) / `aspect_ratio` (string) / `size` (string, `"WxH"`) — `size` is interchangeable with resolution + aspect_ratio.
- `generate_audio` (bool) — only meaningful if the model's `generate_audio` capability is true.
- `seed` (int) — honored only if the model's `seed` capability is true.
- `frame_images[]` — image-to-video; each entry is `{ type: "image_url", image_url: { url }, frame_type: "first_frame" | "last_frame" }`.
- `input_references[]` — reference-to-video (style guidance); image entries have the same shape, no `frame_type`. Audio and video references are `{ type: "audio_url", audio_url: { url } }` and `{ type: "video_url", video_url: { url } }`; only some models (such as `bytedance/seedance-2.5`) use them, and the rest ignore them. If both arrays are present, `frame_images` wins.
- `provider.options.<slug>.parameters.<key>` — provider passthrough, see below.

Image `url` can be a public `https://` URL or a local-file data URL: `MIME=image/png; B64=$(base64 < file.png | tr -d '\n'); url="data:${MIME};base64,${B64}"`. Audio and video references take URLs the same way.

## Provider passthrough

Provider-specific params go under `provider.options.<slug>.parameters`. The allowed keys for a given model are listed (flat) in `allowed_passthrough_parameters` on the models endpoint — but the meaning, value range, and required combinations come from the *upstream provider's* API docs (Google Vertex, Alibaba Dashscope, Kwai, ByteDance Volc Engine, MiniMax, OpenAI, etc.). Read the upstream docs before using an unfamiliar key; casing conventions differ between providers (Google/OpenAI use camelCase, most others use snake_case).

Example:

```json
{
  "model": "google/veo-3.1",
  "prompt": "a time-lapse of a flower blooming",
  "provider": {
    "options": {
      "google-vertex": {
        "parameters": {
          "personGeneration": "allow",
          "negativePrompt": "blurry, low quality"
        }
      }
    }
  }
}
```

`heygen/avatar-iv` animates one photo into a lip-synced talking head: pass the photo as an image in `input_references` and describe the video in `prompt`. Its passthrough keys (slug `heygen`) include `voice_id`, `motion_prompt`, and `expressiveness`; take their values from HeyGen's API docs.

```json
{
  "model": "heygen/avatar-iv",
  "prompt": "A friendly presenter welcomes viewers to the product tour",
  "aspect_ratio": "9:16",
  "input_references": [
    { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
  ]
}
```

## Chaining with other skills

- **Keyframes:** generate stills with the `image-generation` skill, then pass them as `frame_images` (`first_frame` / `last_frame`) or image `input_references` as data URLs.
- **Sound:** make a voiceover with the `speech-generation` skill or a soundtrack with the `music-generation` skill, then pass the audio as an `audio_url` input reference to a model that uses audio, or mix it onto the finished MP4 (for example with `ffmpeg`).

## Notes

- **Billing**: the organization needs credits for an estimate before a job is submitted; once it completes, it is charged for the video's cost. Don't resubmit needlessly.
- **Errors**: `402` = insufficient credits (`credits_required` in body); `400`/`404`/`500` return `{ "message": "..." }` — surface it to the user.

Video generation is not ZDR-eligible because the provider must temporarily retain the output for the async download step.
