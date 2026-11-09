---
name: image-generation
description: Generate images from text prompts (and optionally edit/remix input images). Use when the user asks to create, generate, draw, render, or edit an image, illustration, logo, icon, diagram, slide, photo, animated GIF, or SVG.
---

# Image Generation

Generate images via Letta's hosted endpoint `POST /v1/images/generations`. The API
usually returns base64 image bytes, but some providers return signed image URLs;
save either form to a local image file before replying.

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
import base64, json, urllib.request

with open("image-response.json") as f:
    response = json.load(f)

image = response["images"][0]
if image.get("b64_json"):
    data = base64.b64decode(image["b64_json"])
else:
    data = urllib.request.urlopen(image["url"]).read()

with open("robot-mascot.png", "wb") as f:
    f.write(data)

print("saved robot-mascot.png")
PY
```

In Bash tools launched by Letta Code, use the runtime-provided
`LETTA_BASE_URL` and `LETTA_API_KEY` together for Letta API calls. Build URLs
relative to `${LETTA_BASE_URL%/}` and send `Authorization: Bearer $LETTA_API_KEY`.
Do not hardcode `https://api.letta.com`: Desktop and remote runtimes may provide
a proxy base URL, and the credential may only be valid through that URL. If
either variable is missing, the user needs to authenticate with Letta Cloud (or
provide a Letta API key); do **not** ask for an OpenAI/Gemini provider key. This
endpoint also does not use `/connect` BYOK providers — the only `provider` values
supported here are `flux`, `gemini`, and `openai`.

Then **show the image to the user** by embedding the saved file in your reply:

```markdown
Here's the mascot:

![a friendly robot mascot waving, flat vector logo](./robot-mascot.png)
```

The Letta Code UI renders local file paths in markdown image tags, so the image
appears inline. **Always display generated images this way** — don't just report
the path, and never paste the raw base64 / a `data:` URI. The markdown path must
match where you saved the file. For `n > 1`, save each image to its own file and
embed each on its own line. Keep credit amounts and billing metadata out of
user-facing replies and captions unless the user asks about cost. When asked,
read `billing.credits_charged` from the saved response.

## Request body

| Field | Type | Notes |
|-------|------|-------|
| `provider` | `"flux"` \| `"gemini"` \| `"openai"` | Required. |
| `prompt` | string | Required, 1–32000 chars. |
| `model` | string | Optional; defaults per provider (below). |
| `n` | int 1–4 | Optional, default 1. Request variations in one call. |
| `size` | string | Optional, e.g. `"1024x1024"` (OpenAI). |
| `quality` | `low`\|`medium`\|`high`\|`xhigh`\|`max`\|`auto` | Optional (OpenAI; higher = more credits; `xhigh`/`max` need GPT Image 2.6). |
| `background` | `auto`\|`opaque`\|`transparent` | Optional (OpenAI). Transparent works with png, webp and svg. |
| `complexity` | `low`\|`medium`\|`high` | Optional (OpenAI GPT Image 2.6). How much the model plans before rendering; defaults to `high`. |
| `output_format` | `png`\|`jpeg`\|`webp`\|`gif`\|`svg` | Optional (OpenAI). `gif` and `svg` need GPT Image 2.6; see below. |
| `frame_count` / `frame_duration_ms` | int 2–16 / int 20–2000 | Optional, `gif` only. Defaults 9 frames, 200 ms. |
| `svg` | `{ "model"?, "reasoning"?: { "effort" } }` | Optional, `svg` only. Model that writes the SVG: `gpt-6.1-terra` (default), `gpt-6.1-sol`, `gpt-6-luna` or `gpt-6-astra`. |
| `input_images` | string[] (max 14) | Optional. Base64 **data URLs** for edit/remix. |
| `markup_image` | string | Optional (OpenAI edits). Base64 data URL of a transparent annotation layer marking where to change the first input image. |
| `seed` | int | Optional. |

