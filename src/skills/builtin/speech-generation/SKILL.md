---
name: speech-generation
description: Convert text to speech using ElevenLabs voice AI through Letta. Use when generating audio from text, sending a voice message, reading text aloud, creating voiceovers, speaking in your own voice, or synthesizing speech in 90+ languages.
license: MIT
---

# ElevenLabs Text-to-Speech (via Letta)

Generate natural speech from text - supports 90+ languages, multiple models for quality vs latency tradeoffs. Examples default to `eleven_v4`, the latest and highest-quality model.

This skill is adapted from ElevenLabs' `text-to-speech` skill
([elevenlabs/skills](https://github.com/elevenlabs/skills), MIT; see `LICENSE`).
Instead of calling ElevenLabs with your own key, you call Letta's hosted endpoint
`POST /v1/audio/speech`. It forwards the request to ElevenLabs with Letta's key
and charges the organization's Letta credits, so you do not need an ElevenLabs
API key. The request body uses the same field names as ElevenLabs "Create
speech"; the voice ID goes in the body.

## Quick Start

```bash
base_url="${LETTA_BASE_URL%/}"

curl -sS -X POST "$base_url/v1/audio/speech" \
  -H "Authorization: Bearer $LETTA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello, welcome to ElevenLabs!","voice_id":"JBFqnCBsd6RMkjVDRZzb","model_id":"eleven_v4"}' \
  > speech-response.json

python3 - <<'PY'
import base64, json

with open("speech-response.json") as f:
    response = json.load(f)
if "audio_b64" not in response:
    raise SystemExit(response.get("message", response))

with open("output.mp3", "wb") as f:
    f.write(base64.b64decode(response["audio_b64"]))
print("saved output.mp3")
PY
```

Use the runtime-provided `LETTA_BASE_URL` and `LETTA_API_KEY` together. Build
URLs relative to `${LETTA_BASE_URL%/}` and do not hardcode
`https://api.letta.com`. If either variable is missing, the user needs to
authenticate with Letta Cloud; do not ask for an ElevenLabs key.

Share the saved file the way your current surface supports: attach or upload it
to the conversation or channel you are replying in. Never paste the base64 into
a reply. Keep credit amounts out of replies unless the user asks about cost.

## Models

| Model ID | Languages | Latency | Best For |
|----------|-----------|---------|----------|
| `eleven_v4` | 90+ | Standard | **Default.** Highest quality, emotional range, audio tags, voice cloning accuracy |
| `eleven_v4_turbo` | 90+ | ~100ms | Faster v4 for shorter, time-sensitive replies |
| `eleven_flash_v2_5` | 32 | ~75ms | Lowest latency, lowest cost |
| `eleven_flash_v2` | English | ~75ms | English-only, lowest latency |
| `eleven_multilingual_v2` | 29 | Standard | Previous generation; most stable on very long-form generations |
| `eleven_v3` | 70+ | Standard | Previous generation expressive model |

`eleven_turbo_v2_5` and `eleven_turbo_v2` are superseded by the Flash models (same output, lower latency) — use `eleven_flash_v2_5` / `eleven_flash_v2` instead.

**Eleven v4 notes:** supports only `stability` and `similarity_boost` voice settings (no `style` or `speed`) and does not support SSML. Direct delivery with audio tags such as `[whispers]`, `[laughs]`, `[sarcastic]` (see "Audio Tags").

## Voice IDs

The Letta endpoint accepts ElevenLabs premade voices and voices Letta provides.
If your memory names your own voice ID, use it whenever you speak as yourself.
Other voices (cloned or designed voices from someone's own ElevenLabs account)
are rejected with 400; to use one, call ElevenLabs directly with the user's own
`ELEVENLABS_API_KEY` secret and ElevenLabs' `text-to-speech` skill.

**Premade voices:**
- `JBFqnCBsd6RMkjVDRZzb` - George (male, warm storyteller)
- `EXAVITQu4vr4xnSDxMaL` - Sarah (female, mature, reassuring)
- `cgSgspJ2msm6clMCkdW9` - Jessica (female, playful, conversational)
- `onwK4e9ZLuTAKqWW03F9` - Daniel (male, steady broadcaster)
- `SAz9YHcvj6GT2YYXdXww` - River (neutral, relaxed)

## Voice Settings

Fine-tune how the voice sounds:

- **Stability**: How consistent the voice stays. Lower values = more emotional range and variation, but can sound unstable. Higher = steady, predictable delivery.
- **Similarity boost**: How closely to match the original voice sample. Higher values sound more like the original but may amplify audio artifacts.
- **Style**: Exaggerates the voice's unique style characteristics (v2/v3 models; not supported on Eleven v4).
- **Speed**: Speech speed multiplier (v2/v3 models; not supported on Eleven v4).
- **Speaker boost**: Post-processing that enhances clarity and voice similarity.

```json
{
  "text": "Customize my voice settings.",
  "voice_id": "JBFqnCBsd6RMkjVDRZzb",
  "model_id": "eleven_v4",
  "voice_settings": {
    "stability": 0.5,
    "similarity_boost": 0.75
  }
}
```

`stability`: lower = more expressive, higher = more consistent.
`similarity_boost`: higher = closer to the reference voice. See
[references/voice-settings.md](references/voice-settings.md) for ranges and
use-case presets.

## Audio Tags

Eleven v4 reads bracketed, natural-language cues in `text` as stage directions:

- Place a tag before the words it affects: `[shouts] I can't believe you said that to me.`
- A tag's emotion carries forward, so add another tag only where the delivery should shift.
- Combine tags inside one set of brackets: `[whispering, playful]`. Plain-language tags work, such as `[nervous, trying to sound confident]` or `[phone buzzing]`.
- Use one emotion per clause; contrasting tags on the same words blur the performance.
- Pair tags with punctuation: ellipses slow a line, dashes cut a speaker off, and `[pause]` / `[long pause]` add beats.
- If a delivery misses, swap the tag (try `[let down]` instead of `[despair]`) and regenerate rather than rewriting the line.

## Language Selection

Use `language_code` with models that support language enforcement to guide pronunciation and text normalization. Unsupported language codes are ignored, and `language_code` is not supported on `eleven_multilingual_v2`.

```json
{
  "text": "Bonjour, comment allez-vous?",
  "voice_id": "JBFqnCBsd6RMkjVDRZzb",
  "model_id": "eleven_v4",
  "language_code": "fr"
}
```

## Text Normalization

Controls how numbers, dates, and abbreviations are converted to spoken words. For example, "01/15/2026" becomes "January fifteenth, twenty twenty-six":

- `"auto"` (default): Model decides based on context
- `"on"`: Always normalize (use when you want natural speech)
- `"off"`: Speak literally (use when you want "zero one slash one five...")

```json
{
  "text": "Call 1-800-555-0123 on 01/15/2026",
  "voice_id": "JBFqnCBsd6RMkjVDRZzb",
  "model_id": "eleven_v4",
  "apply_text_normalization": "on"
}
```

## Request Stitching

When generating long audio in multiple requests, the audio can have pops, unnatural pauses, or tone shifts at the boundaries. Request stitching solves this by letting each request know what comes before/after it:

```json
{"text": "This is the first part.", "voice_id": "JBFqnCBsd6RMkjVDRZzb", "model_id": "eleven_v4", "next_text": "And this continues the story."}
```

```json
{"text": "And this continues the story.", "voice_id": "JBFqnCBsd6RMkjVDRZzb", "model_id": "eleven_v4", "previous_text": "This is the first part."}
```

Each response includes `request_id`. Instead of `previous_text`, you can pass up
to three earlier `request_id` values in `previous_request_ids` (and later ones in
`next_request_ids` when regenerating a middle part). Keep the same voice, model,
and voice settings for every part, split long text at sentence or paragraph
boundaries (each request takes up to 10,000 characters), and concatenate the
files in order, for example with `ffmpeg -f concat`.

## Output Formats

Pass `output_format` in the body.

| Format | Description |
|--------|-------------|
| `mp3_44100_128` | MP3 44.1kHz 128kbps (default) - compressed, good for web/apps |
| `mp3_44100_192` | MP3 44.1kHz 192kbps - higher quality compressed |
| `mp3_44100_64` | MP3 44.1kHz 64kbps - lower quality, smaller files |
| `mp3_22050_32` | MP3 22.05kHz 32kbps - smallest MP3 files |
| `pcm_16000` | Raw PCM 16kHz - use for real-time processing |
| `pcm_22050` | Raw PCM 22.05kHz |
| `pcm_24000` | Raw PCM 24kHz |
| `pcm_44100` | Raw PCM 44.1kHz - CD quality |
| `pcm_48000` | Raw PCM 48kHz - highest quality |
| `ulaw_8000` | μ-law 8kHz - standard for phone systems (Twilio, telephony) |
| `alaw_8000` | A-law 8kHz - telephony (alternative to μ-law) |
| `opus_48000_64` | Opus 48kHz 64kbps - efficient codec, small files |
| `wav_44100` | WAV 44.1kHz - uncompressed with headers |

The Letta endpoint returns the whole file at once (as `audio_b64`); it does not stream.

## Response

```json
{
  "model_id": "eleven_v4",
  "voice_id": "JBFqnCBsd6RMkjVDRZzb",
  "output_format": "mp3_44100_128",
  "audio_b64": "<base64>",
  "request_id": "Frhov0LQNC3M9HcHKY3t",
  "characters": 46,
  "billing": { "credits_charged": 4, "transaction_id": "...", "new_credit_balance": "..." }
}
```

## Error Handling

Errors return JSON with a `message`:
- **400 "Voice … is not available"**: use your own voice or a premade voice (see "Voice IDs").
- **400 with an ElevenLabs message**: invalid parameters (check `model_id`, voice settings the model does not support, or text length).
- **402**: the organization is out of Letta credits. Tell the user; do not retry.
- **500**: retry once, then report the failure.

## References

- [Voice Settings](references/voice-settings.md)
