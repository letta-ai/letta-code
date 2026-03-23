---
name: Context Doctor
id: context_doctor
description: Identity and repair degredation in system prompt, external memory, and skills preventing you from following instructions or remembering information as well as you should.
---

# Context Doctor
Your context is managed by yourself, along with additional memory subagents. Your context includes: 
- Your system prompt and instructions (contained in `system/`)
- Your external memory 
- Your skills (procedural memory) 

Over time, context can degrade - which degrades you and your ability to remember the right things or follow your system instructions properly due to bloat and degraded prompt quality. This skills helps you identity issues with your context window and repair them collaboratively with the user. 

## Operating Procedure

### Step 1: Identifying and resolving context issues 
Explore your memory files to identity issues. In general, you should consider what is confusing to you about your own prompts and context, and resolve the issues. 

Below are additional common issues with context and how they can be resolved: 

### Context quality 
Your system prompt and memory filesystem should be well structured and clear. 

**Questions to ask**: 
- Is my system prompt clear and well formatted? 
- Are there wasteful or unnecessary tokens in my prompts? 
- Do I know when to load which files in my memory filesystem? 

#### System prompt bloat 
Prompts that are compiled as part of the system prompt (contained in `system/`) should only take up about 10% of the total context size, though this is a recommendation, not a hard requirement. Usually this means about 20k tokens. 

Use the following script to evaluate the token usage of the system prompt: 
```bash
python3 scripts/estimate_system_tokens.py --memory-dir "$MEMORY_DIR"
```

**Questions to ask**:
- Do all these tokens need to be passed to the LLM on every turn, or can they be retrieved when needed through being part of external memory of my conversation history? 
- Do any of these prompts confuse or distract me? 
- Am I able to effectively follow critical instructions (e.g. persona information, user preferences) given the current prompt structure and contents? 

**Solution**: Reduce the size of the system prompt if needed: 
- Move files outside of `system/` so they are no longer part of the system prompt
- Compact information to be more information dense or eliminate redundancy
- Leverage progressive disclosure: move some context outside of `system/` and reference it to pull in dynamically

**Warnings**: Do not modify existing behavior with your changes - only offload unnecessary context
- Do not remove important critical information (e.g. the human's name) 
- Do not remove prompting that defines your persona and who you are 

#### Context redundancy and unclear organization 
The context in the memory filesystem should have a clear structure, with a well-defined purpose for each file. Memory file descriptions should be precise and non-overlapping. Their contents should be consistent with the description, and have non-overlapping content to other files. 

**Questions to ask**: 
- Do the descriptions make clear what file is for what? 
- Do the contents of the file match the descriptions? (you can ask subagents to check)

**Solution**: Eliminate redundancy and restructure context 
- Consolidate redundant files 
- Re-organize files and rewrite descriptions and filenames to have clear seperation of concerns
- Avoid redundancy by referencing common files from multiple places  (e.g. `[[reference/api]]`

**Solution**: Read the contents of all your memory files (you can use subagents to be more efficient) to identity poor context quality and rewrite context

#### Invalid context format
Files in the memory filesystem must follow certain structural requirements: 
- Must have a  `system/persona.md`
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
Only critical information should be included in the system prompt, as the prompts are passed as part of the context on every turn. Make use of progressive disclosure so that context that is only *sometimes* neede can be dynamically retrieved. 

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

### Step 3: Commit and push
Commit with a descriptive message about the identified issues and solutions:

```bash
cd $MEMORY_DIR
git add -A
git commit --author="<AGENT_NAME> <<ACTUAL_AGENT_ID>@letta.com>" -m "fix(doctor): <summary> 🔮

<identified issues and implemented solutions>"

git push
```

## Critical information 
- **Ask the user about their goals for you, not the implementation**: You understand your own context best, and should follow the guidelines in this document. Do NOT ask the user about their structural preferences - the context is for YOU, not them. Ask them how they want YOU to behave or know instead. 
