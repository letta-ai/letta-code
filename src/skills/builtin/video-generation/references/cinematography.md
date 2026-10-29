> Adapted from fal-ai-community/skills (https://github.com/fal-ai-community/skills, commit 9ca850412943251fc9a466c4c29fdaf7a303a3d8), MIT License per that repository's README. Changes: execution commands replaced with Letta's /v1/videos.

# Cinematography

Use this reference when the user needs cinematic direction, not generic "make it
cinematic" prompting.

Write concrete visual direction. Avoid empty prestige words and em dashes.

## Inputs to collect

Ask only for what affects the shot:

- Subject and action.
- Medium: still image, video, image-to-video, edit, storyboard frame.
- Genre and mood.
- Framing: close-up, medium, wide, overhead, POV, profile, locked-off.
- Camera motion for video: push-in, dolly, tracking, handheld, crane, drone.
- Lens feel: wide, normal, telephoto, macro, shallow or deep focus.
- Lighting: natural, practical, studio, noir, high key, low key, backlit.
- Output: aspect ratio, duration, first frame, last frame, download path.
- Preferred model, if the user wants a specific cinematography model or
  quality/cost profile.

## Execution with Letta

Call `/v1/videos` as described in `SKILL.md`. Pick a model from `SKILL.md`'s
"Choosing a model" section and `/v1/videos/models`, and use only the controls
that endpoint reports for the selected model.

## Prompt build order

Use the SCLCAM structure:

1. Subject: who or what is in frame.
2. Context: location, time, weather, story moment.
3. Lens/framing: distance, angle, focal length feel, depth of field.
4. Camera motion: only for video or if motion blur is desired.
5. Atmosphere: haze, rain, practicals, reflections, texture.
6. Mood/color: palette, contrast, grade, exposure style.
7. Output controls: aspect ratio, duration, first-frame continuity.

Example structure:

```text
[subject] in [context], framed as [shot size and angle], [lens feel],
[lighting setup], [camera movement if video], [color grade], [texture],
[duration or aspect ratio], [continuity constraints]
```

## Quality bar

Before returning, check:

- Camera movement is physically plausible for the scene.
- Lens, shot size, and camera angle do not contradict each other.
- Lighting direction is clear and consistent.
- Color grade supports the mood without flattening subject detail.
- Video prompt describes one shot unless the selected model supports multiple
  prompts or shot lists.
- Downloaded video comes from `/v1/videos/{id}/content`.

If a result looks generic, improve specificity in camera, blocking, light, and
environment before adding more adjectives.

# Shot language reference

## Shot sizes

- Extreme close-up: one detail, texture, eye, hand, product edge.
- Close-up: face or object detail with emotional focus.
- Medium close-up: chest-up subject, useful for dialogue and portraits.
- Medium shot: waist-up subject, body language visible.
- Full shot: entire body or object, silhouette and stance readable.
- Wide shot: subject inside environment.
- Extreme wide: scale, isolation, worldbuilding, architecture.

## Angles

- Eye level: natural, direct, grounded.
- Low angle: power, threat, awe.
- High angle: vulnerability, surveillance, layout clarity.
- Dutch angle: unease, instability. Use sparingly.
- Over-the-shoulder: relationship, conversation, pursuit.
- POV: subjective experience.
- Profile: graphic composition, ritual, tension, fashion.

## Camera movement

- Slow push-in: attention, realization, premium product reveal.
- Pull-back: isolation, context, reveal.
- Dolly left or right: spatial discovery.
- Tracking shot: follow action with continuity.
- Crane up: scale reveal or emotional release.
- Handheld: urgency, intimacy, instability.
- Locked-off: control, deadpan, formalism, surveillance.
- Orbit: product reveal, character inspection, heightened drama.
- Macro glide: product texture, food, jewelry, electronics.

## Composition

- Centered symmetry: control, ritual, luxury, unease.
- Rule of thirds: natural editorial composition.
- Negative space: loneliness, premium ad copy area, tension.
- Foreground obstruction: secrecy, surveillance, voyeurism.
- Leading lines: architecture, movement, precision.
- Frame within frame: confinement, observation, layered space.

## Continuity language

- "same subject and wardrobe as the reference"
- "preserve product shape and label"
- "continue from the uploaded first frame"
- "single continuous shot"
- "no cutaways"
- "no time jump"
- "same lighting direction throughout"

# Lighting, lens, and color reference

## Lighting setups

- Soft key: flattering, commercial, calm.
- Hard key: graphic, dramatic, fashion, noir.
- Backlight: separation, glow, silhouette, premium edge.
- Rim light: subject outline, product glass, metal highlights.
- Practical light: lamps, signs, screens, candles in the scene.
- Motivated light: light that has a visible or logical source.
- Low key: dark frame, selective highlights, suspense.
- High key: bright, low contrast, beauty, comedy, clean product work.
- Top light: interrogation, overhead realism, harsh institutional mood.
- Window light: natural, intimate, documentary.

## Lens feel

- 14-20mm wide: scale, distortion, kinetic interiors, action.
- 24-28mm wide-normal: environmental realism, travel, documentary.
- 35mm: natural cinematic perspective, street, lifestyle, narrative.
- 50mm: classic portrait and product balance.
- 85mm: compressed portrait, beauty, isolation.
- 100mm macro: product detail, jewelry, food texture, eyes.
- Telephoto compression: distance, surveillance, fashion runway.

## Depth of field

- Shallow focus: isolate subject, premium portrait, product hero.
- Deep focus: environment and blocking stay readable.
- Rack focus: attention shifts between two subjects or details.

## Color and grade

- Clean neutral grade: commercial, e-commerce, architecture.
- Warm golden grade: nostalgia, comfort, luxury hospitality.
- Cool cyan shadows: thriller, tech, night exterior.
- Desaturated earth palette: realism, documentary, survival.
- High contrast monochrome: noir, fashion, graphic product.
- Pastel palette: beauty, wellness, light lifestyle.
- Sodium vapor night: urban realism, tension.

## Texture

- Fine film grain: organic image, period mood.
- Clean digital: tech, luxury, e-commerce, architecture.
- Halation: glowing highlights, dream, night practicals.
- Mist filter: soft bloom, romance, beauty.
- Crisp high shutter: action clarity.
- Motion blur: speed, energy, handheld realism.

# Cinematography examples

Use these as direction patterns. Replace subject, model fields, and output
controls with the current task.

## Noir close-up

```text
a detective sitting alone in a parked car at night, close-up from passenger
seat angle, 50mm lens feel, rain streaks on the window in foreground, hard
streetlight slashes across his face, low key noir lighting, deep shadows,
muted green and amber grade, still frame, no text
```

## Product macro glide

```text
single continuous macro glide across the brushed steel edge of a luxury watch,
100mm macro lens feel, black velvet surface, thin strip light reflected along
the bevel, shallow depth of field, slow controlled camera movement, clean dark
commercial grade, no extra text, no logo distortion
```

## Sci-fi wide shot

```text
small astronaut crossing a vast white salt flat toward a black monolith,
extreme wide shot, low horizon, 24mm lens feel, late afternoon backlight,
long shadow, minimal composition, cool silver color grade, quiet atmospheric
haze, cinematic still, no extra ships
```

## Handheld pursuit

```text
8 second handheld tracking shot following a woman running through a narrow
market alley at night, camera shoulder-height behind her, practical neon and
food stall lights, motion blur on background, subject remains readable,
urgent thriller pacing, one continuous shot, no cuts
```

## Warm interior drama

```text
two siblings at a kitchen table after midnight, medium-wide static frame,
35mm lens feel, warm practical lamp on table, cool moonlight through window,
subtle haze, quiet tension, naturalistic color grade, deep focus enough to
read both faces, no melodramatic poses
```
