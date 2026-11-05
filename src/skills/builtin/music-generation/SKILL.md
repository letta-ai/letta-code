---
name: music-generation
description: Generate music using ElevenLabs Music through Letta. Use when creating instrumental tracks, songs with lyrics, background music, jingles, theme songs, or any AI-generated music composition. Supports prompt-based generation and composition plans for section-by-section control.
license: MIT
---

# ElevenLabs Music Generation (via Letta)

Generate music from text prompts: instrumental tracks, songs with lyrics, and fine-grained control via composition plans. Examples use `music_v2_5`, the most advanced ElevenLabs music model and the endpoint's default.

This skill is adapted from ElevenLabs' `music` skill
([elevenlabs/skills](https://github.com/elevenlabs/skills), MIT; see `LICENSE`).
Instead of calling ElevenLabs with your own key, you call Letta's hosted endpoint
`POST /v1/audio/music` (or `POST /v1/audio/music/stream`). It forwards the
request to ElevenLabs with Letta's key and charges the organization's Letta
credits, so you do not need an ElevenLabs API key. The request and response are
the same as ElevenLabs "Compose music": a JSON body with the same field names,
`output_format` as a query parameter, and the audio file as the response body.

## Quick Start

```bash
base_url="${LETTA_BASE_URL%/}"

curl -sS -X POST "$base_url/v1/audio/music/stream?output_format=mp3_48000_192" \
  -H "Authorization: Bearer $LETTA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"A chill lo-fi hip hop beat with jazzy piano chords","music_length_ms":30000,"model_id":"music_v2_5"}' \
  --output output.mp3 \
  --write-out '%{http_code} %{content_type}\n'
```

A `200` with an `audio/...` content type means `output.mp3` is the song. Any
other status means `output.mp3` holds a JSON error with a `message` instead;
read it (see "Error Handling") and do not share the file.

Use the runtime-provided `LETTA_BASE_URL` and `LETTA_API_KEY` together. Build
URLs relative to `${LETTA_BASE_URL%/}` and do not hardcode
`https://api.letta.com`. If either variable is missing, the user needs to
authenticate with Letta Cloud; do not ask for an ElevenLabs key.

Generation takes a while (roughly 10-30 seconds per minute of music). Prefer
`/v1/audio/music/stream`: it sends audio as it is generated, so long songs do
not sit on an idle connection. `/v1/audio/music` takes the same request and
returns the same file, but may send nothing until the whole song is done, so
use it only for short songs. Do not set a short client timeout either way.

Share the saved file the way your current surface supports: attach or upload it
to the conversation or channel you are replying in. Keep credit amounts out of
replies unless the user asks about cost.

## Length

- A song is 3 seconds to 10 minutes (600,000 ms).
- With `prompt`, `music_length_ms` is optional. Leave it out to let the model
  choose a length that suits the prompt.
- With `composition_plan`, the length is the sum of the chunk or section
  `duration_ms` values; do not also send `music_length_ms`.
- Credits are charged for the length of the audio actually returned, at
  ElevenLabs' per-minute price. Before generating, the organization needs
  enough credits for the longest song the request allows: `music_length_ms`,
  the plan total, or 10 minutes when a prompt sets no length. Setting
  `music_length_ms` lowers that requirement.

## Models

| Model ID | Best For |
|----------|----------|
| `music_v2_5` | **Default.** Most advanced: best audio quality and prompt adherence. Chunk-based composition plans. |
| `music_v2` | Previous generation. Chunk-based composition plans. |
| `music_v1` | Oldest. Section-based composition plans. Use only when explicitly requested. |

## Prompting

Describe the music the way a producer would brief a session:

- Genre and mood: "melancholic indie folk", "triumphant orchestral trailer".
- Instrumentation and vocals: "fingerpicked acoustic guitar, soft female vocals".
- Tempo and key when they matter: "90 BPM", "D minor".
- Structure and energy: "starts sparse, builds into a big chorus".
- Lyrics: put them in the prompt for short songs, or use a composition plan
  to control which lines land in which section.
- Set `force_instrumental: true` to guarantee no vocals (prompt mode only).

## Composition Plans

`music_v2_5` composition plans are an ordered list of `chunks`. Each chunk specifies its own
`text` (section label, lyrics, inline cues), `duration_ms`, `positive_styles`, `negative_styles`,
and `context_adherence` (`low`, `medium`, or `high`, default `high`). Up to 30 chunks per plan,
each 3,000–120,000 ms. Each chunk's `text` supports up to 6,132 characters, with up to 30 lines
of 200 characters each. Send the plan instead of `prompt` and `music_length_ms`:

```json
{
  "model_id": "music_v2_5",
  "composition_plan": {
    "chunks": [
      {
        "text": "[Verse]\nWalking down an empty street",
        "duration_ms": 15000,
        "positive_styles": ["pop", "upbeat", "female vocals", "acoustic guitar", "120 BPM", "polished production"],
        "negative_styles": ["dark", "slow"],
        "context_adherence": "high"
      },
      {
        "text": "[Chorus]\nThis is my moment",
        "duration_ms": 15000,
        "positive_styles": ["powerful vocals", "full band"],
        "negative_styles": [],
        "context_adherence": "high"
      }
    ]
  }
}
```

- Put broader characteristics (genre, instrumentation, vocal style) in `positive_styles`, not in
  `text`. The first chunk's styles set the overall tone — include 6–7 styles there.
- Use later chunks' styles for progression: "bass joins in", "building intensity", "drums softening".
- Inline cues in curly braces add moments inside a chunk: `{guitar solo}`, `{vinyl crackle}`.
- Lower `context_adherence` lets a chunk depart from its neighbors, for a bridge or a key change.
- `seed` works with composition plans (not with `prompt`) to make results more repeatable.

For `music_v1`, plans use `positive_global_styles`, `negative_global_styles`, and `sections`
(each with `section_name`, `positive_local_styles`, `negative_local_styles`, `duration_ms`, and
`lines`), and `respect_sections_durations: false` lets the model adjust section lengths.

Inpainting and audio references (`song_id` chunks, `conditioning_ref`, `source_from`) are not
available through this endpoint and return 400.

## Output Formats

Pass `output_format` as a query parameter, not in the body. The default, `auto`,
gives `mp3_48000_192` for `music_v2` and later (`mp3_44100_128` for `music_v1`).
Name the file to match the format.

| Format | Description |
|--------|-------------|
| `mp3_48000_192` | MP3 48kHz 192kbps (what `auto` picks for v2 models) |
| `mp3_48000_320` | MP3 48kHz 320kbps - highest quality MP3 |
| `mp3_44100_128` | MP3 44.1kHz 128kbps - smaller files |
| `pcm_48000` | Raw 16-bit PCM 48kHz, no header - for further processing |
| `opus_48000_128` | Opus 48kHz 128kbps in Ogg - efficient codec, small files |

## Content Restrictions

- Cannot reference specific artists, bands, or copyrighted lyrics. Describe the style instead
  ("1960s British invasion rock" rather than a band name).
- A rejected prompt returns 400 with ElevenLabs' `bad_prompt` detail, which includes a
  `prompt_suggestion` with alternative phrasing. A rejected plan returns `bad_composition_plan`
  with a `composition_plan_suggestion`. Retry with the suggestion.

## Error Handling

Errors return JSON with a `message`:
- **400 with an ElevenLabs message**: invalid parameters or restricted content (see "Content Restrictions").
- **400 "Provide prompt or composition_plan."**: send one of them.
- **402**: the organization does not have enough Letta credits for the longest song the request
  allows (`credits_required`). Setting a shorter `music_length_ms` may help; otherwise tell the user
  and do not retry.
- **500**: retry once, then report the failure.

If the connection drops partway through `/stream`, the file is truncated; only the audio
received is charged. Retry the request rather than sharing a partial song.
