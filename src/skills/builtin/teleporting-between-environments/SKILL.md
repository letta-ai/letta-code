---
name: teleporting-between-environments
description: Moves the current agent conversation between Cloud and connected computers while coordinating machine-local files and setup. Use when the user says "let's continue this task on cloud", asks to continue or move work on another computer, wants to teleport between environments, or needs to upload or download artifacts before or after a handoff.
---

# Teleporting Between Environments

Teleport the current agent and conversation without losing conversational memory. Prepare machine-local state first, then let the destination continue the same task.

## Mental model

- **Memory follows the agent; filesystem access does not.** Files, working directories, credentials, running processes, and local services belong to the computer currently executing the conversation.
- Upload and download paths are relative to the current computer. Cloud cannot read a laptop path until the conversation teleports to that laptop.
- The conversation’s managed Cloud sandbox remains alive while the conversation runs elsewhere.
- Filesystem paths and cwd do not transfer between computers. Re-establish the destination’s repository, working directory, dependencies, credentials, and services after arrival.

## Commands

```bash
letta teleport list
letta teleport cloud
letta teleport back
letta teleport <environment>
```

- `list`: show accessible online targets.
- `cloud`: create or resume this conversation’s managed Cloud sandbox.
- `back`: return to the remembered previous non-Cloud environment.
- `<environment>`: target a listed environment by its friendly selector.

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

### Retrieve a laptop file while running in Cloud

1. Retain the laptop path and intended Cloud task in context.
2. As the final Cloud action, run:

   ```bash
   letta teleport back
   ```

3. After continuation on the laptop, locate and upload the file:

   ```bash
   letta sandbox upload <local-path>
   ```

4. Retain the returned `/root/downloads/...` path.
5. As the final laptop action, run:

   ```bash
   letta teleport cloud
   ```

### Bring a Cloud artifact to a local computer

1. In Cloud, place the output under `/root/downloads` and retain its sandbox path.
2. As the final Cloud action, run:

   ```bash
   letta teleport back
   ```

3. After continuation locally, download it:

   ```bash
   letta sandbox download <sandbox-path> [--to <local-path>]
   ```

### Continue on another connected computer

1. Discover available targets if needed:

   ```bash
   letta teleport list
   ```

2. Prepare or upload everything the current computer owns.
3. As the final action, run:

   ```bash
   letta teleport <environment>
   ```
