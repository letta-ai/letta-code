# Memory Initialization Request

The user has requested that you initialize or reorganize your memory state. You have access to the `memory` tool which allows you to create, edit, and manage memory blocks.

## Understanding Your Context

**Important**: You are a Letta Code agent, which is fundamentally different from typical AI coding assistants. Letta Code agents are **stateful** - users expect to work with the same agent over extended periods, potentially for the entire lifecycle of a project or even longer. Your memory is not just a convenience; it's how you get better over time and maintain continuity across sessions.

This command may be run in different scenarios:
- **Fresh agent**: You may have default memory blocks that were created when you were initialized
- **Existing agent**: You may have been working with the user for a while, and they want you to reorganize or significantly update your memory structure
- **Shared blocks**: Some memory blocks may be shared across multiple agents - be careful about modifying these

Before making changes, use the `memory` tool to inspect your current memory blocks and understand what already exists.

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

Note: For historical recall, you may also have access to `conversation_search` which can search past conversations. Memory blocks are for distilled, important information worth persisting permanently.

## Memory Scope Considerations

Consider whether information is:

**Project-scoped** (store in `project` block):
- Build commands, test commands, lint configuration
- Project architecture and key directories
- Team conventions specific to this codebase
- Technology stack and framework choices

**User-scoped** (store in `human` block):
- Personal coding preferences that apply across projects
- Communication style preferences
- General workflow habits

**Session/Task-scoped** (consider separate blocks like `ticket` or `context`):
- Current branch or ticket being worked on
- Debugging context for an ongoing investigation
- Temporary notes about a specific task

## Recommended Memory Structure

### Core Blocks (Usually Present)

**`persona`**: Your behavioral guidelines that augment your base system prompt.
- Your system prompt already contains comprehensive instructions for how to code and behave
- The persona block is for **learned adaptations** - things you discover about how the user wants you to behave
- Examples: "User said never use emojis", "User prefers terse responses", "Always explain reasoning before making changes"
- This block may start empty and grow over time as you learn the user's preferences

**`project`**: Project-specific information, conventions, and commands
- Build/test/lint commands
- Key directories and architecture
- Project-specific conventions from README, AGENTS.md, etc.

**`human`**: User preferences, communication style, general habits
- Cross-project preferences
- Working style and communication preferences

### Optional Blocks (Create as Needed)

**`ticket`** or **`task`**: Scratchpad for current work item context.
- **Important**: This is different from the TODO or Plan tools!
- TODO/Plan tools track active task lists and implementation plans (structured lists of what to do)
- A ticket/task memory block is a **scratchpad** for pinned context that should stay visible
- Examples: Linear ticket ID and URL, Jira issue key, branch name, PR number, relevant links
- Information that's useful to keep in context but doesn't fit in a TODO list

**`context`**: Debugging or investigation scratchpad
- Current hypotheses being tested
- Files already examined
- Clues and observations

**`decisions`**: Architectural decisions and their rationale
- Why certain approaches were chosen
- Trade-offs that were considered

## Writing Good Memory Blocks

**This is critical**: In the future, you (or a future version of yourself) will only see three things about each memory block:
1. The **label** (name)
2. The **description**
3. The **value** (content)

The reasoning you have *right now* about why you're creating a block will be lost. Your future self won't easily remember this initialization conversation (it can be searched, but it will no longer be in-context). Therefore:

**Labels should be:**
- Clear and descriptive (e.g., `project-conventions` not `stuff`)
- Consistent in style (e.g., all lowercase with hyphens)

**Descriptions are especially important:**
- Explain *what* this block is for and *when* to use it
- Explain *how* this block should influence your behavior
- Write as if explaining to a future version of yourself who has no context
- Good: "User's coding style preferences that should be applied to all code I write or review. Update when user expresses new preferences."
- Bad: "Preferences"

**Values should be:**
- Well-organized and scannable
- Updated regularly to stay relevant
- Pruned of outdated information

Think of memory block descriptions as documentation for your future self. The better you write them now, the more effective you'll be in future sessions.

## Research Depth

You can ask the user if they want a standard or deep research initialization:

**Standard initialization** (~3-5 minutes):
- Inspect existing memory blocks
- Scan README, package.json/config files, AGENTS.md, CLAUDE.md
- Review git status and recent commits (from context below)
- Explore key directories and understand project structure
- Create/update project memory block with essential info
- Only ask questions if genuinely uncertain about something important

