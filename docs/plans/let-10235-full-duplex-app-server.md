# LET-10235: Full-duplex multi-client app-server

## Decision

Each logical app-server client owns one bidirectional WebSocket. Commands,
correlated responses, status snapshots, approval traffic, external tool calls,
and stream deltas all use that socket. Multiple independent sockets can remain
connected to the same app-server process.

Conversation ownership is explicit and exclusive. A successful
`runtime_start` claims its `{agent_id, conversation_id}` scope for that
connection. A second connection receives a failure instead of replacing the
owner. Disconnect releases only that connection's scopes; process services and
other clients remain alive.

This deliberately does not infer reconnect generations. A future same-client
handoff must carry an authenticated, explicit client/generation identity before
it may supersede an older connection.

## Ownership model

| Lifetime | State |
| --- | --- |
| Process | Settings, backend selection, tool registry, mod adapter, telemetry, cron scheduler, channel registry/ingress, message-queue bridge, HTTP/OpenAI surface, authentication policy |
| Connection | WebSocket, generated connection ID, request/response destination, per-socket outbound queue and `event_seq`, claimed scopes, file-command session, external-tool controller calls, heartbeat timestamp |
| Conversation | `TurnLifecycle`, serialized message queue, pending approvals, permission mode, CWD/worktree watcher, reminders/context, active run, explicit connection owner |

`activeRuntime` remains a process singleton because the services that consult
it are process singletons. It is created once for the app-server and is no
longer replaced when a client connects. Connection-specific state is captured
by the connection router and queued-turn delivery context rather than hidden in
`activeRuntime.socket`.

## Routing and cleanup invariants

- Direct command responses are written to the socket that supplied the
  command. Equal `request_id` values on different sockets are independent.
- Background producers write to a process transport. It resolves the runtime
  scope to exactly one owning connection and applies that socket's bounded
  outbound queue.
- Delivered `event_seq` values are contiguous per connection, not shared
  process-wide.
- Queued turns retain their submitting connection. Queue coalescing never
  merges items with different delivery owners.
- Approval and other scoped commands from a non-owner fail without touching
  the owner.
- External tools are registered with a runtime key and controller socket. A
  result from another socket cannot resolve the pending call.
- Disconnect rejects only that connection's external-tool calls and approvals,
  invalidates its conversation lifecycle leases, clears its queues, and stops
  its worktree watchers. Stale async work therefore cannot emit into a later
  owner.
- Heartbeat time and reaping are tracked per socket. A stale socket is
  terminated without stopping the process runtime or healthy peers.
- Server shutdown closes every connection, then stops scheduler, channels,
  external tools, watchers, and the single process runtime.

## Compatibility and rollout

Protocol version 2 advertises `capabilities.full_duplex: true`.

The bundled client defaults to `transportMode: "auto"`:

1. Open the released `channel=control` URL.
2. Request `app_server_info` with a bounded negotiation timeout.
3. If `full_duplex` is true, keep that one socket.
4. If the capability is absent, invalid, or times out, open the released
   `channel=stream` companion and retain split-channel behavior.

The server accepts `channel=duplex`, an omitted channel, and the released
`channel=control` spelling as full-duplex connections. A released client's
`channel=stream` socket is an inert compatibility companion. It is never paired
to a control socket by timing or arrival order; all frames are delivered on the
released client's control socket, which its shared `AppServerClient` already
observes. This makes interleaved legacy reconnects fail safe instead of
cross-wiring clients.

Roll out the server before republishing consumers with the protocol-v2
`AppServerClient`. New clients fall back against old servers. Old SDK clients
remain usable against new servers. Keep the legacy stream endpoint and SDK
management handoff until the oldest supported app-server release includes
protocol v2; then remove the split fallback, inert endpoint, and single-control
pooling together.

## Consumer audit

- `letta-code/src/app-server-client.ts`: owns capability negotiation and the
  one-socket/split fallback.
- `letta-agent-sdk/src/app-server-session.ts` and
  `src/app-server-management.ts`: use the shared client and adopt full duplex
  when their `@letta-ai/letta-code` dependency is advanced.
- `letta-agent-sdk/src/local-app-server.ts`: only owns child-process startup;
  the returned base URL continues to work unchanged.
- `letta-agent-sdk/src/cloud-session.ts`: its cloud status relay is a distinct
  split-channel protocol and explicitly stays in split mode.
- Desktop's `apps/code-desktop/electron/src/listenerManager.ts`,
  `cloudListenerManager.ts`, and `environmentServer.ts` manage outbound listener
  and cloud relay protocols, not the local app-server WebSocket. No Desktop
  protocol change is required.
- The OpenAI-compatible HTTP bridge shares the process runtime, initializes it
  before chat turns, and observes turn lifecycle directly. It does not acquire
  a WebSocket connection.

## Codex reference audit

Audited `openai/codex` main at
`95637f7056835fea66bdd0044414af480fc0fd74`, especially
`codex-rs/app-server-transport/src/transport/websocket.rs` and its WebSocket
connection tests.

Invariants carried over:

- the acceptor assigns a connection ID;
- each connection owns its writer queue and cancellation;
- inbound events retain connection identity;
- open/close are explicit lifecycle events;
- initialization is once per connection;
- request IDs and notifications route through connection identity;
- close removes connection-owned requests, processes, threads, subscriptions,
  and filesystem resources.

Intentional differences:

- Letta has process-global scheduler/channel/tool services, so it uses one
  process runtime plus a connection router instead of one independent
  app-server state object per socket;
- Letta conversation work is serialized by `TurnLifecycle` and an explicit
  runtime-scope owner;
- Letta retains a bounded, capability-negotiated adapter for released
  split-channel clients.

## Regression matrix

Focused tests cover:

1. two clients initializing different runtimes concurrently;
2. identical request IDs on different connections;
3. management traffic while another client submits a foreground turn;
4. runtime frames, external-tool results, and scoped commands staying with
   their owner;
5. client A disconnecting while client B continues;
6. heartbeat reaping A while B remains healthy;
7. unchanged auth/origin policy;
8. interleaved legacy stream/control connections without pairing;
9. server shutdown and connection-owned cleanup;
10. client negotiation, OpenAI bridge, local backend, backpressure, queue, and
    existing listener regression suites.
