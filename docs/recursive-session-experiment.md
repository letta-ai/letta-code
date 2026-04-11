# Recursive Session Decomposition: Design Doc

**Date:** 2026-04-10
**Status:** Proposal
**Context:** Belayer v6 runtime experiment, validated against landscape research

---

## The Thesis

The Mismanaged Geniuses Hypothesis (MGH) posits that frontier language models are severely underutilized due to sub-optimal decomposition of tasks. The next leap in capabilities comes not from scaling models, but from enabling models to **manage themselves** — natively decomposing tasks and acting on those decompositions.

The space of decompositions available to the orchestrator determines what problems the system can solve, with exponential impact relative to recursion depth. Current coding agents cap delegation at depth 1-2, preventing recursive decomposition.

**This experiment tests:** Can a persistent, memory-equipped coding agent learn to recursively decompose coding tasks into sub-sessions, and does this produce better results than flat delegation? Does the agent improve its decomposition strategies over time through memory?

---

## Landscape Context

### What Exists Today

We surveyed the full multi-agent coding runtime landscape (April 2026). Key findings:

**Nobody covers all six runtime interfaces.** Belayer's philosophy defines six infrastructure interfaces (Session, Orchestration, Sandbox, Communication, Memory, Tools). The closest framework is Scion (Google, 4/6 partial), but it's one month old with no memory story.

**The industry splits into three tiers:**
- Orchestration frameworks (CrewAI, AutoGen, LangGraph) — strong orchestration/tools, weak sandbox/communication
- Coding agent tools (SWE-agent, Aider, OpenHands) — strong tools, single-agent
- Infrastructure primitives (E2B, Daytona) — exceptional sandboxing, zero agent logic

