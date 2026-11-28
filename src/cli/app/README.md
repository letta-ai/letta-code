# CLI App Layout

`src/cli/App.tsx` is the public entrypoint. The interactive TUI is a client of
the App Server runtime; it does not run turns, tools, or approvals itself.

- `src/cli/app-server-tui/App.tsx`: startup states and session lifecycle
  (embedded or attached App Server, agent and conversation switching).
- `src/cli/app-server-tui/TuiRoot.tsx`: Ink tree: transcript, approvals,
  composer, and picker overlays.
- `src/cli/app-server-tui/session-store.ts`: renderer-agnostic client state
  (transcript rows, current-turn buffer, run phase, queue, approvals).
- `src/cli/app-server-tui/command-router.ts`: slash command routing to the
  runtime, session RPCs, or overlays.
- `src/cli/app-server-tui/session-host.ts`,
  `embedded-app-server.ts`: loopback App Server and `--connect` / `--register`.
- `constants.ts`, `types.ts` in this directory: shared constants and app props.