| Provider | Default model | Use for |
|----------|---------------|---------|
| `flux` | `flux-2-pro` | Default for normal text-to-image. High-quality general image generation; commonly returns signed URLs. |
| `gemini` | `gemini-3-pro-image` | Strong prompt adherence, image editing/remix. |
| `openai` | `gpt-image-2.6-flare` | Photoreal output, explicit `size`/`quality`, animated GIFs, SVG vectors, markup-guided edits. Use `gpt-image-2.6-sunburst` for detailed work and consistency across edits. |

Default to `flux` for normal text-to-image requests. Use `gemini` when the user
provides input images or wants image editing/remix. Use `openai` when the user
wants photoreal output, a specific size/quality, an animated GIF, an SVG, or an
edit guided by a marked-up region.

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
always returns `b64_json`. Flux commonly returns a signed `url`; download it to
your local image file immediately because signed URLs expire. If OpenAI returns a
`url`, download that URL instead of base64-decoding.

## Editing / remixing images

Pass source images in `input_images` as base64 **data URLs**
(`data:<mime>;base64,<data>`) and describe the edit in `prompt`. Gemini handles
multi-image edits well. To build a data URL from a local file:

```bash
DATA_URL="data:image/png;base64,$(base64 < input.png | tr -d '\n')"
```

## Prompting (applies to every provider)

Write the prompt like a brief for the image you need, then inspect the result
and refine one thing at a time.

1. **Define the result.** Name the subject and the intended use (product photo,
   ad, diagram, slide, logo, UI mockup). Give composition, aspect ratio and
   placement constraints. For complex requests, use labeled sections: scene,
   subject, details, constraints.
2. **Describe what's visible.** Materials, lighting, colors, medium, framing,
   texture. Say "photorealistic" or "real photograph" when that's the goal.
   Camera terms ("35mm film, 50mm lens, shallow depth of field") are appearance
   cues. For moody scenes, give scale, atmosphere and color, not just mood words.
3. **Specify people and actions.** Body framing, scale, gaze and interaction:
   "full body visible, feet included", "looking down at the open book".
4. **Exact text goes in quotes**, with position, typography and how many times
   it should appear ("render the tagline exactly once"). Spell unusual names
   letter by letter. Ask for "no extra text, no watermarks, no unrelated logos",
   then check spelling in the output. Use `quality: "high"` for small text,
   legends, axes, dense labels or slides.
5. **Slides, charts and diagrams** are artifact specs, not illustrations: name
   the deliverable, canvas and hierarchy, include the real numbers and labels,
   and ask for readable type, clean spacing and no decorative clutter. Use a
   landscape size (`1536x1024`, or `1536x864` for 16:9). Check every number the
   model renders; it may invent extras. For educational visuals, state the
   audience and lesson goal and list required and forbidden components.
6. **UI previews**: describe the product as if it already ships (layout,
   hierarchy, real interface elements), not as concept art.
7. **Comics and storyboards**: one concrete, action-focused visual beat per panel.
8. **Logos**: brand, defining shapes, "strong silhouette, reads at small and
   large sizes, flat, minimal strokes", "original, non-infringing".
9. **Edits: separate the change from what must stay.** "Change only X", then
   list what to preserve (identity, face, pose, geometry, layout, lighting,
   labels, camera angle) and what to exclude. Repeat the preserve list on every
   follow-up edit.
10. **Give each reference image a role by number**: "image 1 is the scene,
    image 2 is the dog; put the dog on the sofa in image 1, keep everything else
    unchanged". For style references, say which part to borrow (palette,
    texture, medium) and describe the new subject separately.
11. **Iterate deliberately.** Feed the previous output back as the next
    `input_images[0]`, ask for one change, and restate the critical constraints.
    For a recurring character, generate a character reference first, then reuse
    it and repeat the defining details in every scene.

## OpenAI GPT Image 2.6

The default OpenAI model is `gpt-image-2.6-flare`, the faster one and fine for
most work. Use `gpt-image-2.6-sunburst` when detail, dense layout or edit
accuracy matters; it keeps characters and products more consistent across
edits.

