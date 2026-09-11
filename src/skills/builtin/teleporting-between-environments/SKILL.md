---
name: teleporting-between-environments
description: Moves the current conversation between computers or transfers files from a connected computer into a Cloud conversation's sandbox without moving the parent. Use for teleporting, continuing work on another computer, or copying local files to Cloud through a remote subagent.
---

# Teleporting Between Computers

Teleport the current agent and conversation without losing conversational memory. Prepare machine-local state first, then let the destination continue the same task.

## Mental model

- **Memory follows the agent; filesystem access does not.** Files, working directories, credentials, running processes, and local services belong to the computer currently executing the conversation.
- Local file paths belong to the executing computer. To access a laptop file from Cloud, either delegate to an agent on that laptop or teleport there.
- The conversation’s managed Cloud sandbox remains alive while the conversation runs elsewhere.
- Filesystem paths and cwd do not transfer between computers. Re-establish the destination’s repository, working directory, dependencies, credentials, and services after arrival.

## Commands

```bash
letta teleport list
letta teleport cloud
letta teleport local
letta teleport <computer>
```

- `list`: show accessible online Cloud-registered targets.
- `cloud`: create or resume this conversation’s managed Cloud sandbox.
- `local`: target the one online Letta Desktop computer. Desktop Remote Access must be enabled. If several Desktop computers are online, use `list` and target one explicitly.
- `<computer>`: target a listed remote computer by its friendly selector.

Do not run or recommend `letta teleport back`; return to Desktop with `local`.

Transfer files with the existing sandbox commands:

```bash
letta sandbox upload <local-path>
letta sandbox download <sandbox-path> [--to <local-path>]
```

Do not invent `letta teleport push`, `pull`, or remote file-listing commands. No sandbox ID or wake command is needed.

## Prepare the handoff

Before teleporting:

1. Identify the target and every file, repository state, credential, service, or setup step the task needs there.
2. Finish work that requires the current computer. Verify relevant files exist before transferring them.
3. Upload current-computer artifacts needed in Cloud and retain the returned `/root/downloads/...` paths in context.
4. Retain enough context to recreate destination-local setup, including the repository, branch or revision, working directory, dependency commands, and next action.
5. Run teleport only after all source-side preparation is complete.

## Teleport is the final action

Run the teleport command as the only command in the final Bash tool call. Do not chain later commands, poll the teleport operation, or invoke another source-side tool after it.

The CLI intentionally returns after the server accepts the handoff. Once the Bash result is persisted, the source yields at a clean turn or tool boundary and the destination resumes with no synthetic user message.

If the command reports an offline, stale, unsupported, same-source, or startup error, the conversation remains on the source. Surface the concrete error, correct it if possible, and retry only after the target is available.

## Common workflows

### Copy files from another computer while staying here

Run an `Agent` on the source `computer` and give it the destination conversation ID explicitly. Have it upload the file using:

```bash
letta sandbox upload <local-path> --conversation <parent-conversation-id>
# For an agent's main/default conversation:
letta sandbox upload <local-path> --conversation default --agent <parent-agent-id>
```

The command reads the source computer's file and uploads to the specified Cloud sandbox without moving either conversation. It uses the source computer's Letta credentials, which must authorize access to the destination. Return the uploaded path and destination IDs, not base64 or file contents through model messages. Download supports the same target flags. Without flags, both commands keep using the executing conversation.

### Continue local work in Cloud

1. Inspect the local task state and identify local-only artifacts or setup.
2. Upload each artifact Cloud needs:

   ```bash
   letta sandbox upload <local-path>
   ```

3. Retain each returned sandbox path.
4. As the final action, run:

   ```bash
   letta teleport cloud
   ```

5. After continuation in Cloud, establish the Cloud-local cwd and repository setup before using the uploaded paths.

### Return to Desktop Local

1. Retain the next local action and any setup the Desktop computer needs.
2. Confirm Desktop is open with Remote Access enabled. If more than one Desktop computer is online, use `letta teleport list` and choose one explicitly.
3. As the final action, run:

   ```bash
   letta teleport local
   ```

### Run a separate headless turn on a computer

Use `--computer` when a separate headless invocation, rather than the current conversation handoff, should execute on Cloud or another online computer:

```bash
letta -p --conversation <id> --computer cloud "<prompt>"
letta -p --conversation <id> --computer <name|device-id|connection-id> "<prompt>"
```

This routes that headless message only. Use `letta teleport ...` to move the currently executing conversation.

### Continue on another connected computer

1. Discover available targets if needed:

   ```bash
   letta teleport list
   ```

2. Prepare or upload everything the current computer owns.
3. As the final action, run:

   ```bash
   letta teleport <computer>
   ```
