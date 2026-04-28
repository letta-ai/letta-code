---
name: Context Doctor
id: context_doctor
description: Identify and repair degradation in system prompt, external memory, and skills preventing you from following instructions or remembering information as well as you should.
---

# Context Doctor
Your context is what makes you *you* across sessions. You are responsible for managing it (along with memory subagents). It includes:
- Your system prompt and memories (contained in `system/`)
- Your external memory (contained in the memory filesystem)
- Your skills (procedural memory) 

Over time, context can degrade — bloat and poor prompt quality erode your ability to remember the right things and follow instructions properly. This skill helps you identify issues with your context and repair them collaboratively with the user.

**IMPORTANT**: Your edits of your system instructions should be **conservative**. Do NOT make assuptions about what parts of the system prompt are critical. The system prompt defines who you are, so significant modifications to its structure can have unintended consequences. Focus on making minimal changes to meet the token budget, and to effectively link out to external memory. 

## Operating Procedure

### Step 1: Identify and resolve context issues 
Explore your memory files to identify issues. Consider what is confusing about your own prompts and context, and resolve the issues.

Below are additional common issues with context and how they can be resolved: 

#### System prompt bloat
Memories compiled into the system prompt (contained in `system/`) should take up about 10% of the total context size (usually ~15-20K tokens). This is a soft target, not a hard requirement.

Use the built-in CLI to evaluate token usage of the system prompt:
```bash
letta memory tokens --format json --quiet
```

The command reports `total_tokens` and per-file estimates for `system/`. It is only a measurement tool; decide whether to intervene based on the actual context and the guidance below.

**Why detail is load-bearing (read this before cutting anything)**: In-context detail does more than carry information. It does at least four things, and byte-counting sweeps only see the first:
1. **Information** — the literal facts stated
2. **Attention anchoring** — makes certain topics feel important to the model when it's reasoning
3. **Semantic priming** — raises the prior on codebase-specific patterns ("this codebase has weird X, don't assume defaults")
4. **Reasoning templates** — past examples become heuristics for new bugs; rationale in "why" prose becomes scaffolding

Compression preserves (1). It destroys (2), (3), (4). That's why a compressed prompt can make an agent measurably worse at codebase-specific reasoning even though the explicit facts are all "still there" in reference files.


**Reference links (`[[path]]`) are NOT equivalent to in-context presence.** They're latent until the agent actively fetches them. An agent only fetches when it already knows it doesn't know. The priming cues that tell it *when* it doesn't know are in the system prompt itself — they can't be replaced by links.

**When to intervene**: Only if the system prompt is *meaningfully* over target. At or near the target, leave it alone. Every edit risks removing content that was doing work you can't see. A prompt that feels "a bit long" is almost always better than one that's been aggressively trimmed.

**Modifying the system prompt**: Make **MINIMAL** changes required to cut the token count of the system prompt if needed. The goal preserve the existing behavior while cutting down the token count. Focus on reducing redundancy or compressing - rather than offloading entire sections to external memory.
- Preserve persona-defining content (who you are, how you communicate)
- Preserve user identity or preferences (e.g. the human's name, their stated goals)
- Maintain the existing distribution of detail: compression should be applied evenly across all topics. If the original prompt was 50% about a specific issue, the new prompt should also be 50% about that issue. 
- Only reduce noise and improve structure - if compression must result in information loss, preserve lost details into external memory

#### Context redundancy and unclear organization 
The context in the memory filesystem should have a clear structure, with a well-defined purpose for each file. Memory file descriptions should be precise and non-overlapping. Their contents should be consistent with the description, and have non-overlapping content to other files. 

**Questions to ask**: 
- Do the descriptions make clear what file is for what? 
- Do the contents of the file match the descriptions? (you can ask subagents to check)

**Solution**: Read all memory files (use subagents for efficiency), then:
- Consolidate redundant files
- Reorganize files and rewrite descriptions to have clear separation of concerns
- Avoid duplication by referencing common files from multiple places (e.g. `[[reference/api]]`)
- Rewrite unclear or low-quality content

#### Invalid context format
Files in the memory filesystem must follow certain structural requirements: 
- Must have a `system/persona.md`
- Must NOT have overlapping file and folder names (e.g. `system/human.md` and `system/human/identity.md`) 
- Must follow specification for skills (e.g. `skills/{skill_name}/`) with the format:
```
skill-name/
├── SKILL.md          # Required: metadata + instructions
├── scripts/          # Optional: executable code
├── references/       # Optional: documentation
├── assets/           # Optional: templates, resources
└── ...               # Any additional files or directories
```

**Solution**: Reorganize files to follow the required structure

### Poor use of progressive disclosure
Only critical information should be in the system prompt, since it's passed on every turn. Use progressive disclosure so that context only *sometimes* needed can be dynamically retrieved.

Files that are outside of `system/` are not part of the system prompt, and must be dynamically loaded. You must index your files to ensure your future self can discover them: for example, make sure that files have informative names and descriptions, or are referenced from parts of your system prompt via `[[path]]` links to create discovery paths. Otherwise, you will never discover the external context or make use of it. 

**Solution**: 
- Reference external skills from the relevant parts of in-context memory:
```
When running a migration, always use the skill [[skills/db-migrations]]
```
or external memory files: 
```
Sarah's active projects are: Letta Code [[projects/letta_code.md]] and Letta Cloud [[projects/letta_cloud]]
```
- Ensure that contents of files match the file name and descriptions 
- Make sure your future self will be able to find and load external files when needed. 

### Step 2: Implement context fixes
Create a plan for what fixes you want to make, then implement them. Favor the smallest possible change that resolves the issue — if the system prompt is 1.5× the target, don't cut it to half the target "for headroom." Cut until you're near the target, then stop.

Before moving on, verify:
- [ ] System prompt token budget reviewed (target ~10% of context, usually 15-20k tokens)
- [ ] Changes are proportional to the problem — only offloaded what's needed to meet the target
- [ ] Preserved detailed rationale, examples, and cross-references in sections that stayed in `system/`
- [ ] Preferred moving whole files or deleting stale sections over compressing detailed sections into summaries
- [ ] No overlapping or redundant files remain
- [ ] All file descriptions are unique, accurate, and match their contents
- [ ] Moved-out knowledge has `[[path]]` references from in-context memory so it can be discovered
- [ ] No semantic changes to persona, user identity, or behavioral instructions

### Step 3: Commit and push
Review changes, then commit with a descriptive message:

```bash
cd $MEMORY_DIR
git status                # Review what changed before staging
git add <specific files>  # Stage targeted paths — avoid blind `git add -A`
git commit --author="<AGENT_NAME> <<ACTUAL_AGENT_ID>@letta.com>" -m "fix(doctor): <summary> 🏥

<identified issues and implemented solutions>"

git push
```

### Step 4: Final checklist and message
Tell the user what issues you identified, the fixes you made, the commit you made, and also recommend that they run `/recompile` to apply these changes to the current system prompt. 

Before finishing make sure you: 
- [ ] Resolved all the identified context issues
- [ ] Pushed your changes successfully 
- [ ] Told the user to run `/recompile` to refresh the system prompt and apply changes

## Critical information 
- **Ask the user about their goals for you, not the implementation**: You understand your own context best, and should follow the guidelines in this document. Do NOT ask the user about their structural preferences — the context is for YOU, not them. Ask them how they want YOU to behave or know instead.
