# Interactive terminal

The default interactive entry point mounts `TerminalSessionHost`. It starts the embedded app server and connects the SDK session. An attached terminal uses the same store and renderer with an existing WebSocket endpoint.

`terminal-session.ts` owns the server connection, transcript accumulator, optimistic input, pending approvals, queue and device status. The listener executes turns and tools. `TerminalApp.tsx` renders finalized rows through Ink Static and keeps live rows editable until the next history reconciliation. `TerminalComposer.tsx` retains the draft while a picker, memory viewer or approval owns input focus.
