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
| Run work elsewhere while staying here | `Agent(..., computer: ...)` |
| Bring a remote file into a Cloud conversation | Remote agent runs `letta sandbox upload --conversation ...` |
| Put a Cloud file onto another computer | Remote agent runs `letta sandbox download --conversation ... --to ...` |
| Continue this conversation elsewhere | `letta teleport ...` |

Conversation history and agent memory follow the conversation. Files, working directories, installed tools, credentials, and running services belong to each computer; teleporting does not copy the workspace.

For remote subagents, pass source paths and any destination conversation ID explicitly. The remote computer may have different credentials and installed tools. Use the `Agent` tool definition for invocation and resume options.

## Move this conversation

### Local → Cloud

Upload any files needed in Cloud:

```bash
letta sandbox upload <local-path>
```

Keep the returned paths, repository/branch, and next action in context, then create or resume this conversation's Cloud sandbox:

```bash
letta teleport cloud
```

### Cloud → local or another computer

Have a remote subagent download any needed files first. With Desktop open and Remote Access enabled:

```bash
letta teleport local
```

If several computers are available, choose one from `letta teleport list`:

```bash
letta teleport <computer>
```

**Run teleport alone as the final tool call.** After success, do not poll or run more source-side tools; the same conversation resumes at the destination automatically. Set the working directory and check required setup there. If teleport fails, stay on the source and resolve the error before retrying. The Cloud sandbox remains available while you work elsewhere.

## Discover computers

```bash
letta teleport list
```

This lists accessible online Cloud-registered computers. Use a returned computer name, device ID, or connection ID rather than guessing.

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
letta sandbox upload <local-path> --conversation default --agent <agent-id>
letta sandbox download <sandbox-path> \
  --conversation default --agent <agent-id> --to <local-path>
```

- Concrete conversation IDs resolve their owning agent. `default` requires explicit `--agent`.
- Target flags override the executing session without changing its identity. Do not replace the subagent's identity environment variables with the parent's.
- The executing computer's credentials must authorize access to the target.
- Commands return JSON. Upload returns the stored `/root/downloads/...` path; downloads are limited to that directory. Without `--to`, download saves under the remote file's basename.
- Transfer files directly, not as base64 or file contents through model messages. Return the path and destination IDs; verify received contents or checksums.
- These commands transfer files to/from Cloud sandboxes, not arbitrary remote filesystems. No sandbox ID or separate wake command is needed.

For example, to get a laptop file while staying in Cloud, send an Agent to the laptop with instructions to upload using the parent's conversation ID. Read the returned path in the parent's sandbox.
