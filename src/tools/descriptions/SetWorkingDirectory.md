# SetWorkingDirectory

Changes the working directory for the current conversation. All subsequent tool calls (Bash, Glob, Grep, Read, Write, etc.) will use this as their default directory.

## When to Use

- After creating a git worktree (`git worktree add`), switch into the new worktree so tools operate there
- When you need to work in a different project directory mid-session
- After cloning a repository, switch into the cloned directory

## Parameters

- **path** (required): Absolute or relative path to the new directory. Relative paths resolve against the current working directory.

## Notes

- The path must exist and be a directory
- The change persists across turns for this conversation
- Other conversations are not affected
- The file search index will automatically re-root if the new directory is outside the current index scope
