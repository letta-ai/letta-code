# Operating routines safely

Invariants for any routine with external side effects (rungs 3+ with writes; all of rungs 5–6). These exist because helpful agents at machine speed manufacture ordinary operational entropy: overlapping schedules, forgotten workers, over-scoped credentials, retries that duplicate external actions, and a hundred "automations" nobody owns and everyone is afraid to delete.

## Event discipline (rungs 5–6)

- **Typed event envelope:** event ID, resource ID, source timestamp, idempotency key, lineage (what produced this event, at what depth), links to raw evidence.
- **Durable cursor + reconciliation pass:** webhooks drop and streams stall. Persist your position; run a periodic full sweep to catch what live delivery missed. The sweep is the source of truth; live events are the optimization.
- **One active turn per resource:** lock or queue per resource key; debounce bursts into one turn with the latest state.
- **Suppress your own events.** A routine that reacts to its own posts is a feedback loop. Filter by author/actor before processing.

## Effects and idempotency

- **Record intent before acting, result after.** An effects ledger (event ID → action → run IDs → outcome) is what makes "did we already do this?" answerable.
- **Provider readback:** "the call timed out" does not mean "send it again." Unknown send state stays unknown until you read the provider's actual state (was the comment posted? does the ticket exist?). Only then decide to retry.
- **Dry-run mode from day one:** `--dry-run` shows what would happen — events matched, turns that would run, effects that would fire — without acting. This is also your shadow mode: run read-only against real events, show the user what it would have done and cost, then enable effects.

## Budgets and recursion

- **Budgets:** max turns per hour, max notifications per person per day, max spend. Alert on budget exhaustion; do not silently truncate.
- **Recursion controls:** every delegated turn carries lineage metadata (root ID, parent ID, depth). Enforce a small depth limit. Workers do not spawn workers by default. One stop switch halts the whole tree — test it before enabling effects.

## The manifest

Every deployed routine (rung 3+) has a manifest the user can find without asking you. Keep them in one place — e.g. `routines/<name>.md` in your memory filesystem:

```markdown
# pr-shepherd
purpose: judge PR staleness/risk for letta-code; escalate what needs humans
rung: 5 (watcher)          owner: cameron
source: github.com/…/routines@a1b2c3   sdk: @letta-ai/letta-agent-sdk@0.6.3
trigger: poll GitHub every 30m (cron on ops-host)
agent: agent-xxx           conversations: per-repo (map in routine-state.sqlite)
authority: read GitHub; draft comments; post ONLY reviewer nudges matching routing map
credentials: GH token (repo:read, PR:write) in ops-host keychain — NOT ambient shell
budgets: ≤20 turns/hr, ≤3 nudges/person/day, ≤$2/day
state: /opt/routines/pr-shepherd/routine-state.sqlite
health: last event 2026-08-11T14:02Z; last effect run-abc123
dry-run: bun run sweep.ts --dry-run
stop: crontab -l | grep -v pr-shepherd | crontab -   (then verify no process)
review-by: 2026-09-15 — retire when review latency SLO holds for 30 days
```

A routine that cannot explain why it exists, what authority it has, and how to kill it should not be running.

## Registry checks

Before deploying, check existing manifests — yours and your user's other agents' — for overlap: two routines owning the same events, double-posting to the same channel, or watching the same resource at different intervals. Composition failures look like spam to the humans on the receiving end.

## Retirement checklist

Review, demote, or delete when: the trigger no longer exists · it has not run within its expected window · its owner disappeared · credentials expired or expanded unexpectedly · assumptions fail repeatedly · the product now does it natively · maintenance costs more than the mistakes it prevents · a deterministic script replaced the agent layer · nobody can explain it.

Order: remove execution authority and scheduling first; revoke credentials; keep source, decisions, and last state as history; delete the manifest last (it documents the retirement).
