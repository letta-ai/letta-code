---
name: working-across-computers
description: Guides work across Cloud, local, and other available computers, including teleporting conversations, running remote subagents, transferring files, and publishing an app from a managed Cloud sandbox. Load when a request needs the user's laptop or another machine's files, apps, or tools; when connecting a computer; when exposing an app running in a managed sandbox at a public URL; or when moving or delegating work between local and Cloud in either direction, including running Cloud subagents from local.
---

# Working Across Computers

## Discover access before declaring a limitation

The current filesystem is not the full set of computers you can use. When a request needs another computer, run `letta teleport list`. If a suitable computer is available, delegate there; otherwise follow the [connection instructions](references/connect-a-computer-for-remote-access.md). Do not infer that another computer is inaccessible merely because you are running in Cloud.

## Choose where to work

- When running in Cloud, prefer staying there and delegating local work to subagents on the relevant computer.
- If the user explicitly asks to move this conversation locally or elsewhere, teleport it.
- Moving a conversation that started locally into Cloud is a normal workflow: transfer needed files first, then teleport.

| Intent | Mechanism |
|---|---|
| Run work elsewhere while staying here | `Agent` |
| Bring a remote file into a Cloud conversation | Remote agent: `sandbox upload` |
| Put a Cloud file onto another computer | Remote agent: `sandbox download` |
| Publish an app running in this managed Cloud sandbox | `sandbox expose` |
| Continue this conversation elsewhere | `teleport` |

Conversation history and agent memory follow the conversation. Files, working directories, installed tools, credentials, and running services belong to each computer; teleporting does not copy the workspace.

For remote subagents, set `computer` and pass source paths and destination conversation IDs explicitly. Use the `Agent` tool definition for invocation and resume options.

If the user wants to connect a new computer, `letta teleport list` has no suitable target, or the requested local machine is missing or unreachable, read [Connect a computer for remote access](references/connect-a-computer-for-remote-access.md).

## Keep active Monitors on their computer

A Monitor belongs to the computer where it started. While this conversation has an active Monitor, use a subagent on the requested computer instead of teleporting the parent conversation. If the user explicitly insists on moving the parent conversation, explain that they must stop the Monitor before teleporting the parent conversation; do not retry teleport while the Monitor remains active.

## Move this conversation

**Run the teleport handoff alone as the final tool call.** After success, do not poll or run more source-side tools; the same conversation resumes at the destination automatically. Set the working directory and check required setup there. If teleport fails, stay on the source and resolve the error before retrying. The Cloud sandbox remains available while you work elsewhere.

### Local → Cloud

Upload any files needed in Cloud:

```bash
letta sandbox upload <local-path>
```

Keep the returned paths, repository/branch, and next action in context, then create or resume this conversation's Cloud sandbox:

```bash
letta teleport cloud
```

### Cloud → other computers

List available computers:

```bash
letta teleport list
```

Have a remote subagent download any needed files and verify completion before moving. Use a returned computer name, device ID, or connection ID:

```bash
letta teleport <computer>
```

## Transfer files to or from Cloud

Run upload where the local file exists; run download where the local copy should be saved.

```bash
# Use the executing conversation's Cloud sandbox
letta sandbox upload <local-path>
letta sandbox download <sandbox-path> --to <local-path>

# Explicit Cloud conversation (sandboxes are per-conversation)
letta sandbox upload <local-path> --conversation <destination-conversation-id>
letta sandbox download <sandbox-path> \
  --conversation <source-conversation-id> --to <local-path>

# An agent's main/default conversation
letta sandbox upload <local-path> --agent <agent-id>
letta sandbox download <sandbox-path> --agent <agent-id> --to <local-path>
```

- `--agent` alone selects that agent's main/default conversation. Concrete `--conversation` IDs resolve their owning agent.
- Target flags override the executing session without changing its identity. Do not replace the subagent's identity environment variables with the parent's.
- The executing computer's credentials must authorize access to the target.
- Commands return JSON. Use the exact upload path returned; never reconstruct it from the filename.
- Download sources must be under `/root/downloads`; `--to` selects the destination path on the receiving computer. Without `--to`, download saves under the source file's basename.
- Transfer files directly, not as base64 or file contents through model messages. Return the path and destination IDs; verify received contents or checksums.
- These commands transfer files to/from Cloud sandboxes, not arbitrary remote filesystems. No sandbox ID or separate wake command is needed.

## Publish an app from a managed Cloud sandbox

After starting an HTTP, WebSocket, or SSE app on a sandbox port, expose it at a private Letta URL:

```bash
letta sandbox expose <port> --expires-in <duration>
```

Choose the lifetime explicitly with a whole-second, minute, or hour duration such as `30m`, `2h`, or `24h`. The supported range is 1 minute through 24 hours; there is no implicit default. This command works only inside the managed Cloud sandbox that owns the app. It does not accept `--agent` or `--conversation`; run it in the same sandbox as the service. The JSON result contains `{ url, port, expiresAt, private: true }`. Only signed-in members of the owning organization can open a private exposure. The legacy `--private` flag is accepted as a no-op, so omitting it is preferred.

Use `--public` only when the requester explicitly wants anyone holding the URL to have access:

```bash
letta sandbox expose <port> --public --expires-in <duration>
```

Public exposure URLs are bearer capabilities until `expiresAt`; share them only where requested. Never add `--public` merely to avoid a sign-in requirement.

An exposed app only works while its sandbox is running. The sandbox sleeps after it has been idle for a while, and the app's server process does not survive a restart.
Treat exposed apps as temporary demos. Anything meant to stay up goes on Vercel.

To add time to the same URL and port, extend the active exposure before it expires:

```bash
letta sandbox expose <port> --extend-by <duration>
```

Extension adds to the current deadline, preserves the bearer URL, and fails if there is no active exposure or the port changed. The resulting remaining lifetime cannot exceed 24 hours. Use `--expires-in` instead when intentionally resetting the remaining lifetime from now; never pass both expiry flags.

## Share a live view of a Cloud sandbox desktop

When someone outside chat (Slack, email, a teammate) needs to watch or drive the sandbox desktop, mint a viewer link:

```bash
letta sandbox desktop-link                          # this conversation's sandbox
letta sandbox desktop-link --conversation <conv-id> # another Cloud conversation
```

It prints `{ url, expiresAt }`. The URL opens the desktop in a browser tab with no sign-in. Anyone holding it can view and control the desktop until `expiresAt` (about one hour), so hand it to the person who asked, in a private message or thread, and say when it expires. Mint a new one if it lapses. The sandbox must be a ready Linux VM with desktop support; the command reports the server's error otherwise.
