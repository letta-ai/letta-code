# TUI Guidance

These rules apply to Ink rendering, approvals, and interactive input under
`src/cli/`. Read `app/README.md` for the current ownership map before choosing a
file to change.

## Rendering

- `react-dom` is not a dependency and Ink does not use it.
- Ink does not automatically batch related state updates after an `await`. Apply
  updates that should paint together before the first awaited boundary.
- Items committed through `<Static>` do not re-render. Commit an item only after
  its displayed content is complete, keep its key stable, and change the static
  render epoch only for an intentional full transcript repaint.
- A transcript item may be live or static, never both. Filter committed IDs out
  of the live list before rendering.
- Isolate frequently changing input, timer, and stream state from tall transcript
  components. Memoize stable bodies rather than whole stateful trees.

## Approvals and Input

- Route every tool approval through `ApprovalSwitch`; do not add a second
  tool-specific approval branch in the transcript.
- Show one focused approval. Other parallel approvals remain compact pending or
  decided stubs until they become current.
- Keep `Input` mounted after startup. Use its visibility, enabled, and collapse
  props while approvals or overlays own focus so draft and terminal state survive.
- Bracketed paste and keyboard-protocol handling live in `PasteAwareTextInput`
  and the vendored Ink patches. Do not add competing raw stdin listeners.

## Verification

Run focused tests for the component or hook you changed. For render-sensitive
work, also exercise narrow and wide terminals, tall output, and parallel
approvals or paste input when those paths are affected.
