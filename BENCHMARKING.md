# Benchmarking Letta memory on existing data

How to measure what Letta learns from existing conversation data. The data can
be coding-agent sessions, chat logs, or a benchmark dataset. You convert it to
the [trajectory](https://github.com/letta-ai/trajectory) format, import it into
a fresh local agent, and let the agent build memory from it. Then you test the
agent against a baseline.

The pipeline has two steps:

1. **Convert** your data to trajectory-v1 session files.
2. **Import** the folder into a blank local agent with `letta import`. Import
   stores every session as a conversation, then runs a memory-initialization
   turn that analyzes the history with a dynamic Workflow and commits the
   resulting memory.

## Setup

Use a scratch local-backend directory so the run doesn't touch your real
`~/.letta/lc-local-backend` state:

```bash
export LETTA_LOCAL_BACKEND_DIR=$(mktemp -d /tmp/letta-bench-XXXX)
export TRAJ_DIR=$(mktemp -d /tmp/letta-traj-XXXX)
```

From a checkout, use `bun run dev` wherever this guide says `letta`. Each run is
disposable. To start over, delete `$LETTA_LOCAL_BACKEND_DIR`; don't reset it in
place.

## 1. Convert data to trajectory format

Each session becomes one JSON file containing an array of trajectory-v1
records. The first record is a `meta` record, and the rest are conversational
records in order:

```json
[
  { "role": "meta", "source": "my-dataset" },
  { "role": "user", "content": "I just moved to Lisbon.", "timestamp": "2024-03-01T10:00:00.000Z" },
  { "role": "assistant", "content": "How are you settling in?", "timestamp": "2024-03-01T10:00:05.000Z" }
]
```

The `meta` record needs `source`; `cwd`, `git_branch`, and `model` are optional.
Every other record needs an ISO `timestamp`. Assistant tool calls use
`tool_calls: [{ id, name, args }]`, where `args` is a JSON-object string, and
each call must be answered by a `tool` record with the matching `tool_call_id`.
The full contract is
[`schema/trajectory-v1.schema.json`](https://github.com/letta-ai/trajectory/blob/main/schema/trajectory-v1.schema.json).
Use `user`, `assistant`, `reasoning`, and `tool` records. Import has no mapping
for `system` or `observation` records and stores them as assistant text.

Lay the files out one directory per source:

```
$TRAJ_DIR/
  my-dataset/
    session-001.json
    session-002.json
```

The folder may contain only `.json` session files and, optionally, a
`manifest.json`. Symlinks and other files are rejected.

Pick the conversion path that matches your data.

**Coding-agent sessions on this machine** (Claude Code, Codex, and others). Let
Letta export them. This also writes a `manifest.json`:

```bash
letta trajectories detect                      # sessions available per source
letta trajectories export --out "$TRAJ_DIR" --source claude-code --project /path/to/repo
```

Use `--transcript <source>:<path>` to export a transcript file copied from
another machine. Before you import, check that the `errors` array in
`manifest.json` is empty; import refuses a manifest with errors.

**Native transcripts from a supported harness** (see the
[supported sources](https://github.com/letta-ai/trajectory#supported-sources)).
Normalize them with the library:

```ts
import { normalizeTranscript } from "@letta-ai/trajectory";

const { records, diagnostics } = normalizeTranscript({ source: "codex", transcript: rawJsonl });
await Bun.write(`${TRAJ_DIR}/codex/${sessionId}.json`, JSON.stringify(records));
```

**Any other data** (chat logs, benchmark conversations). Write the records
yourself and validate each file:

```ts
import { validateTranscript } from "@letta-ai/trajectory";

validateTranscript(records); // throws on an invalid trajectory
```

For multi-session benchmarks, write one file per session and use real or
synthetic timestamps that keep the sessions in chronological order. The memory
pass relies on that order to resolve facts that change over time.

**Hold out your evaluation data.** Decide the test questions or tasks before
converting, and leave out anything that contains their answers verbatim. The
goal is to measure what memory retains and generalizes from the history, not
whether the agent can read the answer key.

## 2. Create a blank agent

```bash
AGENT_ID=$(letta --backend local agents create --personality blank --name bench-01 \
  --model openai/gpt-5.5 \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
```

Choose the model here. Import has no model option, so the memory-initialization
turn uses the agent's model, and its Workflow workers use the same model unless
the Workflow is given one explicitly. The provider must have credentials in the
scratch backend, such as `OPENAI_API_KEY` in the environment. `/model` in a later
session changes only that conversation's model, not the agent's.

A new agent starts with boilerplate memory files, so snapshot its memory
repository before importing:

```bash
MEMORY_DIR="$LETTA_LOCAL_BACKEND_DIR/memfs/$AGENT_ID/memory"
git -C "$MEMORY_DIR" rev-parse HEAD > "$LETTA_LOCAL_BACKEND_DIR/pre-import-rev"
```

## 3. Import

```bash
cd "$(mktemp -d)"
letta --backend local import "$TRAJ_DIR" --agent "$AGENT_ID"
```

Run import from an empty directory. The initialization turn also looks at the
current working directory, so running it inside a repository mixes notes about
that repository into the agent's memory.

Import does the following:

1. Validates every session file before writing anything, with or without a
   manifest.
2. Creates one out-of-context conversation per session and prints a JSON
   summary that maps each session to its conversation ID.
3. Starts a headless memory-initialization turn. The agent groups the sessions
   into cohorts, launches a dynamic Workflow of read-only workers to analyze
   them, reads the Workflow results, and writes and commits memory. If some
   sessions were not covered, it launches follow-up Workflows.

The command exits 0 only if all of these are true:

- A Workflow ran and succeeded.
- The workers' `sessionsRead` reports cover every session.
- Memory has a new commit with a non-empty `MEMORY.md`.
- The memory repository has no uncommitted changes.

If a Workflow fails or never starts, the command exits non-zero instead of
falling back to a serial pass. The run waits at most 30 minutes.

Import once per agent. A second import into the same agent is refused, so to
retry after a failure, create a new blank agent and import again.

## 4. Inspect the memory

```bash
git -C "$MEMORY_DIR" diff --stat "$(cat "$LETTA_LOCAL_BACKEND_DIR/pre-import-rev")" HEAD
git -C "$MEMORY_DIR" log --stat
letta --backend local memory tokens --memory-dir "$MEMORY_DIR"
```

To read an imported session as the agent stored it, use a conversation ID from
the import summary:

```bash
letta --backend local messages transcript --agent "$AGENT_ID" --conversation <conversation-id>
```

File counts and token sizes measure volume, not quality. Read the memory files,
check a sample of facts against the source sessions, and look for things that
are wrong, stale, or too generic to be useful.

## 5. Evaluate against a baseline

Run the same held-out questions or tasks against two agents: the imported agent
and a blank agent created the same way, with the same `--model`, but never
imported. Keep everything else
the same: model, tools, permissions, prompts and their order, repository commit
for coding tasks, and a fresh conversation per question on both agents.

```bash
letta --backend local -p --agent "$AGENT_ID" --new "<question>"
```

Score each item with an objective check wherever you can. For recall questions,
use exact match or a fixed rubric. For coding tasks, use tests that pass, a
build that succeeds, or expected behavior.

Record the following:

| Field | Notes |
| --- | --- |
| Pass / fail or score | Per item, per agent |
| Token cost | Memory adds context to every turn |
| Turns and wall-clock | Per item |
| Memory size | From step 4 |

Report the score difference together with the cost difference. Keep a
description of the corpus with the results: its sources, number of sessions and
records, and how it was converted. Across runs, change one corpus dimension at a
time.
