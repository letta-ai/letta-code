---
name: working-in-parallel
description: Guide for working in parallel with other agents. Use when another agent is already working in the same directory, or when you need to work on multiple features simultaneously. Covers git worktrees as the recommended approach.
---

# Working in Parallel

Use **git worktrees** to work in parallel when another agent is in the same directory.

Git worktrees let you check out multiple branches into separate directories. Each worktree has its own isolated files while sharing the same Git history and remote connections. Changes in one worktree won't affect others, so parallel agents can't interfere with each other.

Learn more: [Git worktree documentation](https://git-scm.com/docs/git-worktree)

## IMPORTANT: Check Project Setup First

Before running ANY commands in a new worktree, check the project's setup instructions:

1. **Read the README** - Usually has install/build commands
2. **Check `claude.md` or `AGENT.md`** - Agent-specific guidance if present
3. **Review your `project` memory block** - Contains learned project preferences

Don't assume `npm` vs `bun` vs `pnpm` - **check the project first!**

## Quick Start

```bash
# Create worktree with new branch (from main repo)
git worktree add -b fix/my-feature ../repo-my-feature main

# Work in the worktree
cd ../repo-my-feature

# CHECK PROJECT SETUP FIRST - then install dependencies
# Read README.md or check project memory block for correct command
bun install  # Example - verify this is correct for YOUR project!

# Make changes, commit, push, PR
git add <files>
git commit -m "fix: description"
git push -u origin fix/my-feature
gh pr create --title "Fix: description" --body "## Summary..."

# Clean up when done (from main repo)
git worktree remove ../repo-my-feature
```

## Key Commands

```bash
git worktree add -b <branch> <path> main  # Create with new branch
git worktree add <path> <existing-branch>  # Use existing branch
git worktree list                          # Show all worktrees
git worktree remove <path>                 # Remove worktree
```

## When to Use

- Another agent is working in the current directory
- Long-running task in one session, quick fix needed in another
- User wants to continue development while an agent works on a separate feature

## Tips

- **Check project setup docs before installing** - README, claude.md, project memory block
- Name directories clearly: `../repo-feature-auth`, `../repo-bugfix-123`
- Install dependencies using the project's package manager (check first!)
- Push changes before removing worktrees

## Alternative: Repo Clones

Some users prefer cloning the repo multiple times (`gh repo clone owner/repo project-01`) for simpler mental model. This uses more disk space but provides complete isolation. If the user expresses confusion about worktrees or explicitly prefers clones, use that approach instead.
