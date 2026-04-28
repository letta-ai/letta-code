---
name: working-in-parallel
description: Guide for working in parallel with other agents. Use when another agent is already working in the same directory, or when you need to work on multiple features simultaneously. Covers git worktrees as the recommended approach.
---

# Working in Parallel

Use **git worktrees** to work in parallel when another agent is in the same directory.

Git worktrees let you check out multiple branches into separate directories. Each worktree has its own isolated files while sharing the same Git history and remote connections. Changes in one worktree won't affect others, so parallel agents can't interfere with each other.

Learn more: [Git worktree documentation](https://git-scm.com/docs/git-worktree)

## IMPORTANT: Worktree Location

**All worktrees MUST be created under `.letta/worktrees/` in the repo root.** This keeps worktrees organized, gitignored, and out of the user's project directory.

Before creating the first worktree, ensure `.letta/worktrees` is in the repo's `.gitignore`:

```bash
# Add to .gitignore if not already present
grep -q '.letta/worktrees' .gitignore 2>/dev/null || echo '.letta/worktrees' >> .gitignore
```

## IMPORTANT: Check Project Setup First

Before running ANY commands in a new worktree, check the project's setup instructions:

1. **Read the README** - Usually has install/build commands
2. **Check `claude.md` or `AGENT.md`** - Agent-specific guidance if present
3. **Review your `project` memory block** - Contains learned project preferences

Don't assume `npm` vs `bun` vs `pnpm` - **check the project first!**

## Quick Start

```bash
# Ensure .letta/worktrees is gitignored
grep -q '.letta/worktrees' .gitignore 2>/dev/null || echo '.letta/worktrees' >> .gitignore

# Create worktree with new branch (from repo root)
git worktree add -b fix/my-feature .letta/worktrees/my-feature main

# Work in the worktree
cd .letta/worktrees/my-feature

# CHECK PROJECT SETUP FIRST - then install dependencies
# Read README.md or check project memory block for correct command
bun install  # Example - verify this is correct for YOUR project!

# Make changes, commit, push, PR
git add <files>
git commit -m "fix: description"
git push -u origin fix/my-feature
gh pr create --title "Fix: description" --body "## Summary..."

# Clean up when done (from repo root)
git worktree remove .letta/worktrees/my-feature
```

## Key Commands

```bash
git worktree add -b <branch> .letta/worktrees/<name> main  # Create with new branch
git worktree add .letta/worktrees/<name> <existing-branch>  # Use existing branch
git worktree list                                            # Show all worktrees
git worktree remove .letta/worktrees/<name>                  # Remove worktree
```

## When to Use

- Another agent is working in the current directory
- Long-running task in one session, quick fix needed in another
- User wants to continue development while an agent works on a separate feature

## Pre-commit Hooks in Worktrees

Worktrees share `.git`, but pre-commit hooks may need initialization depending on project setup. After creating a worktree and installing dependencies, verify hooks are active before committing. Check project docs or run the project's hook setup command if needed.

## Tips

- **Always use `.letta/worktrees/`** - never create worktrees outside this directory
- **Check project setup docs before installing** - README, claude.md, project memory block
- Name worktrees clearly: `.letta/worktrees/feature-auth`, `.letta/worktrees/bugfix-123`
- Install dependencies using the project's package manager (check first!)
- Push changes before removing worktrees

## Alternative: Repo Clones

Some users prefer cloning the repo multiple times (`gh repo clone owner/repo project-01`) for simpler mental model. This uses more disk space but provides complete isolation. If the user expresses confusion about worktrees or explicitly prefers clones, use that approach instead.
