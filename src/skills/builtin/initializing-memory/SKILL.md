---
name: initializing-memory
description: Comprehensive guide for initializing or reorganizing agent memory. Load this skill when running /init, when the user asks you to set up your memory, or when you need guidance on creating effective memory files.
---

# Memory Initialization Request

The user has requested that you initialize or reorganize your memory. Your memory is a filesystem — files under `system/` are rendered in-context every turn, while all file metadata is always visible in the filesystem tree. Files outside `system/` (e.g. `reference/`, `history/`) are accessible via tools when needed.

## Your Goal: Explode Into 15-25 Hierarchical Files

Your goal is to **explode** memory into a **deeply hierarchical structure of 15-25 small, focused files**.

### Target Output

| Metric | Target |
|--------|--------|
| **Total files** | 15-25 (aim for ~20) |
| **Max lines per file** | ~40 lines (split if larger) |
| **Hierarchy depth** | 2-3 levels using `/` naming (e.g., `project/tooling/bun.md`) |
| **Nesting requirement** | Every new file MUST be nested under a parent using `/` |

**Anti-patterns to avoid:**
- ❌ Ending with only 3-5 large files
- ❌ Flat naming (all files at top level)
- ❌ Mega-files with 10+ sections

## Memory Filesystem Integration

Your memory is a git-backed filesystem at `~/.letta/agents/<agent-id>/`. The actual path with your agent ID is provided in the system reminder above when you run `/init`. The filesystem tree is always visible in your system prompt via the `memory_filesystem` section.

