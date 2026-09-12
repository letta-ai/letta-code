# Investigating behavior

Identify the target incident from the user's symptom, conversation/message
reference, or time window. For a general health check, start with a bounded
sample of the current agent's recent history across conversations.

1. **Locate the incident.** Use the supplied symptom or message reference, or
   findings from the general health check. Look for user corrections,
   repeated failed attempts, unsupported success claims, or excessive context.
   Start with the identified incident conversation. Search other conversations
   of the same agent when a hypothesis calls for it. Include a successful example
   when one exists; do not select only failures and claim the pattern is universal.
2. **Expand around the failure.** Read the request, relevant preceding messages,
   tool arguments and results, the correction, and the eventual outcome. Use
   canonical message, step, and tool-call IDs when available. Never correlate by
   finding a conversation ID quoted inside historical prompt text.
3. **Follow the evidence.** Form a specific hypothesis and retrieve the next
   record needed to test it. Inspect relevant memory and skill files and their
   Git history. Separate what was stored, what was retrieved, what reached the
   model, what it requested, and what the tool actually did.
4. **Identify the responsible component.** The cause may be stale memory,
   conflicting instructions, failed retrieval, a skill, channel input, tool
   execution, authentication, compaction, or model configuration. Do not add a
   behavioral instruction to compensate for missing input or a harness bug.

## Available evidence

### Conversation evidence for both backends

Message listing, search, and transcript export work with both backends. Replace
`BACKEND` in the examples with `local` or `api` for the target agent. The launch
message identifies the current agent's backend; verify it for a different target.
Keep the target's configured local storage or API endpoint. Where the investigator
runs does not determine which backend holds the incident.

Replace the example IDs below with the **target** IDs identified for the incident.
Save command output to the chosen scratch location using the host's available
capabilities, then parse the JSON into a compact inventory:

```text
letta --backend BACKEND messages list --agent agent-TARGET --conversation conv-TARGET --limit 30 --include-errors
```

Start with a compact inventory, then inspect the messages relevant to the
hypothesis. Include timestamps, canonical IDs, types, tool names, and short text
previews as needed. Message content may be a string or an array of typed parts:
extract text parts explicitly before applying string operations. A message may
also contain multiple tool calls or returns; inspect the relevant entry rather
than assuming the first one is the whole step. Keep base64 images, signatures,
and unrelated skill bodies out of inventories; inspect those artifacts only if
the hypothesis requires them.

Use a supplied message reference or a scoped search to reach an older incident
directly. Choose the next bounded read to test the hypothesis, for example:

```text
letta --backend BACKEND messages search --agent agent-TARGET --conversation conv-TARGET --query "distinctive correction" --limit 5
letta --backend BACKEND messages list --agent agent-TARGET --conversation conv-TARGET --before message-ID --limit 10 --include-errors
letta --backend BACKEND messages list --agent agent-TARGET --conversation conv-TARGET --after message-ID --order asc --limit 10 --include-errors
```

Project these saved results into a compact view, then read selected full text or
tool fields. Avoid dumping raw JSON into the model context or fetching a large
list and a transcript export of the same span together. If output is clipped,
filter the saved result instead of increasing the output limit or refetching it.
Use `letta --backend BACKEND messages transcript` when a longer sequence is
needed; save its output to scratch and select the relevant span. Stop collecting
when the causal chain and its remaining uncertainty are clear.

A default conversation uses `--conversation default --agent agent-TARGET`.
Search can be scoped with `--conversation`, `--start-date`, and `--end-date`.
For full exports, check `truncated`; fetch more pages only if needed. Listing
returns one page, not a completeness guarantee. Date filters on listing apply
only to that fetched page. Preserve IDs by using `messages list` when expanding
or correlating records; a formatted transcript is a reading aid.

### Client records on either backend

Client records, when accessible, live under the supplied transcript root at
`<target-agent-id>/<target-conversation-id>/transcript.jsonl`.
They can include text, tool arguments/results, errors, and source message IDs.
They are host-local and may omit failed/interrupted turns or conversations run
elsewhere. Read raw records instead of reflection payloads, which truncate tool
arguments. Missing client records are not evidence of successful execution.

### Local backend records

For local agents, start with the same message commands using `--backend local`.
Search matches text rather than embeddings; use distinctive wording from the
incident. These commands read the configured local store without a Letta API
request. If that store is on another host and unavailable, report the gap.

When the hypothesis needs raw messages, compaction history, or provider metadata,
locate the active local backend storage, respecting `LETTA_LOCAL_BACKEND_DIR`
if configured. Under `conversations/`, match the agent and conversation IDs in
`conversation.json` rather than guessing the directory name. In that directory,
`manifest.json` describes the transcript format and `messages.jsonl` holds message
and compaction entries. This is separate from the client transcript root above.
Inspect only the relevant conversation.
Use message/tool-call IDs to correlate records; append-only snapshots of the same
message do not establish repeated execution. Inspect compaction summaries and
retained-message boundaries when testing lost-context hypotheses, and recorded
provider/model/usage metadata when testing configuration or context-size issues.

`steps trace` does not record or retrieve local provider requests; it reports
unsupported. A local investigation can still establish memory, tool, storage,
or compaction defects from these records. Do not invent a historical request.

### API provider traces

For API-backed agents, when a message provides a step ID:

```text
letta --backend api steps trace --agent agent-TARGET --step step-ID
```

This uses normal Letta API access to retrieve step metadata and any available
provider trace. Inspect the actual request and response when present. An
unavailable trace is a limitation, not a clean bill of health; continue with
the other evidence relevant to the hypothesis.

### Historical context limits

The current memory files are not necessarily what a past request contained.
Use existing captured requests, compiled prompts, and memory revisions when
available. Otherwise label historical prompt claims as uncertain. Tokens from
`letta memory tokens --memory-dir <path> --format json --quiet` are estimates of
core memory, not the full historical provider input.

Prompt and cached-token counts establish size and cache usage, not which messages
or instructions were present. Shared conversation history can support an
inference about context reuse; it does not prove the exact input to a historical
step. Preserve that qualification in the finding and impact summary, even after
other evidence establishes the routing or storage behavior.

Current source can explain a plausible mechanism. Establish the incident's
deployed version and runtime path before claiming that implementation caused it.
A proposed routing policy or other product change remains a candidate fix until
its behavior is reproduced and verified; identify policy choices separately.

## Worked examples

- **Confusing people:** Inspect whether a referenced person's stable ID and name
  appeared together in the received message. A current-sender name does not
  resolve every person mentioned. If the mapping was absent, identify the
  ingestion problem; do not blame memory retrieval without evidence.
- **Large Slack bootstrap:** Count the historical messages and their sizes in
  the received context. Two long daily reports among 20 recent messages can
  dominate an input. Check selection and size limits before trimming persona.
- **Apparently duplicated sends:** Match tool calls, approvals, results, and
  external message IDs. The same body in several transcript records can still
  represent one external send. Without delivery evidence, report uncertainty.
- **Repeated auth failures:** Distinguish malformed arguments from an actual
  authentication rejection. Never record a credential as a memory fix.

## Verify a proposed fix

Recheck the original failure against the proposed change and a successful control
where possible. For a harness/integration bug, provide a small reproduction and
the evidence needed by its owner. Do not claim a fix was applied because you
recommended it.
