# TUI guidance

The Ink rules below apply to `app/`, `components/`, and interactive
input/rendering helpers under `src/cli/`. They do not apply to `commands/` or
`subcommands/` unless a file renders Ink. Read `app/README.md` for the current
ownership map before choosing a file to change, and put behavior in the focused
hook or helper that owns it.

## Ink rendering

- `react-dom` is not installed and Ink does not use it.
- Ink runs in legacy React mode. Updates after an `await` are not automatically
  batched, so apply related state updates before the first await when they should
  paint together.
- Items emitted through Ink's `<Static>` do not re-render. Commit an item only
  after its displayed content is complete, and keep its key stable. Change the
  `Static` render key only for an intentional full transcript repaint.
- One transcript item may be live or static, never both. Filter committed IDs
  out of the live list before rendering to avoid duplicate output.
- Keep frequently changing state out of tall transcript components. Memoize
  stable bodies and isolate the small interactive part when typing, timers, or
  stream chunks would otherwise repaint the full component.
- Primitive values rendered directly under an Ink `<Box>` need a `<Text>`
  wrapper.

## Approvals and input

- Route every tool approval through `ApprovalSwitch`; do not add a second
  tool-specific approval branch in the transcript.
- Show one current approval. Other parallel approvals remain compact pending or
  decided stubs until they become current.
- Once the app is ready, keep the input component mounted while approvals or
  overlays disable or collapse it. Use its visibility and enabled props so draft
  text and terminal state survive the transition.
- Use the vendored Ink input path for bracketed paste support.
- Ink input handlers stack. Assign each key to one active surface and guard
  handlers when an overlay, approval, or input mode owns that key.
- Kitty keyboard release events must not trigger an action a second time.

## Verification

Run focused tests for the component or hook you changed. For render-sensitive
work, also exercise the TUI with narrow and wide terminals, tall output, and
parallel approvals when applicable. `LETTA_DEBUG_FLICKER=1` enables extra repaint
diagnostics while tracing terminal churn.
