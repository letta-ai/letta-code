# Ghostty footer flicker plan

Context: In Ghostty (not iTerm2), the bottom row of the CLI (`Press / for commands`, agent name/model, input divider) occasionally flickers while streaming/thinking. Likely tied to how often `InputRich` rerenders during streaming updates (shimmer/timer/token count).

What to dig into:
- Reproduce in Ghostty vs iTerm2 with a long streaming response; capture frame rate and whether flicker correlates with thinking shimmer or token/elapsed counters.
- Profile `InputRich` renders while streaming: the `setInterval` for shimmer (120ms), elapsed timer (1s), and token count updates from `refreshDerived`/`setTokenCount` might be forcing full re-renders.
- Check Ghostty rendering quirks with frequent writes (e.g., carriage returns vs full-line redraws). Ensure nothing writes ANSI clear/home except the resize handler.
- Confirm whether the bottom footer is part of the same render tree that updates on every shimmer tick. It currently sits inside `InputRich`, so any state change there may redraw the footer.

Likely fix direction:
- Decouple footer from high-frequency state: extract the footer row (prompt, mode hint, agent/model) into a memoized component that only updates when its own props change (not on shimmer/elapsed/token changes). Pass primitive props (modeName/modeColor/etc.) or memoized objects so React.memo actually sticks.
- Memoize/throttle the high-frequency pieces: wrap `ShimmerText` in `memo`, memoize `statusHintText` and `modeInfo` via `useMemo`, and avoid regenerating `horizontalLine` except when columns change.
- Consider fixed-width boxes for footer columns to reduce layout reflow between hint variants; if Ghostty-specific, minimizing attribute churn (`dimColor`, color) might help.
- If the footer ever needs callbacks, ensure they’re `useCallback`-stable before memoizing.

Verification (order: profile → implement → verify):
- Add a temporary `console.count("Footer render")` (or similar) to verify render frequency before/after the decouple.
- Run the CLI in Ghostty with streaming, watch for flicker before/after changes.
- Ensure iTerm2 behavior unchanged; confirm no regressions in footer updates (ctrl-c/escape hints, mode state incl. ralphActive/ralphPending/ralphPendingYolo, agent/model display, bash mode messaging).
