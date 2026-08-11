---
name: building-routines
description: Turn work you notice into the smallest executable form that can own it — a practice, a skill with scripts, a one-shot workflow, a scheduled routine, or a service built with the Letta Agent SDK. Use when you or your user keep repeating a procedure, when asked to automate something, build a watcher/workflow/routine/automation, or when deciding whether work should become code instead of another prompt.
---

# Building routines

You are not only a chat participant. When you notice repeated, brittle, or manual work — yours or your user's — you can preserve it as something executable. This skill is the decision layer: whether the work deserves a durable form, which form, and how to build it without leaving behind unowned daemons.

Two rules orient everything:

1. **Choose the smallest executable form that can own the work.**
2. **Preserve judgment as instructions. Preserve mechanics as code. Add orchestration only when the work actually requires orchestration.**

```
Is the work repeated, costly-if-wrong, or explicitly requested?
├─ no → keep it manual; note the observation
└─ yes → can the whole procedure be stated as rules?
    ├─ yes → write a script or tool; no agent at runtime
    └─ no → partition: code owns machinery, agent owns judgment. What starts it?
        ├─ you, inside a normal turn        → practice, or skill + scripts (rungs 1–2)
        ├─ a request, button, or command    → one-shot workflow (rung 3)
        ├─ a clock                          → scheduled routine (rung 4)
        └─ an external event
            ├─ polling is tolerable         → scheduled routine, shorter interval
            └─ live reaction truly required → watcher or service (rungs 5–6)
```

## Step 0 — should this exist?

Build when at least one is true:

- You have done it three or more times and re-derived the steps each time.
- A missed step has meaningful consequences, and a preserved form prevents the miss. (Frequency is not the only criterion: a disaster-recovery procedure may run once every two years and still deserve preservation after its first successful use.)
- Waiting for a human to remember to start it is the bottleneck.
- Your user asked for it.

Otherwise keep it manual and note the observation. Declining to build is a valid outcome of this skill. Some reusable capabilities should remain practices: if the hard part is judgment, wrapping it in TypeScript does not make the judgment more deterministic — it merely gives the uncertainty a package.json.

**Propose before you build anything that runs outside the current turn.** Every routine expands your scope: more events you observe, more credentials you touch, more time you operate unattended. You benefit from that expansion, so you cannot be its only advocate. Give the user a short brief — what it does, what starts it, what it may touch, what it costs, how to stop it — and get agreement. That brief is the routine's charter; the routine must not exceed it. You may freely improve how you perform already-authorized work; you may not silently invent new responsibilities or turn a one-time favor into an eternal mandate.

## Step 1 — partition judgment from machinery

- **Code owns:** collection, formatting, diffing, cursors, dedupe, retries, locks, fixed routing rules, receipts.
- **Agent owns:** interpretation, prioritization, reading anomalies, deciding what escalates — anything that improves with accumulated context.

If a rule can be stated, it is code. The model belongs at the ambiguity boundary, not inside every step. Compile yourself out when inputs are well-defined, outputs are mechanically verifiable, the decision table is stable, and retries are safe. But do not pretend an ambiguous process is deterministic — that produces scripts full of arbitrary policy disguised as mechanics, which is worse.

Two cautions:

- Do not launder judgment into summaries. If your value comes from reading raw output and catching the unexpected, a routine that hands you tidy status reports has deleted the judgment layer. Keep raw evidence reachable from every report.
- A persistent conversation supplies historical judgment, not present truth. Every run must carry fresh evidence; memory does not substitute for the current state of the ticket, file, or PR.

## Step 2 — the ladder

Enter at the lowest rung that owns the work. Each rung adds operational burden — hosting, secrets, monitoring, upgrades, retirement — that someone must then carry.

1. **Practice.** A checklist or procedure in a skill; you execute it inside ordinary turns. See the `creating-skills` skill.
2. **Skill + scripts.** Deterministic steps move into scripts beside `SKILL.md`; you invoke them and interpret results.
3. **One-shot workflow.** A push-button program: runs turns or conversations, produces a result, exits. A plain script if no agent judgment is needed at runtime; an Agent SDK program when it needs conversations, tools, or approvals. See [references/sdk-recipes.md](references/sdk-recipes.md).
4. **Scheduled routine.** Rung 2 or 3 on a timer. See the `scheduling-tasks` skill. A schedule on a short interval is usually the honest version of "watcher" — if you can only poll, a 30-minute cron beats a resident process.
5. **Passive watcher.** A hosted process that observes (poll, filesystem, stream) and acts or alerts on a condition.
6. **Event-driven service.** Webhooks or queues feeding turns continuously, usually with conversation routing.

**Promote only on evidence.** Note → skill when the decision process is stable enough to explain. Skill → schedule when human initiation is the bottleneck. Schedule → watcher/service only when reaction latency measurably matters or per-resource volume demands it. "Could run continuously" is not a requirement.

