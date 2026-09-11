---
name: working-across-computers
description: Guides work across Cloud, local, and other available computers, including teleporting the current conversation, orchestrating remote subagents, and uploading or downloading files to Cloud sandboxes. Use when moving between computers (e.g. teleporting between cloud/local) or coordinating work and files across them.
---

# Working Across Computers

## Choose where to work

- When running in Cloud, prefer staying there and delegating local work to subagents on the relevant computer.
- If the user explicitly asks to move this conversation locally or elsewhere, teleport it.
- Moving a conversation that started locally into Cloud is a normal workflow: transfer needed files first, then teleport.

| Intent | Mechanism |
|---|---|
| Run work elsewhere while staying here | `Agent` |
| Bring a remote file into a Cloud conversation | Remote agent: `sandbox upload` |
| Put a Cloud file onto another computer | Remote agent: `sandbox download` |
| Continue this conversation elsewhere | `teleport` |

Conversation history and agent memory follow the conversation. Files, working directories, installed tools, credentials, and running services belong to each computer; teleporting does not copy the workspace.

For remote subagents, set `computer` and pass source paths and destination conversation IDs explicitly. Use the `Agent` tool definition for invocation and resume options.

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

With exactly one online Desktop, open with Remote Access enabled, you can use the shortcut:

```bash
letta teleport local
```

## Transfer files to or from Cloud

Run upload where the local file exists; run download where the local copy should be saved.

```bash
# Use the executing conversation's Cloud sandbox
letta sandbox upload <local-path>
letta sandbox download <sandbox-path> --to <local-path>

# Explicit Cloud conversation
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
