# Letta Daemon guide

`apps/daemon` is a main-process-only Electron tray application. Keep it small:
it supervises the bundled Letta Code remote listener and lets the user name the
computer. It is not a second Desktop application.

## Ownership

- Electron main owns the tray, settings window, updater, and listener child.
- Letta Code owns authentication, remote registration, turns, tools, and logs.
- Consume the listener's versioned host protocol. Never parse human log text to
  infer readiness or activity.
- Spawn the exact packaged `@letta-ai/letta-code` entrypoint, never whichever
  `letta` happens to be on `PATH`.

## Security

- Keep `nodeIntegration` disabled and `contextIsolation` enabled.
- Expose only narrow, validated IPC methods from preload.
- Do not store API keys, refresh tokens, or other credentials in daemon
  settings. The existing Letta Code authentication layer owns credentials.
- The daemon uses the outbound authenticated remote-computer connection. It
  must not open a public inbound listener.

## Validation

- Run `bun run check` from this directory.
- Run the packaged application, not only the source build, before release.
- Exercise environment rename, listener restart, unexpected child exit,
  single-instance behavior, and graceful quit on every supported platform.