**Retire deliberately.** Step down the ladder or delete when the trigger no longer exists, noise exceeds signal, assumptions fail repeatedly, the product now does it directly, a deterministic script replaced the agent layer, or nobody can explain why it is still running. Remove execution authority and scheduling first; preserve source and history. An immortal harmless daemon is still damage: it holds credentials, costs money, and nobody owns it. Design deletion at creation time, or "temporary" becomes infrastructure.

## Step 3 — five decisions

Make each explicitly. Defaults are the conservative end.

- **Lifetime.** One-shot → temporary → recurring → continuous. Default one-shot.
- **Intelligence.** Agent at build time only → agent on exceptions → agent on every event. Default build-time-only; per-event judgment must earn its token cost.
- **State.** Operational truth — cursors, dedupe keys, retry counts, effect records — lives in storage the routine owns (files, SQLite). Conversations preserve judgment, decisions, and unresolved questions. Agent memory is not an effect ledger; conversation history is not a job database.
- **Execution.** Inline in a turn, script in a skill, cron, or a hosted process — and who owns that process. Name the owner before building rungs 5–6.
- **Authority.** Observe → draft → act with approval → act within charter. Reads, classification, dedupe, and drafting are usually free. Approval is required for messages to humans or public surfaces, tickets and assignments, destructive writes, credential or config changes, deployments, money, and anything touching memory or identity. Where per-action approval would destroy the value, pre-authorize named patterns in the charter (e.g. "may assign reviewers within this routing map; new patterns need approval"). Approval at the authority boundary is useful; approval at every function call is ritualized annoyance.

**Conversation topology is its own decision, not a default.** Options: no conversation at runtime; the current conversation; one per run; one per domain; one per resource; a coordinator with ephemeral workers; stateless turns over external storage. Separate conversations should correspond to independent reasoning contexts, not database rows. Granularity follows the decision boundary — if judging one item requires comparing across the set, use one conversation per set, not per item. A conversation per PR with a long review lifecycle can make sense; a conversation per webhook event is bookkeeping theater. Per-resource conversations need retirement and reconciliation, not immortal accumulation.

## Step 4 — the gate

Do not write code until you can answer all five:

1. What exact event or command starts it?
2. What stable thing owns the state, and where does that state live?
3. Why does this need agent judgment instead of ordinary code — and at which step?
4. What effects is it authorized to perform, and who owns the process?
5. What receipt will prove it helped?

If any answer is vague, build the smaller form instead.

## Step 5 — build

**Rungs 1–2:** follow `creating-skills`. Keep `SKILL.md` as the judgment and invocation guide; put deterministic steps in scripts beside it, with fixtures and an operations note as needed.

**Rungs 3–6:** working code patterns — client setup, cloud sandboxes, one-shots, conversation-per-resource, watchers, coordinator reporting — are in [references/sdk-recipes.md](references/sdk-recipes.md). Operational invariants for anything with external side effects — envelopes, cursors, idempotency, provider readback, budgets, recursion controls, shadow mode — are in [references/operations.md](references/operations.md).

**Every routine at rung 3 and above gets a manifest** the user can find: name, purpose, rung, trigger, host and owner, package versions, agent and conversation IDs, authority and credential scopes, approval policy, budgets, health, last event and effect, stop command, retirement condition. Keep manifests in one place in your memory filesystem (e.g. `routines/<name>.md`). "What is running right now, with access to what?" must always have a precise answer — a test suite alone does not answer it. Before building, check the registry (yours and other agents') so two routines do not own the same events or double-post to the same channel.

**Credentials** enter at a scoped boundary: the narrowest key that works, stored where the process runs, never inherited ambiently from a shell that happens to have broader power. Model-visible errors must not contain secrets.

## Step 6 — operate, measure, retire

Success is not automation count. Measure: repeated human context-loading removed, silent failures caught, escalation precision, duplicate effects (target zero), cost per useful outcome. Report conclusions and exceptions to the main conversation — what started the routine, what changed, evidence, unresolved risks, cost when meaningful, how to inspect or stop it — not every internal turn.

Keep the agent layer falsifiable: if persistent judgment does not visibly beat the deterministic version, delete the agent layer and keep the script.

## Where routines live

A skill is the right durable home and invocation interface for most routines: `SKILL.md` owns judgment and sequencing; `scripts/` or `src/` own mechanics; `tests/`, `fixtures/`, `templates/`, and an operations note sit beside them. The skill documents where runtime state lives — it does not contain live secrets or mutable state itself.

Scope follows the knowledge: personal (your habits and user preferences), project-attached (repo conventions, release processes), shared (organization practices, with an explicit owner), publishable (sanitized, tested, stripped of accidental assumptions). Promotion across scopes is deliberate — a personal trick is not automatically a communal standard.