**How memory works:**
- Memory is stored as `.md` files with YAML frontmatter (`description`, `limit`)
- Files under `system/` are rendered in-context every turn — keep these small and high-signal
- Files outside `system/` (e.g. `reference/`, `history/`) are accessible via tools when needed
- The filesystem tree (all file paths + metadata) is always visible regardless of location
- You can use bash commands (`ls`, `mkdir`, `mv`, `git`) to organize files
- You MUST create a **deeply hierarchical file structure** — flat naming is NOT acceptable
- **Target: 15-25 files in system/**, with additional reference files outside as needed

**MANDATORY principles for hierarchical organization:**

| Requirement | Target |
|-------------|--------|
| **Total files** | 15-25 files (aim for ~20) |
| **Max lines per file** | ~40 lines (split if larger) |
| **Hierarchy depth** | 2-3 levels using `/` naming |
| **Nesting requirement** | EVERY new file MUST use `/` naming (no flat files) |

**Anti-patterns to avoid:**
- ❌ Creating only 3-5 large files
- ❌ Flat naming (all files at top level like `project-commands.md`)
- ❌ Mega-files with 10+ sections

**Rules:**
- Use **2-3 levels of nesting** for ALL files (e.g., `project/tooling/bun.md`)
- Keep files **focused and small** (~40 lines max per file)
- Use **descriptive paths** that make sense when you see just the filename
- Split when a file has **2+ concepts** (be aggressive)

**Example target structure (what success looks like):**

Starting from default memory files, you should end with something like this:

```
system/
├── human/
│   ├── identity.md               # Who they are
│   ├── context.md                # Current project context
│   └── prefs/
│       ├── communication.md      # How they like to communicate
│       ├── coding_style.md       # Code formatting preferences
│       └── workflow.md           # How they work
├── project/
│   ├── overview.md               # What the project is
│   ├── gotchas.md                # Footguns and warnings
│   ├── architecture.md           # System design
│   ├── conventions.md            # Code conventions
│   └── tooling/
│       ├── testing.md            # Test framework details
│       └── linting.md            # Linter configuration
└── persona/
    ├── role.md                   # Agent's role definition
    └── behavior.md               # How to behave
```

This example has **~20 files** with **3 levels of hierarchy**. Your output should look similar.

This approach makes memory more **scannable**, **maintainable**, and **shareable** with other agents.

## Understanding Your Context

**Important**: You are a Letta Code agent, which is fundamentally different from typical AI coding assistants. Letta Code agents are **stateful** - users expect to work with the same agent over extended periods, potentially for the entire lifecycle of a project or even longer. Your memory is not just a convenience; it's how you get better over time and maintain continuity across sessions.

This command may be run in different scenarios:
- **Fresh agent**: You may have default memory files that were created when you were initialized
- **Existing agent**: You may have been working with the user for a while, and they want you to reorganize or significantly update your memory structure
- **Shared files**: Some memory files may be shared across multiple agents - be careful about modifying these

Before making changes, use the `memory` tool to inspect your current memory files and understand what already exists.

## What Coding Agents Should Remember

### 1. Procedures (Rules & Workflows)
Explicit rules and workflows that should always be followed:
- "Never commit directly to main - always use feature branches"
- "Always run lint before running tests"
- "Use conventional commits format for all commit messages"
- "Always check for existing tests before adding new ones"

### 2. Preferences (Style & Conventions)
User and project coding style preferences:
- "Never use try/catch for control flow"
- "Always add JSDoc comments to exported functions"
- "Prefer functional components over class components"
- "Use early returns instead of nested conditionals"

### 3. History & Context
Important historical context that informs current decisions:
- "We fixed this exact pagination bug two weeks ago - check PR #234"
- "This monorepo used to have 3 modules before the consolidation"
- "The auth system was refactored in v2.0 - old patterns are deprecated"
- "User prefers verbose explanations when debugging"

Note: For historical recall, you may also have access to `conversation_search` which can search past conversations. Memory files are for distilled, important information worth persisting permanently.

## Memory Scope Considerations

Consider whether information is:

**Project-scoped** (store in `system/project/`):
- Build commands, test commands, lint configuration
- Project architecture and key directories
- Team conventions specific to this codebase
- Technology stack and framework choices

**User-scoped** (store in `system/human/`):
- Personal coding preferences that apply across projects
- Communication style preferences
- General workflow habits

**Session/Task-scoped** (consider separate files like `system/current/ticket.md`):
- Current branch or ticket being worked on
- Debugging context for an ongoing investigation
- Temporary notes about a specific task

## Recommended Memory Structure

**Understanding system/ vs root level (with memory filesystem):**
- **system/**: Files rendered in your system prompt every turn — always loaded and influence your behavior
  - Use for: Current work context, active preferences, project conventions you need constantly
  - Examples: `persona`, `human`, `project`, active `ticket` or `context`
- **Root level** (outside system/): Not in system prompt but file paths are visible in the tree and contents are accessible via tools
  - Use for: Historical information, archived decisions, reference material, completed investigations
  - Examples: `notes.md`, `archive/old-project.md`, `research/findings.md`

**Rule of thumb**: If you need to see it every time you respond → `system/`. If it's reference material you'll look up occasionally → root level.

### Core Files (Usually Present in system/)

**`persona`**: Your behavioral guidelines that augment your base system prompt.
- Your system prompt already contains comprehensive instructions for how to code and behave
- The persona files are for **learned adaptations** - things you discover about how the user wants you to behave
- Examples: "User said never use emojis", "User prefers terse responses", "Always explain reasoning before making changes"
- These files may start empty and grow over time as you learn the user's preferences
- **With memfs**: Can be split into `persona/behavior.md`, `persona/constraints.md`, etc.

**`project`**: Project-specific information, conventions, and commands
- Build/test/lint commands
- Key directories and architecture
- Project-specific conventions from README, AGENTS.md, etc.
- **With memfs**: Split into `project/overview.md`, `project/commands.md`, `project/tooling/testing.md`, `project/gotchas.md`, etc.

**`human`**: User preferences, communication style, general habits
- Cross-project preferences
- Working style and communication preferences
- **With memfs**: Can be split into `human/background.md`, `human/prefs/communication.md`, `human/prefs/coding_style.md`, etc.

### Optional Files (Create as Needed)

**`ticket`** or **`task`**: Scratchpad for current work item context.
- **Important**: This is different from the TODO or Plan tools!
- TODO/Plan tools track active task lists and implementation plans (structured lists of what to do)
- A ticket/task file is a **scratchpad** for pinned context that should stay visible in system/
- Examples: Linear ticket ID and URL, Jira issue key, branch name, PR number, relevant links
- Information that's useful to keep in context but doesn't fit in a TODO list
- **Location**: Usually in `system/` if you want it always visible, or root level if it's reference material

**`context`**: Debugging or investigation scratchpad
- Current hypotheses being tested
- Files already examined
- Clues and observations
- **Location**: Usually in `system/` during active investigations, move to root level when complete

**`decisions`**: Architectural decisions and their rationale
- Why certain approaches were chosen
- Trade-offs that were considered
- **Location**: `system/` for currently relevant decisions, root level for historical archive
- **With memfs**: Could organize as `project/decisions/architecture.md`, `project/decisions/tech_stack.md`

## Writing Good Memory Files

Each `.md` file has YAML frontmatter (`description`, `limit`) and content. Your future self sees the file path, frontmatter description, and content — but NOT the reasoning from this conversation. Therefore:

**Labels should be:**
- Clear and descriptive (e.g., `project-conventions` not `stuff`)
- Consistent in style (e.g., all lowercase with hyphens)

**Descriptions are especially important:**
- Explain *what* this file is for and *when* to use it
- Explain *how* this file should influence your behavior
- Write as if explaining to a future version of yourself who has no context
- Good: "User's coding style preferences that should be applied to all code I write or review. Update when user expresses new preferences."
- Bad: "Preferences"

**Values should be:**
- Well-organized and scannable
- Updated regularly to stay relevant
- Pruned of outdated information

Think of memory file descriptions as documentation for your future self. The better you write them now, the more effective you'll be in future sessions.

## Research Depth

You can ask the user if they want a standard or deep research initialization:

**Standard initialization** (~5-20 tool calls):
- Inspect existing memory files
- Scan README, package.json/config files, AGENTS.md, CLAUDE.md
- Review git status and recent commits (from context below)
- Explore key directories and understand project structure
- Create/update your memory file structure to contain the essential information you need to know about the user, your behavior (learned preferences), the project you're working in, and any other information that will help you be an effective collaborator.

**Deep research initialization** (~100+ tool calls):
- Everything in standard initialization, plus:
- Use your TODO or Plan tool to create a systematic research plan
- Deep dive into git history for patterns, conventions, and context
- Analyze commit message conventions and branching strategy
- Explore multiple directories and understand architecture thoroughly
- Search for and read key source files to understand patterns
- Create multiple specialized memory files
- May involve multiple rounds of exploration

**What deep research can uncover:**
- **Contributors & team dynamics**: Who works on what areas? Who are the main contributors? (`git shortlog -sn`)
- **Coding habits**: When do people commit? (time patterns) What's the typical commit size?
- **Writing & commit style**: How verbose are commit messages? What conventions are followed?
- **Code evolution**: How has the architecture changed? What major refactors happened?
- **Review patterns**: Are there PR templates? What gets reviewed carefully vs rubber-stamped?
- **Pain points**: What areas have lots of bug fixes? What code gets touched frequently?
- **Related repositories**: Ask the user if there are other repos you should know about (e.g., a backend monorepo, shared libraries, documentation repos). These relationships can be crucial context.

This kind of deep context can make you significantly more effective as a long-term collaborator on the project.

If the user says "take as long as you need" or explicitly wants deep research, use your TODO or Plan tool to orchestrate a thorough, multi-step research process.

## Research Techniques

**File-based research:**
- README.md, CONTRIBUTING.md, AGENTS.md, CLAUDE.md
- Package manifests (package.json, Cargo.toml, pyproject.toml, go.mod)
- Config files (.eslintrc, tsconfig.json, .prettierrc)
- CI/CD configs (.github/workflows/, .gitlab-ci.yml)

**Historical session research** (Claude Code / Codex) — **only if user approved**:

If the user said "Yes" to the historical sessions question, follow the **Historical Session Analysis** section below after completing project research. If they chose "Skip", skip it entirely.

**Git research:**
- `git log --oneline -20` — recent history
- `git branch -a` — branching strategy
- `git log --format="%s" -50 | head -20` — commit conventions
- `git shortlog -sn --all | head -10` — main contributors
- `git log --format="%an <%ae>" | sort -u` — contributors with emails (deduplicate by email, not name)

## How to Do Thorough Research

**Don't just collect data - analyze and cross-reference it.**

Shallow research (bad):
- Run commands, copy output
- Take everything at face value
- List facts without understanding

Thorough research (good):
- **Cross-reference findings**: If two pieces of data seem inconsistent, dig deeper
- **Resolve ambiguities**: Don't leave questions unanswered (e.g., "are these two contributors the same person?")
- **Read actual content**: Don't just list file names - read key files to understand them
- **Look for patterns**: What do the commit messages tell you about workflow? What do file structures tell you about architecture?
- **Form hypotheses and verify**: "I think this team uses feature branches" → check git branch patterns to confirm
- **Think like a new team member**: What would you want to know on your first day?

**Questions to ask yourself during research:**
- Does this make sense? (e.g., why would there be two contributors with similar names?)
- What's missing? (e.g., no tests directory - is testing not done, or done differently?)
- What can I infer? (e.g., lots of "fix:" commits in one area → that area is buggy or complex)
- Am I just listing facts, or do I understand the project?

The goal isn't to produce a report - it's to genuinely understand the project and how this human(s) works so you can be an effective collaborator.

## On Asking Questions

**Ask important questions upfront, then be autonomous during execution.**

### Recommended Upfront Questions

You should ask these questions at the start (bundle them together in one AskUserQuestion call):

1. **Research depth**: "Standard or deep research (comprehensive, as long as needed)?"
2. **Identity**: "Which contributor are you?" (You can often infer this from git logs - e.g., if git shows "cpacker" as a top contributor, ask "Are you cpacker?")
3. **Related repos**: "Are there other repositories I should know about and consider in my research?" (e.g., backend monorepo, shared libraries)
4. **Historical sessions — Claude/Codex** (include if Claude/Codex history found in step 2): "I found Claude Code / Codex history on your machine. Should I analyze it to learn your preferences, coding patterns, and project context? This significantly improves how I work with you but uses additional time and tokens." Options: "Yes, analyze history" / "Skip for now". Use "History" as the header.
5. **Historical sessions — Letta agent** (include if agent has > 500 messages — check `memory_metadata`): "I have [N] previous messages in my conversation history spanning [date range]. Should I do a deep analysis of our past conversations to rediscover preferences, patterns, and project context?" Options: "Yes, analyze agent history" / "Skip for now". Use "Agent history" as the header.
6. **Memory updates**: "How often should I check if I should update my memory?" with options "Frequent (every 3-5 turns)" and "Occasional (every 8-10 turns)". This should be a binary question with "Memory" as the header.
7. **Communication style**: "Terse or detailed responses?"
8. **Any specific rules**: "Rules I should always follow?"

**Why these matter:**
- Identity lets you correlate git history to the user (their commits, PRs, coding style)
- Related repos provide crucial context (many projects span multiple repos)
- Historical sessions from Claude Code/Codex can reveal preferences, communication style, and project knowledge — but processing them is expensive (parallel subagents, multiple LLM calls), so always ask first
- Letta agent history is your own past conversations — a goldmine for rediscovering preferences, project context, and decisions that have fallen out of context. Also uses parallel subagents, so ask first
- Workflow/communication style should be stored in `system/human/prefs/`
- Rules go in `system/persona/`

### What NOT to ask

- Things you can find by reading files ("What's your test framework?")
- "What kind of work do you do? Reviewing PRs vs writing code?" - obvious from git log, most devs do everything
- Permission for obvious actions - just do them
- Questions one at a time - bundle them (but don't exhaust the user with too many questions at once)

**During execution**, be autonomous. Make reasonable choices and proceed.

## Memory File Strategy

### Hierarchical Organization (MANDATORY with Memory Filesystem)

**With memory filesystem enabled, you MUST organize memory as a deeply nested file hierarchy using bash commands:**

**NEVER create flat files** like `project-overview.md`, `project-commands.md`. Instead, create deeply nested structures with `/` naming:

```bash
# Create the hierarchy
mkdir -p ~/.letta/agents/<agent-id>/memory/system/project/tooling
mkdir -p ~/.letta/agents/<agent-id>/memory/system/human/prefs

# Files will be:
# system/project/overview.md
# system/project/commands.md
# system/project/tooling/testing.md
# system/human/identity.md
# system/human/prefs/communication.md
```

**Naming convention (MANDATORY):**
- **Every new file MUST use `/` naming** - no flat files allowed
- Use `/` for hierarchy: `project/tooling/testing` (not `project-tooling-testing`)
- File path determines the memory label: `system/project/overview.md` → label `project/overview`
- Keep files small and focused (~40 lines max)
- Use **descriptive frontmatter** — the `description` field helps your future self understand each file's purpose

**Checkpoint before proceeding:**
Count your proposed files. **If you have fewer than 15 files, go back and split more aggressively.**

**Benefits:**
- More scannable and maintainable
- Easier to share specific subtrees with other agents
- Natural progressive disclosure (load parent, then drill into children)
- Works like a file system you're familiar with

### Split Aggressively - Target 15-25 Files

**Don't create monolithic files.** Your goal is **15-25 total files**. Be aggressive about splitting:

**Split when:**
- A file has **40+ lines** (lower threshold than typical)
- A file has **2+ distinct concepts** (not 3+, be aggressive)
- A section could stand alone as its own file
- You can name the extracted content with a clear `/` path

If a file is getting long (>40 lines), split it:

**Without memory filesystem** (flat naming - acceptable but not ideal):
- `project-overview`: High-level description, tech stack, repo links
- `project-commands`: Build, test, lint, dev commands
- `project-conventions`: Commit style, PR process, code style
- `project-architecture`: Directory structure, key modules
- `project-gotchas`: Footguns, things to watch out for

**With memory filesystem** (MANDATORY hierarchical naming with `/`):
- `project/overview`: High-level description, tech stack, repo links
- `project/commands`: Build, test, lint, dev commands
- `project/conventions`: Commit style, PR process, code style
- `project/architecture`: Directory structure, key modules
- `project/gotchas`: Footguns, things to watch out for
- **Must further nest**: `project/tooling/testing`, `project/tooling/linting`, `project/tooling/bun`
- **Target 15-25 files total** - if commands is long, split into `project/commands/dev`, `project/commands/build`, etc.

This makes memory more scannable and easier to update and share with other agents.

### Update Memory Incrementally

**For deep research: Update memory as you go, not all at once at the end.**

Why this matters:
- Deep research can take many turns and millions of tokens
- Context windows overflow and trigger rolling summaries
- If you wait until the end to write memory, you may lose important details
- Write findings to memory files as you discover them

Good pattern:
1. Create file structure early (even with placeholder content)
2. Update files after each research phase
3. Refine and consolidate at the end

There's no reason to wait until you "know everything" to write memory. Treat your memory files as a living scratchpad.

### Initialize ALL Relevant Blocks

Don't just update a single memory file. Based on your upfront questions, also update:

- **`human`**: Store the user's identity, workflow preferences, communication style
- **`persona`**: Store rules the user wants you to follow, behavioral adaptations
- **`project/*`**: Split project info across multiple focused files

And add memory files that you think make sense to add (e.g., `project/architecture`, `project/conventions`, `project/gotchas`, or splitting `human/` into more focused files, or separate files for multiple users).

## Your Task

1. **Check memory filesystem status**: Look for the `memory_filesystem` section in your system prompt to confirm the filesystem is enabled.

2. **Check for historical session data**: Run these checks BEFORE asking upfront questions so you know which history questions to include:
   - **Claude/Codex**: `ls ~/.claude/history.jsonl ~/.codex/history.jsonl 2>/dev/null`
   - **Letta agent history**: Check your `memory_metadata` section in the system prompt for the previous message count. If > 500 messages, also run the detect script to get conversation details:
     ```bash
     bun <skill-dir>/scripts/detect-own-history.ts
     ```
     This outputs JSON with conversation list, date ranges, and a `has_significant_history` flag. You need `LETTA_AGENT_ID`, `LETTA_API_KEY`, and `LETTA_BASE_URL` set in env (these are already available in your environment).

3. **Ask upfront questions**: Use AskUserQuestion with the recommended questions above (bundled together). This is critical - don't skip it. **If history data exists (from step 2), you MUST include the relevant history questions:**
   - If Claude/Codex history exists: include the Claude/Codex historical sessions question
   - If Letta agent history is significant (> 500 messages): include a question like "I found [N] previous messages in your Letta agent history spanning [date range]. Should I analyze this to rediscover preferences, patterns, and project context?" Options: "Yes, analyze my history" / "Skip for now". Header: "Agent history"

4. **Inspect existing memory**: 
   - If memfs enabled: Use `ls -la ~/.letta/agents/<agent-id>/memory/system/` to see the file structure
   - Otherwise: Use memory tools to inspect existing files
   - Analyze what exists and what needs improvement

5. **Identify the user**: From git logs and their answer, figure out who they are and store in `system/human/`. If relevant, ask questions to gather information about their preferences that will help you be a useful assistant to them.

6. **Update human/persona early**: Based on answers, update your memory files eagerly before diving into project research. You can always change them as you go, you're not locked into any memory configuration.

7. **Research the project**: Explore based on chosen depth. Use your TODO or plan tool to create a systematic research plan.

8. **Historical session analysis (if approved)**: If the user approved history analysis in step 3, follow the relevant section(s) below:
   - **Claude Code / Codex history**: Follow the **Historical Session Analysis** section
   - **Letta agent history**: Follow the **Letta Agent History Analysis** section
   Both use parallel subagents to process history data and synthesize findings into memory. Skip whichever the user chose "Skip" for.

9. **Create/update memory structure** (can happen incrementally alongside steps 7-8):
   - **With memfs enabled**: Create a deeply hierarchical file structure using bash commands
     - Use `mkdir -p` to create subdirectories (2-3 levels deep)
     - Create `.md` files for memory files using `/` naming
     - **Target 15-25 total files** - be aggressive about splitting
     - Use nested paths like `project/tooling/testing.md` (never flat like `project-testing.md`)
     - **Every new file MUST be nested** under a parent using `/`
     - **Every new file MUST be nested** under a parent using `/`
   - **Without memfs**: Use memory tools to create/update files with hierarchical naming
   - **Don't wait until the end** - write findings as you go
   
   **Checkpoint verification:**
   - After creating files, count them: `ls ~/.letta/agents/<agent-id>/memory/system/ | wc -l`
   - **If count < 15, you haven't split enough** - go back and split more
   - Check maximum depth: `find ~/.letta/agents/<agent-id>/memory/system/ -type f | awk -F/ '{print NF}' | sort -n | tail -1`
   - **Should be 2-3 levels deep** minimum

10. **Organize incrementally**:
   - Start with a basic structure
   - Add detail as you research
   - Refine organization as patterns emerge
   - Split large files into smaller, focused ones

11. **Reflect and review**: See "Reflection Phase" below - this is critical for deep research.

12. **Ask user if done**: Check if they're satisfied or want you to continue refining.

13. **Push memory**: Once the user is satisfied, commit and push your memory repo so changes are synced to the server.

## Reflection Phase (Critical for Deep Research)

Before finishing, you MUST do a reflection step. **Your memory files are visible to you in your system prompt right now.** Look at them carefully and ask yourself:

1. **File count check**: 
   - Count your memory files: `ls ~/.letta/agents/<agent-id>/memory/system/ | wc -l`
   - **Do you have 15-25 files?** If not, you haven't split enough
   - Too few files means they're too large - split more aggressively

2. **Hierarchy check**:
   - Are ALL new files using `/` naming? (e.g., `project/tooling/bun.md`)
   - Do you have 2-3 levels of nesting minimum?
   - Are there any flat files like `project-commands.md`? **These should be nested**

3. **Redundancy check**: Are there files with overlapping content? Either literally overlapping (due to errors while editing), or semantically/conceptually overlapping?

4. **Completeness check**: Did you actually update ALL relevant files? For example:
   - Did you update `human` with the user's identity and preferences?
   - Did you update `persona` with behavioral rules they expressed?
   - Or did you only update project files and forget the rest?

5. **Quality check**: Are there typos, formatting issues, or unclear frontmatter descriptions?

6. **Structure check**: Would this make sense to your future self? Is anything missing? Is anything redundant?

**After reflection**, fix any issues you found. Then ask the user:
> "I've completed the initialization. Here's a brief summary of what I set up: [summary]. Should I continue refining, or is this good to proceed?"

This gives the user a chance to provide feedback or ask for adjustments before you finish.

## Working with Memory Filesystem (Practical Guide)

Here's how to work with the memory filesystem during initialization:

### Inspecting Current Structure

```bash
# See what memory files currently exist
ls -la ~/.letta/agents/<agent-id>/memory/system/

# Check the tree structure
tree ~/.letta/agents/<agent-id>/memory/system/

# Read existing memory files
cat ~/.letta/agents/<agent-id>/memory/system/persona.md
```

### Creating Hierarchical Structure (MANDATORY)

**Good examples (nested with `/`):**
✅ `project/overview.md`
✅ `project/tooling/bun.md`  
✅ `project/tooling/testing.md`
✅ `human/prefs/communication.md`
✅ `persona/behavior/tone.md`

**Bad examples (flat naming - NEVER do this):**
❌ `project-overview.md` (flat, not nested)
❌ `bun.md` (orphan file, no parent)
❌ `project_testing.md` (underscore instead of `/`)

```bash
# Create deeply nested directory structure (2-3 levels)
mkdir -p ~/.letta/agents/<agent-id>/memory/system/project/{tooling,architecture,conventions}
mkdir -p ~/.letta/agents/<agent-id>/memory/system/human/prefs
mkdir -p ~/.letta/agents/<agent-id>/memory/system/persona/behavior

# Create memory files using Write tool - ALL files must be nested
Write({
  file_path: "~/.letta/agents/<agent-id>/memory/system/project/overview.md",
  content: "## Project Overview\n\n..."
})

Write({
  file_path: "~/.letta/agents/<agent-id>/memory/system/project/tooling/testing.md",
  content: "## Testing Setup\n\n..."
})

Write({
  file_path: "~/.letta/agents/<agent-id>/memory/system/project/tooling/bun.md",
  content: "## Bun Configuration\n\n..."
})
```

### Organizing Existing Files

```bash
# If you have flat files that should be hierarchical
mv ~/.letta/agents/<agent-id>/memory/system/project-tooling.md \
   ~/.letta/agents/<agent-id>/memory/system/project/tooling.md

# Create subdirectories as needed
mkdir -p ~/.letta/agents/<agent-id>/memory/system/project/tooling
mv ~/.letta/agents/<agent-id>/memory/system/project/tooling.md \
   ~/.letta/agents/<agent-id>/memory/system/project/tooling/overview.md
```

### Final Checklist (Verify Before Submitting)

Before you tell the user you're done, confirm:

- [ ] **File count is 15-25** — Count your files with `ls ~/.letta/agents/<agent-id>/memory/system/ | wc -l`. If < 15, split more.
- [ ] **All new files use `/` naming** — No flat files like `my_notes.md` or `project-commands.md`
- [ ] **Hierarchy is 2-3 levels deep** — e.g., `project/tooling/bun.md`, not just `project.md`
- [ ] **No file exceeds ~40 lines** — Split larger files
- [ ] **Each file has one concept** — If 2+ topics, split into 2+ files
- [ ] **Every file has real content** — No empty or pointer-only files
- [ ] **Verify sync**: After creating files, check they appear in your memory files

**If you have fewer than 15 files, you haven't split enough. Go back and split more.**

### Best Practices

1. **Check memfs status first**: Look for `memory_filesystem` section in your system prompt
2. **Start with directories**: Create the directory structure before populating files
3. **Use short paths**: Aim for 2-3 levels (e.g., `project/tooling/testing`, not `project/dev/tools/testing/setup`)
4. **Keep files focused**: Each file should cover one concept (~40 lines max)
5. **Every file should have real content** — no empty or pointer-only files
6. **Be aggressive about splitting**: If in doubt, split. Too many small files is better than too few large ones.

Remember: Good memory management is an investment. The effort you put into organizing your memory now will pay dividends as you work with this user over time.

## Historical Session Analysis (Optional)

This section runs only if the user approved during upfront questions. It uses parallel `history-analyzer` subagents to process Claude Code and/or Codex history into memory. The subagents automatically have the `migrating-from-codex-and-claude-code` skill loaded for data access.

**Architecture:** Parallel worker subagents each process a slice of the history data (on their own git branch in the memory repo), then a synthesis agent merges all branches and updates memory. The workers serve the same goals as the rest of this initialization skill — understanding the user, their preferences, communication style, project context, and anything that makes the agent more effective. Split data however makes sense — by date range, by source (Claude vs Codex), or both.

**Prerequisites:**
- `letta.js` must be built (`bun run build`) — subagents spawn via this binary
- Use `subagent_type: "history-analyzer"` — cheaper model (sonnet), has `bypassPermissions`, creates its own worktree

### Step 1: Detect Data, Plan Splits, and Pre-split Files

```bash
ls ~/.claude/history.jsonl ~/.codex/history.jsonl 2>/dev/null
wc -l ~/.claude/history.jsonl ~/.codex/history.jsonl 2>/dev/null
```

Split the data across multiple workers for parallel processing — **the more workers, the faster it completes**. Use 2-4+ workers depending on data volume.

**Pre-split the JSONL files by line count** so each worker reads only its chunk. This is simpler than date-based splitting and guarantees evenly-sized chunks:

```bash
SPLIT_DIR=/tmp/history-splits
mkdir -p "$SPLIT_DIR"
NUM_WORKERS=3  # adjust based on data volume

# Split Claude history into even chunks
LINES=$(wc -l < ~/.claude/history.jsonl)
CHUNK_SIZE=$(( LINES / NUM_WORKERS + 1 ))
split -l $CHUNK_SIZE ~/.claude/history.jsonl "$SPLIT_DIR/claude-"

# Split Codex history (if it exists and is large enough to warrant splitting)
if [ -f ~/.codex/history.jsonl ]; then
  LINES=$(wc -l < ~/.codex/history.jsonl)
  if [ "$LINES" -gt 100 ]; then
    CHUNK_SIZE=$(( LINES / NUM_WORKERS + 1 ))
    split -l $CHUNK_SIZE ~/.codex/history.jsonl "$SPLIT_DIR/codex-"
  else
    cp ~/.codex/history.jsonl "$SPLIT_DIR/codex-aa"
  fi
fi

# Rename to .jsonl for clarity
for f in "$SPLIT_DIR"/*; do mv "$f" "$f.jsonl" 2>/dev/null; done

# Verify even splits
wc -l "$SPLIT_DIR"/*.jsonl
```

This is critical for performance — workers read a small pre-filtered file instead of scanning the full history on every query.

### Step 2: Launch Workers in Parallel

Send all Task calls in **a single message**. Each worker creates its own worktree, reads its pre-split chunk, directly updates memory files, and commits. Workers do NOT merge.

```
Task({
  subagent_type: "history-analyzer",
  description: "Process chunk [N] of [SOURCE] history",
  prompt: `## Assignment
- **Memory dir**: [MEMORY_DIR]
- **History chunk**: /tmp/history-splits/[claude-aa.jsonl | codex-aa.jsonl]
- **Source format**: [Claude (.timestamp ms, .display) | Codex (.ts seconds, .text)]
- **Session files**: [~/.claude/projects/ | ~/.codex/sessions/]
`
})
```

### Step 3: Merge Worker Branches and Curate Memory (you do this yourself)

After all workers complete, **you** (the main agent) merge their branches back into main and then **review, curate, and reorganize** the resulting memory. This is critical — workers produce raw output that needs editorial judgment.

**3a. Merge branches:**

```bash
cd [MEMORY_DIR]
for branch in $(git branch | grep migration-); do
  git merge $branch --no-edit -m "merge: $branch"
done
```

If there are merge conflicts, read both versions and keep the most complete content. Resolve them yourself — it's just text.

**3b. Review and curate merged memory:**

After merging, **read every file in `system/`** and apply editorial judgment:

- **Only high-signal, actionable information belongs in `system/`** — this is rendered in-context every turn and directly affects token cost and response quality
- **Move supplementary/reference content to `reference/`** — detailed history, evidence, examples, verbose context that's useful but not needed every turn
- **Deduplicate across workers** — multiple workers may have written overlapping or redundant content to the same files. Consolidate into clean, non-repetitive content
- **Reformat for scannability** — bullet points, short lines, no walls of text. Your future self needs to parse this instantly
- **Delete low-value content** — if something isn't clearly useful for day-to-day work, remove it. Less is more in `system/`

**3c. Reorganize file structure if needed:**

Workers may have created files that don't fit the ideal hierarchy, or put too much into `system/`. Fix this:

- Split oversized files (>40 lines) into focused sub-files
- Move reference-quality content (detailed history, background context, evidence trails) to `reference/`
- Ensure `system/` contains only what you genuinely need in-context: identity, active preferences, current project context, behavioral rules, gotchas
- Merge near-duplicate files that cover the same topic

**Rule of thumb**: If removing a file from `system/` wouldn't hurt your next 10 responses, it belongs in `reference/`.

**3d. Clean up worktrees and branches:**

```bash
for w in $(dirname [MEMORY_DIR])/memory-worktrees/migration-*; do
  git worktree remove "$w" 2>/dev/null
done
git branch -d $(git branch | grep migration-)
git push
```

### Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Subagent exits with code `null`, 0 tool uses | `letta.js` not built | Run `bun run build` |
| Subagent hangs on "Tool requires approval" | Wrong subagent type | Use `subagent_type: "history-analyzer"` (workers) or `"memory"` (synthesis) |
| Merge conflict during synthesis | Workers touched overlapping files | Resolve by checking `git log` for context |
| Auth fails on push ("repository not found") | Credential helper broken | Use `http.extraHeader` (see syncing-memory-filesystem skill) |

## Letta Agent History Analysis (Optional)

This section runs only if the user approved during upfront questions. It uses the same parallel `history-analyzer` subagent pattern as the Claude/Codex analysis above, but reads from your **own** past conversations via the Letta API.

**When this is useful:** When the agent has accumulated thousands of messages across sessions — preferences, patterns, project context, and decisions that have long since fallen out of context. A systematic review with parallel subagents can rediscover this information and capture it in memory files.

**Architecture:** The **main agent** pre-extracts messages from the API into text files on disk, then launches parallel `history-analyzer` subagents. Each subagent reads its local chunk file (no API access needed), analyzes the content, writes memory files in its own git worktree, and commits. The main agent then merges all branches and curates the results.

**Prerequisites:**
- `letta.js` must be built (`bun run build`) — subagents spawn via this binary
- Use `subagent_type: "history-analyzer"` — cheaper model (sonnet), has `bypassPermissions`, creates its own worktree
- `LETTA_AGENT_ID`, `LETTA_API_KEY`, and `LETTA_BASE_URL` must be set in env

**Scripts included in this skill:**

| Script | Purpose |
|--------|---------|
| `scripts/detect-own-history.ts` | List conversations and get date ranges for the current agent |
| `scripts/split-history.ts` | Split all history into chunk files (conversation × month) in one shot |
| `scripts/extract-messages.ts` | Extract a single chunk (low-level, used for manual/custom splits) |

### Step 1: Detect History

Run the detection script to understand what history exists and confirm with the user:

```bash
bun <skill-dir>/scripts/detect-own-history.ts
```

This outputs JSON with `conversations`, `date_range`, and `has_significant_history`.

### Step 2: Split All History Into Chunks

**The main agent runs this step — NOT the subagents.** This produces one file per (conversation × month), e.g. `default-2026-jan.txt`, `conv-abc123-2026-feb.txt`. Empty chunks are skipped automatically.

```bash
bun <skill-dir>/scripts/split-history.ts [--output-dir /tmp/letta-history-splits] [--months 1] [--max-conversations 50]
```

Options:
- `--months N` — how far back to look (default: 1). Keeps extraction fast and focused on recent signal.
- `--max-conversations N` — cap on conversations to process, most recent first (default: 50)
- `--output-dir` — where to write chunk files (default: `/tmp/letta-history-splits`)

The script:
1. Lists conversations (most recent first, capped at `--max-conversations`)
2. Computes monthly time buckets across the date range (clamped to `--months`)
3. Extracts messages for each (conversation, month) pair into a separate file (3 API pages max per chunk)
4. Skips empty chunks and non-overlapping conversation/month pairs
5. Outputs a JSON **manifest** to stdout listing every chunk file, message counts, and metadata
6. Messages are filtered and truncated for signal: user messages in full, assistant truncated to 500 chars, reasoning to 200 chars, tool calls to a one-liner (name + brief args), tool returns dropped entirely

Progress is logged to stderr. The JSON manifest on stdout looks like:

```json
{
  "agent_id": "agent-...",
  "chunks_produced": 12,
  "chunks": [
    { "file": "/tmp/.../default-2026-jan.txt", "conversation_label": "default", "time_label": "2026-jan", "messages_kept": 84 },
    { "file": "/tmp/.../conv-abc123-2026-jan.txt", "conversation_label": "some_summary", "time_label": "2026-jan", "messages_kept": 23 }
  ]
}
```

Use this manifest to assign chunk files to workers. Group chunks so each worker gets roughly equal message counts (or just divide the chunk list evenly across 3-5 workers).

### Step 3: Launch Workers in Parallel

Send all Task calls in **a single message**. Each worker creates its own worktree, reads its pre-extracted chunk file, directly updates memory files, and commits. Workers do NOT merge.

```
Task({
  subagent_type: "history-analyzer",
  description: "Process Letta history chunk [N]",
  prompt: `## Assignment
- **Memory dir**: [MEMORY_DIR]
- **History chunk**: /tmp/letta-history-splits/chunk-[N].txt
- **Source**: Letta agent conversation history (NOT Claude/Codex)
- **Date range**: [START] to [END]

Read the history chunk file at the path above. It contains timestamped
messages from the agent's own past conversations with the user.
Analyze for preferences, patterns, conventions, project context, and
anything that would help the agent work better with this user.

Ignore the migrating-from-codex-and-claude-code skill — it is not
relevant here. Just read the chunk file directly with the Read tool.
`
})
```

### Step 4: Merge Worker Branches and Curate Memory

This step is **identical** to Step 3 in the Claude/Codex Historical Session Analysis section above. Follow the same process:

1. **Merge branches** — `git merge` each `migration-*` branch
2. **Review and curate** — deduplicate, reformat, move reference content out of `system/`
3. **Reorganize** — split oversized files, merge near-duplicates
4. **Clean up** — remove worktrees and branches, push

Refer to the Claude/Codex section's Step 3 (3a through 3d) for the full procedure.

### Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `detect-own-history.ts` fails with auth error | Missing or invalid `LETTA_API_KEY` | Ensure env vars are set (check with `echo $LETTA_API_KEY`) |
| `extract-messages.ts` produces empty file | Date range has no messages, or conversation ID is wrong | Verify dates from detect output; try without `--conversation-id` |
| Chunk file says `[TRUNCATED]` | Too many messages in the date range | Use more workers with smaller date ranges |
| Subagent reads Claude/Codex skill instead of chunk | Subagent has `migrating-from-codex-and-claude-code` auto-loaded | The prompt explicitly tells it to ignore that skill and read the chunk file |