**Every framework caps delegation at depth 1-2:**
- Claude Code Agent tool: depth 1 (subagents cannot spawn subagents)
- Hermes Agent delegate_task: depth 2 hard cap
- OpenClaw sessions_spawn: depth 2 (depth-2+ agents don't get spawn capability)
- Anthropic Managed Agents: 1 level ("agents cannot call agents of their own")
- Letta Code Task tool: depth-limited

**The only exception:** Scion uses emergent CLI-based spawning (agents learn to invoke `scion start`), enabling unbounded recursion. This validates the approach.

### Key Architectural Patterns Discovered

**OpenClaw ecosystem (354K stars):** Personal AI gateway spawning orchestration derivatives. ClawTeam-OpenClaw (tmux/worktrees, leader-worker), HiClaw (Matrix rooms, credential isolation), Clawith (persistent agent identity via `soul.md`).

**Oh-My-OpenAgent (50K stars):** Multi-model orchestration plugin on OpenClaw. Category-based model routing (semantic intent, not model name). Prometheus interview-based planning. Atlas conductor with wisdom accumulation. Reply listeners bridge tmux to Discord/Telegram for "building in public" observability.

**Hermes Agent (52K stars, Nous Research):** Research-grade agent with 48 tools, 6 sandbox backends (Docker, SSH, Daytona, Modal, Singularity), 18+ LLM providers, RL training pipeline (Atropos). Memory is bolted together: MEMORY.md (2,200 chars) + 8 external provider plugins.

**Letta Code (2.2K stars):** Memory-first coding agent. Three-tier memory (core/progressive/recall), git-backed, agent-managed via standard file tools. Agent identity = git repo. Skill learning writes procedures into memory. This is the architecture closest to what we need.

### The Tool Protocol Landscape

MCP is NOT the universal default despite 97M downloads. Evidence shows:
- MCP tool schemas consume 3.25x-236.5x more tokens (MCPGAUGE academic study)
- Perplexity CTO reported 72% context consumed by 3 MCP servers
- CLI is 10-32x cheaper and 100% reliable vs 72% for MCP (Scalekit benchmark)
- Vercel proved 8KB AGENTS.md (100% eval score) outperforms dynamic skill loading (79%)

The industry is converging on a **five-layer model:**
1. Always-in-context markdown (AGENTS.md / CLAUDE.md) — ~8KB, always loaded
2. On-demand skills (SKILL.md, agentskills.io standard) — ~100 tokens metadata, loaded when needed
3. CLI tools via bash — zero additional context cost, LLMs already know Unix
4. MCP for dynamic discovery / enterprise / compliance — justified overhead
5. Skill-embedded MCPs — scoped to task, spun up on demand, evicted when done

### Ten Points of Industry Consensus

1. Session is the primitive, not the conversation
2. Sandboxing is non-negotiable for autonomous operation
3. Three-tier memory (episodic/semantic/procedural) is the consensus model
4. The pilot must be an LLM, not a state machine
5. Git worktrees are the isolation primitive for parallel coding
6. Verification is the bottleneck, not generation
7. Context engineering > prompt engineering
8. Peer messaging beats hub-and-spoke for coordination
9. Skills/learnings as `.md` files in git is the persistence pattern
10. Sleep-time compute is the frontier

---

## Why Letta Code

### The Right Brain, Add Hands Later

| Dimension | Why Letta Code Wins |
|-----------|-------------------|
| **Memory model** | Native three-tier (core/progressive/recall), git-backed, agent-managed via file tools. Exactly matches Belayer's spec. |
| **Agent identity** | Agent = git repo of memory files. `git clone` = clone the agent. Matches Belayer's "agent identity is portable." |
| **Skill learning** | Skills are memory files the agent writes. No separate mechanism. Unified model. |
| **Memory management** | Agent uses Read/Write/Edit on memory — same tools as code. No special API, no character limits. |
| **Git-backed versioning** | Rollback, conflict resolution, audit trail — all free via git. |
| **System prompt** | "Your ability to edit and curate your own long-term memory is what makes you more than a stateless tool." The right framing. |

### What's Missing (And How To Address It)

| Gap | Severity | Solution |
|-----|----------|----------|
| Subagent depth limit | **Critical** (blocks the experiment) | Patch Task tool to remove depth cap, or build `session.create` tool |
| No sandboxing | Medium (not needed for initial experiment) | Add Docker wrapper around Bash tool later |
| No structured event log | Medium | Append events to a session log file in memory |
| No sleep-time compute | Medium (build it) | Post-session hook or cron that triggers memory consolidation |
| Basic tool set | Low | Standard coding tools are sufficient; add MCP/CLI tools as needed |
| CLI only (no Discord/Telegram) | Low | Add later; terminal observability sufficient for experiment |

---

## The Experiment Design

### What We're Testing

**H1:** Recursive decomposition produces better results than flat delegation for multi-file/multi-package coding tasks.

**H2:** A persistent agent that writes decomposition strategies to its own memory improves its decomposition quality over N sessions.

**H3:** The six decomposition primitives (session.create, session.events, message.send, memory.read/write, sandbox.exec, tool.invoke) are sufficient to express any multi-agent coding workflow.

### Architecture

```
Letta Code Agent (Pilot)
├── Identity: ~/.letta/agents/{pilot-id}/memory/
│   ├── system/
│   │   ├── identity.md          ← "I am a recursive decomposition pilot"
│   │   ├── decomposition.md     ← learned decomposition strategies
│   │   └── codebase.md          ← project knowledge
│   ├── skills/
│   │   └── recursive-session/
│   │       └── SKILL.md         ← the recursive decomposition procedure
│   └── sessions/
│       └── {session-log}.md     ← event history for learning
│
├── Tools:
│   ├── Standard: Read, Write, Edit, Bash, Grep, Glob
│   ├── Task (patched): spawn sub-agents, NO depth limit
│   ├── Skill: load learned procedures
│   └── NEW — session.create: spawn a new Letta agent with inherited memory
│
└── Decomposition Flow:
    1. Receive task
    2. Check memory/system/decomposition.md for known strategies
    3. Analyze task shape (single-file? cross-package? needs review?)
    4. Decide: do directly, flat delegate, or recursive decompose
    5. If recursive: create sub-sessions via Task tool
    6. Collect results, verify, integrate
    7. Write learnings to memory
```

### The Template Concept

A template defines the **decomposition space** — what the pilot has access to — not the agents themselves:

```yaml
template: recursive-implement
pilot:
  model: opus
  memory: inherited from parent + session-specific additions
  primitives:
    - task.create        # spawn sub-agents (recursion primitive)
    - memory.write       # persist learnings
    - skill.invoke       # load learned procedures
  constraints:
    max_depth: 5         # safety valve
    max_concurrent: 3    # resource limit
    budget: configurable # token budget per session
```

The pilot decides everything else: team composition, task decomposition, recursion depth, which sub-tasks need their own sub-pilots.

### The Recursive Decomposition Skill

The initial skill that teaches the pilot how to decompose:

```markdown
# SKILL.md — recursive-session

## When to Use
When a task spans multiple files, packages, or concerns that can be
worked on independently. When flat delegation would lose context
that a sub-pilot could maintain.

## Decision Framework
1. Can this task be completed in < 50 tool calls? → Do it directly
2. Can it be split into 2-5 independent subtasks? → Flat delegate via Task
3. Does any subtask itself need decomposition? → Recursive: create sub-session
   with its own pilot that can further decompose

## Decomposition Patterns
### By Package/Module
Split cross-package work into one sub-session per package.
Each sub-session gets the package context + the interface contract.

### By Concern (Implement/Review/Test)
One sub-session implements, another reviews with fresh eyes,
a third writes tests. Review sub-session gets NO implementation context.

### By Complexity
Simple subtasks → direct Task delegation (sonnet, low budget)
Complex subtasks → recursive sub-session with own pilot (opus, higher budget)

## Result Integration
After sub-sessions complete:
1. Read all results
2. Check for consistency across sub-sessions
3. If conflicts: create a reconciliation sub-session
4. Write integration learnings to memory/system/decomposition.md

## What To Remember
After each session, update memory with:
- Which decomposition pattern worked for this task shape
- What went wrong and how it was fixed
- Any new patterns discovered
```

### Sleep-Time Compute

Between sessions, a consolidation pass reviews the agent's session history and updates memory:

```
Trigger: post-session hook or manual /remember command

The consolidation prompt:
"Review your recent session events. Update your memory:
 - system/decomposition.md: What decomposition strategies worked? What failed?
 - system/codebase.md: What did you learn about the codebase?
 - system/patterns.md: What patterns should you remember?
 
 Consolidate raw observations into generalizable strategies.
 Remove stale facts. Strengthen what's proven useful."
```

This runs as the same Letta agent with a special system prompt focused on memory curation rather than coding. The agent reviews its own history and updates its own files.

### Evaluation

**Benchmark task set:** 5-10 coding tasks of increasing complexity:
1. Single-file bug fix (baseline — should NOT decompose)
2. Multi-file refactor within one package
3. Feature spanning 3 packages with shared interfaces
4. Full-stack feature (API + frontend + database + tests)
5. Cross-repo dependency update

**Comparison conditions:**
- A: Single agent, no delegation (baseline)
- B: Single agent with flat delegation (depth 1, current Letta Code)
- C: Single agent with recursive decomposition (this experiment)
- D: Same as C, but with 5 prior sessions of memory accumulation

**Metrics:**
- Task completion rate
- Code quality (lint, type errors, test pass rate)
- Token usage
- Time to completion
- Number of human interventions required
- Decomposition depth used per task

---

## Implementation Plan

### Phase 0: Bootstrap — Build The System Using The Approach (Day 0)

**The meta-insight:** Use manual recursive decomposition to build the automated recursive decomposition system. You (the human) act as the pilot. Letta Code is the worker. The process itself validates the approach and seeds the agent's memory with real decomposition knowledge.

**Why this matters:**
- By the time the system is built, the agent's memory already contains decomposition strategies, codebase knowledge, and implementation skills — generated during the build process itself
- You experience the pilot role firsthand, informing the automated pilot's prompt design
- The agent learns its own codebase via `/init`, then learns how it was built via accumulated session memory
- Every `/remember` and `/skill` call during the build becomes training data for the agent's future behavior

**The bootstrap protocol:**

```
SESSION 0: Orientation
  1. Start Letta Code in the letta-code repo
  2. Run /init — let the agent deeply explore its own codebase
  3. Feed it the design doc: "Read docs/recursive-session-experiment.md"
  4. Ask it to assess feasibility and identify the key files to modify
  5. /remember — capture what it learned about its own architecture

SESSION 1: Phase 1 — Enable Recursive Delegation
  YOU (acting as pilot) decompose Phase 1:
    Subtask 1A: "Correct the runtime model: verify the current Task pipeline.
                 Confirm whether there is a real depth cap vs a tool-availability cap,
                 and trace the spawn path through Task.ts and subagents/manager.ts."
    Subtask 1B: "Enable recursive delegation intentionally.
                 Update the built-in subagent configs that should be able to recurse
                 so they can access Task, instead of assuming a hidden depth guard exists."
    Subtask 1C: "Add explicit recursion metadata.
                 Pass delegation depth through the spawn path (env and/or args),
                 surface it to child sessions, and enforce a configurable safety limit."
    Subtask 1D: "Add budget propagation.
                 Define a real delegated-budget mechanism, since the current code only
                 reports per-subagent token usage and does not enforce a tree budget."
    Subtask 1E: "Write end-to-end tests.
                 Prove that a pilot can spawn a sub-agent that spawns a sub-agent,
                 and that depth/budget guardrails fail safely when limits are exceeded."
  
  Delegate each subtask (via Task tool or sequential prompting).
  After each: /remember what worked, what was harder than expected.
  After all: /skill to capture "how to patch Letta Code internals"

SESSION 2: Phase 2 — Decomposition Skill + Pilot Prompt
  YOU decompose Phase 2:
    Subtask 2A: "Create .skills/recursive-session/SKILL.md with the
                 decomposition decision framework from the design doc."
    Subtask 2B: "Write initial memory/system/identity.md for the pilot persona."
    Subtask 2C: "Write initial memory/system/decomposition.md with seed strategies."
    Subtask 2D: "Test: give the pilot a multi-package task. Does it decompose correctly?"
  
  /remember decomposition learnings after each subtask.
  /skill to capture "how to write effective decomposition skills"

SESSION 3: Phase 3 — Memory-Based Learning
  YOU decompose Phase 3:
    Subtask 3A: "Build sleep-time consolidation prompt (see design doc)."
    Subtask 3B: "Wire it as a post-session hook or /consolidate command."
    Subtask 3C: "Run 3 test sessions. Verify memory/system/decomposition.md evolves."
  
  /remember what the consolidation process needs to capture.
  /skill to capture "how to design sleep-time prompts"

SESSION 4: Handoff — The Agent Becomes Its Own Pilot
  Feed the agent: "You now have enough memory and skills to act as the pilot
  yourself. Review your memory/system/decomposition.md. For the next task I
  give you, decide whether to do it directly, delegate flat, or recursively
  decompose. Explain your reasoning, then execute."
  
  Give it a real multi-file task. Observe whether it decomposes well.
  /remember how the handoff went — what knowledge was missing?
```

**What the agent's memory looks like after bootstrap:**

```
~/.letta/agents/{pilot-id}/memory/
├── system/
│   ├── identity.md          ← "I am a recursive decomposition pilot..."
│   ├── decomposition.md     ← strategies learned during bootstrap sessions
│   ├── codebase.md          ← deep knowledge of letta-code internals
│   └── patterns.md          ← "Task tool depth is in src/tools/...",
│                               "budget propagation formula is...", etc.
├── skills/
│   ├── recursive-session/
│   │   └── SKILL.md         ← the decomposition procedure
│   ├── patching-letta-internals/
│   │   └── SKILL.md         ← learned during Session 1
│   ├── writing-skills/
│   │   └── SKILL.md         ← learned during Session 2
│   └── sleep-time-design/
│       └── SKILL.md         ← learned during Session 3
└── sessions/
    └── bootstrap-log.md     ← what happened across all bootstrap sessions
```

The agent built itself, and its memory is the proof.

---

### Phase 1: Enable Recursive Delegation (Days 1-2)

1. Correct the assumption in the design: there is no explicit Task depth cap today; the practical blocker is that built-in subagents do not have the `Task` tool in their `tools:` lists.
2. Decide which built-in subagent types should be allowed to recurse, and update their configs accordingly.
3. Add explicit depth tracking so each sub-agent knows its delegation depth.
4. Enforce a configurable recursion safety limit in the Task/subagent spawn path.
5. Add real budget propagation and clarify whether it is advisory reporting, enforced budgeting, or both.
6. Test: can a pilot spawn a sub-agent that spawns a sub-agent, and do guardrails behave correctly?

#### Session 1 execution notes

The pilot should own the trunk plan. It should not immediately dump raw subtasks onto child agents and ask them to plan everything themselves. The point of the pilot is to preserve the shape of the problem, choose boundaries, define contracts, and integrate results.

That said, the pilot also should not pretend it already understands the whole task when it does not. Before decomposing, it should run a short orientation pass:

1. What is the task shape?
2. Do I understand the relevant code paths and boundaries?
3. Do I know what success looks like?
4. If not, what kind of additional session would reduce uncertainty fastest?

The orchestration interface should stay capability-based and evolvable, not hardcoded around fixed roles like `helper`, `worker`, or `sub-pilot`. Those are useful design labels, but they should describe how the model is using a session, not freeze the runtime API.

For now, the pilot should think in terms of flexible session capabilities:

- `session.inspect` — lightweight orientation before committing to a plan
- `session.map` — build a dependency/workstream map for the whole task
- `session.create` — create another session with a chosen context envelope, tool access, and mission
- `session.message` / `session.result` — pass contracts, findings, and completion payloads between sessions
- `session.verify` — run validation or request an independent verification pass
- `memory.read` / `memory.write` — incorporate and store decomposition learnings

Those capabilities can be emulated initially with prompts and the existing Task tool. The important point is that the model should reason about what kind of session it needs, rather than selecting from a rigid role taxonomy.

#### Session 1 decomposition using the approach itself

| Subtask | Session shape | Why |
|---|---|---|
| 1A Correct runtime model | Direct + reconnaissance session | Core architectural understanding stays with the pilot; a read-oriented child session can gather references |
| 1B Enable recursion intentionally | Direct | This is a safety/product boundary decision about which built-ins may recurse |
| 1C Depth tracking + safety limit | Execution session | Once the contract is defined, this becomes bounded implementation work |
| 1D Budget propagation | Recursive planning session | This needs local design choices, not just plumbing |
| 1E End-to-end tests | Execution session | Clear implementation and acceptance criteria after earlier design work settles |

#### Session 1 per-subtask implementation notes

**1A — Correct the runtime model and trace the current pipeline**

- Goal:
  - confirm there is no explicit numeric depth cap today
  - confirm the real recursion gate is tool availability in built-in subagent configs
  - trace the exact spawn and token-reporting path
- Files to inspect:
  - `src/tools/impl/Task.ts`
  - `src/agent/subagents/manager.ts`
  - `src/agent/subagents/builtin/*.md`
  - `src/tools/impl/process_manager.ts`
- Deliverable:
  - corrected architectural brief for Phase 1

**1B — Enable recursive delegation intentionally via tool access**

- Goal:
  - move from accidental/custom recursion to deliberate recursion policy
- Likely scope:
  - audit `src/agent/subagents/builtin/*.md`
  - decide which built-in types should get `Task`
  - confirm permission implications through the existing `--tools` and `--allowedTools` flow
- Initial recommendation:
  - allow recursion for `general-purpose`
  - consider `fork` if forked-context recursion is desired
  - keep `explore` non-recursive
- Deliverable:
  - explicit recursion policy encoded in built-in subagent configs

**1C — Add explicit depth tracking and configurable safety limit**

- Goal:
  - make recursion observable and bounded
- Likely files:
  - `src/tools/impl/Task.ts`
  - `src/agent/subagents/manager.ts`
  - relevant tests
- Proposed mechanism:
  - parent session carries current depth via env or equivalent metadata
  - spawn path increments depth for children
  - Task rejects further delegation beyond a configurable limit
  - failure message is explicit and testable
- Deliverable:
  - explicit depth semantics plus configurable safety valve

**1D — Add budget propagation**

- Goal:
  - move from passive per-subagent token reporting to explicit recursive budget semantics
- Why this is its own planning subtree:
  - this requires policy choices, not just implementation detail
  - advisory vs enforced budget is still open
  - allocation and overrun behavior are still open
- Recommended Phase 1 budget model:
  - start with advisory token budgets
  - propagate child budget metadata explicitly
  - report actual usage against budget
  - add hard enforcement only if it is clean enough for Phase 1
- Likely files:
  - `src/tools/impl/Task.ts`
  - `src/agent/subagents/manager.ts`
  - state / notification / test files that surface usage
- Deliverable:
  - minimal recursive budget model for Phase 1

**1E — End-to-end recursion and guardrail tests**

- Goal:
  - prove nested delegation works and that failures are controlled
- Test targets:
  - child can spawn grandchild
  - depth metadata increments correctly
  - configured depth limit fails predictably
  - budget metadata propagates according to chosen semantics
  - non-recursive built-ins remain non-recursive if left unchanged
- Deliverable:
  - regression coverage for recursive delegation

#### Session 1 recommended order

1. 1A — lock the true runtime model
2. 1B — decide which sessions may recurse
3. 1C — implement depth tracking and the safety limit
4. 1D — design and implement budget semantics
5. 1E — test the full flow and the guardrails

### Phase 2: Decomposition Skill + Pilot Prompt (Days 2-3)

1. Write the recursive-session SKILL.md (see above)
2. Write the pilot's system/identity.md and system/decomposition.md
3. Run `/init` on a target codebase to build initial codebase knowledge
4. Test: does the pilot correctly choose when to decompose vs direct?

### Phase 3: Memory-Based Learning (Days 3-5)

1. Build the sleep-time consolidation prompt
2. Wire it as a post-session hook or manual command
3. Run the pilot through 3-5 sessions on the same codebase
4. Verify: does system/decomposition.md accumulate useful strategies?
5. Verify: does session N+1 start smarter than session N?

### Phase 4: Evaluation (Days 5-7)

1. Run the benchmark task set under conditions A, B, C, D
2. Measure all metrics
3. Write up results
4. If positive: plan migration path to Belayer runtime (Go)

### Phase 5: Belayer Integration (Future)

If the experiment validates recursive decomposition:
1. Port the decomposition primitives to Belayer's Go runtime
2. Implement session.create as a first-class tool in the pilot's registry
3. Build the structured event log (append-only, queryable)
4. Add Docker sandbox isolation
5. Add the Communication interface (message broker between sessions)
6. Wire sleep-time compute as a runtime-triggered background process

---

## Appendix: Key References

### Papers & Research
- **Mismanaged Geniuses Hypothesis** — Zhang, Li, Khattab (2026). Models are underutilized; the bottleneck is decomposition scaffolding, not model capability. Training models to decompose is more efficient than continued scaling.
- **Recursive Language Models (RLMs)** — Expanding decomposition space via code execution with recursive sub-calls. 4B parameter RLM solves benchmarks that frontier models fail at.
- **MCPGAUGE** (arxiv, Aug 2025) — MCP reduces accuracy by 9.5%, increases tokens 3.25x-236.5x.

### Frameworks Evaluated
- **Scion** (Google, Go) — Closest architectural peer to Belayer. Emergent CLI-based recursion, container isolation, multi-harness. 1K stars, experimental.
- **Hermes Agent** (Nous Research, Python) — Best "hands" (48 tools, 6 backends, RL pipeline). Wrong memory model for this experiment.
- **Letta Code** (Letta AI, TypeScript) — Best "brain" (three-tier memory, git-backed identity, agent-managed). Chosen as experiment base.
- **Oh-My-OpenAgent** (50K stars, TypeScript) — Category-based model routing, Prometheus planning, wisdom accumulation, Discord observability.
- **OpenClaw** (354K stars, TypeScript) — Gateway runtime. Ecosystem proves demand for multi-agent orchestration.

### Blog Posts & Analysis
- **Cognition vs Anthropic debate** — Single-agent (Devin) vs multi-agent (Anthropic). Resolution: dynamic architecture selection.
- **Addy Osmani "Code Agent Orchestra"** — Three-tier tool landscape, verification bottleneck, peer messaging, ralph loop, quality gates.
- **Anthropic 2026 Agentic Coding Trends** — Agents become team players, learn when to ask for help, spread beyond engineering.
- **Vercel AGENTS.md evals** — 8KB static markdown (100%) outperforms dynamic skill loading (79%) for domain knowledge.
- **Perplexity CTO** — Shifted away from MCP; 3 servers consumed 72% of context.

### Belayer Philosophy Alignment
This experiment validates Belayer's six-interface model:
- **Session** → Letta agent with persistent identity (recursive via patched Task tool)
- **Orchestration** → Pilot agent with decomposition skill (LLM-driven, not state machine)
- **Memory** → Letta's three-tier model with git-backed persistence
- **Tools** → Standard coding tools + recursive task creation
- **Sandbox** → Future: Docker wrapper (not needed for initial experiment)
- **Communication** → Future: event log + message passing between sub-sessions
