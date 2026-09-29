# Benchmarking trajectory import on the local backend

Take real coding-agent history (Claude Code, Codex, and the other harnesses the
trajectory package supports), load it into a fresh local agent, and measure
whether that history makes the agent better at real tasks.

Export transcripts, create a blank local agent, import, inspect, then evaluate
against a baseline.

## Setup

Point the local backend at a scratch directory. Otherwise a run reads and
mutates your real `~/.letta/lc-local-backend` agents, auth, and transcripts.

```bash
export LETTA_LOCAL_BACKEND_DIR=/tmp/letta-bench-$(date +%s)
export LETTA_TRAJ_DIR=/tmp/letta-trajectories-bench
```

`--backend local` is a one-off override and does not change your saved default.
From a checkout, substitute `bun run dev` for `letta`. A run is disposable —
delete `$LETTA_LOCAL_BACKEND_DIR` and start over rather than resetting in place.

## 1. Export transcripts to trajectory-v1

```bash
letta trajectories detect
```

One line per source with a session count, e.g. `claude-code: 212 session(s)`.

Export — keep the first corpus small, one source and one project:

```bash
letta trajectories export \
  --out "$LETTA_TRAJ_DIR" \
  --source claude-code \
  --project /path/to/the/repo
```

| Flag | Effect |
| --- | --- |
| `--source <name>` | Repeatable; omit to export every supported source |
| `--project <path>` | Keep only sessions whose recorded cwd starts with this path |
| `--transcript <source>:<path>` | Normalize a specific file, e.g. one copied from another machine |
| `--json` | Emit the manifest on stdout instead of progress lines |

You get `$LETTA_TRAJ_DIR/manifest.json` plus one file per session under
`<source>/<startedAt>_<sessionId>.json`. Each session file is a JSON array of
trajectory-v1 records: a `meta` record (source, cwd, git branch, model) followed
by `user`, `assistant`, `reasoning`, and `tool` records. The manifest indexes
every session with its `sessionId`, per-role counts, and first user prompt.
Skim before importing:

```bash
letta trajectories list --out "$LETTA_TRAJ_DIR"
letta trajectories view <sessionId> --out "$LETTA_TRAJ_DIR" --tools
```

Check the `errors` array in `manifest.json` — sessions that fail to normalize
are absent from the corpus, so a source that exported 4 of 200 sessions makes
the rest of the run meaningless. `export` replaces a directory it previously
wrote and refuses a non-empty directory it did not create, so give each corpus
its own `--out`.

**Hold tasks out here.** Decide your evaluation tasks before exporting and scope
`--project` and `--source` so the sessions that solved those tasks stay out of
the corpus. Importing history that contains the answers measures recall, not
capability.

## 2. Create a blank local agent

```bash
AGENT_ID=$(letta --backend local agents create --personality blank --name bench-01 \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
```

`--personality blank` avoids a preselected persona; it does not leave memory
empty. A new agent still starts with boilerplate `MEMORY.md`, `persona.md`, and
`human.md`. Memory lives at `$LETTA_LOCAL_BACKEND_DIR/memfs/$AGENT_ID/memory`.
Snapshot it now so step 4 compares before against after rather than treating
everything present later as imported:

```bash
find "$LETTA_LOCAL_BACKEND_DIR/memfs/$AGENT_ID/memory" -type f
```

## 3. Import

```bash
letta --backend local import "$LETTA_TRAJ_DIR" --agent "$AGENT_ID"
```

Import is local-backend only. It creates one out-of-context conversation per
exported session, then runs a simplified memory-initialization turn over that
history — no upfront questions. The output reports how many messages and
conversations it created, and the conversation ID for each; keep that list for
the next step.

Import once per agent. If the init turn fails after the messages land, create a
fresh agent and re-import rather than re-running import on the same one.

## 4. Inspect what landed

Read back an imported conversation by its ID from the import output. Imported
history lives in those conversations, not in the agent's `default` one:

```bash
letta --backend local messages transcript --agent "$AGENT_ID" --conversation <imported-id>
```

Then the memory, read against the step 2 snapshot so you count what changed
rather than what is merely present:

```bash
find "$LETTA_LOCAL_BACKEND_DIR/memfs/$AGENT_ID/memory" -type f
letta --backend local memory status --agent "$AGENT_ID"
letta --backend local memory tokens --memory-dir "$LETTA_LOCAL_BACKEND_DIR/memfs/$AGENT_ID/memory"
```

Memory is git-backed, so
`git -C "$LETTA_LOCAL_BACKEND_DIR/memfs/$AGENT_ID/memory" log --stat` shows what
was written and in how many passes.

This step is diagnostic. File count and token size describe volume, not skill —
a large memory tree can be entirely generic. Read a few files against the
corpus, ask whether the facts trace back to real sessions, and treat the answer
as a hypothesis to test in step 5.

## 5. Evaluate against a baseline

Capability is a comparison, so run the same held-out tasks against two agents:
the imported one from step 3, and a second blank agent created exactly like
step 2 with no import.

Hold everything else fixed — same model, tools, and permissions, same repository
at the same commit, same task prompts in the same order, one fresh conversation
per task on both sides, each agent in its own `LETTA_LOCAL_BACKEND_DIR`.

Use 5–10 tasks from the corpus's domain but absent from it, each with a
pass/fail check you can run without judging the transcript — a test that goes
green, a build that succeeds, a diff that matches expected behavior. Per task,
per agent, capture:

| Field | How |
| --- | --- |
| Pass / fail | Your objective check |
| Turns to completion | Transcript |
| Wall-clock | Time the run |
| Token cost | `/usage` in the session, or your provider's BYOK dashboard |
| Human interventions | Count of times you had to correct or unblock |

Report the pass-rate difference alongside the cost difference — history that
lifts pass rate while tripling tokens is a different result than one that does
both. Keep the corpus description (`manifest.json` session and record counts,
sources, project filter) with the numbers, and vary one corpus dimension at a
time across runs.
