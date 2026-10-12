---
name: speech-generation
description: Generate spoken audio from text (text to speech) with ElevenLabs voices. Use when the user asks you to say something out loud, send a voice message or voice note, read text aloud, narrate, record a voiceover, or speak in your own voice.
---

# Speech Generation

Generate speech via Letta's hosted endpoint `POST /v1/audio/speech`. It calls
ElevenLabs with Letta's key and charges the organization's Letta credits, so you
do not need an ElevenLabs key. The response contains the audio as base64; save
it to a file before replying.

## Example

```bash
base_url="${LETTA_BASE_URL%/}"

curl -sS -X POST "$base_url/v1/audio/speech" \
  -H "Authorization: Bearer $LETTA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text":"[warmly] Morning! I finished the report overnight. [pause] Want the short version?","voice_id":"JBFqnCBsd6RMkjVDRZzb"}' \
  > speech-response.json

python3 - <<'PY'
import base64, json

with open("speech-response.json") as f:
    response = json.load(f)
if "audio_b64" not in response:
    raise SystemExit(response.get("message", response))

with open("morning-update.mp3", "wb") as f:
    f.write(base64.b64decode(response["audio_b64"]))
print("saved morning-update.mp3")
PY
```

In Bash tools launched by Letta Code, use the runtime-provided
`LETTA_BASE_URL` and `LETTA_API_KEY` together. Build URLs relative to
`${LETTA_BASE_URL%/}` and do not hardcode `https://api.letta.com`. If either
variable is missing, the user needs to authenticate with Letta Cloud; do not ask
for an ElevenLabs key for this endpoint.

Share the saved file the way your current surface supports: attach or upload it
to the conversation or channel you are replying in. Never paste the base64 into a
reply. Keep credit amounts out of replies unless the user asks about cost; they
are in `billing.credits_charged`.

## Choosing a voice

`voice_id` is required. The endpoint accepts:

- **Your own voice**, if your memory names one. Use it whenever you speak as
  yourself so you always sound the same.
- **ElevenLabs premade voices**, for anything else, for example:
  - `JBFqnCBsd6RMkjVDRZzb` George (warm storyteller)
  - `EXAVITQu4vr4xnSDxMaL` Sarah (mature, reassuring)
  - `cgSgspJ2msm6clMCkdW9` Jessica (playful, conversational)
  - `onwK4e9ZLuTAKqWW03F9` Daniel (steady broadcaster)
  - `SAz9YHcvj6GT2YYXdXww` River (relaxed, neutral)

Other voices (cloned or designed voices from someone's own ElevenLabs account)
are rejected with 400. To use one, call ElevenLabs directly with the user's own
`ELEVENLABS_API_KEY` secret instead of this endpoint.

## Directing the delivery

The default model, `eleven_v4`, reads inline audio tags as stage directions.
Write them in square brackets inside `text`:

- Put the tag before the words it affects: `[excited] We shipped it!`
- A tag carries forward until you add a new one, so add tags only where the
  delivery should change.
- Combine qualities in one tag: `[whispering, playful]`. Plain-language tags
  work, for example `[nervous, trying to sound confident]` or `[phone buzzing]`.
- Use one emotion per clause; contrasting tags on the same words blur the read.
- Pace with punctuation and pause tags: ellipses slow a line, dashes cut it
  off, and `[pause]` / `[long pause]` add beats. SSML `<break>` tags do not work.
- Well-written text often performs correctly with no tags. If a read misses,
  swap the tag (try `[worried]` instead of `[sad]`) and regenerate rather than
  rewriting the line.

## Request body

The body mirrors ElevenLabs "Create speech", so ElevenLabs' own documentation
for these fields applies.

| Field | Notes |
|-------|-------|
| `text` | Required, up to 10,000 characters. |
| `voice_id` | Required. See "Choosing a voice". |
| `model_id` | Default `eleven_v4`. Use `eleven_v4_turbo` when speed matters more than nuance. |
| `output_format` | Default `mp3_44100_128`. Also `opus_48000_64`, `wav_44100`, `pcm_24000`, `ulaw_8000` (phone), and others ElevenLabs lists. |
| `voice_settings` | Optional `{stability, similarity_boost, style, speed, use_speaker_boost}`. v4 uses only `stability` and `similarity_boost`; the others have no effect on v4. Lower stability gives a more expressive read, higher a steadier one. |
| `language_code` | Optional ISO 639-1 code to force a language. |
| `seed` | Optional, for near-repeatable output. |
| `previous_text`, `next_text`, `previous_request_ids`, `next_request_ids` | Optional continuity hints for long audio (see below). |
| `apply_text_normalization` | Optional `auto` / `on` / `off` for how numbers and dates are spoken. |

## Response

```json
{
  "model_id": "eleven_v4",
  "voice_id": "JBFqnCBsd6RMkjVDRZzb",
  "output_format": "mp3_44100_128",
  "audio_b64": "<base64>",
  "request_id": "Frhov0LQNC3M9HcHKY3t",
  "characters": 46,
  "billing": { "credits_charged": 4, "...": "..." }
}
```

## Long audio

For text over 10,000 characters, or audio you build in parts, split at sentence
or paragraph boundaries and keep the same `voice_id`, `model_id`, and
`voice_settings` for every part. Pass the previous parts' `request_id` values in
`previous_request_ids` (up to 3) so the joins sound continuous, then concatenate
the files in order (for example with `ffmpeg -f concat`).

## Errors

- **400 "Voice … is not available"**: use your own voice or a premade voice.
- **400 with an ElevenLabs message**: fix the request, for example remove a
  voice setting the model does not support, or shorten the text.
- **402**: the organization is out of credits. Tell the user; do not retry.
- **500**: retry once, then report the failure.
