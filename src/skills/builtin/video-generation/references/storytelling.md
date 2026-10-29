> Adapted from fal-ai-community/skills (https://github.com/fal-ai-community/skills, commit 9ca850412943251fc9a466c4c29fdaf7a303a3d8), MIT License per that repository's README. Changes: execution commands replaced with Letta's /v1/videos.

# Storytelling

Use this reference when the user wants a sequence, not a single asset.

The goal is to produce clear story beats and executable video generation. Avoid
generic inspiration copy, fake dialogue, and em dashes.

## Inputs to collect

Ask only when missing information affects execution.

- Format: ad, short film, music video, documentary, tutorial, social story.
- Duration and aspect ratio.
- Number of shots or allowed range.
- Main subject, character, product, or location.
- Continuity anchors: character, product, wardrobe, environment, color.
- Source media: first frame, reference image, product shot, audio track.
- Audio needs: narration, music, sound design, transcript, no audio.
- Preferred model or model family, if the user wants to decide quality, cost,
  speed, audio, or multi-shot tradeoffs.

## Execution with Letta

Call `/v1/videos` as described in `SKILL.md`. Pick models from `SKILL.md`'s
"Choosing a model" section and `/v1/videos/models`, and use only the sequence,
reference, audio, and timeline controls that endpoint reports for each selected
model. Generate clips separately when the selected model supports only one
prompt, and do not claim they are stitched unless a model or another tool
actually stitched them.

## Shot planning

Plan every sequence as beats first:

1. Hook: immediate visual reason to keep watching.
2. Setup: who, what, where, and why it matters.
3. Development: movement, discovery, proof, or escalation.
4. Turn: reveal, transformation, result, or emotional change.
5. Close: final image, product memory, CTA-safe frame, or unresolved mood.

For each shot, write:

- Shot number and duration.
- Story purpose.
- Visual prompt.
- Continuity anchor.
- Input reference, if any.
- Letta video model.
- Expected output path.

## Prompt build order

Use this structure for each shot:

```text
SHOT [number], [duration]:
[story purpose]. [subject and action]. [location and time]. [camera framing].
[camera movement]. [lighting and color]. [continuity anchor]. [transition or
relationship to previous shot].
```

Keep one shot to one clear action unless the selected model supports multi-shot
or timeline prompting.

## Quality bar

Before returning:

- Shot order has a clear narrative function.
- The first shot is strong enough for the platform.
- Continuity anchors are repeated without bloating every prompt.
- Camera motion is varied but not random.
- Durations add up to the requested runtime.
- Async request IDs and downloaded files are recorded.
- The model's actual schema, not assumptions, drove the final command.

# Shot planning reference

## Basic sequence shapes

## 15 second social ad

| Shot | Time | Purpose | Visual role |
| --- | --- | --- | --- |
| 1 | 0-2s | Hook | striking product or problem image |
| 2 | 2-6s | Context | product in use or character reaction |
| 3 | 6-11s | Proof | feature, texture, process, result |
| 4 | 11-15s | Close | memorable final frame with safe space |

## 30 second commercial

| Shot | Time | Purpose | Visual role |
| --- | --- | --- | --- |
| 1 | 0-3s | Hook | image that defines the world |
| 2 | 3-7s | Product or hero | show subject clearly |
| 3 | 7-13s | Benefit | action, feature, transformation |
| 4 | 13-20s | Lifestyle or proof | real context, emotion, result |
| 5 | 20-27s | Escalation | strongest beauty or motion shot |
| 6 | 27-30s | End frame | clean brand-safe final composition |

## Short cinematic scene

| Shot | Purpose |
| --- | --- |
| Establishing | where the scene happens and mood |
| Character reveal | who matters |
| Action beat | what changes |
| Reaction | emotional consequence |
| Detail insert | object, clue, texture, proof |
| Resolution | new state or unanswered tension |

## Continuity anchors

Character anchor:

```text
same character face, hair, wardrobe, age, posture, and style as the approved
reference
```

Product anchor:

```text
same product shape, color, packaging, logo placement, and material as the
reference
```

Location anchor:

```text
same room layout, window direction, color palette, and time of day
```

Motion anchor:

```text
single continuous shot, starts where previous shot ended, no time jump
```

## Pacing guidance

- Fast: 1-3 second shots, strong motion, clear graphic frames.
- Medium: 3-6 second shots, product demos, lifestyle, dialogue-like scenes.
- Slow: 6-10 second shots, luxury, drama, architecture, atmosphere.
- Variable: fast hook, slower proof, strong final frame.

# Storytelling workflows

## Native multi-prompt sequence

Use only when the model supports multiple prompts, shot arrays, scenes,
timeline, or keyframe-like fields.

1. Inspect the model and identify the exact multi-shot fields.
2. Convert the story into concise shot prompts.
3. Keep one continuity anchor outside the repeated shot details if the model
   supports a global prompt.
4. Run async and download the completed result.
5. Check whether the model returned one video or per-shot files.

## Manual per-shot video

Use when the model supports only one shot at a time.

1. Create a shot table.
2. Generate or upload a reference frame for each shot.
3. Run each shot with unique output paths.
4. Record model, request id, prompt, local output path, and defects.
5. Return clips in timeline order. Do not claim they are stitched unless they
   are actually stitched by the model or another tool.

## First-frame to last-frame

1. Generate or choose the opening frame.
2. Generate or choose the target final frame.
3. Supply both frames if supported.
4. Inspect the model for accepted first/last frame fields.
5. Prompt the transition as one physical motion or transformation.
6. Run async and download.

## Character narrative

1. Use `character-design` to create or confirm the anchor.
2. Build shot variables around action, expression, and location.
3. Use image-to-video from approved stills when identity drift matters.
4. Compare each result to the anchor before advancing to the next shot.

## Product narrative

1. Use `commercial` to define product invariants.
2. Plan the sequence around hook, feature, context, proof, final frame.
3. Use the same product reference for every shot if the model allows it.
4. Keep motion modest when packaging fidelity matters.

## Audio narrative

1. Choose a model with narration, music, or sound generation support.
2. Use the model's supported audio controls.
3. Use transcript or beat timing to set shot durations.
4. Return audio path and visual clip paths separately unless a model produces
   combined audio-video output.

# Storytelling examples

These examples show planning density and prompt tone. Adapt to the user's model
and references.

## 15 second coffee social ad

| Shot | Duration | Prompt |
| --- | --- | --- |
| 1 | 2s | macro close-up of espresso crema swirling in a glass cup, warm morning window light, shallow focus, immediate sensory hook |
| 2 | 4s | same coffee cup placed beside a small bag of beans on a clean kitchen counter, slow push-in, product and texture readable |
| 3 | 5s | hand pours milk into the coffee, soft cloud bloom, controlled motion, warm lifestyle lighting, no text |
| 4 | 4s | final hero frame of cup and beans with clean negative space on right for copy, calm premium breakfast mood |

Execution note: generate still or video per shot unless the selected model
supports a prompt list.

## 30 second architecture brand film

| Shot | Duration | Purpose |
| --- | --- | --- |
| 1 | 4s | dawn exterior of a modern house, wide static frame, warm interior lights |
| 2 | 5s | slow tracking shot along concrete wall and timber detail, tactile proof |
| 3 | 5s | architect's hand sketches over plan, natural desk light, human process |
| 4 | 6s | family crosses the living room, soft backlight, space feels livable |
| 5 | 6s | crane up from courtyard to roofline, shows scale and geometry |
| 6 | 4s | quiet final exterior with empty safe space for brand mark |

Continuity anchor:

```text
same house, same material palette of warm timber, pale concrete, black steel
frames, and soft morning light
```

## Cinematic reunion scene

| Shot | Duration | Prompt |
| --- | --- | --- |
| 1 | 5s | empty train platform in blue hour rain, wide locked-off frame, practical lights reflected on wet ground |
| 2 | 4s | close-up of woman noticing someone off screen, same coat and hairstyle, soft backlight, restrained emotion |
| 3 | 4s | medium shot of man stepping from train doorway, matching eyeline, cool station light |
| 4 | 5s | slow tracking two-shot as they walk toward each other, shallow depth of field, no crowd distraction |
| 5 | 6s | close hands meeting, rain on sleeves, quiet emotional detail |
| 6 | 6s | wide final frame of both under station clock, warm practical light, unresolved calm |

## Product launch sequence

```text
SHOT 1, 3s:
black screen opens to a thin rim light tracing the product silhouette, centered
macro frame, premium suspense, no text.

SHOT 2, 4s:
slow orbit reveals the product material and main contour, controlled studio
reflections, same product shape and logo placement as the reference.

SHOT 3, 5s:
close-up of the key feature in use, clean hand interaction, product remains
sharp, no fake labels.

SHOT 4, 3s:
final hero composition on simple surface with large negative space for copy,
brand-safe end frame, no generated text.
```
