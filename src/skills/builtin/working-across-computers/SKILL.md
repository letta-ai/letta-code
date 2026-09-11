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

```bash
letta teleport cloud       # Create or resume this conversation's Cloud sandbox
letta teleport local       # Move to the one online Desktop computer
letta teleport <computer>  # Move to a specific listed computer
```

For `local`, Desktop must be open with Remote Access enabled. If several Desktop computers are online, list them and select one explicitly. The conversation's managed Cloud sandbox remains alive while the conversation runs elsewhere.

### Prepare, then teleport

1. Identify files, repository state, credentials, services, and setup needed at the destination.
2. Finish source-only work. Verify and transfer required files before moving.
3. Retain destination paths, repository/branch/revision, setup requirements, and the next action.
4. Run the teleport command **alone as the final shell tool call**. Do not chain commands, poll it, or run more source-side tools after success.
5. At the destination, re-establish the working directory and verify files, dependencies, credentials, and services before continuing.

For local → Cloud, upload needed local files, retain their returned paths, then run `letta teleport cloud`. For Cloud → local, arrange required downloads on the local computer before handing off.

Teleport returns when the server accepts the handoff. After the tool result is persisted, the source yields and the destination resumes the same conversation without another user message.

If teleport reports an offline, stale, unsupported, same-source, or startup error, the conversation remains on the source. Address the specific error before retrying.

Do not invent `letta teleport back`, `push`, `pull`, or remote file-listing commands. Use `local` or a listed computer to return, and `sandbox upload/download` for files.

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