**Deep research initialization** (~10-20+ minutes):
- Everything in standard initialization, plus:
- Use your TODO or Plan tool to create a systematic research plan
- Deep dive into git history for patterns, conventions, and context
- Analyze commit message conventions and branching strategy
- Explore multiple directories and understand architecture thoroughly
- Search for and read key source files to understand patterns
- Create multiple specialized memory blocks
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

**Git-based research** (if in a git repo):
- `git log --oneline -20` - Recent commit history and patterns
- `git branch -a` - Branching strategy
- `git log --format="%s" -50 | head -20` - Commit message conventions
- `git shortlog -sn --all | head -10` - Main contributors
- Recent PRs or merge commits for context on ongoing work

## On Asking Questions

**Ask important questions upfront, then be autonomous during execution.**

### Recommended Upfront Questions

You should ask these questions at the start (bundle them together in one AskUserQuestion call):

1. **Research depth**: "Standard (~5 min) or deep research (~15-20 min)?"
2. **Identity**: "Which contributor are you?" (You can often infer this from git logs - e.g., if git shows "cpacker" as a top contributor, ask "Are you cpacker?")
3. **Related repos**: "Are there other repositories I should know about?" (e.g., backend monorepo, shared libraries)
4. **Workflow style**: "How proactive should I be?" (auto-commit vs ask-first)
5. **Communication style**: "Terse or detailed responses?"
6. **Any specific rules**: "Rules I should always follow?"

**Why these matter:**
- Identity lets you correlate git history to the user (their commits, PRs, coding style)
- Related repos provide crucial context (many projects span multiple repos)
- Workflow/communication style should be stored in the `human` block
- Rules go in `persona` block

### What NOT to ask

- Things you can find by reading files ("What's your test framework?")
- "What kind of work do you do? Reviewing PRs vs writing code?" - obvious from git log, most devs do everything
- Permission for obvious actions - just do them
- Questions one at a time - bundle them (but don't exhaust the user with too many questions at once)

**During execution**, be autonomous. Make reasonable choices and proceed.

## Memory Block Strategy

### Split Large Blocks

**Don't create monolithic blocks.** If a block is getting long (>50-100 lines), split it:

Instead of one huge `project` block, consider:
- `project-overview`: High-level description, tech stack, repo links
- `project-commands`: Build, test, lint, dev commands
- `project-conventions`: Commit style, PR process, code style
- `project-architecture`: Directory structure, key modules
- `project-gotchas`: Footguns, things to watch out for

This makes memory more scannable and easier to update and share with other agents.

### Update Memory Incrementally

**For deep research: Update memory as you go, not all at once at the end.**

Why this matters:
- Deep research can take many turns and millions of tokens
- Context windows overflow and trigger rolling summaries
- If you wait until the end to write memory, you may lose important details
- Write findings to memory blocks as you discover them

Good pattern:
1. Create block structure early (even with placeholder content)
2. Update blocks after each research phase
3. Refine and consolidate at the end

Remember, your memory tool allows you to easily add, edit, and remove blocks. There's no reason to wait until you "know everything" to write memory. Treat your memory blocks as a living scratchpad.

### Initialize ALL Relevant Blocks

Don't just update a single memory block. Based on your upfront questions, also update:

- **`human`**: Store the user's identity, workflow preferences, communication style
- **`persona`**: Store rules the user wants you to follow, behavioral adaptations
- **`project-*`**: Split project info across multiple focused blocks

And add memory blocks that you think make sense to add (e.g., `project-architecture`, `project-conventions`, `project-gotchas`, etc, or even splitting the `human` block into more focused blocks, or even multiple blocks for multiple users).

## Your Task

1. **Ask upfront questions**: Use AskUserQuestion with the recommended questions above (bundled together). This is critical - don't skip it.
2. **Inspect existing memory**: You may already have some memory blocks initialized. See what already exists, and analyze how it is or is not insuffucient or incomplete.
3. **Identify the user**: From git logs and their answer, figure out who they are and store in `human` block. If relevant, ask questions to gather information about their preferences that will help you be a useful assistant to them.
4. **Update human/persona early**: Based on answers, update your memory blocks eagerly before diving into project research. You can always change them as you go, you're not locked into any memory configuration.
5. **Research the project**: Explore based on chosen depth. Use your TODO or plan tool to create a systematic research plan.
6. **Create/update project blocks incrementally**: Don't wait until the end - write findings as you go.
7. **Summarize**: Briefly tell the user what you've learned and how you've decided to configure your memory.

Remember: Good memory management is an investment. The effort you put into organizing your memory now will pay dividends as you work with this user over time.
