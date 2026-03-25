---
name: Context Doctor
id: context_doctor
description: Identify and repair degradation in system prompt, external memory, and skills preventing you from following instructions or remembering information as well as you should.
---

# Context Doctor
Your context is managed by yourself, along with additional memory subagents. Your context includes: 
- Your system prompt and instructions (contained in `system/`)
- Your external memory 
- Your skills (procedural memory) 

Over time, context can degrade — bloat and poor prompt quality erode your ability to remember the right things and follow instructions properly. This skill helps you identify issues with your context and repair them collaboratively with the user.

## Operating Procedure

### Step 1: Identifying and resolving context issues 
Explore your memory files to identify issues. Consider what is confusing about your own prompts and context, and resolve the issues.

Below are additional common issues with context and how they can be resolved: 

### Context quality 
Your system prompt and memory filesystem should be well structured and clear. 

**Questions to ask**: 
- Is my system prompt clear and well formatted? 
- Are there wasteful or unnecessary tokens in my prompts? 
- Do I know when to load which files in my memory filesystem? 

#### System prompt bloat 
Prompts that are compiled as part of the system prompt (contained in `system/`) should only take up about 10% of the total context size, though this is a recommendation, not a hard requirement. Usually this means about 15-20k tokens. 

Use the following script to evaluate the token usage of the system prompt: 
```bash
bun scripts/estimate_system_tokens.ts --memory-dir "$MEMORY_DIR"
```

**Questions to ask**:
- Do all these tokens need to be passed to the LLM on every turn, or can they be retrieved when needed through being part of external memory of my conversation history? 
- Do any of these prompts confuse or distract me? 
- Am I able to effectively follow critical instructions (e.g. persona information, user preferences) given the current prompt structure and contents? 

**Solution**: Reduce the size of the system prompt if needed: 
- Move files outside of `system/` so they are no longer part of the system prompt
- Compact information to be more information dense or eliminate redundancy
- Leverage progressive disclosure: move some context outside of `system/` and reference it to pull in dynamically

**Scope**: You may refine, tighten, and restructure prompts to improve clarity and adherence — but do not change the intended semantics. The goal is better signal, not different behavior.
- Do not alter persona-defining content (who you are, how you communicate)
- Do not remove or change user identity or preferences (e.g. the human's name, their stated goals)
- Do not rewrite instructions in ways that shift their meaning — only reduce noise and improve structure

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

Files that are outside of `system/` are not part of the system prompt, and must be dynamically loaded. You must index your files to ensure your future self can discover them: for example, make sure that files have informative names and descriptions, or are referenced from parts of your system prompt. Otherwise, you will never discover the external context or make use of it. 

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
Create a plan for what fixes you want to make, then implement them.

Before moving on, verify:
- [ ] System prompt token budget reviewed (target ~10% of context, usually 15-20k tokens)
- [ ] No overlapping or redundant files remain
- [ ] All file descriptions are unique, accurate, and match their contents
- [ ] Moved-out knowledge has references from in-context memory so it can be discovered
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
Tell the user what issues you identitied, the fixes you made, the commit you made, and also recommend that they run `/recompile` to apply these changes to the current system prompt. 

Before finishing make sure you: 
- [ ] Resolved all the identified context issues
- [ ] Pushed your changes successfully 
- [ ] Told the user to run `/recompile` to refresh the system prompt and apply changes

## Critical information 
- **Ask the user about their goals for you, not the implementation**: You understand your own context best, and should follow the guidelines in this document. Do NOT ask the user about their structural preferences - the context is for YOU, not them. Ask them how they want YOU to behave or know instead. 