- **`quality`** controls rendering detail (texture, small lettering): `low`,
  `medium`, `high`, and on 2.6 also `xhigh` and `max`. Higher costs more.
- **`complexity`** controls how much the model plans the scene before
  rendering: `low`, `medium` or `high` (OpenAI's default when omitted). Keep the
  default for open-ended prompts and complex layouts, where more planning gives
  a better composition. Use `low` for a targeted edit or a fully specified
  design, where more planning adds latency and can introduce unwanted changes.
  Change quality or complexity, not both at once.
- **`size`**: `1024x1024`, `1536x1024`, `1024x1536`, or custom with both sides
  multiples of 16 and an aspect ratio between 1:3 and 3:1.
- **`background`**: `"transparent"` for cutouts and logos (PNG, WebP or SVG).
  Also say "isolated subject, fully transparent background, clean alpha edges,
  no checkerboard" in the prompt, since a drawn checkerboard is not
  transparency. Repeat it on follow-up edits.

### Animated GIF

Set `"output_format": "gif"` (generations or edits). Optional `frame_count`
(2–16, default 9) and `frame_duration_ms` (20–2000, default 200); 9 frames at
200 ms is a 1.8 s loop. Leave `size` unset or use a small size like
`"512x512"`: all frames must fit the model's pixel limit, so a large size with
many frames is rejected. If that happens, reduce the frame count or size.

For a smooth loop, give the subject a starting pose to return to and say
whether the camera moves:

> A little monkey in an olive-green hooded coat stands in a snowy pine forest
> at dusk. It holds a glowing amber lantern at chest height, slowly lifts it,
> looks up and blinks, then lowers it back to its starting pose. Keep the
> lantern in its hands and the camera still. Make the motion loop smoothly.

To animate a still (a sketch, mascot or product shot), pass it in
`input_images`. Save the decoded `b64_json` bytes as `.gif`.

### SVG

Set `"output_format": "svg"` with `n: 1`, generations only (no
`input_images`). Use it for logos, icons and illustrations someone will scale
or recolor. The image model renders a reference image (`quality` applies to
it) and a second model writes the SVG from it. `"svg": { "model": "..." }`
picks that model (`gpt-6.1-terra` by default, or `gpt-6.1-sol`, `gpt-6-luna`,
`gpt-6-astra`), and `"svg": { "reasoning": { "effort": "high" } }` sets its
effort. SVG costs more than a raster image. `background: "transparent"` works.
Decode `b64_json` to UTF-8 XML and save it as `.svg`; the result is static
vector art with no scripts or embedded rasters.

### Markup-guided edits

Point at the exact region to change instead of describing it. Pass the photo as
`input_images[0]` and, as `markup_image` (a data URL), a transparent PNG with
the **same pixel dimensions** where the region is circled or marked. Then state
the change in `prompt` ("Make the circled vase cobalt blue; keep the dried
stems and everything else unchanged"). Markup applies only to the first input
image; other `input_images` are references. Build the overlay locally:

```bash
python3 -c '
from PIL import Image, ImageDraw
src = Image.open("photo.png")
overlay = Image.new("RGBA", src.size, (0, 0, 0, 0))
ImageDraw.Draw(overlay).ellipse((420, 260, 640, 560), outline=(255, 0, 0, 255), width=8)
overlay.save("markup.png")
'
MARKUP_URL="data:image/png;base64,$(base64 < markup.png | tr -d '\n')"
```

Compare the edit with the original to catch changes outside the marked region.

For limits not covered here, see OpenAI's
[GPT Image 2.6 section of the image generation guide](https://developers.openai.com/api/docs/guides/image-generation#gpt-image-26)
and the [image prompting guide](https://developers.openai.com/api/docs/guides/image-prompting),
which has worked prompts for each technique above.

## Notes

- **Billing**: every success charges credits; don't loop needlessly.
- **Errors**: `402` = insufficient credits (`credits_required` in body); `400`/`500`
  return `{ "message": "..." }` — surface it to the user.
- Only `flux`, `gemini`, and `openai` are supported here.
