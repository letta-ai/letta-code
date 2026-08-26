---
name: capturing-tui-visual-proof
description: Captures reviewable before-and-after visual proof from the real Letta Code Ink TUI. Use when a Letta Code PR changes interactive CLI rendering or behavior and needs terminal screenshots or GIFs in its PR body.
---

# Capturing TUI Visual Proof

Record the production TUI through `bun run src/index.ts`. Do not substitute a
mocked Ink component, text fixture, generated image, or headless output for the
real terminal workflow.

## Choose the Proof

- Static rendering change: capture before/after screenshots.
- Interaction or state transition: capture before/after GIFs.
- Timing or animation claim: record continuously; do not hide the interval that
  proves the claim.

Keep every variable except the code revision identical: terminal dimensions,
theme, agent, model, prompt, fixtures, and CLI flags.

## Prepare Exact Before and After Checkouts

Use the PR's base SHA rather than current `main`, which may have advanced:

```bash
repo=$(git rev-parse --show-toplevel)
pr=1234 # replace with the PR number
base=$(gh pr view "$pr" --json baseRefOid --jq .baseRefOid)
before=/tmp/letta-code-pr-$pr-before

rm -rf "$before"
git clone --shared --no-checkout "$repo" "$before"
git -C "$before" checkout --detach "$base"
```

For a dependency-neutral change, reuse the current checkout's dependencies:

```bash
ln -s "$repo/node_modules" "$before/node_modules"
```

If the PR changes dependencies, install them independently in each checkout
instead. Never install through a symlinked `node_modules`.

## Make the Interaction Deterministic

Use the same existing test agent and a new conversation for both runs. For
skill-loading proof, create a small temporary project skill with a fixed reply:

```bash
proof_skills=/tmp/letta-code-pr-$pr-skills
mkdir -p "$proof_skills/pr-proof-demo"
cat > "$proof_skills/pr-proof-demo/SKILL.md" <<'SKILL'
---
name: pr-proof-demo
description: Loads deterministic instructions for TUI visual proof.
---

After loading this skill, reply exactly: `Skill loaded.`
SKILL
```

Dry-run the flow in each checkout before recording:

```bash
bun run src/index.ts \
  --agent "$AGENT_ID" \
  --new \
  --no-system-info-reminder \
  --reflection-trigger off \
  --skills "$proof_skills" \
  --skill-sources project
```

Do not add `--model` to a shared agent merely to accelerate proof; that can
persistently change its model configuration.

## Record with VHS

Install [VHS](https://github.com/charmbracelet/vhs) if unavailable. Record at
roughly 960px wide, 10-15 fps, and a legible font size. Produce MP4 while
iterating and GIF for the PR.

Create one tape per checkout from this pattern:

```text
# Replace CHECKOUT, AGENT_ID, and SKILLS_DIR before running.
Output "/tmp/pr-proof.gif"
Output "/tmp/pr-proof.mp4"
Set Shell "zsh"
Set Width 960
Set Height 720
Set FontSize 14
Set Framerate 12
Set TypingSpeed 20ms
Set Theme "Catppuccin Mocha"
Set CursorBlink false

Hide
Type "clear && cd <CHECKOUT> && bun run src/index.ts --agent <AGENT_ID> --new --no-system-info-reminder --reflection-trigger off --skills <SKILLS_DIR> --skill-sources project"
Enter
Sleep 20s
Show
Sleep 1s
Type "Use the pr-proof-demo skill, then follow its instructions."
Sleep 500ms
Enter
Sleep 1s
Hide
Sleep 45s
Show
Sleep 4s
```

Run it with:

```bash
vhs validate /tmp/pr-proof.tape
vhs /tmp/pr-proof.tape
```

For a still, run the same real interaction and add
`Screenshot /tmp/pr-proof.png` after the final state appears.

`Hide` may remove startup or model latency from a rendering proof while the real
process continues running. First dry-run the command and choose generous waits.
Never use hidden time to skip the interaction or state transition being claimed.

Before publishing, check that the recording contains no secrets, tokens,
private paths, or unrelated conversation history.

## Inspect Every Recording

Open the GIF and inspect frames across its full duration, not just its first or
last frame:

```bash
mkdir -p /tmp/proof-frames
ffmpeg -y -i /tmp/pr-proof.gif -vf 'fps=1' \
  /tmp/proof-frames/frame-%02d.png
```

Verify that:

- the initial, interaction, and final states are legible;
- before reproduces the original bug;
- after demonstrates the fix without hiding surrounding behavior;
- both recordings use equivalent inputs and layout.

## Publish to the PR

Copy only final proof assets into the branch:

```bash
asset_dir=.github/pr-assets/PR-$pr
mkdir -p "$asset_dir"
cp /tmp/before.gif "$asset_dir/before.gif"
cp /tmp/after.gif "$asset_dir/after.gif"
```

Commit and push the assets, then embed full-SHA-pinned same-origin URLs:

```bash
sha=$(git rev-parse HEAD)
git remote get-url origin
```

```markdown
| Before | After |
| --- | --- |
| ![Before](https://github.com/OWNER/REPO/raw/FULL_SHA/.github/pr-assets/PR-NUMBER/before.gif) | ![After](https://github.com/OWNER/REPO/raw/FULL_SHA/.github/pr-assets/PR-NUMBER/after.gif) |
```

Use `github.com/OWNER/REPO/raw/...`, not `raw.githubusercontent.com`, and use a
full commit SHA rather than a branch or short SHA. Fetch the final PR body and
download both embedded URLs to confirm they return the committed files.

Keep tapes, temporary skills, MP4s, frames, and detached checkouts out of the PR.
