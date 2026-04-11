# Bootstrap Prompt — Session 0: Orientation

Paste this into Letta Code after running `/init` on the letta-code repo.

---

## The Prompt

```
Read the design doc at docs/recursive-session-experiment.md carefully. This is a plan to build recursive session decomposition on top of Letta Code itself — enabling agents to recursively break down coding tasks into sub-sessions, each with their own context, and learn which decomposition strategies work over time through persistent memory.

We're going to build this system together using the approach it describes. I'll act as the "pilot" — manually decomposing the implementation into phases and subtasks, delegating work to you, and capturing what we learn along the way. By the time we're done building it, your memory will already contain the decomposition strategies, codebase knowledge, and implementation skills — because we'll generate them as we go.

Before we start building, I need you to:

1. Read through the full design doc and summarize your understanding of what we're building and why.

2. Assess the Letta Code codebase for feasibility. Specifically:
   - Where is the Task tool's delegation depth limit enforced? What file, what line?
   - How does the Task tool currently spawn sub-agents? What's the call chain?
   - How is budget/token tracking handled for delegated tasks?
   - What's the current depth limit, and what mechanism enforces it?
   - Are there any other constraints that would block recursive delegation?

3. Identify the key files we'll need to modify for Phase 1 (enabling recursive delegation). Give me a concrete file list with what needs to change in each.

4. Flag anything in the design doc that seems wrong or impractical given what you've now learned about the codebase. Push back on anything that won't work.

After this, I'll use /remember to capture your findings in memory, and we'll start Phase 1 by decomposing it into subtasks together.
```

---

## After the agent responds, run:

```
/remember The agent analyzed the letta-code codebase for recursive delegation feasibility. Key files identified: [paste the files it found]. Depth limit is enforced in [location]. The approach [is/isn't] feasible because [reasons]. Concerns raised: [any pushback].
```

Then move to Session 1 by decomposing Phase 1 based on what it found. The design doc has the subtask breakdown, but adapt it based on the agent's actual findings about the codebase — the agent knows its own internals better than our plan does.

---

## Session 1 Prompt Template

After Session 0's /remember, start a new conversation (/clear) and:

```
We're building recursive session decomposition on top of Letta Code. Check your memory for the codebase analysis from our last session — you identified the key files and the delegation depth limit location.

Phase 1 is enabling recursive delegation. I'm going to decompose this into subtasks and delegate them to you one at a time. After each subtask, I'll capture what we learned.

Subtask 1A: [adapted based on Session 0 findings]

Go.
```

After each subtask completes:
```
/remember [what worked, what was harder than expected, key decisions made]
```

After all Phase 1 subtasks:
```
/skill Learn from this session how to patch Letta Code's delegation internals. Capture: which files we touched, what the constraints were, what patterns to follow when modifying the tool dispatch chain.
```

---

## Session 2 Prompt Template

```
We completed Phase 1 — recursive delegation is enabled. Check your memory for what we learned. Now we're building Phase 2: the decomposition skill and pilot prompt.

I'm decomposing this phase into subtasks:

Subtask 2A: Create the recursive-session skill. Read the SKILL.md template in the design doc (docs/recursive-session-experiment.md, "The Recursive Decomposition Skill" section). Write it to .skills/recursive-session/SKILL.md. Adapt the decomposition patterns based on what you've learned about this codebase specifically.

Go.
```

---

## Session 3 Prompt Template

```
Phase 1 (recursive delegation) and Phase 2 (decomposition skill + pilot prompt) are done. Check your memory for accumulated learnings.

Phase 3: Memory-based learning. We need to build the sleep-time consolidation mechanism — a way for you to review your session history and update your memory/system/*.md files with generalizable strategies.

I'm decomposing this:

Subtask 3A: Write a consolidation prompt that, when given to you between sessions, causes you to review recent work and update your memory. The prompt should focus on: what decomposition strategies worked, what codebase knowledge to persist, what patterns to generalize. Save it to docs/consolidation-prompt.md.

Go.
```

---

## Session 4: The Handoff

```
We've built the recursive decomposition system together across 4 sessions. Your memory now contains codebase knowledge, decomposition strategies, and implementation skills accumulated through the process.

It's time for you to be the pilot.

Review your memory/system/decomposition.md. For the task I'm about to give you, decide:
- Should you do it directly?
- Should you delegate flat (single level)?
- Should you recursively decompose into sub-sessions?

Explain your reasoning, then execute your plan.

The task: [give it a real multi-file coding task on this repo or another project]
```

After observing:
```
/remember How the handoff went. Did the agent decompose well? What knowledge was missing? What would make the next handoff smoother?
```
