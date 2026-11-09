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

## Known Gotchas

- **`*Rich.tsx` naming inversion.** The `*Rich.tsx` files are the ACTIVE
  components, not the plain-named siblings. `App.tsx` imports Rich files and
  renames them on import. The non-Rich files were dead stubs. When auditing a
  `*Rich` file, check `App.tsx` imports first.
- **CLI glyph registry.** `src/cli/helpers/glyphs.ts` is the central registry
  for display glyphs. All components import from there.
- **Threading state through app subsystems.** When adding state that crosses
  subsystem boundaries, update ALL context types: `ConversationLoopContext`,
  `SubmitHandlerContext`, `ConversationSwitchingContext`. Missing one causes
  type error (missing definition) or runtime undefined (missing
  destructuring/prop-passing).

## Code Review Signals

### TUI Flicker (most common bug)

App.tsx has ~54 `useEffect` calls and spread state. Adding any `useState` or
`useReducer` that updates on keystroke, timer tick, or streaming chunk triggers
re-renders across the entire component tree.

- **Do:** Use refs for values that don't need to trigger renders. Use
  `React.memo()` for static content. Keep state minimal.
- **Don't:** Add `useState`/`useReducer` for UI features that update on every
  keystroke, timer tick, or streaming chunk.
- **Debug:** `LETTA_DEBUG_FLICKER=1` logs re-render triggers to file.
- **Review signal:** any PR adding state to App.tsx, modifying `useEffect` deps,
  or touching approval/rendering components.

### Ink `<Static>` and Double-Printing

Ink's `<Static>` writes to stdout and never erases. Changing the component key
re-mounts and re-renders all items, but previously rendered items persist on
screen, causing duplicate/triple output.

- Do not change the `<Static>` key unless items are already empty.
- Do not render the same output through both buffers (`commandRunner`) and
  `setStaticItems`.
- The accepted exception is an intentional transcript repaint on a display
  toggle (PR #4032): clear the screen first (`CLEAR_SCREEN_AND_HOME`), or use
  vendored Ink's atomic `repaintStaticOutput`. A key change without a preceding
  clear is a double-print risk.

### Interrupt Lock / State Cleanup

`EAGER_CANCEL` path and non-EAGER fallback BOTH need to clear ALL state flags
(`isExecutingTool`, `abortControllerRef`, `toolResultsInFlightRef`). Missing
one = permanently busy.

- **Review signal:** interrupt handling, ESC key, tool execution cleanup paths.
